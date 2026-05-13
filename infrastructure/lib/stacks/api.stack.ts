// API stack: HTTP API Gateway + JWT Authorizer (ID Token) + Identity/Journal Lambdas in VPC.

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
import { Key, KeySpec, KeyUsage } from 'aws-cdk-lib/aws-kms';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, FunctionUrlAuthType, InvokeMode, Runtime } from 'aws-cdk-lib/aws-lambda';
import { buildApiGwCors, buildFunctionUrlCors } from '../config/cors.config.js';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../config/env.config.js';
import type { AuroraConstruct } from './data/aurora.construct.js';
import type { CacheConstruct } from './data/cache.construct.js';
import type { IdentityStack } from './identity.stack.js';

export interface ApiStackProps extends StackProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly vpc: IVpc;
  readonly lambdaSg: ISecurityGroup;
  readonly aurora: AuroraConstruct;
  readonly cache: CacheConstruct;
  readonly identity: IdentityStack;
  readonly sharedKey: IKey;
  readonly codefSecret: ISecret;
  readonly legalSyncStateMachineArn?: string;
  readonly legalKbId?: string;
  readonly filingGeneratorFnArn?: string;
  readonly filingGeneratorFnName?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDENTITY_LAMBDA_ENTRY = join(__dirname, '../../../apps/identity/src/infrastructure/inbound/http/identity.lambda.ts');
