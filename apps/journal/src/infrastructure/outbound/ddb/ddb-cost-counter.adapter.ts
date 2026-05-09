// DynamoDB CostCounter adapter: atomic daily increment with conditional limit check.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { CostCounter } from '../../../application/ports/cost-counter.port.js';

const TABLE_NAME = process.env.COST_COUNTER_TABLE_NAME ?? '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TTL_SECONDS_AFTER_NOW = 48 * 3600;

export class DdbCostCounterAdapter implements CostCounter {
  async incrementAndCheck(userId: string, date: string, limit: number): Promise<{ allowed: boolean; count: number }> {
    try {
      const ttlUnix = Math.floor(Date.now() / 1000) + TTL_SECONDS_AFTER_NOW;
      const result = await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `USER#${userId}`, sk: `DATE#${date}` },
          UpdateExpression: 'ADD #count :one SET expires_at = if_not_exists(expires_at, :ttl)',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count' },
          ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':ttl': ttlUnix },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      const count = (result.Attributes?.['count'] as number) ?? 1;
      return { allowed: true, count };
    } catch (err) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        return { allowed: false, count: limit };
      }
      throw err;
    }
  }
}
