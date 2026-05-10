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
  public readonly ecosCredentialSecret: Secret;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    const isProd = props.deploymentEnv === 'prod';
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.sharedKey = new Key(this, 'SharedKey', {
      description: 'CMK for cross-stack secrets that do not require key-policy mutation (CODEF Secret, DynamoDB).',
      enableKeyRotation: true,
      removalPolicy,
    });

    // Encryption left to AWS-managed `aws/secretsmanager` key on purpose: keeps the secret
    // grantable from downstream stacks (Api Lambda) without cross-stack KMS key-policy edges
    // that produce dependency cycles between Foundation/Data/Api.
    this.codefCredentialSecret = new Secret(this, 'CodefCredentialSecret', {
      description: 'CODEF API credentials. Inject value out-of-band via scripts/sync-secrets-from-env.sh.',
      removalPolicy,
    });

    this.ecosCredentialSecret = new Secret(this, 'EcosCredentialSecret', {
      description: 'ECOS REST API credentials for FX rate ingestion. Inject value out-of-band.',
      removalPolicy,
    });

    NagSuppressions.addResourceSuppressions(this.codefCredentialSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason:
          'CODEF credentials are externally issued OAuth client + per-user Connected IDs; AWS-managed automatic rotation is not applicable. Rotation happens via AgentCore Identity flow (90-day cycle) added in Phase 1.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(this.ecosCredentialSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason:
          'ECOS API credentials are externally issued; AWS-managed automatic rotation is not applicable until Phase 1 credential broker.',
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

    new CfnOutput(this, 'EcosCredentialSecretArn', {
      value: this.ecosCredentialSecret.secretArn,
      description: 'ARN of the ECOS credential secret for FX collector Lambdas.',
      exportName: `${id}-EcosCredentialSecretArn`,
    });
  }
}
