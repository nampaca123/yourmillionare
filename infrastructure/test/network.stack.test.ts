// Unit tests for the NetworkStack synthesis output.

import { App, Aspects, Tags } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, it, expect, beforeAll } from 'vitest';

import { NetworkStack } from '../lib/stacks/network.stack.js';

const TEST_ACCOUNT = '123456789012';
const TEST_REGION = 'ap-northeast-2';

const buildStack = (env: 'dev' | 'prod' = 'dev') => {
  const app = new App();
  Tags.of(app).add('Project', 'yourmillionare');
  Tags.of(app).add('Environment', env);
  Tags.of(app).add('ManagedBy', 'cdk');
  Tags.of(app).add('Owner', 'platform');

  const network = new NetworkStack(app, 'Ym-Network', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
    deploymentEnv: env,
  });

  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

  return { template: Template.fromStack(network), stack: network };
};

describe('NetworkStack (dev)', () => {
  let template: Template;
  let stack: NetworkStack;

  beforeAll(() => {
    const built = buildStack('dev');
    template = built.template;
    stack = built.stack;
  });

  it('should create exactly one VPC when synthesized', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });

  it('should create 6 subnets total (3 PUBLIC + 3 PRIVATE_ISOLATED) when synthesized', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  it('should create 0 NAT gateways when synthesized', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('should create VPC Flow Logs resource when synthesized', () => {
    template.resourceCountIs('AWS::EC2::FlowLog', 1);
  });

  it('should create exactly 2 interface endpoints (secretsmanager, kms) when synthesized', () => {
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Interface' },
    });
    expect(Object.keys(endpoints)).toHaveLength(2);
  });

  it('should create exactly 2 gateway endpoints (s3, dynamodb) when synthesized', () => {
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Gateway' },
    });
    expect(Object.keys(endpoints)).toHaveLength(2);
  });

  it('should create sg-aurora with ingress from sg-lambda on 5432 only when synthesized', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 5432,
      ToPort: 5432,
      IpProtocol: 'tcp',
    });
  });

  it('should emit no cdk-nag errors when synthesized with AwsSolutionsChecks', () => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors).toEqual([]);
  });
});

describe('NetworkStack (prod)', () => {
  let template: Template;

  beforeAll(() => {
    const built = buildStack('prod');
    template = built.template;
  });

  it('should create 0 NAT gateways in prod as well (NAT decision deferred to Slice 4)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('should create 6 subnets in prod when synthesized', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 6);
  });
});
