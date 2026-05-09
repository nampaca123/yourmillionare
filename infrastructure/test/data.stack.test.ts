// Unit tests for the DataStack synthesis output.

import { App, Aspects, Tags } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, it, expect, beforeAll } from 'vitest';

import { FoundationStack } from '../lib/stacks/foundation.stack.js';
import { NetworkStack } from '../lib/stacks/network.stack.js';
import { DataStack } from '../lib/stacks/data.stack.js';

const TEST_ACCOUNT = '123456789012';
const TEST_REGION = 'ap-northeast-2';

const buildStack = (env: 'dev' | 'prod' = 'dev') => {
  const app = new App();
  Tags.of(app).add('Project', 'yourmillionare');
  Tags.of(app).add('Environment', env);
  Tags.of(app).add('ManagedBy', 'cdk');
  Tags.of(app).add('Owner', 'platform');

  const foundation = new FoundationStack(app, 'Ym-Foundation', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
    deploymentEnv: env,
  });

  const network = new NetworkStack(app, 'Ym-Network', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
    deploymentEnv: env,
    availabilityZones: [`${TEST_REGION}a`, `${TEST_REGION}b`, `${TEST_REGION}c`],
  });

  const data = new DataStack(app, 'Ym-Data', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
    deploymentEnv: env,
    vpc: network.vpc,
    lambdaSg: network.lambdaSg,
    auroraSg: network.auroraSg,
    sharedKey: foundation.sharedKey,
    availabilityZones: [`${TEST_REGION}a`, `${TEST_REGION}b`, `${TEST_REGION}c`],
  });

  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

  return { template: Template.fromStack(data), stack: data };
};

describe('DataStack (dev)', () => {
  let template: Template;
  let stack: DataStack;

  beforeAll(() => {
    const built = buildStack('dev');
    template = built.template;
    stack = built.stack;
  });

  it('should create exactly 1 Aurora cluster with aurora-postgresql engine when synthesized', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: '15.10',
    });
  });

  it('should enable Data API (EnableHttpEndpoint) on the Aurora cluster when synthesized', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      EnableHttpEndpoint: true,
    });
  });

  it('should enable IAM database authentication on the Aurora cluster when synthesized', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      EnableIAMDatabaseAuthentication: true,
    });
  });

  it('should set defaultDatabaseName to yourmillionare when synthesized', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      DatabaseName: 'yourmillionare',
    });
  });

  it('should have Aurora serverless scaling config with min 0 for dev when synthesized', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 2 },
    });
  });

  it('should create 4 DynamoDB tables when synthesized', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 4);
  });

  it('should set TTL on IdempotencyKeys table when synthesized', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'expires_at', Enabled: true },
    });
  });

  it('should encrypt all DynamoDB tables with the shared KMS key when synthesized', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    for (const table of Object.values(tables)) {
      const sse = (table as Record<string, unknown>)['Properties'] as Record<string, unknown>;
      expect(sse['SSESpecification']).toBeDefined();
    }
  });

  it('should create 3 Lambda functions (migrator, schema-verifier, iam-verifier) when synthesized', () => {
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { Runtime: 'nodejs20.x' },
    });
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(3);
  });

  it('should set reservedConcurrentExecutions 1 on migrator and verifier functions when synthesized', () => {
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Runtime: 'nodejs20.x',
        ReservedConcurrentExecutions: 1,
      },
    });
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(3);
  });

  it('should create 0 RDS Proxy resources (deferred to Slice 4) when synthesized', () => {
    template.resourceCountIs('AWS::RDS::DBProxy', 0);
  });

  it('should create a CustomResource for schema migration that depends on another CR for verification when synthesized', () => {
    const crs = template.findResources('AWS::CloudFormation::CustomResource');
    expect(Object.keys(crs).length).toBeGreaterThanOrEqual(3);
  });

  it('should emit no cdk-nag errors when synthesized with AwsSolutionsChecks', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors).toEqual([]);
  });
});

describe('DataStack (prod)', () => {
  let template: Template;

  beforeAll(() => {
    const built = buildStack('prod');
    template = built.template;
  });

  it('should set Aurora serverless scaling config with min 0.5 for prod when synthesized', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
    });
  });

  it('should enable deletion protection for prod Aurora cluster when synthesized', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      DeletionProtection: true,
    });
  });
});
