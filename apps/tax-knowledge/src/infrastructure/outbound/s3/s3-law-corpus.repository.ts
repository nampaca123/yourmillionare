// Persists raw OPEN_LAW responses to S3 — the source of truth for Bedrock KB ingestion.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const RAW_PREFIX = 'raw';
const CHUNKS_PREFIX = 'chunks';
const FETCH_TIMEOUT_MS = 8_000;

export interface S3LawCorpusConfig {
  readonly bucket: string;
  readonly region?: string;
}

export class S3LawCorpusRepository {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3LawCorpusConfig) {
    if (!config.bucket) throw new Error('LEGAL_KB_BUCKET is not configured');
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region ?? process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2',
      requestHandler: { requestTimeout: FETCH_TIMEOUT_MS },
    });
  }

  async putRaw(input: { lawId: string; mst: string; payload: unknown }): Promise<string> {
    const key = `${RAW_PREFIX}/${input.lawId}/${input.mst}/full.json`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(input.payload),
        ContentType: 'application/json',
      }),
    );
    return `s3://${this.bucket}/${key}`;
  }

  async putChunk(input: { lawId: string; mst: string; articleNumber: string; payload: unknown; metadata: Record<string, unknown> }): Promise<string> {
    const key = `${CHUNKS_PREFIX}/${input.lawId}/${input.mst}/article-${input.articleNumber}.json`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(input.payload),
        ContentType: 'application/json',
        Metadata: Object.fromEntries(
          Object.entries(input.metadata).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
        ),
      }),
    );
    return `s3://${this.bucket}/${key}`;
  }
}
