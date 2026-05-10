// Unit tests for the FoundationStack synthesis output.

import { App, Aspects, Tags } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, it, expect, beforeAll } from 'vitest';

import { FoundationStack } from '../lib/stacks/foundation.stack.js';

const TEST_ACCOUNT = '123456789012';
const TEST_REGION = 'ap-northeast-2';

const buildStack = (): { template: Template; stack: FoundationStack } => {
  const app = new App();
  Tags.of(app).add('Project', 'yourmillionare');
  Tags.of(app).add('Environment', 'dev');
  Tags.of(app).add('ManagedBy', 'cdk');
  Tags.of(app).add('Owner', 'platform');

  const stack = new FoundationStack(app, 'Ym-Dev-Foundation', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
    deploymentEnv: 'dev',
  });

  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

  return { template: Template.fromStack(stack), stack };
};

describe('FoundationStack', () => {
  let template: Template;
  let stack: FoundationStack;

  beforeAll(() => {
    const built = buildStack();
    template = built.template;
    stack = built.stack;
  });

  it('should provision exactly one KMS CMK with rotation enabled when synthesized', () => {
    template.resourceCountIs('AWS::KMS::Key', 1);

    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  it('should provision two Secrets Manager secrets (CODEF + ECOS) when synthesized', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
  });

  it('should expose the four common tags on every taggable resource when app-level tags are set', () => {
    const expectedTags = [
      { Key: 'Environment', Value: 'dev' },
      { Key: 'ManagedBy', Value: 'cdk' },
      { Key: 'Owner', Value: 'platform' },
      { Key: 'Project', Value: 'yourmillionare' },
    ];

    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Tags: Match.arrayWith(expectedTags),
    });
  });

  it('should emit no cdk-nag errors when synthesized with AwsSolutionsChecks', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));

    expect(errors).toEqual([]);
  });
});
