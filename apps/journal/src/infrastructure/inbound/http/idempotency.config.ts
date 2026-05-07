// Idempotency persistence layer factory for @aws-lambda-powertools/idempotency.

import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import { IdempotencyConfig } from '@aws-lambda-powertools/idempotency';

export const buildPersistenceStore = (sk: string): DynamoDBPersistenceLayer =>
  new DynamoDBPersistenceLayer({
    tableName: process.env.IDEMPOTENCY_TABLE_NAME ?? '',
    keyAttr: 'pk',
    sortKeyAttr: 'sk',
    expiryAttr: 'expires_at',
    statusAttr: 'status',
    dataAttr: 'response',
    staticPkValue: sk,
  });

export const buildIdempotencyConfig = (eventKeyJmesPath: string): IdempotencyConfig =>
  new IdempotencyConfig({
    eventKeyJmesPath,
    payloadValidationJmesPath: 'body',
    throwOnNoIdempotencyKey: false,
    expiresAfterSeconds: 24 * 60 * 60,
  });
