// Identity stack: Cognito User Pool, Google IdP, App Client, and Hosted UI domain.

import { CfnOutput, RemovalPolicy, SecretValue, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  AdvancedSecurityMode,
  Mfa,
  OAuthScope,
  ProviderAttribute,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolIdentityProviderGoogle,
  VerificationEmailStyle,
} from 'aws-cdk-lib/aws-cognito';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../config/env.config.js';

export interface IdentityStackProps extends StackProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly googleClientId: string;
  readonly googleClientSecret: string;
  readonly cognitoDomainPrefix: string;
  readonly callbackUrls?: string[];
  readonly logoutUrls?: string[];
}

export class IdentityStack extends Stack {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;
  public readonly issuerUrl: string;
  public readonly hostedUiDomainBaseUrl: string;

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
      mfa: isProd ? Mfa.OPTIONAL : Mfa.OFF,
      advancedSecurityMode: isProd ? AdvancedSecurityMode.ENFORCED : AdvancedSecurityMode.OFF,
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const googleIdp = new UserPoolIdentityProviderGoogle(this, 'GoogleIdp', {
      userPool: this.userPool,
      clientId: props.googleClientId,
      clientSecretValue: SecretValue.unsafePlainText(props.googleClientSecret),
      scopes: ['openid', 'email', 'profile'],
      attributeMapping: {
        email: ProviderAttribute.GOOGLE_EMAIL,
        givenName: ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: ProviderAttribute.GOOGLE_FAMILY_NAME,
      },
    });

    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
    });
    this.hostedUiDomainBaseUrl = `https://${props.cognitoDomainPrefix}.auth.${region}.amazoncognito.com`;

    const callbackUrls = props.callbackUrls && props.callbackUrls.length > 0
      ? props.callbackUrls
      : ['http://localhost:3000/callback'];
    const logoutUrls = props.logoutUrls && props.logoutUrls.length > 0
      ? props.logoutUrls
      : ['http://localhost:3000/'];

    this.userPoolClient = new UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      generateSecret: false,
      authFlows: { userSrp: true, adminUserPassword: true },
      supportedIdentityProviders: [
        UserPoolClientIdentityProvider.COGNITO,
        UserPoolClientIdentityProvider.GOOGLE,
      ],
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [OAuthScope.EMAIL, OAuthScope.OPENID, OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
      idTokenValidity: undefined,
      accessTokenValidity: undefined,
    });
    this.userPoolClient.node.addDependency(googleIdp);
    this.userPoolClient.node.addDependency(domain);

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
    new CfnOutput(this, 'HostedUiDomainBaseUrl', {
      value: this.hostedUiDomainBaseUrl,
      exportName: `${id}-HostedUiDomainBaseUrl`,
    });
    new CfnOutput(this, 'GoogleRedirectUri', {
      value: `${this.hostedUiDomainBaseUrl}/oauth2/idpresponse`,
      description: 'Add this URI to GCP OAuth Client Authorized redirect URIs',
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
