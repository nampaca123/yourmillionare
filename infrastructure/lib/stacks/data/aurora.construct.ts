// Aurora construct: Serverless v2 cluster with Data API, IAM auth, and dev/prod branching.

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  PerformanceInsightRetention,
} from 'aws-cdk-lib/aws-rds';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
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
}

export class AuroraConstruct {
  public readonly cluster: DatabaseCluster;
  public readonly masterSecret: ISecret;

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
      serverlessV2MinCapacity: isProd ? 0.5 : 0,
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
          reason: 'Master secret rotation deferred to Slice 4 when RDS Proxy is introduced.',
        },
      ],
      true,
    );
  }
}
