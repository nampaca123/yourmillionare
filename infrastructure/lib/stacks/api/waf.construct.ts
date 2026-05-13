// API WAF v2 WebACL: 4 AWS managed rule groups (count-mode in PR-A) + IP rate limit (block).

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { CfnLoggingConfiguration, CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../../config/env.config.js';

const RATE_LIMIT_5MIN = { dev: 5000, prod: 2000 } as const;

export interface WafConstructProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly stageArn: string;
  readonly alarmTopic: ITopic;
}

export class WafConstruct {
  public readonly webAcl: CfnWebACL;
  public readonly association: CfnWebACLAssociation;

  constructor(scope: Construct, id: string, props: WafConstructProps) {
    const isProd = props.deploymentEnv === 'prod';
    const rateLimit = isProd ? RATE_LIMIT_5MIN.prod : RATE_LIMIT_5MIN.dev;
    const webAclName = `${id}WebAcl`;

    // PR-A: managed rules are Count mode for both dev and prod.
    // PR-C flips managed rules to Block. IP rate limit is Block from PR-A.
    const managedRuleAction = { count: {} };

    this.webAcl = new CfnWebACL(scope, webAclName, {
      name: webAclName,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: webAclName,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWS-Managed-Common',
          priority: 0,
          overrideAction: managedRuleAction,
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-Managed-Common',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWS-Managed-KnownBadInputs',
          priority: 1,
          overrideAction: managedRuleAction,
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-Managed-KnownBadInputs',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWS-Managed-AmazonIpReputation',
          priority: 2,
          overrideAction: managedRuleAction,
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAmazonIpReputationList' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-Managed-AmazonIpReputation',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWS-Managed-AnonymousIp',
          priority: 3,
          overrideAction: managedRuleAction,
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAnonymousIpList' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-Managed-AnonymousIp',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'IpRateLimit',
          priority: 4,
          action: { block: {} },
          statement: {
            rateBasedStatement: { aggregateKeyType: 'IP', limit: rateLimit },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'IpRateLimit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Dedicated CMK with CloudWatch Logs service principal — sharedKey lacks
    // logs.*.amazonaws.com permission, mirroring FlowLogsKey pattern.
    const logGroupKey = new Key(scope, `${id}LogKey`, {
      description: `KMS key for ${id} WAF log group encryption.`,
      enableKeyRotation: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const region = Stack.of(scope).region;
    const account = Stack.of(scope).account;
    logGroupKey.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal(`logs.${region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${region}:${account}:*`,
          },
        },
      }),
    );

    const logGroup = new LogGroup(scope, `${id}LogGroup`, {
      logGroupName: `aws-waf-logs-yourmillionare-${props.deploymentEnv}`,
      encryptionKey: logGroupKey,
      retention: isProd ? RetentionDays.THREE_MONTHS : RetentionDays.TWO_WEEKS,
    });
    new CfnLoggingConfiguration(scope, `${id}LoggingConfig`, {
      logDestinationConfigs: [logGroup.logGroupArn],
      resourceArn: this.webAcl.attrArn,
    });

    this.association = new CfnWebACLAssociation(scope, `${id}Association`, {
      resourceArn: props.stageArn,
      webAclArn: this.webAcl.attrArn,
    });

    new Alarm(scope, `${id}BlockedRequestsAlarm`, {
      alarmName: `${id}-WafBlockedRequests-500-5min`,
      metric: new Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        statistic: 'Sum',
        period: Duration.minutes(5),
        dimensionsMap: { WebACL: webAclName, Region: 'ap-northeast-2', Rule: 'ALL' },
      }),
      threshold: 500,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(props.alarmTopic));
  }
}
