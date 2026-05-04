// Data stack: Aurora Serverless v2, DynamoDB tables, schema migrator, and verifier custom resources.

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { CfnOutput, CustomResource, Duration, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
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
  readonly sharedKey: IKey;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '../../../schema.sql');
const BOOTSTRAP_PATH = join(__dirname, 'data/sql/db-bootstrap.sql');
const LAMBDA_ENTRY = (file: string) => join(__dirname, `data/${file}`);

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export class DataStack extends Stack {
  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const isProd = props.deploymentEnv === 'prod';
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // --- Aurora ---
    const aurora = new AuroraConstruct(this, 'AuroraCluster', {
      deploymentEnv: props.deploymentEnv,
      vpc: props.vpc,
      auroraSg: props.auroraSg,
    });

    // --- DynamoDB tables ---
    const cache = new CacheConstruct(this, 'Cache', {
      deploymentEnv: props.deploymentEnv,
      sharedKey: props.sharedKey,
    });

    // --- Schema migrator Lambda (no VPC, Data API) ---
    const schemaSha256 = sha256(readFileSync(SCHEMA_PATH));
    const bootstrapSha256 = sha256(readFileSync(BOOTSTRAP_PATH));

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
    const migrationCR = new CustomResource(this, 'SchemaMigration', {
      serviceToken: migratorProvider.serviceToken,
      properties: { schemaSha256, bootstrapSha256 },
    });
    // Data API requires at least one running DB instance. The cluster resource is created
    // before the writer instance, so we must explicitly wait for the writer.
    const writerInstance = aurora.cluster.node.findChild('writer');
    migrationCR.node.addDependency(writerInstance);

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
        CLUSTER_PORT: '5432',
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
    for (const fn of [migratorFn, verifierSchemaFn]) {
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
    for (const provider of [migratorProvider, verifierSchemaProvider, verifierIamProvider]) {
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

    // --- Outputs ---
    new CfnOutput(this, 'AuroraClusterArn', { value: aurora.cluster.clusterArn, exportName: `${id}-AuroraClusterArn` });
    new CfnOutput(this, 'AuroraEndpoint', { value: aurora.cluster.clusterEndpoint.hostname, exportName: `${id}-AuroraEndpoint` });
    new CfnOutput(this, 'AuroraSecretArn', { value: aurora.masterSecret.secretArn, exportName: `${id}-AuroraSecretArn` });
    new CfnOutput(this, 'MonthlySummaryCacheArn', { value: cache.monthlySummaryCache.tableArn });
    new CfnOutput(this, 'TransactionCacheArn', { value: cache.transactionCache.tableArn });
    new CfnOutput(this, 'IdempotencyKeysArn', { value: cache.idempotencyKeys.tableArn });
    new CfnOutput(this, 'CostCounterArn', { value: cache.costCounter.tableArn });
  }
}
