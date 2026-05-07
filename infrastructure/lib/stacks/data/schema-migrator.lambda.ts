// Schema migrator: applies db-bootstrap.sql, schema.sql, then incremental migrations/ in order.

import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
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

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

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

async function isVersionApplied(
  client: RDSDataClient,
  version: string,
  transactionId: string,
): Promise<boolean> {
  const result = await client.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
      transactionId,
      sql: `SELECT 1 FROM schema_migrations WHERE version = '${version}'`,
    }),
  );
  return (result.records?.length ?? 0) > 0;
}

async function recordVersion(
  client: RDSDataClient,
  version: string,
  sha256: string,
  transactionId: string,
): Promise<void> {
  await client.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
      transactionId,
      sql: `INSERT INTO schema_migrations (version, sha256_hex) VALUES ('${version}', '${sha256}')`,
    }),
  );
}

const RESUME_RETRY_DELAY_MS = 15_000;
const RESUME_MAX_RETRIES = 8;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDatabaseResuming(err: unknown): boolean {
  if (err instanceof Error) {
    const name = (err as { name?: string }).name ?? '';
    return name === 'DatabaseResumingException' || name === 'CommunicationsErrorException';
  }
  return false;
}

async function withResumeRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= RESUME_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isDatabaseResuming(err) && attempt < RESUME_MAX_RETRIES) {
        console.info(JSON.stringify({ message: 'Aurora resuming, retrying', attempt, delayMs: RESUME_RETRY_DELAY_MS }));
        await sleep(RESUME_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

async function runInTransaction(
  client: RDSDataClient,
  work: (txId: string) => Promise<void>,
): Promise<void> {
  const { transactionId } = await withResumeRetry(() =>
    client.send(
      new BeginTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
      }),
    ),
  );
  if (!transactionId) throw new Error('Failed to begin transaction');

  try {
    await work(transactionId);
    await client.send(
      new CommitTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        transactionId,
      }),
    );
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
}

export const handler = async (event: CfnEvent): Promise<CfnResult> => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? PHYSICAL_ID };
  }

  const bootstrapSql = readFileSync(join(__dirname, 'db-bootstrap.sql'), 'utf8');
  const schemaSql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

  const client = new RDSDataClient({ region: REGION });

  // 'baseline-v1' is the stable canonical key. Legacy deployments recorded the sha256 hash
  // of (bootstrapSql + schemaSql) as the version. Both patterns are recognised to avoid
  // re-running schema.sql on a DB that was already initialised with a different schema.sql hash.
  const BASELINE_KEY = 'baseline-v1';
  const legacyVersion = sha256Hex(bootstrapSql + schemaSql);

  // --- Phase 1: bootstrap + base schema (single transaction) ---
  await runInTransaction(client, async (txId) => {
    await execStatements(client, splitStatements(bootstrapSql), txId);

    const newKeyApplied = await isVersionApplied(client, BASELINE_KEY, txId);

    // Legacy deployments stored sha256(bootstrapSql + schemaSql) as the version key (64-char hex).
    // Accept any such entry as proof that the baseline was already applied, regardless of which
    // exact hash was recorded (covers schema.sql edits between deployments).
    const legacyResult = await client.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        transactionId: txId,
        sql: "SELECT 1 FROM schema_migrations WHERE length(version) = 64 LIMIT 1",
      }),
    );
    const legacyKeyApplied = (legacyResult.records?.length ?? 0) > 0;

    if (newKeyApplied || legacyKeyApplied) {
      if (!newKeyApplied) {
        await recordVersion(client, BASELINE_KEY, legacyVersion, txId);
      }
      return;
    }

    await execStatements(client, splitStatements(schemaSql), txId);
    await recordVersion(client, BASELINE_KEY, legacyVersion, txId);
  });

  // --- Phase 2: incremental migrations, one transaction per file ---
  // Partial-failure behaviour: if a file fails, only that file's transaction is rolled back.
  // The file's version row is NOT written, so the next deployment re-tries it from scratch.
  // Files that already committed keep their rows and are skipped on retry.
  const migrationsDir = join(__dirname, 'migrations');
  let migrationFiles: string[] = [];
  try {
    migrationFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    // migrations/ dir not present — nothing to apply
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, filename), 'utf8');
    const hash = sha256Hex(sql);

    await runInTransaction(client, async (txId) => {
      if (await isVersionApplied(client, filename, txId)) {
        skipped.push(filename);
        return;
      }
      await execStatements(client, splitStatements(sql), txId);
      await recordVersion(client, filename, hash, txId);
      applied.push(filename);
    });
  }

  return {
    PhysicalResourceId: PHYSICAL_ID,
    Data: {
      BaseVersion: BASELINE_KEY,
      MigrationsApplied: applied.join(','),
      MigrationsSkipped: skipped.join(','),
    },
  };
};
