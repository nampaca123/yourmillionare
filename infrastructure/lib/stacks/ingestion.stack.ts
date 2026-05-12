// Ingestion stack: CODEF EDA — VPC Lambdas for tenant listing, bank fetch, classification; SQS + SFN + Scheduler.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction, SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../config/env.config.js';
import type { AuroraConstruct } from './data/aurora.construct.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TENANTS_LIST_ENTRY = join(__dirname, '../../../apps/codef/src/infrastructure/inbound/http/tenants-list.lambda.ts');
const CODEF_FETCH_ENTRY = join(__dirname, '../../../apps/codef/src/infrastructure/inbound/http/codef-fetch.lambda.ts');
const CLASSIFY_WORKER_ENTRY = join(__dirname, '../../../apps/codef/src/infrastructure/inbound/http/codef-classify-worker.lambda.ts');
const FX_COLLECTOR_ENTRY = join(__dirname, '../../../apps/fx/src/infrastructure/inbound/fx-collector.lambda.ts');
const HOLIDAY_SYNC_ENTRY = join(__dirname, '../../../apps/tax/src/infrastructure/inbound/scheduled/holiday-yearly-sync.lambda.ts');
const LAW_SYNC_ENTRY = join(__dirname, '../../../apps/tax-knowledge/src/infrastructure/inbound/scheduled/monthly-law-sync.lambda.ts');

const BEDROCK_PROFILE_ID = 'global.anthropic.claude-sonnet-4-6';

export interface IngestionStackProps extends StackProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly vpc: IVpc;
  readonly lambdaSg: ISecurityGroup;
  readonly aurora: AuroraConstruct;
  readonly codefSecretArn: string;
  readonly transactionCache: ITable;
}

