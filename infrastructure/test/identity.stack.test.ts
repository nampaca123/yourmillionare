// Unit tests for the IdentityStack synthesis output.

import { App, Aspects, Tags } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, it, expect, beforeAll } from 'vitest';

import { IdentityStack } from '../lib/stacks/identity.stack.js';

const TEST_ACCOUNT = '123456789012';
const TEST_REGION = 'ap-northeast-2';

const buildStack = (env: 'dev' | 'prod' = 'dev') => {
  const app = new App();
  Tags.of(app).add('Project', 'yourmillionare');
  Tags.of(app).add('Environment', env);

  const stack = new IdentityStack(app, 'Ym-Identity', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
    deploymentEnv: env,
    googleClientId: 'test-google-client',
    googleClientSecret: 'test-google-secret',
    cognitoDomainPrefix: `yourmillionare-${env}-test`,
    callbackUrls: ['http://localhost:3000/callback'],
    logoutUrls: ['http://localhost:3000/'],
  });

  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

  return { template: Template.fromStack(stack), stack };
};

describe('IdentityStack (dev)', () => {
  let template: Template;
  let stack: IdentityStack;

  beforeAll(() => {
    const built = buildStack('dev');
    template = built.template;
    stack = built.stack;
  });

  it('should create exactly 1 UserPool when synthesized', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  it('should enforce minimum password length of 12 when synthesized', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 12,
          RequireUppercase: true,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        },
      },
    });
  });

  it('should set MFA to OFF for dev when synthesized', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'OFF',
    });
  });

  it('should create exactly 1 UserPoolClient when synthesized', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  });

  it('should configure UserPoolClient without a client secret when synthesized', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
    });
  });

  it('should emit no cdk-nag errors when synthesized with AwsSolutionsChecks', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors).toEqual([]);
  });
});

describe('IdentityStack (prod)', () => {
  let template: Template;

  beforeAll(() => {
    const built = buildStack('prod');
    template = built.template;
  });

  it('should set MFA to OPTIONAL for prod when synthesized', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'OPTIONAL',
    });
  });

  it('should set Advanced Security Mode to ENFORCED for prod when synthesized', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED' },
    });
  });
});
