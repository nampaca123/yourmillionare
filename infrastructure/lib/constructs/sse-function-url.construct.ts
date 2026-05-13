// Standardised SSE Function URL construct: enforces consistent CORS, Cognito env injection, and Response Streaming wiring so new SSE lambdas cannot drift from the central pattern.

import { CfnOutput, Duration } from 'aws-cdk-lib';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Architecture, FunctionUrlAuthType, InvokeMode, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

import { buildFunctionUrlCors } from '../config/cors.config.js';

const DEFAULT_MEMORY_MB = 512;
const DEFAULT_TIMEOUT = Duration.minutes(3);
const DEFAULT_RUNTIME = Runtime.NODEJS_20_X;
const DEFAULT_ARCHITECTURE = Architecture.ARM_64;

export interface SseFunctionUrlProps {
  readonly entry: string;
  readonly handler?: string;
  readonly stage: 'dev' | 'prod';
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly vpc: IVpc;
  readonly lambdaSg: ISecurityGroup;
  readonly memoryMb?: number;
  readonly timeout?: Duration;
  readonly environment: Record<string, string>;
  readonly cognitoUserPoolId: string;
  readonly cognitoUserPoolClientId: string;
  readonly nodeModules?: ReadonlyArray<string>;
  readonly externalModules?: ReadonlyArray<string>;
  readonly outputName: string;
  readonly outputDescription: string;
}

export class SseFunctionUrl extends Construct {
  public readonly fn: NodejsFunction;
  public readonly url: string;

  constructor(scope: Construct, id: string, props: SseFunctionUrlProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, 'Fn', {
      entry: props.entry,
      handler: props.handler ?? 'handler',
      runtime: DEFAULT_RUNTIME,
      architecture: DEFAULT_ARCHITECTURE,
      memorySize: props.memoryMb ?? DEFAULT_MEMORY_MB,
      timeout: props.timeout ?? DEFAULT_TIMEOUT,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        ...props.environment,
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_USER_POOL_CLIENT_ID: props.cognitoUserPoolClientId,
      },
      bundling: {
        externalModules: [...(props.externalModules ?? ['@aws-sdk/*', 'pg-native'])],
        nodeModules: [...(props.nodeModules ?? ['pg'])],
      },
    });

    const fnUrl = this.fn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      invokeMode: InvokeMode.RESPONSE_STREAM,
      cors: buildFunctionUrlCors({ stage: props.stage, allowedOrigins: props.allowedOrigins }),
    });
    this.url = fnUrl.url;

    new CfnOutput(this, props.outputName, {
      value: this.url,
      description: props.outputDescription,
      exportName: `${scope.node.id}-${props.outputName}`,
    });
  }
}
