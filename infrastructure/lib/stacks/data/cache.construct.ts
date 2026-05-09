// Cache construct: four DynamoDB on-demand tables with KMS encryption.

import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

import type { DeploymentEnv } from '../../config/env.config.js';

export interface CacheConstructProps {
  readonly deploymentEnv: DeploymentEnv;
  readonly sharedKey: IKey;
}

const makeTable = (
  scope: Construct,
  id: string,
  sharedKey: IKey,
  isProd: boolean,
  extra?: { timeToLiveAttribute?: string },
): Table =>
  new Table(scope, id, {
    partitionKey: { name: 'pk', type: AttributeType.STRING },
    sortKey: { name: 'sk', type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
    encryption: TableEncryption.CUSTOMER_MANAGED,
    encryptionKey: sharedKey,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
    removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    ...extra,
  });

export class CacheConstruct {
  public readonly monthlySummaryCache: Table;
  public readonly transactionCache: Table;
  public readonly idempotencyKeys: Table;
  public readonly costCounter: Table;

  constructor(scope: Construct, id: string, props: CacheConstructProps) {
    const isProd = props.deploymentEnv === 'prod';

    this.monthlySummaryCache = makeTable(scope, `${id}MonthlySummaryCache`, props.sharedKey, isProd);
    this.transactionCache = makeTable(scope, `${id}TransactionCache`, props.sharedKey, isProd);
    this.idempotencyKeys = makeTable(scope, `${id}IdempotencyKeys`, props.sharedKey, isProd, {
      timeToLiveAttribute: 'expires_at',
    });
    this.costCounter = makeTable(scope, `${id}CostCounter`, props.sharedKey, isProd, {
      timeToLiveAttribute: 'expires_at',
    });
  }
}
