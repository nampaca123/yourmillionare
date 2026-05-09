// Ingestion stack: CODEF EDA skeleton — SQS classify queue, Step Functions tenant fan-out, Scheduler ticks, FX collector stub.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { Duration, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction, SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../config/env.config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TENANTS_LIST_ENTRY = join(__dirname, '../../../apps/codef/src/infrastructure/inbound/http/tenants-list.lambda.ts');
const CODEF_FETCH_ENTRY = join(__dirname, '../../../apps/codef/src/infrastructure/inbound/http/codef-fetch.lambda.ts');
const CLASSIFY_WORKER_ENTRY = join(__dirname, '../../../apps/codef/src/infrastructure/inbound/http/codef-classify-worker.lambda.ts');
const FX_COLLECTOR_ENTRY = join(__dirname, '../../../apps/fx/src/infrastructure/inbound/fx-collector.lambda.ts');

export interface IngestionStackProps extends StackProps {
  readonly deploymentEnv: DeploymentEnv;
}

export class IngestionStack extends Stack {
  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);

    const isProd = props.deploymentEnv === 'prod';

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

    const tenantsListFn = new NodejsFunction(this, 'TenantsListFn', {
      entry: TENANTS_LIST_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        LOG_LEVEL: isProd ? 'info' : 'debug',
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    const codefFetchFn = new NodejsFunction(this, 'CodefFetchFn', {
      entry: CODEF_FETCH_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(60),
      environment: {
        CODEF_MODE: 'mock',
        SYSTEM_USER_UUID: '00000000-0000-0000-0000-000000000001',
        LOG_LEVEL: isProd ? 'info' : 'debug',
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    const classifyWorkerFn = new NodejsFunction(this, 'CodefClassifyWorkerFn', {
      entry: CLASSIFY_WORKER_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 5,
      environment: {
        SYSTEM_USER_UUID: '00000000-0000-0000-0000-000000000001',
        LOG_LEVEL: isProd ? 'info' : 'debug',
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

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

    const listTenantsTask = new tasks.LambdaInvoke(this, 'ListTenantsTask', {
      lambdaFunction: tenantsListFn,
      payloadResponseOnly: true,
      resultPath: '$.listOut',
    });

    const fetchTenantTask = new tasks.LambdaInvoke(this, 'FetchTenantTask', {
      lambdaFunction: codefFetchFn,
      payload: sfn.TaskInput.fromObject({
        tenantId: sfn.JsonPath.stringAt('$$.Map.Item.Value'),
      }),
      payloadResponseOnly: true,
    });

    const map = new sfn.Map(this, 'TenantFetchMap', {
      itemsPath: '$.listOut.tenantIds',
      maxConcurrency: 3,
    });
    map.iterator(fetchTenantTask);

    const definition = sfn.Chain.start(listTenantsTask).next(map);

    const stateMachine = new sfn.StateMachine(this, 'IngestionStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      tracingEnabled: true,
    });

    const lambdaExecutionSuppressions = [
      {
        id: 'AwsSolutions-L1',
        reason: 'NODEJS_20_X is current LTS; Lambda 22 adoption deferred.',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is required for managed logging per AWS Lambda baseline.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
    ] as const;

    for (const fn of [tenantsListFn, codefFetchFn, classifyWorkerFn, fxCollectorFn]) {
      NagSuppressions.addResourceSuppressions(fn, [...lambdaExecutionSuppressions], true);
    }

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
