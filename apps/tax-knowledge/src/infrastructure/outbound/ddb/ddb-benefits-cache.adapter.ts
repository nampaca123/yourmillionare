// DDB-backed entry-guard cache for find_applicable_benefits — keyed by tenant + profileHash + asOfDate.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';

const TTL_SECONDS = 86_400;

export interface CachedBenefits<T> {
  readonly cachedAt: string;
  readonly payload: T;
}

export class DdbBenefitsCacheAdapter<T extends object> {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName?: string) {
    this.tableName = tableName ?? process.env.BENEFITS_CACHE_TABLE_NAME ?? process.env.IDEMPOTENCY_TABLE_NAME ?? '';
    this.doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2' }),
    );
  }

  hashProfile(profile: unknown): string {
    const stable = JSON.stringify(profile, Object.keys(profile as Record<string, unknown>).sort());
    return createHash('sha256').update(stable).digest('hex').slice(0, 32);
  }

  cacheKey(tenantId: string, profileHash: string, asOfDate: string): string {
    return `benefits#${tenantId}#${profileHash}#${asOfDate}`;
  }

  async get(tenantId: string, profileHash: string, asOfDate: string): Promise<CachedBenefits<T> | null> {
    if (!this.tableName) return null;
    const result = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { id: this.cacheKey(tenantId, profileHash, asOfDate) } }),
    );
    const item = result.Item;
    if (!item || !item.payload) return null;
    return { cachedAt: item.cachedAt as string, payload: item.payload as T };
  }

  async put(tenantId: string, profileHash: string, asOfDate: string, payload: T): Promise<void> {
    if (!this.tableName) return;
    const expiration = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          id: this.cacheKey(tenantId, profileHash, asOfDate),
          payload,
          cachedAt: new Date().toISOString(),
          expiration,
        },
      }),
    );
  }
}