export class IngestionStack extends Stack {
  public readonly manualSyncStateMachineArn: string;
  public readonly legalSyncStateMachineArn: string;

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);

    const isProd = props.deploymentEnv === 'prod';
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    const codefSecret = Secret.fromSecretCompleteArn(this, 'CodefSecretRef', props.codefSecretArn);

    const classifyDlq = new Queue(this, 'ClassifyDLQ', {
      retentionPeriod: Duration.days(14),
    });

    const classifyQueue = new Queue(this, 'ClassifyTasksQueue', {
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: classifyDlq, maxReceiveCount: 3 },
    });

    NagSuppressions.addResourceSuppressions(classifyQueue, [
      {
        id: 'AwsSolutions-SQS4',
        reason: 'Queue is consumed only by VPC-bound Lambda via AWS-managed integration; TLS-only policy deferred.',
      },
    ]);
    NagSuppressions.addResourceSuppressions(classifyDlq, [
      {
        id: 'AwsSolutions-SQS4',
        reason: 'DLQ is operator-only via IAM; TLS-only queue policy deferred.',
      },
    ]);

    const alarmTopic = new Topic(this, 'IngestionAlarmTopic', {
      displayName: `${id} ingestion alarms`,
    });

    const commonVpcConfig = {
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
    };

    const commonEnv = {
      CLUSTER_ENDPOINT: props.aurora.cluster.clusterEndpoint.hostname,
      CLUSTER_PORT: '5432',
      DATABASE_NAME: 'yourmillionare',
      APP_REGION: region,
      SYSTEM_USER_UUID: '00000000-0000-0000-0000-000000000001',
      LOG_LEVEL: isProd ? 'info' : 'debug',
    };

    const commonBundling = {
      externalModules: ['@aws-sdk/*', 'pg-native'],
      nodeModules: ['pg'],
    };

    const rdsConnectPolicy = new PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [
        `arn:aws:rds-db:${region}:${account}:dbuser:${props.aurora.cluster.clusterResourceIdentifier}/app_user`,
      ],
    });

    const tenantsListFn = new NodejsFunction(this, 'TenantsListFn', {
      entry: TENANTS_LIST_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      ...commonVpcConfig,
      environment: commonEnv,
      bundling: commonBundling,
    });
    tenantsListFn.addToRolePolicy(rdsConnectPolicy);

    const codefFetchFn = new NodejsFunction(this, 'CodefFetchFn', {
      entry: CODEF_FETCH_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(60),
      ...commonVpcConfig,
      environment: {
        ...commonEnv,
        CODEF_SECRET_ARN: codefSecret.secretArn,
        CLASSIFY_QUEUE_URL: classifyQueue.queueUrl,
      },
      bundling: commonBundling,
    });
    codefFetchFn.addToRolePolicy(rdsConnectPolicy);
    codefSecret.grantRead(codefFetchFn);
    classifyQueue.grantSendMessages(codefFetchFn);

    const classifyWorkerFn = new NodejsFunction(this, 'CodefClassifyWorkerFn', {
      entry: CLASSIFY_WORKER_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      ...commonVpcConfig,
      environment: {
        ...commonEnv,
        BEDROCK_MODEL_ID: BEDROCK_PROFILE_ID,
        TRANSACTION_CACHE_TABLE_NAME: props.transactionCache.tableName,
      },
      bundling: commonBundling,
    });
    classifyWorkerFn.addToRolePolicy(rdsConnectPolicy);
    classifyWorkerFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
        resources: [
          `arn:aws:bedrock:${region}:${account}:inference-profile/${BEDROCK_PROFILE_ID}`,
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
        ],
      }),
    );
    props.transactionCache.grantReadWriteData(classifyWorkerFn);

    classifyWorkerFn.addEventSource(
      new SqsEventSource(classifyQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );

    const fxCollectorFn = new NodejsFunction(this, 'FxCollectorFn', {
      entry: FX_COLLECTOR_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: {
        LOG_LEVEL: isProd ? 'info' : 'debug',
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    // --- Legal KB S3 bucket: stores raw OPEN_LAW responses + Bedrock KB chunk objects. ---
    const legalKbBucket = new Bucket(this, 'LegalKbBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
    });

    // --- Holiday yearly sync (KASI 특일정보) ---
    const holidaySyncFn = new NodejsFunction(this, 'HolidayYearlySyncFn', {
      entry: HOLIDAY_SYNC_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(60),
      ...commonVpcConfig,
      environment: {
        ...commonEnv,
        HOLIDAY_API_SERVICE_KEY: process.env.HOLIDAY_API_SERVICE_KEY ?? '',
      },
      bundling: commonBundling,
    });
    holidaySyncFn.addToRolePolicy(rdsConnectPolicy);

    // --- Monthly OPEN_LAW corpus sync — fetches latest revisions + uploads raw to LegalKbBucket ---
    const lawSyncFn = new NodejsFunction(this, 'MonthlyLawSyncFn', {
      entry: LAW_SYNC_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(5),
      ...commonVpcConfig,
      environment: {
        ...commonEnv,
        OPEN_LAW_OC: process.env.OPEN_LAW_OC ?? '',
        LEGAL_KB_BUCKET: legalKbBucket.bucketName,
      },
      bundling: commonBundling,
    });
    lawSyncFn.addToRolePolicy(rdsConnectPolicy);
    legalKbBucket.grantReadWrite(lawSyncFn);

    const listTenantsTask = new tasks.LambdaInvoke(this, 'ListTenantsTask', {
      lambdaFunction: tenantsListFn,
      payloadResponseOnly: true,
      resultPath: '$.listOut',
    });

    const fetchTenantTask = new tasks.LambdaInvoke(this, 'FetchTenantTask', {
      lambdaFunction: codefFetchFn,
      payload: sfn.TaskInput.fromObject({
        tenantId: sfn.JsonPath.stringAt('$.tenantId'),
      }),
      payloadResponseOnly: true,
    });

    const map = new sfn.Map(this, 'TenantFetchMap', {
      itemsPath: '$.listOut.tenantIds',
      maxConcurrency: 3,
      itemSelector: {
        tenantId: sfn.JsonPath.stringAt('$$.Map.Item.Value'),
      },
    });
    map.itemProcessor(fetchTenantTask);

    const definition = sfn.Chain.start(listTenantsTask).next(map);

    const stateMachine = new sfn.StateMachine(this, 'IngestionStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      tracingEnabled: true,
    });

    new CfnOutput(this, 'IngestionStateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'ARN of the CODEF ingestion Step Functions state machine. Used by run-codef-e2e.sh to trigger fetches.',
      exportName: `${id}-IngestionStateMachineArn`,
    });

    const vpcLambdaSuppressions = [
      {
        id: 'AwsSolutions-L1',
        reason: 'NODEJS_20_X is current LTS; Lambda 22 adoption deferred.',
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
        reason: 'rds-db:connect ARN is scoped to app_user on this cluster; wildcard suffix from CDK execution role.',
        appliesTo: ['Resource::*'],
      },
    ];

    for (const fn of [tenantsListFn, codefFetchFn, classifyWorkerFn, holidaySyncFn, lawSyncFn]) {
      NagSuppressions.addResourceSuppressions(fn, vpcLambdaSuppressions, true);
    }
    NagSuppressions.addResourceSuppressions(lawSyncFn, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CDK grantReadWrite on LegalKbBucket expands to scoped GetBucket*/GetObject*/List*/PutObject* actions on bucket ARN only.',
        appliesTo: [
          'Action::s3:GetBucket*',
          'Action::s3:GetObject*',
          'Action::s3:List*',
          'Action::s3:Abort*',
          'Action::s3:DeleteObject*',
          'Resource::<LegalKbBucketB3596809.Arn>/*',
        ],
      },
    ], true);
    NagSuppressions.addResourceSuppressions(legalKbBucket, [
      { id: 'AwsSolutions-S1', reason: 'Access logs deferred; bucket holds public 법제처 law texts (no PII).' },
    ]);

    NagSuppressions.addResourceSuppressions(
      fxCollectorFn,
      [
        {
          id: 'AwsSolutions-L1',
          reason: 'NODEJS_20_X is current LTS; Lambda 22 adoption deferred.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is required for managed logging per AWS Lambda baseline.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      classifyWorkerFn,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Bedrock inference profile resource includes foundation-model wildcard ARN as required by SDK routing.',
          appliesTo: ['Resource::arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'kms:ReEncrypt* and kms:GenerateDataKey* added by CDK grantReadWriteData for DynamoDB CMK; scoped to transactionCache key.',
          appliesTo: ['Action::kms:ReEncrypt*', 'Action::kms:GenerateDataKey*'],
        },
      ],
      true,
    );

    const stateMachinePolicy = stateMachine.role.node.tryFindChild('DefaultPolicy');
    if (stateMachinePolicy) {
      NagSuppressions.addResourceSuppressions(stateMachinePolicy, [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK-generated Step Functions execution policy includes scoped Lambda invoke statements with wildcard suffix segments.',
        },
      ]);
    }

    NagSuppressions.addResourceSuppressions(alarmTopic, [
      {
        id: 'AwsSolutions-SNS3',
        reason: 'Operational alarm topic uses default policy; HTTPS-only publishers enforced in Phase 1.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(stateMachine, [
      {
        id: 'AwsSolutions-SF1',
        reason: 'SFN CloudWatch Logs integration deferred to Slice 6 observability hardening.',
      },
    ]);

    new Rule(this, 'IngestionScheduleRule', {
      schedule: Schedule.rate(Duration.hours(6)),
    }).addTarget(new SfnStateMachine(stateMachine));

    new Rule(this, 'FxCollectScheduleRule', {
      schedule: Schedule.rate(Duration.hours(1)),
    }).addTarget(new LambdaFunction(fxCollectorFn));

    // --- ManualSyncStateMachine: single-tenant fetch invoked from POST /tenants/{id}/sync ---
    const manualFetchTask = new tasks.LambdaInvoke(this, 'ManualFetchTenant', {
      lambdaFunction: codefFetchFn,
      payload: sfn.TaskInput.fromObject({
        tenantId: sfn.JsonPath.stringAt('$.tenantId'),
      }),
      payloadResponseOnly: true,
    });
    const manualSyncSm = new sfn.StateMachine(this, 'ManualSyncStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(manualFetchTask),
      tracingEnabled: true,
    });
    this.manualSyncStateMachineArn = manualSyncSm.stateMachineArn;
    new CfnOutput(this, 'ManualSyncStateMachineArn', {
      value: manualSyncSm.stateMachineArn,
      description: 'ARN of the per-tenant manual sync Step Functions state machine. Wired into Journal Lambda env.',
      exportName: `${id}-ManualSyncStateMachineArn`,
    });

    // --- LegalSyncStateMachine: monthly 법제처 OPEN_LAW corpus sync orchestrator ---
    const lawSyncTask = new tasks.LambdaInvoke(this, 'MonthlyLawSyncInvoke', {
      lambdaFunction: lawSyncFn,
      payloadResponseOnly: true,
    });
    const legalSyncSm = new sfn.StateMachine(this, 'LegalSyncStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(lawSyncTask),
      tracingEnabled: true,
    });

    // --- HolidayYearlySyncRule: 매년 1월 1일 03:00 KST (UTC 18:00 Dec 31) — and an idempotent monthly top-up ---
    new Rule(this, 'HolidayYearlySyncRule', {
      schedule: Schedule.cron({ minute: '0', hour: '18', day: '31', month: 'DEC' }),
    }).addTarget(new LambdaFunction(holidaySyncFn));
    new Rule(this, 'HolidayMonthlyRefreshRule', {
      schedule: Schedule.cron({ minute: '0', hour: '18', day: '1' }),
    }).addTarget(new LambdaFunction(holidaySyncFn));
    this.legalSyncStateMachineArn = legalSyncSm.stateMachineArn;
    new CfnOutput(this, 'LegalSyncStateMachineArn', {
      value: legalSyncSm.stateMachineArn,
      description: 'ARN of the monthly legal-corpus sync state machine. Stub until Wave-5.',
      exportName: `${id}-LegalSyncStateMachineArn`,
    });

    new Rule(this, 'LegalSyncScheduleRule', {
      schedule: Schedule.cron({ minute: '0', hour: '18', day: '1' }),
    }).addTarget(new SfnStateMachine(legalSyncSm));

    NagSuppressions.addResourceSuppressions(
      manualSyncSm,
      [{ id: 'AwsSolutions-SF1', reason: 'SFN CloudWatch Logs integration deferred to Slice 6 observability hardening.' }],
    );
    NagSuppressions.addResourceSuppressions(
      legalSyncSm,
      [{ id: 'AwsSolutions-SF1', reason: 'SFN CloudWatch Logs integration deferred; stub state machine.' }],
    );
    for (const sm of [manualSyncSm, legalSyncSm]) {
      const policy = sm.role.node.tryFindChild('DefaultPolicy');
      if (policy) {
        NagSuppressions.addResourceSuppressions(policy, [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'CDK-generated Step Functions execution policy includes scoped Lambda invoke statements with wildcard suffix; xray + log-delivery actions require wildcard resources.',
          },
        ]);
      }
    }

    const dlqAlarm = new Alarm(this, 'ClassifyDlqDepthAlarm', {
      metric: classifyDlq.metricApproximateNumberOfMessagesVisible({
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(new SnsAction(alarmTopic));

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-SNS2',
        reason: 'Operational alarm topic encryption deferred to Phase 1 KMS subscription pattern.',
      },
    ]);
  }
}
