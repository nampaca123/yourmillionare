// Foundation stack: shared KMS CMK and Secrets Manager slot for downstream stacks.

import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../config/env.config.js';

export interface FoundationStackProps extends StackProps {
  readonly deploymentEnv: DeploymentEnv;
}

export class FoundationStack extends Stack {
  public readonly sharedKey: Key;
  public readonly codefCredentialSecret: Secret;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    const isProd = props.deploymentEnv === 'prod';
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.sharedKey = new Key(this, 'SharedKey', {
      description: 'Shared CMK for envelope encryption across YourMillionare stacks.',
      enableKeyRotation: true,
      removalPolicy,
    });

    this.codefCredentialSecret = new Secret(this, 'CodefCredentialSecret', {
      description: 'CODEF API credentials and per-tenant Connected ID payloads. Inject value out-of-band.',
      encryptionKey: this.sharedKey,
      removalPolicy,
    });

    NagSuppressions.addResourceSuppressions(this.codefCredentialSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason:
          'CODEF credentials are externally issued OAuth client + per-user Connected IDs; AWS-managed automatic rotation is not applicable. Rotation happens via AgentCore Identity flow (90-day cycle) added in Phase 1.',
      },
    ]);

    new CfnOutput(this, 'SharedKeyArn', {
      value: this.sharedKey.keyArn,
      description: 'ARN of the shared KMS CMK reused by downstream stacks.',
      exportName: `${id}-SharedKeyArn`,
    });

    new CfnOutput(this, 'CodefCredentialSecretArn', {
      value: this.codefCredentialSecret.secretArn,
      description: 'ARN of the CODEF credential secret. Populate via AWS CLI before adapter deploys.',
      exportName: `${id}-CodefCredentialSecretArn`,
    });
  }
}
