// API stack: HTTP API Gateway + JWT Authorizer (ID Token) + Identity Lambda in VPC.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { Key } from 'aws-cdk-lib/aws-kms';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../config/env.config.js';
import type { AuroraConstruct } from './data/aurora.construct.js';
import type { IdentityStack } from './identity.stack.js';

export interface ApiStackProps extends StackProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly vpc: IVpc;
  readonly lambdaSg: ISecurityGroup;
  readonly aurora: AuroraConstruct;
  readonly identity: IdentityStack;
  readonly sharedKey: IKey;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDENTITY_LAMBDA_ENTRY = join(__dirname, '../../../apps/identity/src/infrastructure/inbound/http/identity.lambda.ts');

export class ApiStack extends Stack {
  public readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const isProd = props.deploymentEnv === 'prod';
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // --- KMS keys for biz_reg_no encryption and HMAC ---
    const bizRegKey = new Key(this, 'BizRegNoKey', {
      description: 'Encrypts biz_reg_no field in tenants table',
      enableKeyRotation: true,
      removalPolicy: isProd ? undefined : undefined,
    });

    const bizRegHmacKey = new Key(this, 'BizRegNoHmacKey', {
      description: 'HMAC key for biz_reg_no deduplication — do NOT rotate',
      enableKeyRotation: false,
    });

    // --- Access logs ---
    const accessLogGroup = new LogGroup(this, 'ApiAccessLogs', {
      retention: isProd ? RetentionDays.THREE_MONTHS : RetentionDays.TWO_WEEKS,
      removalPolicy: undefined,
    });

    // --- Identity Lambda ---
    const identityFn = new NodejsFunction(this, 'IdentityFn', {
      entry: IDENTITY_LAMBDA_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        CLUSTER_ENDPOINT: props.aurora.cluster.clusterEndpoint.hostname,
        CLUSTER_PORT: '5432',
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
        LOG_LEVEL: isProd ? 'info' : 'debug',
        KMS_BIZREG_KEY_ARN: bizRegKey.keyArn,
        KMS_BIZREG_HMAC_KEY_ARN: bizRegHmacKey.keyArn,
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'pg-native'],
        nodeModules: ['pg'],
      },
    });

    // rds-db:connect scoped to app_user
    identityFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['rds-db:connect'],
        resources: [
          `arn:aws:rds-db:${region}:${account}:dbuser:${props.aurora.cluster.clusterResourceIdentifier}/app_user`,
        ],
      }),
    );

    bizRegKey.grantEncryptDecrypt(identityFn);
    bizRegHmacKey.grant(identityFn, 'kms:GenerateMac', 'kms:VerifyMac');

    // --- HTTP API ---
    const jwtAuthorizer = new HttpJwtAuthorizer('JwtAuthorizer', props.identity.issuerUrl, {
      // audience = UserPoolClientId → only ID Tokens (aud=clientId) pass; Access Tokens have no aud.
      jwtAudience: [props.identity.userPoolClient.userPoolClientId],
    });

    this.httpApi = new HttpApi(this, 'HttpApi', {
      createDefaultStage: true,
    });

    // Attach access logs to the default stage (stable CDK pattern)
    const cfnStage = this.httpApi.defaultStage?.node.defaultChild as { accessLogSettings?: unknown; attrApiId?: string };
    if (cfnStage) {
      Object.assign(cfnStage, {
        accessLogSettings: {
          destinationArn: accessLogGroup.logGroupArn,
          format: JSON.stringify({
            requestId: '$context.requestId',
            ip: '$context.identity.sourceIp',
            routeKey: '$context.routeKey',
            status: '$context.status',
            responseLatency: '$context.responseLatency',
            integrationError: '$context.integrationErrorMessage',
          }),
        },
      });
    }

    const integration = new HttpLambdaIntegration('IdentityIntegration', identityFn);

    // GET /health — no authorizer (intentional liveness probe)
    this.httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      integration,
    });

    // Authenticated routes
    for (const [method, path] of [
      [HttpMethod.GET, '/me'],
      [HttpMethod.POST, '/tenants'],
      [HttpMethod.GET, '/me/tenants'],
    ] as [HttpMethod, string][]) {
      this.httpApi.addRoutes({
        path,
        methods: [method],
        integration,
        authorizer: jwtAuthorizer,
      });
    }

    // --- Outputs ---
    new CfnOutput(this, 'HttpApiUrl', { value: this.httpApi.url ?? '' });

    // --- cdk-nag suppressions ---
    NagSuppressions.addResourceSuppressions(
      this.httpApi,
      [
        {
          id: 'AwsSolutions-APIG1',
          reason: 'Access logging is configured on the default stage via CfnStage override; cdk-nag cannot detect it through the L2 construct',
        },
        {
          id: 'AwsSolutions-APIG4',
          reason: 'GET /health is an intentional unauthenticated liveness probe with no backend dependency',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      identityFn,
      [
        {
          id: 'AwsSolutions-L1',
          reason: 'NODEJS_20_X is current LTS; 22_X adoption deferred to Slice 4',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaVPCAccessExecutionRole + AWSLambdaBasicExecutionRole are required for VPC Lambda',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'rds-db:connect ARN is scoped to app_user on this specific cluster; wildcard only in execution role from CDK VPC grant',
          appliesTo: ['Resource::*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'kms:ReEncrypt* and kms:GenerateDataKey* are added by CDK grantEncryptDecrypt; scoped to BizRegNo key',
          appliesTo: ['Action::kms:ReEncrypt*', 'Action::kms:GenerateDataKey*'],
        },
      ],
      true,
    );

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'CDK-generated log retention Lambda uses managed execution role',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CDK-generated log retention Lambda uses wildcard log group ARN',
        appliesTo: ['Resource::*'],
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'CDK-generated log retention Lambda runtime managed by CDK',
      },
      {
        id: 'AwsSolutions-KMS5',
        reason: 'BizRegNoHmacKey intentionally has key rotation disabled; rotating it would break deterministic HMAC-based deduplication',
      },
    ]);
  }
}
