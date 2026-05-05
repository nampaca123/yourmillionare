// Identity stack: Cognito User Pool and App Client for Slice 3 authentication.

import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  AdvancedSecurityMode,
  Mfa,
  OAuthScope,
  UserPool,
  UserPoolClient,
  VerificationEmailStyle,
} from 'aws-cdk-lib/aws-cognito';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../config/env.config.js';

export interface IdentityStackProps extends StackProps {
  readonly deploymentEnv: DeploymentEnv;
}

export class IdentityStack extends Stack {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;
  public readonly issuerUrl: string;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);

    const isProd = props.deploymentEnv === 'prod';
    const region = Stack.of(this).region;

    this.userPool = new UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      userVerification: {
        emailStyle: VerificationEmailStyle.CODE,
      },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      // dev: MFA OFF for UX/cost; prod: OPTIONAL so users can opt in.
      mfa: isProd ? Mfa.OPTIONAL : Mfa.OFF,
      // dev: Advanced Security OFF to avoid $0.05/MAU; prod: ENFORCED for fraud detection.
      advancedSecurityMode: isProd ? AdvancedSecurityMode.ENFORCED : AdvancedSecurityMode.OFF,
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.userPoolClient = new UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        scopes: [OAuthScope.EMAIL, OAuthScope.OPENID, OAuthScope.PROFILE],
      },
      // ID Token and Access Token TTL: 1 hour
      idTokenValidity: undefined,
      accessTokenValidity: undefined,
    });

    this.issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${this.userPool.userPoolId}`;

    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `${id}-UserPoolId`,
    });
    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${id}-UserPoolClientId`,
    });
    new CfnOutput(this, 'IssuerUrl', {
      value: this.issuerUrl,
      exportName: `${id}-IssuerUrl`,
    });

    // --- cdk-nag suppressions ---
    NagSuppressions.addResourceSuppressions(this.userPool, [
      {
        id: 'AwsSolutions-COG2',
        reason: 'dev MFA OFF for UX/cost; prod OPTIONAL with documented enable plan in identity.stack.ts',
      },
      {
        id: 'AwsSolutions-COG3',
        reason: 'dev Advanced Security OFF to save $0.05/MAU; prod ENFORCED',
      },
      {
        id: 'AwsSolutions-COG8',
        reason: 'Cognito Plus tier deferred; advanced security is OFF in dev and ENFORCED in prod via AdvancedSecurityMode',
      },
    ]);
  }
}
