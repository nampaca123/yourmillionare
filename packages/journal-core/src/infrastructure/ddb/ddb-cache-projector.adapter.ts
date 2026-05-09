// DynamoDB adapter implementing CacheProjector with conditional PutItem for idempotent projection.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import type { CacheProjector } from '../../application/ports/cache-projector.port.js';
import type { JournalEntry } from '../../domain/journal-entry.entity.js';
import { logger } from '../../logging/logger.js';

const TABLE_NAME = process.env.TRANSACTION_CACHE_TABLE_NAME ?? '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export class DdbCacheProjectorAdapter implements CacheProjector {
  async projectEntry(tenantId: string, entry: JournalEntry): Promise<void> {
    const entryId = entry.id;
    if (!entryId) {
      logger.warn({ tenantId }, 'Skipping cache projection: entry id missing');
      return;
    }
    if (!TABLE_NAME) {
      logger.warn({ tenantId }, 'Skipping cache projection: TRANSACTION_CACHE_TABLE_NAME unset');
      return;
    }

    const pk = `tenant#${tenantId}`;
    const sk = `tx#${entry.entryDate}#${entryId}`;

    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            pk,
            sk,
            tenantId,
            entryId,
            entryDate: entry.entryDate,
            source: entry.source,
            lines: entry.lines,
            description: entry.description ?? null,
          },
          ConditionExpression: 'attribute_not_exists(sk)',
        }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return;
      logger.warn({ err, tenantId, entryId }, 'Transaction cache projection failed');
    }
  }
}
