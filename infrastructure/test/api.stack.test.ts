// Unit tests for the ApiStack synthesis output.

import { App, Aspects, Tags } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { FoundationStack } from '../lib/stacks/foundation.stack.js';
import { NetworkStack } from '../lib/stacks/network.stack.js';
import { DataStack } from '../lib/stacks/data.stack.js';
import { IdentityStack } from '../lib/stacks/identity.stack.js';
import { ApiStack } from '../lib/stacks/api.stack.js';

const TEST_ACCOUNT = '123456789012';
const TEST_REGION = 'ap-northeast-2';
const ORIGINAL_CORS_ENV = process.env.API_CORS_ALLOWED_ORIGINS;

const buildStack = (env: 'dev' | 'prod' = 'dev') => {
  process.env.API_CORS_ALLOWED_ORIGINS = 'http://localhost:3000,https://dashboard.example.com';
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
    proxySg: network.proxySg,
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
    ecosSecret: foundation.ecosCredentialSecret,
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

  it('should create exactly 55 routes when synthesized (43 explicit + 12 catch-all = 6 verbs x 2 paths /, /{proxy+})', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 55);
  });

  it('should attach not-found integration on non-OPTIONS verbs only so corsPreflight stays in charge of OPTIONS', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /{proxy+}',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /{proxy+}',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /',
    });
  });

  it('should NOT register an OPTIONS catch-all route (would shadow corsPreflight)', () => {
    const routes = template.findResources('AWS::ApiGatewayV2::Route', {
      Properties: { RouteKey: 'OPTIONS /{proxy+}' },
    });
    expect(Object.keys(routes).length).toBe(0);
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

  it('should grant rds-db:connect on both cluster and proxy resource IDs', () => {
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({ Action: 'rds-db:connect' }),
          ]),
        }),
      },
    });
    expect(Object.keys(policies).length).toBe(8);
    for (const policy of Object.values(policies)) {
      const stmt = (policy as { Properties: { PolicyDocument: { Statement: Array<{ Action: string; Resource: unknown[] }> } } })
        .Properties.PolicyDocument.Statement.find((s) => s.Action === 'rds-db:connect');
      expect(stmt?.Resource).toHaveLength(2);
    }
  });

  it('should emit no cdk-nag errors when synthesized with AwsSolutionsChecks', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors).toEqual([]);
  });

  it('should not set JOURNAL_STUB_CLASSIFIER on Journal Lambda in dev (Bedrock used everywhere)', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(fns)) {
      const vars = (fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }).Properties?.Environment?.Variables ?? {};
      expect(vars).not.toHaveProperty('JOURNAL_STUB_CLASSIFIER');
    }
  });

});

describe('ApiStack (prod)', () => {
  let template: Template;

  beforeAll(() => {
    template = buildStack('prod').template;
  });

  afterAll(() => {
    if (ORIGINAL_CORS_ENV === undefined) delete process.env.API_CORS_ALLOWED_ORIGINS;
    else process.env.API_CORS_ALLOWED_ORIGINS = ORIGINAL_CORS_ENV;
  });

  it('should not set JOURNAL_STUB_CLASSIFIER on Journal Lambda in prod', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(fns)) {
      const vars = (fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }).Properties?.Environment?.Variables ?? {};
      expect(vars).not.toHaveProperty('JOURNAL_STUB_CLASSIFIER');
    }
  });
});
