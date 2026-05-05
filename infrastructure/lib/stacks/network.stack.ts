// Network stack: VPC, security groups, VPC endpoints, and Flow Logs for all downstream stacks.

import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import {
  FlowLog,
  FlowLogDestination,
  FlowLogResourceType,
  FlowLogTrafficType,
  GatewayVpcEndpointAwsService,
  InterfaceVpcEndpointAwsService,
  IpAddresses,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Key } from 'aws-cdk-lib/aws-kms';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../config/env.config.js';

export interface NetworkStackProps extends StackProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly vpcCidr?: string;
  readonly availabilityZones: string[];
}

export class NetworkStack extends Stack {
  public readonly vpc: Vpc;
  public readonly lambdaSg: SecurityGroup;
  public readonly auroraSg: SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const isProd = props.deploymentEnv === 'prod';
    const vpcCidr = props.vpcCidr ?? '10.20.0.0/16';
    const azs = props.availabilityZones;

    // Local CMK for Flow Logs. CloudWatch Logs requires an explicit KMS key policy grant
    // allowing the logs service principal — using a cross-stack key would force a
    // Foundation → Network dependency cycle. Local key avoids that.
    const flowLogsKey = new Key(this, 'FlowLogsKey', {
      description: 'Ym Network Flow Logs CMK',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    flowLogsKey.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
          },
        },
      }),
    );

    // 3 PUBLIC + 3 PRIVATE_ISOLATED subnets, no NAT in Slice 2.
    // PRIVATE_WITH_EGRESS is deferred to Slice 4 together with the NAT decision.
    this.vpc = new Vpc(this, 'Vpc', {
      ipAddresses: IpAddresses.cidr(vpcCidr),
      availabilityZones: azs,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // VPC Flow Logs — enables AwsSolutions-VPC7, encrypted with local CMK.
    // Slice 4 cost gate: re-evaluate S3 destination ($0.25/GB) vs CW ($0.50/GB).
    const flowLogsGroup = new LogGroup(this, 'FlowLogsGroup', {
      encryptionKey: flowLogsKey,
      retention: isProd ? RetentionDays.THREE_MONTHS : RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new FlowLog(this, 'FlowLog', {
      resourceType: FlowLogResourceType.fromVpc(this.vpc),
      trafficType: FlowLogTrafficType.ALL,
      destination: FlowLogDestination.toCloudWatchLogs(flowLogsGroup),
    });

    // sg-lambda: for Slice 3+ app Lambdas. Not consumed in Slice 2 (migrator/verifier are out-of-VPC).
    this.lambdaSg = new SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'Slice 3+ application Lambda functions.',
      allowAllOutbound: true,
    });

    // sg-aurora: only accepts 5432 from sg-lambda, no CIDR ingress.
    this.auroraSg = new SecurityGroup(this, 'AuroraSg', {
      vpc: this.vpc,
      description: 'Aurora Serverless v2 cluster.',
      allowAllOutbound: false,
    });
    this.auroraSg.addIngressRule(this.lambdaSg, Port.tcp(5432), 'Lambdas on 5432');

    // Interface endpoints — 1 AZ in dev (cost: 2 ENI × $0.01/h = ~$14.6/mo),
    // 3 AZ in prod (6 ENI, ~$43.8/mo). secretsmanager and kms only.
    // azs[0] comes from props (no context lookup) so this is safe at synth time.
    const endpointSubnets = isProd
      ? { subnetType: SubnetType.PRIVATE_ISOLATED }
      : { availabilityZones: [azs[0]], subnetType: SubnetType.PRIVATE_ISOLATED };

    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: endpointSubnets,
      privateDnsEnabled: true,
    });
    this.vpc.addInterfaceEndpoint('KmsEndpoint', {
      service: InterfaceVpcEndpointAwsService.KMS,
      subnets: endpointSubnets,
      privateDnsEnabled: true,
    });

    // Gateway endpoints — always free.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: GatewayVpcEndpointAwsService.DYNAMODB,
    });

    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId, exportName: `${id}-VpcId` });
    new CfnOutput(this, 'LambdaSgId', { value: this.lambdaSg.securityGroupId, exportName: `${id}-LambdaSgId` });
    new CfnOutput(this, 'AuroraSgId', { value: this.auroraSg.securityGroupId, exportName: `${id}-AuroraSgId` });
    new CfnOutput(this, 'FlowLogsGroupArn', { value: flowLogsGroup.logGroupArn, exportName: `${id}-FlowLogsGroupArn` });

    NagSuppressions.addResourceSuppressions(flowLogsKey, [
      {
        id: 'AwsSolutions-KMS5',
        reason: 'Flow Logs CMK has key rotation enabled; this suppression covers any remaining KMS rule.',
      },
    ]);

    const endpointNagSuppression = [
      {
        id: 'CdkNagValidationFailure',
        reason:
          'AwsSolutions-EC23 validation fails because the ingress CIDR rule uses Fn::GetAtt for the VPC CIDR block. ' +
          'The rule cannot evaluate intrinsic functions at synth time; the actual SG restricts ingress to the VPC CIDR only.',
      },
    ];
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${id}/Vpc/SecretsManagerEndpoint/SecurityGroup/Resource`,
      endpointNagSuppression,
    );
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${id}/Vpc/KmsEndpoint/SecurityGroup/Resource`,
      endpointNagSuppression,
    );
  }
}
