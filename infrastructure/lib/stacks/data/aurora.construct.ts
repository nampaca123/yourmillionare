// Aurora construct: Serverless v2 cluster with Data API, IAM auth, and dev/prod branching.

import { Duration, Lazy, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  AuroraPostgresEngineVersion,
  CfnDBProxy,
  CfnDBProxyTargetGroup,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  PerformanceInsightRetention,
} from 'aws-cdk-lib/aws-rds';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../../config/env.config.js';

const DATABASE_NAME = 'yourmillionare';
const PG_15_10 = AuroraPostgresEngineVersion.of('15.10', '15');

export interface AuroraConstructProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly vpc: IVpc;
  readonly auroraSg: ISecurityGroup;
  readonly proxySg: ISecurityGroup;
}

export class AuroraConstruct {
  public readonly cluster: DatabaseCluster;
  public readonly masterSecret: ISecret;
  public readonly proxy: CfnDBProxy;

  constructor(scope: Construct, id: string, props: AuroraConstructProps) {
    const isProd = props.deploymentEnv === 'prod';

    // Local keys: avoids CDK auto-grant writing Foundation's KMS resource policy with
    // Data-stack Lambda ARNs (which creates a Foundation→Data→Network→Foundation cycle).
    const storageKey = new Key(scope, `${id}StorageKey`, {
      description: 'KMS key for Aurora Serverless v2 storage encryption.',
      enableKeyRotation: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const secretKey = new Key(scope, `${id}SecretKey`, {
      description: 'KMS key for Aurora master secret encryption.',
      enableKeyRotation: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.cluster = new DatabaseCluster(scope, id, {
      engine: DatabaseClusterEngine.auroraPostgres({ version: PG_15_10 }),
      writer: ClusterInstance.serverlessV2('writer', {
        enablePerformanceInsights: true,
        performanceInsightRetention: PerformanceInsightRetention.DEFAULT,
      }),
      serverlessV2MinCapacity: isProd ? 0.5 : 0.5,
      serverlessV2MaxCapacity: isProd ? 4 : 2,
      credentials: Credentials.fromGeneratedSecret('postgres', {
        encryptionKey: secretKey,
      }),
      defaultDatabaseName: DATABASE_NAME,
      storageEncrypted: true,
      storageEncryptionKey: storageKey,
      iamAuthentication: true,
      enableDataApi: true,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.auroraSg],
      removalPolicy: isProd ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      deletionProtection: isProd,
      backup: { retention: isProd ? Duration.days(14) : Duration.days(1) },
      autoMinorVersionUpgrade: true,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: isProd ? RetentionDays.THREE_MONTHS : RetentionDays.TWO_WEEKS,
    });

    if (!this.cluster.secret) throw new Error('Aurora master secret was not created');
    this.masterSecret = this.cluster.secret;

    // Use CfnDBProxy directly to avoid the L2 addProxy auto-connection rule.
    // The L2 DatabaseProxy calls cluster.connections.allowDefaultPortFrom(proxy), which adds
    // an ingress rule to auroraSg (NetworkStack) using the cluster port token (DataStack),
    // creating a DependencyCycle. The NetworkStack already adds auroraSg.addIngressRule
    // with a hardcoded port 5432, making the auto-connection redundant and harmful.
    const proxyRole = new Role(scope, `${id}ProxyRole`, {
      assumedBy: new ServicePrincipal('rds.amazonaws.com'),
    });
    this.masterSecret.grantRead(proxyRole);
    secretKey.grantDecrypt(proxyRole);

    const isolatedSubnetIds = Lazy.list({
      produce: () => props.vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    this.proxy = new CfnDBProxy(scope, `${id}Proxy`, {
      dbProxyName: `${Stack.of(scope).stackName}-aurora-proxy`,
      engineFamily: 'POSTGRESQL',
      requireTls: true,
      debugLogging: false,
      idleClientTimeout: Duration.minutes(30).toSeconds(),
      roleArn: proxyRole.roleArn,
      auth: [
        {
          authScheme: 'SECRETS',
          iamAuth: 'REQUIRED',
          secretArn: this.masterSecret.secretArn,
        },
      ],
      vpcSecurityGroupIds: [props.proxySg.securityGroupId],
      vpcSubnetIds: isolatedSubnetIds,
    });
    this.proxy.applyRemovalPolicy(isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);

    const proxyTargetGroup = new CfnDBProxyTargetGroup(scope, `${id}ProxyTargetGroup`, {
      dbProxyName: this.proxy.ref,
      targetGroupName: 'default',
      dbClusterIdentifiers: [this.cluster.clusterIdentifier],
      connectionPoolConfigurationInfo: {
        maxConnectionsPercent: 90,
        maxIdleConnectionsPercent: 50,
      },
    });
    proxyTargetGroup.addDependency(this.proxy);

    NagSuppressions.addResourceSuppressions(
      this.cluster,
      [
        {
          id: 'AwsSolutions-RDS11',
          reason: 'Default port 5432 is acceptable inside PRIVATE_ISOLATED subnet with no CIDR ingress.',
        },
        {
          id: 'AwsSolutions-RDS14',
          reason: 'Aurora PostgreSQL does not support Backtrack; feature is MySQL-only.',
        },
        {
          id: 'AwsSolutions-SMG4',
          reason: 'Aurora master secret is bound to RDS Proxy (added in this slice). The 30-day HostedRotation single-user schedule remains active; Proxy reads the rotated secret transparently.',
        },
      ],
      true,
    );
  }
}
