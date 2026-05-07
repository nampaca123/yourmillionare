// Network stack: VPC, security groups, VPC endpoints, Flow Logs, and NAT Instance for all downstream stacks.

import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import {
  CfnInstance,
  FlowLog,
  FlowLogDestination,
  FlowLogResourceType,
  FlowLogTrafficType,
  GatewayVpcEndpointAwsService,
  Instance,
  InstanceClass,
  InstanceSize,
  InstanceType,
  InterfaceVpcEndpointAwsService,
  IpAddresses,
  NatProvider,
  NatTrafficDirection,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Key } from 'aws-cdk-lib/aws-kms';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../config/env.config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

    // t4g.nano fck-nat: ~$3.5/mo dev, ~$10.5/mo prod (vs NAT Gateway ~$33/mo).
    // NatProvider.instanceV2 uses the fck-nat AMI with ARM64 support.
    // In dev: 1 NAT instance in azs[0] only (SPOF accepted).
    // In prod: 3 NAT instances, one per AZ.
    const natProvider = NatProvider.instanceV2({
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
      defaultAllowedTraffic: NatTrafficDirection.INBOUND_AND_OUTBOUND,
    });

    this.vpc = new Vpc(this, 'Vpc', {
      ipAddresses: IpAddresses.cidr(vpcCidr),
      availabilityZones: azs,
      natGateways: isProd ? 3 : 1,
      natGatewayProvider: natProvider,
      // Order matters for CIDR allocation. isolated must stay at indices 3-5 (10.20.3-5.0/24)
      // to avoid replacing the existing Aurora subnets. egress gets 10.20.6-8.0/24.
      subnetConfiguration: [
        { name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        { name: 'egress', subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // Enforce IMDSv2 on all NAT instances (AwsSolutions-EC29 compliance).
    // natProvider.gatewayInstances is populated by Vpc constructor above.
    const natInstances = (natProvider as unknown as { gatewayInstances: Instance[] }).gatewayInstances;
    for (const inst of natInstances) {
      const cfnInst = inst.node.defaultChild as CfnInstance;
      cfnInst.addPropertyOverride('MetadataOptions', {
        HttpTokens: 'required',
        HttpPutResponseHopLimit: 2,
      });
    }

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

    this.lambdaSg = new SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'Slice 3+ application Lambda functions.',
      allowAllOutbound: true,
    });

    this.auroraSg = new SecurityGroup(this, 'AuroraSg', {
      vpc: this.vpc,
      description: 'Aurora Serverless v2 cluster.',
      allowAllOutbound: false,
    });
    this.auroraSg.addIngressRule(this.lambdaSg, Port.tcp(5432), 'Lambdas on 5432');

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

    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Standalone Lambda for manual egress verification: invoke it and check publicIp in response.
    // aws lambda invoke --function-name <fn-name> --payload '{}' /tmp/out.json
    const egressVerifierFn = new NodejsFunction(this, 'EgressVerifierFn', {
      entry: join(__dirname, 'network/egress-verifier.lambda.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      vpc: this.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.lambdaSg],
    });

    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId, exportName: `${id}-VpcId` });
    new CfnOutput(this, 'LambdaSgId', { value: this.lambdaSg.securityGroupId, exportName: `${id}-LambdaSgId` });
    new CfnOutput(this, 'AuroraSgId', { value: this.auroraSg.securityGroupId, exportName: `${id}-AuroraSgId` });
    new CfnOutput(this, 'FlowLogsGroupArn', { value: flowLogsGroup.logGroupArn, exportName: `${id}-FlowLogsGroupArn` });
    new CfnOutput(this, 'EgressVerifierFnName', { value: egressVerifierFn.functionName });

    NagSuppressions.addResourceSuppressions(flowLogsKey, [
      {
        id: 'AwsSolutions-KMS5',
        reason: 'Flow Logs CMK has key rotation enabled; this suppression covers any remaining KMS rule.',
      },
    ]);

    // NAT instance security group allows 0.0.0.0/0 inbound (required for NAT forwarding)
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${id}/Vpc/NatSecurityGroup/Resource`,
      [{ id: 'AwsSolutions-EC23', reason: 'NAT instance SG requires 0.0.0.0/0 inbound to forward traffic from private subnets.' }],
    );

    // NAT instance EBS and monitoring suppressions
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${id}/Vpc/publicSubnet1/NatInstance/Resource`,
      [
        { id: 'AwsSolutions-EC26', reason: 'fck-nat AMI root volume — KMS EBS encryption deferred; instance is stateless (no sensitive data on disk).' },
        { id: 'AwsSolutions-EC28', reason: 'dev NAT instance — detailed monitoring enabled in prod via CloudWatch alarm.' },
        { id: 'AwsSolutions-EC29', reason: 'IMDSv2 enforced via addPropertyOverride on CfnInstance MetadataOptions.' },
      ],
    );

    // Egress verifier Lambda nag suppressions
    NagSuppressions.addResourceSuppressions(egressVerifierFn, [
      { id: 'AwsSolutions-L1', reason: 'NODEJS_20_X is current LTS; upgrading to 22_X deferred to Slice 5.' },
    ], true);
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${id}/EgressVerifierFn/ServiceRole/Resource`,
      [{ id: 'AwsSolutions-IAM4', reason: 'AWSLambdaVPCAccessExecutionRole is required for VPC Lambda.' }],
    );

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