const JOURNAL_LAMBDA_ENTRY = join(__dirname, '../../../apps/journal/src/infrastructure/inbound/http/journal.lambda.ts');
const FX_LAMBDA_ENTRY = join(__dirname, '../../../apps/fx/src/infrastructure/inbound/http/fx.lambda.ts');
const TAX_LAMBDA_ENTRY = join(__dirname, '../../../apps/tax/src/infrastructure/inbound/http/tax.lambda.ts');
const TAX_STRATEGY_LAMBDA_ENTRY = join(__dirname, '../../../apps/tax/src/infrastructure/inbound/streaming/tax-strategy.lambda.ts');
const CODEF_SYNC_STREAM_LAMBDA_ENTRY = join(__dirname, '../../../apps/codef/src/infrastructure/inbound/streaming/fs-sync-stream.lambda.ts');
const TAX_KNOWLEDGE_LAMBDA_ENTRY = join(__dirname, '../../../apps/tax-knowledge/src/infrastructure/inbound/http/tax-knowledge.lambda.ts');
const API_NOT_FOUND_LAMBDA_ENTRY = join(__dirname, '../lambdas/api-not-found.lambda.ts');
// Sonnet 4.6 for cheap deterministic work (transaction classification). Opus 4.6 for advisory/reasoning agents (Opus 4.7 model access not yet granted on this AWS account; revisit once approved).
const BEDROCK_CLASSIFIER_MODEL_ID = 'global.anthropic.claude-sonnet-4-6';
const BEDROCK_STRATEGY_MODEL_ID = 'global.anthropic.claude-opus-4-6-v1';
const RERANK_REGION_DEFAULT = 'ap-northeast-1';
const RERANK_MODEL_DEFAULT = 'cohere.rerank-v3-5:0';
const EMBED_MODEL_DEFAULT = 'amazon.titan-embed-text-v2:0';

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

    const bizRegHmacKey = new Key(this, 'BizRegNoHmacSha256Key', {
      keySpec: KeySpec.HMAC_256,
      keyUsage: KeyUsage.GENERATE_VERIFY_MAC,
      description: 'HMAC key for biz_reg_no deduplication — do NOT rotate',
    });

    // --- Access logs ---
    const accessLogGroup = new LogGroup(this, 'ApiAccessLogs', {
      retention: isProd ? RetentionDays.THREE_MONTHS : RetentionDays.TWO_WEEKS,
      removalPolicy: undefined,
    });

    // --- Identity Lambda ---
    // PRIVATE_WITH_EGRESS subnet is required: CODEF account/create + account-list need outbound internet via NAT.
    const identityFn = new NodejsFunction(this, 'IdentityFn', {
      entry: IDENTITY_LAMBDA_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        CLUSTER_ENDPOINT: props.aurora.cluster.clusterEndpoint.hostname,
        CLUSTER_PORT: '5432',
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
        LOG_LEVEL: isProd ? 'info' : 'debug',
        KMS_BIZREG_KEY_ARN: bizRegKey.keyArn,
        KMS_BIZREG_HMAC_KEY_ARN: bizRegHmacKey.keyArn,
        IDEMPOTENCY_TABLE_NAME: props.cache.idempotencyKeys.tableName,
        CODEF_SECRET_ARN: props.codefSecret.secretArn,
        FILING_GENERATOR_FN_NAME: props.filingGeneratorFnName ?? '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'pg-native'],
        nodeModules: ['pg', '@aws-lambda-powertools/idempotency'],
      },
    });

    if (props.filingGeneratorFnArn) {
      identityFn.addToRolePolicy(
        new PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [props.filingGeneratorFnArn],
        }),
      );
    }

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
    props.cache.idempotencyKeys.grantReadWriteData(identityFn);
    props.codefSecret.grantRead(identityFn);

    // --- Journal Lambda ---
    // PRIVATE_WITH_EGRESS subnet is required: Bedrock API calls need outbound internet via NAT.
    const journalFn = new NodejsFunction(this, 'JournalFn', {
      entry: JOURNAL_LAMBDA_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        CLUSTER_ENDPOINT: props.aurora.cluster.clusterEndpoint.hostname,
        CLUSTER_PORT: '5432',
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
        LOG_LEVEL: isProd ? 'info' : 'debug',
        BEDROCK_MODEL_ID: BEDROCK_CLASSIFIER_MODEL_ID,
        BEDROCK_DAILY_LIMIT_PER_USER: '100',
        COST_COUNTER_TABLE_NAME: props.cache.costCounter.tableName,
        IDEMPOTENCY_TABLE_NAME: props.cache.idempotencyKeys.tableName,
        TRANSACTION_CACHE_TABLE_NAME: props.cache.transactionCache.tableName,
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'pg-native'],
        nodeModules: ['pg', '@aws-lambda-powertools/idempotency'],
      },
    });

    journalFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['rds-db:connect'],
        resources: [
          `arn:aws:rds-db:${region}:${account}:dbuser:${props.aurora.cluster.clusterResourceIdentifier}/app_user`,
        ],
      }),
    );
    journalFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
        resources: [
          `arn:aws:bedrock:${region}:${account}:inference-profile/${BEDROCK_CLASSIFIER_MODEL_ID}`,
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
        ],
      }),
    );
    props.cache.costCounter.grantReadWriteData(journalFn);
    props.cache.idempotencyKeys.grantReadWriteData(journalFn);
    props.cache.transactionCache.grantReadWriteData(journalFn);

    // --- FX Lambda (HTTP) ---
    const fxFn = new NodejsFunction(this, 'FxFn', {
      entry: FX_LAMBDA_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(15),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        CLUSTER_ENDPOINT: props.aurora.cluster.clusterEndpoint.hostname,
        CLUSTER_PORT: '5432',
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
        LOG_LEVEL: isProd ? 'info' : 'debug',
        ECOS_API_KEY: process.env.ECOS_API_KEY ?? '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'pg-native'],
        nodeModules: ['pg'],
      },
    });
    fxFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['rds-db:connect'],
        resources: [`arn:aws:rds-db:${region}:${account}:dbuser:${props.aurora.cluster.clusterResourceIdentifier}/app_user`],
      }),
    );

    // --- Tax Lambda (HTTP) ---
    const taxFn = new NodejsFunction(this, 'TaxFn', {
      entry: TAX_LAMBDA_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 384,
      timeout: Duration.seconds(20),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        CLUSTER_ENDPOINT: props.aurora.cluster.clusterEndpoint.hostname,
        CLUSTER_PORT: '5432',
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
        LOG_LEVEL: isProd ? 'info' : 'debug',
        HOLIDAY_API_SERVICE_KEY: process.env.HOLIDAY_API_SERVICE_KEY ?? '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'pg-native'],
        nodeModules: ['pg', '@aws-lambda-powertools/idempotency'],
      },
    });
    taxFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['rds-db:connect'],
        resources: [`arn:aws:rds-db:${region}:${account}:dbuser:${props.aurora.cluster.clusterResourceIdentifier}/app_user`],
      }),
    );

    const apiGwCors = buildApiGwCors({ stage: props.deploymentEnv });
    const functionUrlCors = buildFunctionUrlCors({ stage: props.deploymentEnv });

    // --- Tax-Strategy SSE Lambda (Function URL with response streaming, Bedrock Converse + KB tools) ---
    const kbRegionForStrategy = process.env.BEDROCK_KB_REGION ?? region;
    const rerankRegionForStrategy = process.env.BEDROCK_RERANK_REGION ?? RERANK_REGION_DEFAULT;
    const rerankModelForStrategy = process.env.BEDROCK_RERANK_MODEL ?? RERANK_MODEL_DEFAULT;
    const embedModelForStrategy = process.env.BEDROCK_EMBED_MODEL ?? EMBED_MODEL_DEFAULT;
    const taxStrategyFn = new NodejsFunction(this, 'TaxStrategyFn', {
      entry: TAX_STRATEGY_LAMBDA_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(10),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        CLUSTER_ENDPOINT: props.aurora.cluster.clusterEndpoint.hostname,
        CLUSTER_PORT: '5432',
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
        LOG_LEVEL: isProd ? 'info' : 'debug',
        COGNITO_USER_POOL_ID: props.identity.userPool.userPoolId,
        COGNITO_USER_POOL_CLIENT_ID: props.identity.userPoolClient.userPoolClientId,
        BEDROCK_KB_ID: props.legalKbId ?? process.env.BEDROCK_KB_ID ?? '',
        BEDROCK_KB_REGION: kbRegionForStrategy,
        BEDROCK_RERANK_REGION: rerankRegionForStrategy,
        BEDROCK_RERANK_MODEL: rerankModelForStrategy,
        BEDROCK_EMBED_MODEL: embedModelForStrategy,
        BEDROCK_MODEL_ID: BEDROCK_STRATEGY_MODEL_ID,
        AWS_ACCOUNT_ID: account,
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'pg-native'],
        nodeModules: ['pg'],
      },
    });
    taxStrategyFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['rds-db:connect'],
        resources: [`arn:aws:rds-db:${region}:${account}:dbuser:${props.aurora.cluster.clusterResourceIdentifier}/app_user`],
      }),
    );
    taxStrategyFn.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:Converse',
          'bedrock:ConverseStream',
          'bedrock:Retrieve',
          'bedrock:RetrieveAndGenerate',
          'bedrock:Rerank',
          'bedrock:GetInferenceProfile',
        ],
        resources: ['*'],
      }),
    );
    const taxStrategyFnUrl = taxStrategyFn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      invokeMode: InvokeMode.RESPONSE_STREAM,
      cors: functionUrlCors,
    });
    new CfnOutput(this, 'TaxStrategyFnUrl', {
      value: taxStrategyFnUrl.url,
      description: 'Function URL for tax/strategy SSE endpoint (Bearer JWT in Authorization header).',
      exportName: `${id}-TaxStrategyFnUrl`,
    });

    // --- Codef-Sync SSE Lambda (Function URL with response streaming, inline CODEF fetch + Bedrock classification) ---
    const codefSyncStreamFn = new NodejsFunction(this, 'CodefSyncStreamFn', {
      entry: CODEF_SYNC_STREAM_LAMBDA_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(14),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        CLUSTER_ENDPOINT: props.aurora.cluster.clusterEndpoint.hostname,
        CLUSTER_PORT: '5432',
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
        LOG_LEVEL: isProd ? 'info' : 'debug',
        COGNITO_USER_POOL_ID: props.identity.userPool.userPoolId,
        COGNITO_USER_POOL_CLIENT_ID: props.identity.userPoolClient.userPoolClientId,
        BEDROCK_MODEL_ID: BEDROCK_CLASSIFIER_MODEL_ID,
        TRANSACTION_CACHE_TABLE_NAME: props.cache.transactionCache.tableName,
        CODEF_SECRET_ARN: props.codefSecret.secretArn,
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'pg-native'],
        nodeModules: ['pg'],
      },
    });
    codefSyncStreamFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['rds-db:connect'],
        resources: [`arn:aws:rds-db:${region}:${account}:dbuser:${props.aurora.cluster.clusterResourceIdentifier}/app_user`],
      }),
    );
    codefSyncStreamFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
        resources: [
          `arn:aws:bedrock:${region}:${account}:inference-profile/${BEDROCK_CLASSIFIER_MODEL_ID}`,
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
        ],
      }),
    );
    props.codefSecret.grantRead(codefSyncStreamFn);
    props.cache.transactionCache.grantReadWriteData(codefSyncStreamFn);

    const codefSyncStreamFnUrl = codefSyncStreamFn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      invokeMode: InvokeMode.RESPONSE_STREAM,
      cors: functionUrlCors,
    });
    new CfnOutput(this, 'CodefSyncStreamFnUrl', {
      value: codefSyncStreamFnUrl.url,
      description: 'Function URL for POST /tenants/{tenantId}/fs/sync SSE endpoint (Bearer JWT in Authorization header).',
      exportName: `${id}-CodefSyncStreamFnUrl`,
    });

    NagSuppressions.addResourceSuppressions(
      codefSyncStreamFn,
      [
        { id: 'AwsSolutions-L1', reason: 'NODEJS_20_X is current LTS; 22_X adoption deferred' },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaVPCAccessExecutionRole + AWSLambdaBasicExecutionRole required for VPC Lambda',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'rds-db:connect scoped to app_user; bedrock foundation-model wildcard required for cross-region inference profile',
          appliesTo: [
            'Resource::*',
            'Resource::arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'kms:ReEncrypt*/kms:GenerateDataKey* added by CDK grantReadWriteData for DynamoDB CMK',
          appliesTo: ['Action::kms:ReEncrypt*', 'Action::kms:GenerateDataKey*'],
        },
      ],
      true,
    );

    // --- Tax-Knowledge Lambda (Bedrock KB + AgentCore-style tools + admin) ---
    const kbRegion = process.env.BEDROCK_KB_REGION ?? region;
    const rerankRegion = process.env.BEDROCK_RERANK_REGION ?? RERANK_REGION_DEFAULT;
    const rerankModel = process.env.BEDROCK_RERANK_MODEL ?? RERANK_MODEL_DEFAULT;
    const embedModel = process.env.BEDROCK_EMBED_MODEL ?? EMBED_MODEL_DEFAULT;

    const taxKnowledgeFn = new NodejsFunction(this, 'TaxKnowledgeFn', {
      entry: TAX_KNOWLEDGE_LAMBDA_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        CLUSTER_ENDPOINT: props.aurora.cluster.clusterEndpoint.hostname,
        CLUSTER_PORT: '5432',
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
        LOG_LEVEL: isProd ? 'info' : 'debug',
        BEDROCK_KB_ID: props.legalKbId ?? process.env.BEDROCK_KB_ID ?? '',
        BEDROCK_KB_REGION: kbRegion,
        BEDROCK_RERANK_REGION: rerankRegion,
        BEDROCK_RERANK_MODEL: rerankModel,
        BEDROCK_EMBED_MODEL: embedModel,
        BEDROCK_MODEL_ID: BEDROCK_STRATEGY_MODEL_ID,
        ADMIN_COGNITO_GROUP: process.env.ADMIN_COGNITO_GROUP ?? 'ym-tax-admin',
        RERANK_DAILY_LIMIT_PER_USER: process.env.RERANK_DAILY_LIMIT_PER_USER ?? '20',
        LEGAL_SYNC_STATE_MACHINE_ARN: props.legalSyncStateMachineArn ?? process.env.LEGAL_SYNC_STATE_MACHINE_ARN ?? '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'pg-native'],
        nodeModules: ['pg'],
      },
    });
    taxKnowledgeFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['rds-db:connect'],
        resources: [`arn:aws:rds-db:${region}:${account}:dbuser:${props.aurora.cluster.clusterResourceIdentifier}/app_user`],
      }),
    );
    taxKnowledgeFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate', 'bedrock:Rerank'],
        resources: ['*'],
      }),
    );
    taxKnowledgeFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${kbRegion}::foundation-model/${embedModel}`,
          `arn:aws:bedrock:${rerankRegion}::foundation-model/${rerankModel}`,
          `arn:aws:bedrock:${region}:${account}:inference-profile/${BEDROCK_STRATEGY_MODEL_ID}`,
        ],
      }),
    );
    taxKnowledgeFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [`arn:aws:states:${region}:${account}:stateMachine:*`],
      }),
    );

    // --- HTTP API ---
    const jwtAuthorizer = new HttpJwtAuthorizer('JwtAuthorizer', props.identity.issuerUrl, {
      // audience = UserPoolClientId → only ID Tokens (aud=clientId) pass; Access Tokens have no aud.
      jwtAudience: [props.identity.userPoolClient.userPoolClientId],
    });

    this.httpApi = new HttpApi(this, 'HttpApi', {
      createDefaultStage: true,
      corsPreflight: apiGwCors,
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

    // --- Not-Found catch-all (gives unmatched routes a 404 with CORS headers; otherwise API GW emits 404 without CORS and the browser surfaces it as a CORS error). ---
    const apiNotFoundFn = new NodejsFunction(this, 'ApiNotFoundFn', {
      entry: API_NOT_FOUND_LAMBDA_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      environment: {
        CODEF_SYNC_STREAM_FN_URL: codefSyncStreamFnUrl.url,
        TAX_STRATEGY_FN_URL: taxStrategyFnUrl.url,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });
    const notFoundIntegration = new HttpLambdaIntegration('NotFoundIntegration', apiNotFoundFn);

    const identityIntegration = new HttpLambdaIntegration('IdentityIntegration', identityFn);
    const journalIntegration = new HttpLambdaIntegration('JournalIntegration', journalFn);
    const fxIntegration = new HttpLambdaIntegration('FxIntegration', fxFn);
    const taxIntegration = new HttpLambdaIntegration('TaxIntegration', taxFn);
    const taxKnowledgeIntegration = new HttpLambdaIntegration('TaxKnowledgeIntegration', taxKnowledgeFn);

    // GET /health — no authorizer (intentional liveness probe)
    this.httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      integration: identityIntegration,
    });

    // GET /accounts/chart — global K-IFRS chart, unauthenticated, static
    this.httpApi.addRoutes({
      path: '/accounts/chart',
      methods: [HttpMethod.GET],
      integration: journalIntegration,
    });

    // Identity authenticated routes
    for (const [method, path] of [
      [HttpMethod.GET, '/me'],
      [HttpMethod.POST, '/tenants'],
      [HttpMethod.GET, '/me/tenants'],
      [HttpMethod.POST, '/tenants/{tenantId}/bank-connections'],
      [HttpMethod.POST, '/tenants/{tenantId}/bank-accounts'],
    ] as [HttpMethod, string][]) {
      this.httpApi.addRoutes({
        path,
        methods: [method],
        integration: identityIntegration,
        authorizer: jwtAuthorizer,
      });
    }

    // Journal authenticated routes (path-scoped per tenant). POST /fs/sync moved to SSE Function URL (CodefSyncStreamFn).
    for (const [method, path] of [
      [HttpMethod.POST, '/tenants/{tenantId}/journal/classify'],
      [HttpMethod.POST, '/tenants/{tenantId}/journal/entries'],
      [HttpMethod.GET,  '/tenants/{tenantId}/entries'],
      [HttpMethod.PATCH, '/tenants/{tenantId}/entries/{entryId}'],
      [HttpMethod.POST, '/tenants/{tenantId}/entries/{entryId}/confirm'],
      [HttpMethod.POST, '/tenants/{tenantId}/entries/{entryId}/discard'],
      [HttpMethod.GET, '/tenants/{tenantId}/summary/monthly'],
      [HttpMethod.GET, '/tenants/{tenantId}/receivables'],
      [HttpMethod.PATCH, '/tenants/{tenantId}/receivables/{entryId}'],
      [HttpMethod.GET, '/tenants/{tenantId}/accounts/balances'],
      [HttpMethod.GET, '/tenants/{tenantId}/reports/pnl'],
      [HttpMethod.GET, '/tenants/{tenantId}/reports/balance-sheet'],
      [HttpMethod.GET, '/tenants/{tenantId}/reports/cash-flow'],
      [HttpMethod.GET, '/tenants/{tenantId}/reports/trial-balance'],
    ] as [HttpMethod, string][]) {
      this.httpApi.addRoutes({
        path,
        methods: [method],
        integration: journalIntegration,
        authorizer: jwtAuthorizer,
      });
    }

    // FX routes
    for (const [method, path] of [
      [HttpMethod.GET, '/fx/rates/usd-krw'],
      [HttpMethod.POST, '/tenants/{tenantId}/fx/revalue'],
    ] as [HttpMethod, string][]) {
      this.httpApi.addRoutes({
        path,
        methods: [method],
        integration: fxIntegration,
        authorizer: jwtAuthorizer,
      });
    }

    // Tax routes (filings + withholding + tax-invoices + corporation-profile)
    for (const [method, path] of [
      [HttpMethod.GET, '/tenants/{tenantId}/corporation-profile'],
      [HttpMethod.POST, '/tenants/{tenantId}/corporation-profile'],
      [HttpMethod.GET, '/tenants/{tenantId}/filings/upcoming'],
      [HttpMethod.GET, '/tenants/{tenantId}/filings/{id}/draft'],
      [HttpMethod.GET, '/tenants/{tenantId}/filings/{id}/penalty-simulation'],
      [HttpMethod.POST, '/tenants/{tenantId}/filings/{id}/recompute'],
      [HttpMethod.GET, '/tenants/{tenantId}/withholding/pending'],
      [HttpMethod.POST, '/tenants/{tenantId}/withholding/{id}/file'],
      [HttpMethod.GET, '/tenants/{tenantId}/tax-invoices'],
    ] as [HttpMethod, string][]) {
      this.httpApi.addRoutes({
        path,
        methods: [method],
        integration: taxIntegration,
        authorizer: jwtAuthorizer,
      });
    }

    // Tax-Knowledge routes (AgentCore-style tools + admin)
    for (const [method, path] of [
      [HttpMethod.POST, '/tenants/{tenantId}/agent/search-tax-law'],
      [HttpMethod.POST, '/tenants/{tenantId}/agent/find-benefits'],
      [HttpMethod.GET, '/admin/tax-rules'],
      [HttpMethod.POST, '/admin/tax-rules/{id}/approve'],
      [HttpMethod.GET, '/admin/tax-rules/{id}/change-log'],
      [HttpMethod.GET, '/admin/tax-law-sync/state'],
      [HttpMethod.POST, '/admin/tax-law-sync/run'],
      [HttpMethod.GET, '/admin/tax-rule-reviews'],
      [HttpMethod.POST, '/admin/tax-rule-reviews/{id}/resolve'],
    ] as [HttpMethod, string][]) {
      this.httpApi.addRoutes({
        path,
        methods: [method],
        integration: taxKnowledgeIntegration,
        authorizer: jwtAuthorizer,
      });
    }

    // --- Catch-all: structured 404 + CORS hint for unmatched routes. Must NOT include OPTIONS — that would shadow API Gateway's automatic corsPreflight on every existing route and break browser preflight for the whole API. ---
    const CATCH_ALL_METHODS = [
      HttpMethod.GET,
      HttpMethod.POST,
      HttpMethod.PATCH,
      HttpMethod.DELETE,
      HttpMethod.PUT,
      HttpMethod.HEAD,
    ];
    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: CATCH_ALL_METHODS,
      integration: notFoundIntegration,
    });
    this.httpApi.addRoutes({
      path: '/',
      methods: CATCH_ALL_METHODS,
      integration: notFoundIntegration,
    });

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

    NagSuppressions.addResourceSuppressions(
      journalFn,
      [
        {
          id: 'AwsSolutions-L1',
          reason: 'NODEJS_20_X is current LTS; 22_X adoption deferred to Slice 5',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaVPCAccessExecutionRole + AWSLambdaBasicExecutionRole required for VPC Lambda',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'rds-db:connect scoped to app_user; bedrock foundation-model wildcard required for cross-region inference profile',
          appliesTo: [
            'Resource::*',
            'Resource::arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'kms:ReEncrypt* and kms:GenerateDataKey* added by CDK grantReadWriteData for DynamoDB CMK; scoped to shared KMS key',
          appliesTo: ['Action::kms:ReEncrypt*', 'Action::kms:GenerateDataKey*'],
        },
      ],
      true,
    );

    for (const fn of [fxFn, taxFn, taxKnowledgeFn, taxStrategyFn]) {
      NagSuppressions.addResourceSuppressions(
        fn,
        [
          { id: 'AwsSolutions-L1', reason: 'NODEJS_20_X is current LTS; 22_X adoption deferred' },
          {
            id: 'AwsSolutions-IAM4',
            reason: 'AWSLambdaVPCAccessExecutionRole + AWSLambdaBasicExecutionRole required for VPC Lambda',
            appliesTo: [
              'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
              'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
            ],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'rds-db:connect scoped to app_user; Bedrock Retrieve/Rerank/states wildcards required for cross-region + dynamic KB IDs',
            appliesTo: [
              'Resource::*',
              `Resource::arn:aws:states:${region}:${account}:stateMachine:*`,
            ],
          },
        ],
        true,
      );
    }

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
        reason: 'BizRegNo HMAC key is KMS HMAC_256; rotating would break deterministic biz_reg_no_hash',
      },
    ]);
  }
}
