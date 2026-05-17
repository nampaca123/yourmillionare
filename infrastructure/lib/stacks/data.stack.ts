// Data stack: Aurora Serverless v2, DynamoDB tables, schema migrator, and verifier custom resources.

import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { CfnOutput, CustomResource, Duration, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { HostedRotation, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { NagSuppressions } from 'cdk-nag';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../config/env.config.js';
import { AuroraConstruct } from './data/aurora.construct.js';
import { CacheConstruct } from './data/cache.construct.js';

export interface DataStackProps extends StackProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly vpc: IVpc;
  readonly lambdaSg: ISecurityGroup;
  readonly auroraSg: ISecurityGroup;
  readonly proxySg: ISecurityGroup;
  readonly sharedKey: IKey;
  readonly availabilityZones: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const AURORA_PORT = 5432;
const SCHEMA_PATH = join(__dirname, '../../../schema.sql');
const BOOTSTRAP_PATH = join(__dirname, 'data/sql/db-bootstrap.sql');
const MIGRATIONS_DIR = join(__dirname, 'data/sql/migrations');
const LAMBDA_ENTRY = (file: string) => join(__dirname, `data/${file}`);

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function migrationsSha256(): string {
  let files: string[] = [];
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return 'no-migrations';
  }
  const combined = files.map((f) => `${f}:${sha256(readFileSync(join(MIGRATIONS_DIR, f)))}`).join('|');
  return createHash('sha256').update(combined).digest('hex');
}

export class DataStack extends Stack {
  public readonly aurora: AuroraConstruct;
  public readonly cache: CacheConstruct;
  public readonly bedrockKbDbSecret: ISecret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const isProd = props.deploymentEnv === 'prod';
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // --- Aurora ---
    this.aurora = new AuroraConstruct(this, 'AuroraCluster', {
      deploymentEnv: props.deploymentEnv,
      vpc: props.vpc,
      auroraSg: props.auroraSg,
      proxySg: props.proxySg,
    });

    const aurora = this.aurora;

    // --- DynamoDB tables ---
    this.cache = new CacheConstruct(this, 'Cache', {
      deploymentEnv: props.deploymentEnv,
      sharedKey: props.sharedKey,
    });

    if (!isProd) {
      const ddb3Suppression = [
        {
          id: 'AwsSolutions-DDB3',
          reason: 'Cache tables disable PITR in dev for cost savings; cache data is ephemeral and can be regenerated from Aurora.',
        },
      ];
      NagSuppressions.addResourceSuppressions(this.cache.monthlySummaryCache, ddb3Suppression);
      NagSuppressions.addResourceSuppressions(this.cache.transactionCache, ddb3Suppression);
      NagSuppressions.addResourceSuppressions(this.cache.idempotencyKeys, ddb3Suppression);
      NagSuppressions.addResourceSuppressions(this.cache.costCounter, ddb3Suppression);
    }

    // --- Master secret rotation (30-day cycle) ---
    // Rotation Lambda uses PRIVATE_ISOLATED (no internet needed: SM + KMS endpoints exist).
    // securityGroups: [lambdaSg] ensures auroraSg ingress rules already allow it on 5432.
    // azs[0] fixed so the Lambda always hits the same SM/KMS endpoint ENI in dev (1 AZ).
    const azs = props.availabilityZones;
    aurora.masterSecret.addRotationSchedule('Rotate', {
      hostedRotation: HostedRotation.postgreSqlSingleUser({
        vpc: props.vpc,
        vpcSubnets: { availabilityZones: [azs[0]], subnetType: SubnetType.PRIVATE_ISOLATED },
        securityGroups: [props.lambdaSg],
        // Explicit short name to stay within Lambda's 64-char function name limit
        functionName: `${this.stackName}-AuroraRotation`,
      }),
      automaticallyAfter: Duration.days(30),
    });

    // --- Schema migrator Lambda (no VPC, Data API) ---
    const schemaSha256 = sha256(readFileSync(SCHEMA_PATH));
    const bootstrapSha256 = sha256(readFileSync(BOOTSTRAP_PATH));
    const migrationsHash = migrationsSha256();

    const migratorFn = new NodejsFunction(this, 'SchemaMigratorFn', {
      entry: LAMBDA_ENTRY('schema-migrator.lambda.ts'),
      runtime: Runtime.NODEJS_20_X,
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 512,
      reservedConcurrentExecutions: 1,
      environment: {
        CLUSTER_ARN: aurora.cluster.clusterArn,
        SECRET_ARN: aurora.masterSecret.secretArn,
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        commandHooks: {
          afterBundling: (_inputDir: string, outputDir: string) => [
            `cp "${SCHEMA_PATH}" "${outputDir}/schema.sql"`,
            `cp "${BOOTSTRAP_PATH}" "${outputDir}/db-bootstrap.sql"`,
            `cp -R "${join(__dirname, 'data/sql/migrations')}" "${outputDir}/migrations"`,
          ],
          beforeBundling: () => [],
          beforeInstall: () => [],
        },
      },
    });

    aurora.cluster.grantDataApiAccess(migratorFn);
    aurora.masterSecret.grantRead(migratorFn);
    migratorFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [props.sharedKey.keyArn],
      }),
    );

    const migratorProvider = new Provider(this, 'SchemaMigratorProvider', {
      onEventHandler: migratorFn,
    });
    // migrationsSha256 in properties ensures the CR re-runs when any migration file changes.
    // The Custom Resource is triggered by properties hash changes — asset hash alone is not enough.
    const migrationCR = new CustomResource(this, 'SchemaMigration', {
      serviceToken: migratorProvider.serviceToken,
      properties: { schemaSha256, bootstrapSha256, migrationsSha256: migrationsHash },
    });
    // Data API requires at least one running DB instance. The cluster resource is created
    // before the writer instance, so we must explicitly wait for the writer.
    const writerInstance = aurora.cluster.node.findChild('writer');
    migrationCR.node.addDependency(writerInstance);

    // --- Bedrock KB scoped DB secret + password binder ---
    const KB_SECRET_PASSWORD_LENGTH = 32;

    const kbDbSecret = new Secret(this, 'BedrockKbDbSecret', {
      secretName: `${this.stackName}-bedrock-kb-db-credentials`,
      encryptionKey: props.sharedKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'bedrock_kb_user',
          dbname: 'yourmillionare',
          host: aurora.cluster.clusterEndpoint.hostname,
          port: AURORA_PORT,
          engine: 'postgres',
          dbClusterIdentifier: aurora.cluster.clusterIdentifier,
        }),
        generateStringKey: 'password',
        passwordLength: KB_SECRET_PASSWORD_LENGTH,
        excludePunctuation: true,
      },
    });
    this.bedrockKbDbSecret = kbDbSecret;

    const kbPasswordBinderFn = new NodejsFunction(this, 'KbPasswordBinderFn', {
      entry: LAMBDA_ENTRY('kb-password-binder.lambda.ts'),
      runtime: Runtime.NODEJS_20_X,
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 256,
      reservedConcurrentExecutions: 1,
      environment: {
        CLUSTER_ARN: aurora.cluster.clusterArn,
        MASTER_SECRET_ARN: aurora.masterSecret.secretArn,
        KB_SECRET_ARN: kbDbSecret.secretArn,
        DATABASE_NAME: 'yourmillionare',
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    aurora.cluster.grantDataApiAccess(kbPasswordBinderFn);
    aurora.masterSecret.grantRead(kbPasswordBinderFn);
    kbDbSecret.grantRead(kbPasswordBinderFn);
    kbPasswordBinderFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [props.sharedKey.keyArn],
      }),
    );

    const kbPasswordBinderProvider = new Provider(this, 'KbPasswordBinderProvider', {
      onEventHandler: kbPasswordBinderFn,
    });
    const kbPasswordBinderCR = new CustomResource(this, 'KbPasswordBinder', {
      serviceToken: kbPasswordBinderProvider.serviceToken,
      properties: { secretArn: kbDbSecret.secretArn },
    });
    kbPasswordBinderCR.node.addDependency(migrationCR);

    // --- Verifier: schema check (no VPC, Data API) ---
    const verifierSchemaFn = new NodejsFunction(this, 'VerifierSchemaFn', {
      entry: LAMBDA_ENTRY('verifier-schema.lambda.ts'),
      runtime: Runtime.NODEJS_20_X,
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 256,
      reservedConcurrentExecutions: 1,
      environment: {
        CLUSTER_ARN: aurora.cluster.clusterArn,
        SECRET_ARN: aurora.masterSecret.secretArn,
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    aurora.cluster.grantDataApiAccess(verifierSchemaFn);
    aurora.masterSecret.grantRead(verifierSchemaFn);

    const verifierSchemaProvider = new Provider(this, 'VerifierSchemaProvider', {
      onEventHandler: verifierSchemaFn,
    });
    const verifierSchemaCR = new CustomResource(this, 'VerifierSchema', {
      serviceToken: verifierSchemaProvider.serviceToken,
      properties: { schemaSha256 },
    });
    verifierSchemaCR.node.addDependency(migrationCR);

    // --- Verifier: IAM token rehearsal (in VPC, sg-lambda) ---
    const verifierIamFn = new NodejsFunction(this, 'VerifierIamFn', {
      entry: LAMBDA_ENTRY('verifier-iam.lambda.ts'),
      runtime: Runtime.NODEJS_20_X,
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 256,
      reservedConcurrentExecutions: 1,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        CLUSTER_ENDPOINT: aurora.cluster.clusterEndpoint.hostname,
        CLUSTER_ARN: aurora.cluster.clusterArn,
        SECRET_ARN: aurora.masterSecret.secretArn,
        CLUSTER_PORT: String(AURORA_PORT),
        DATABASE_NAME: 'yourmillionare',
        APP_REGION: region,
      },
      bundling: {
        externalModules: ['@aws-sdk/*', 'pg-native'],
        nodeModules: ['pg'],
      },
    });

    verifierIamFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['rds-db:connect'],
        resources: [
          `arn:aws:rds-db:${region}:${account}:dbuser:${aurora.cluster.clusterResourceIdentifier}/app_user`,
        ],
      }),
    );
    aurora.cluster.grantDataApiAccess(verifierIamFn);
    aurora.masterSecret.grantRead(verifierIamFn);

    const verifierIamProvider = new Provider(this, 'VerifierIamProvider', {
      onEventHandler: verifierIamFn,
    });
    const verifierIamCR = new CustomResource(this, 'VerifierIam', {
      serviceToken: verifierIamProvider.serviceToken,
      properties: { schemaSha256 },
    });
    verifierIamCR.node.addDependency(verifierSchemaCR);

    // --- cdk-nag suppressions ---

    // Custom Lambda functions
    for (const fn of [migratorFn, verifierSchemaFn, kbPasswordBinderFn]) {
      NagSuppressions.addResourceSuppressions(
        fn,
        [
          {
            id: 'AwsSolutions-L1',
            reason: 'NODEJS_20_X is the current LTS; 22_X adoption deferred to Slice 3 along with runtime library updates.',
          },
          {
            id: 'AwsSolutions-IAM4',
            reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs.',
            appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'grantDataApiAccess and Secrets Manager read grant use wildcard resource; scope constrained to this cluster and secret.',
            appliesTo: ['Resource::*'],
          },
        ],
        true,
      );
    }
    NagSuppressions.addResourceSuppressions(
      verifierIamFn,
      [
        {
          id: 'AwsSolutions-L1',
          reason: 'NODEJS_20_X is the current LTS; 22_X adoption deferred to Slice 3.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaVPCAccessExecutionRole is required for VPC-attached Lambda; AWSLambdaBasicExecutionRole for CloudWatch Logs.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard ARN in Lambda execution role from VPC access.',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );

    // CDK-generated Provider framework Lambdas
    for (const provider of [migratorProvider, verifierSchemaProvider, verifierIamProvider, kbPasswordBinderProvider]) {
      NagSuppressions.addResourceSuppressions(
        provider,
        [
          {
            id: 'AwsSolutions-L1',
            reason: 'CDK Provider framework Lambda runtime is managed by CDK.',
          },
          {
            id: 'AwsSolutions-IAM4',
            reason: 'CDK Provider framework Lambda uses managed execution role; not customer-controlled.',
            appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
          },
          {
            id: 'AwsSolutions-IAM5',
            reason: 'CDK Provider framework uses wildcard log group ARN; not customer-controlled.',
            appliesTo: ['Resource::*'],
          },
        ],
        true,
      );
    }

    // CDK-generated log-retention Lambda and Provider framework-onEvent Lambdas.
    // addResourceSuppressions with applyToChildren does not always reach 4+ levels deep;
    // use addResourceSuppressionsByPath with deterministic paths to cover them.
    const frameworkIam5Paths = [
      `/${this.stackName}/SchemaMigratorProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
      `/${this.stackName}/VerifierSchemaProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
      `/${this.stackName}/VerifierIamProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
      `/${this.stackName}/KbPasswordBinderProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
    ];
    for (const path of frameworkIam5Paths) {
      NagSuppressions.addResourceSuppressionsByPath(this, path, [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK Provider framework-onEvent Lambda uses wildcard invoke permissions on its handler; not customer-controlled.',
          appliesTo: [{ regex: '/^Resource::.*$/' }],
        },
      ]);
    }

    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CDK-generated log retention Lambda uses managed execution role; not customer-controlled.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK-generated log retention Lambda uses wildcard log group ARN; not customer-controlled.',
          appliesTo: ['Resource::*'],
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'CDK-generated log retention Lambda runtime managed by CDK; NODEJS_20_X used for customer Lambdas.',
        },
      ],
    );

    if (!isProd) {
      NagSuppressions.addResourceSuppressions(
        aurora.cluster,
        [
          {
            id: 'AwsSolutions-RDS10',
            reason: 'Deletion protection disabled in dev to allow full stack teardown without manual steps.',
          },
        ],
        true,
      );
    }

    // HostedRotation Lambda suppressions (AWS-managed, not customer-controlled).
    // Using stack-level suppression since CDK generates paths for HostedRotation that
    // vary by CDK version and cannot be reliably referenced by path.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-L1',
        reason: 'HostedRotation Lambda runtime is managed by AWS; NODEJS_20_X used for customer Lambdas.',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'HostedRotation Lambda uses AWS-managed execution roles; not customer-controlled.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'HostedRotation and CDK Provider framework Lambdas use wildcard resources; not customer-controlled.',
        appliesTo: ['Resource::*'],
      },
    ]);

    // --- RDS Proxy alarms ---
    const dataAlarmTopic = new Topic(this, 'DataAlarmTopic', {
      topicName: `${this.stackName}-DataAlarmTopic`,
      masterKey: props.sharedKey,
    });

    const proxyDims = { DBProxyName: aurora.proxy.dbProxyName ?? '' };

    new Alarm(this, 'ProxyBorrowLatencyAlarm', {
      alarmName: `${this.stackName}-ProxyBorrowLatency-p99-50ms`,
      metric: new Metric({
        namespace: 'AWS/RDS',
        metricName: 'ConnectionBorrowLatency',
        statistic: 'p99',
        period: Duration.minutes(5),
        dimensionsMap: proxyDims,
      }),
      threshold: 50,
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(dataAlarmTopic));

    const maxConnectionsAlarmThreshold = isProd ? 700 : 350;
    new Alarm(this, 'ProxyDatabaseConnectionsAlarm', {
      alarmName: `${this.stackName}-ProxyDatabaseConnections-80pct`,
      metric: new Metric({
        namespace: 'AWS/RDS',
        metricName: 'DatabaseConnections',
        statistic: 'Maximum',
        period: Duration.minutes(5),
        dimensionsMap: proxyDims,
      }),
      threshold: maxConnectionsAlarmThreshold,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(dataAlarmTopic));

    const clientConnectionsAlarmThreshold = isProd ? 200 : 50;
    new Alarm(this, 'ProxyClientConnectionsAlarm', {
      alarmName: `${this.stackName}-ProxyClientConnections-spike`,
      metric: new Metric({
        namespace: 'AWS/RDS',
        metricName: 'ClientConnectionsBorrowingFromProxy',
        statistic: 'Average',
        period: Duration.minutes(5),
        dimensionsMap: proxyDims,
      }),
      threshold: clientConnectionsAlarmThreshold,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(dataAlarmTopic));

    // --- Outputs ---
    new CfnOutput(this, 'AuroraClusterArn', { value: aurora.cluster.clusterArn, exportName: `${id}-AuroraClusterArn` });
    new CfnOutput(this, 'AuroraEndpoint', { value: aurora.cluster.clusterEndpoint.hostname, exportName: `${id}-AuroraEndpoint` });
    new CfnOutput(this, 'AuroraSecretArn', { value: aurora.masterSecret.secretArn, exportName: `${id}-AuroraSecretArn` });
    new CfnOutput(this, 'BedrockKbDbSecretArn', { value: kbDbSecret.secretArn, exportName: `${id}-BedrockKbDbSecretArn` });
    new CfnOutput(this, 'MonthlySummaryCacheArn', { value: this.cache.monthlySummaryCache.tableArn });
    new CfnOutput(this, 'TransactionCacheArn', { value: this.cache.transactionCache.tableArn });
    new CfnOutput(this, 'IdempotencyKeysArn', { value: this.cache.idempotencyKeys.tableArn });
    new CfnOutput(this, 'CostCounterArn', { value: this.cache.costCounter.tableArn });
    new CfnOutput(this, 'DataAlarmTopicArn', { value: dataAlarmTopic.topicArn });
    new CfnOutput(this, 'ProxyEndpoint', { value: aurora.proxy.attrEndpoint });
  }
}
