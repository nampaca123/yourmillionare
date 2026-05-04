// Schema migrator: applies db-bootstrap.sql then schema.sql via Aurora Data API (no VPC).

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data';

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: Record<string, string>;
}

interface CfnResult {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

const CLUSTER_ARN = process.env.CLUSTER_ARN ?? '';
const SECRET_ARN = process.env.SECRET_ARN ?? '';
const DATABASE = process.env.DATABASE_NAME ?? 'yourmillionare';
const REGION = process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';
const PHYSICAL_ID = 'schema-migration';

function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDollarQuote = false;
  let dollarTag = '';
  let inLineComment = false;
  let inBlockComment = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? '';

    if (!inDollarQuote && !inSingleQuote && !inBlockComment && ch === '-' && next === '-') {
      inLineComment = true;
    }
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      current += ch;
      i++;
      continue;
    }

    if (!inDollarQuote && !inSingleQuote && ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        current += '*/';
        i += 2;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    if (!inDollarQuote && ch === "'") {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }
    if (inSingleQuote) {
      current += ch;
      i++;
      continue;
    }

    if (!inDollarQuote && ch === '$') {
      let tagEnd = i + 1;
      while (tagEnd < sql.length && sql[tagEnd] !== '$' && sql[tagEnd] !== '\n') tagEnd++;
      if (tagEnd < sql.length && sql[tagEnd] === '$') {
        const tag = sql.substring(i, tagEnd + 1);
        inDollarQuote = true;
        dollarTag = tag;
        current += tag;
        i = tagEnd + 1;
        continue;
      }
    }
    if (inDollarQuote && sql.startsWith(dollarTag, i)) {
      inDollarQuote = false;
      current += dollarTag;
      i += dollarTag.length;
      dollarTag = '';
      continue;
    }

    if (!inDollarQuote && !inSingleQuote && !inBlockComment && ch === ';') {
      current += ch;
      const trimmed = current.trim();
      if (trimmed.length > 1) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  const remaining = current.trim();
  if (remaining.length > 0) statements.push(remaining);
  return statements;
}

async function execStatements(
  client: RDSDataClient,
  sqls: string[],
  transactionId: string,
): Promise<void> {
  for (const sql of sqls) {
    await client.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        transactionId,
        sql,
      }),
    );
  }
}

export const handler = async (event: CfnEvent): Promise<CfnResult> => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? PHYSICAL_ID };
  }

  const bootstrapSql = readFileSync(join(__dirname, 'db-bootstrap.sql'), 'utf8');
  const schemaSql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

  const version = createHash('sha256')
    .update(bootstrapSql + schemaSql)
    .digest('hex');

  const client = new RDSDataClient({ region: REGION });

  const { transactionId } = await client.send(
    new BeginTransactionCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
    }),
  );

  if (!transactionId) throw new Error('Failed to begin transaction');

  try {
    await execStatements(client, splitStatements(bootstrapSql), transactionId);

    const existing = await client.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        transactionId,
        sql: `SELECT 1 FROM schema_migrations WHERE version = '${version}'`,
      }),
    );

    if ((existing.records?.length ?? 0) > 0) {
      await client.send(
        new CommitTransactionCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          transactionId,
        }),
      );
      return { PhysicalResourceId: PHYSICAL_ID, Data: { Version: version, Skipped: 'true' } };
    }

    await execStatements(client, splitStatements(schemaSql), transactionId);

    await client.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        transactionId,
        sql: `INSERT INTO schema_migrations (version, sha256_hex) VALUES ('${version}', '${version}')`,
      }),
    );

    await client.send(
      new CommitTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        transactionId,
      }),
    );

    return { PhysicalResourceId: PHYSICAL_ID, Data: { Version: version, Skipped: 'false' } };
  } catch (err) {
    await client.send(
      new RollbackTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        transactionId,
      }),
    ).catch(() => undefined);
    throw err;
  }
};
