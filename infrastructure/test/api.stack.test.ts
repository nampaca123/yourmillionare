// Unit tests for the ApiStack synthesis output.

import { App, Aspects, Tags } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, it, expect, beforeAll } from 'vitest';

import { FoundationStack } from '../lib/stacks/foundation.stack.js';
import { NetworkStack } from '../lib/stacks/network.stack.js';
import { DataStack } from '../lib/stacks/data.stack.js';
import { IdentityStack } from '../lib/stacks/identity.stack.js';
import { ApiStack } from '../lib/stacks/api.stack.js';

const TEST_ACCOUNT = '123456789012';
const TEST_REGION = 'ap-northeast-2';

const buildStack = (env: 'dev' | 'prod' = 'dev') => {
  const app = new App();
  Tags.of(app).add('Project', 'yourmillionare');
  Tags.of(app).add('Environment', env);

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

  const identity = new IdentityStack(app, 'Ym-Identity', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
    deploymentEnv: env,
    googleClientId: 'test-google-client',
    googleClientSecret: 'test-google-secret',
    cognitoDomainPrefix: `yourmillionare-${env}-test`,
    callbackUrls: ['http://localhost:3000/callback'],
    logoutUrls: ['http://localhost:3000/'],
  });

  const apiStack = new ApiStack(app, 'Ym-Api', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
    deploymentEnv: env,
    vpc: network.vpc,
    lambdaSg: network.lambdaSg,
    aurora: data.aurora,
    cache: data.cache,
    identity,
    sharedKey: foundation.sharedKey,
    codefSecret: foundation.codefCredentialSecret,
  });

  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

  return { template: Template.fromStack(apiStack), stack: apiStack };
};

describe('ApiStack (dev)', () => {
  let template: Template;
  let stack: ApiStack;

  beforeAll(() => {
    const built = buildStack('dev');
    template = built.template;
    stack = built.stack;
  });

  it('should create exactly 1 HttpApi when synthesized', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  it('should create exactly 1 JWT Authorizer when synthesized', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  });

  it('should create exactly 9 routes when synthesized', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 9);
  });

  it('should create 1 Lambda function for the identity handler when synthesized', () => {
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { Runtime: 'nodejs20.x' },
    });
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(1);
  });

  it('should configure Identity Lambda inside a VPC when synthesized', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
    });
  });

  it('should include rds-db:connect IAM policy on Identity Lambda when synthesized', () => {
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'rds-db:connect',
            }),
          ]),
        }),
      },
    });
    expect(Object.keys(policies).length).toBeGreaterThanOrEqual(1);
  });

  it('should emit no cdk-nag errors when synthesized with AwsSolutionsChecks', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors).toEqual([]);
  });

  it('should set journal stub classifier env to 1 for dev', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          JOURNAL_STUB_CLASSIFIER: '1',
        }),
      },
    });
  });
});

describe('ApiStack (prod)', () => {
  let template: Template;

  beforeAll(() => {
    template = buildStack('prod').template;
  });

  it('should set journal stub classifier env to 0 for prod', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          JOURNAL_STUB_CLASSIFIER: '0',
        }),
      },
    });
  });
});
