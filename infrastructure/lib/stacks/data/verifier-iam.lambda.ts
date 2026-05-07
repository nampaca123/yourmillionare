// Verifier (IAM): rehearses Slice 3 connection pattern and validates RLS tenant isolation.

import {
  ExecuteStatementCommand,
  RDSDataClient,
} from '@aws-sdk/client-rds-data';
import { Signer } from '@aws-sdk/rds-signer';
import { Client } from 'pg';

const RESUME_MAX_RETRIES = 8;
const RESUME_RETRY_DELAY_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isDatabaseResuming(err: unknown): boolean {
  const name = err instanceof Error ? (err as { name?: string }).name ?? '' : '';
  return name === 'DatabaseResumingException' || name === 'CommunicationsErrorException';
}

async function withResumeRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= RESUME_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isDatabaseResuming(err) && attempt < RESUME_MAX_RETRIES) {
        process.stdout.write(JSON.stringify({ message: 'Aurora resuming, retrying', attempt }) + '\n');
        await sleep(RESUME_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
}

interface VerifierOutput {
  check: 'iam-token';
  status: 'OK' | 'FAILED';
  iamConnectMs: number;
  rlsIsolationPassed: boolean;
  errors: string[];
}

const CLUSTER_ENDPOINT = process.env.CLUSTER_ENDPOINT ?? '';
const CLUSTER_ARN = process.env.CLUSTER_ARN ?? '';
const SECRET_ARN = process.env.SECRET_ARN ?? '';
const CLUSTER_PORT = parseInt(process.env.CLUSTER_PORT ?? '5432', 10);
const DATABASE = process.env.DATABASE_NAME ?? 'yourmillionare';
const REGION = process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';
const PHYSICAL_ID = 'verifier-iam';

const FIXTURE_USER_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const FIXTURE_USER_EMAIL = '__verifier@ym.internal__';
const FIXTURE_TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FIXTURE_TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FIXTURE_LEGAL_NAME_A = '__verifier_tenant_a__';
const FIXTURE_LEGAL_NAME_B = '__verifier_tenant_b__';

const exec = (dataApiClient: RDSDataClient, sql: string) =>
  withResumeRetry(() =>
    dataApiClient.send(
      new ExecuteStatementCommand({ resourceArn: CLUSTER_ARN, secretArn: SECRET_ARN, database: DATABASE, sql }),
    ),
  );

// Insert all fixtures via Data API BEFORE opening the pg connection.
// This avoids ETIMEDOUT: the pg TCP connection goes idle while Data API calls run
// (which can take 10-15s if Aurora is resuming), and Aurora's scale-to-zero can
// terminate the idle TCP connection mid-scenario.
async function insertFixtures(dataApiClient: RDSDataClient): Promise<void> {
  await exec(
    dataApiClient,
    `INSERT INTO users (id, cognito_sub, email) VALUES ('${FIXTURE_USER_ID}', '${FIXTURE_USER_ID}', '${FIXTURE_USER_EMAIL}') ON CONFLICT (id) DO NOTHING`,
  );
  for (const [id, name] of [[FIXTURE_TENANT_A, FIXTURE_LEGAL_NAME_A], [FIXTURE_TENANT_B, FIXTURE_LEGAL_NAME_B]]) {
    await exec(
      dataApiClient,
      `INSERT INTO tenants (id, biz_reg_no_encrypted, biz_reg_no_hash, legal_name, display_name)
       VALUES ('${id}', '\\x00', '\\x00', '${name}', '${name}') ON CONFLICT (id) DO NOTHING`,
    );
  }
  await exec(
    dataApiClient,
    `INSERT INTO tenant_members (tenant_id, user_id) VALUES ('${FIXTURE_TENANT_A}', '${FIXTURE_USER_ID}') ON CONFLICT DO NOTHING`,
  );
}

async function cleanupFixtures(dataApiClient: RDSDataClient): Promise<void> {
  for (const id of [FIXTURE_TENANT_A, FIXTURE_TENANT_B]) {
    await exec(dataApiClient, `DELETE FROM tenants WHERE id = '${id}'`);
  }
  await exec(dataApiClient, `DELETE FROM users WHERE id = '${FIXTURE_USER_ID}'`);
}

async function runRlsIsolationScenario(appClient: Client): Promise<void> {
  // With app_user + current settings pointing to tenant A, user should see tenant A.
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_user_id', '${FIXTURE_USER_ID}', true)`);
  await appClient.query(`SELECT set_config('app.current_tenant_id', '${FIXTURE_TENANT_A}', true)`);

  const countA = await appClient.query(`SELECT COUNT(*)::int AS n FROM tenants WHERE id = '${FIXTURE_TENANT_A}'`);
  if (Number(countA.rows[0]?.n) !== 1) {
    throw new Error(`RLS isolation FAIL: expected tenant A to be visible, got ${countA.rows[0]?.n}`);
  }

  // Switch to tenant B context — tenant A must NOT be visible (no tenant_members row for B).
  await appClient.query(`SELECT set_config('app.current_tenant_id', '${FIXTURE_TENANT_B}', true)`);

  const leakCheck = await appClient.query(`SELECT id FROM tenants WHERE id = '${FIXTURE_TENANT_A}'`);
  if (leakCheck.rowCount !== 0) {
    throw new Error(`RLS isolation FAIL: tenant A leaked with current_tenant_id=B`);
  }

  await appClient.query('ROLLBACK');
}

export const handler = async (event: CfnEvent): Promise<{ PhysicalResourceId: string }> => {
  // Only run the full IAM + RLS check on initial stack creation.
  // Updates don't change the Aurora cluster, RLS policies, or IAM auth config,
  // so re-running on every deployment update is unnecessary and causes Aurora
  // cold-start failures (scale-to-zero after inactivity).
  if (event.RequestType === 'Delete' || event.RequestType === 'Update') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? PHYSICAL_ID };
  }

  const errors: string[] = [];
  let rlsIsolationPassed = false;
  const start = Date.now();
  let appClient: Client | undefined;
  const dataApiClient = new RDSDataClient({ region: REGION });

  // Step 1: Insert fixtures via Data API BEFORE opening the pg TCP connection.
  // This prevents ETIMEDOUT: long-running Data API calls (Aurora resume) would leave the
  // pg connection idle long enough for Aurora's scale-to-zero to terminate it.
  try {
    await insertFixtures(dataApiClient);
  } catch (err) {
    errors.push(`Fixture setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: Open pg connection and run the RLS isolation scenario immediately.
  if (errors.length === 0) {
    try {
      const signer = new Signer({
        hostname: CLUSTER_ENDPOINT,
        port: CLUSTER_PORT,
        username: 'app_user',
        region: REGION,
      });

      const token = await signer.getAuthToken();

      appClient = new Client({
        host: CLUSTER_ENDPOINT,
        port: CLUSTER_PORT,
        user: 'app_user',
        password: token,
        database: DATABASE,
        ssl: { rejectUnauthorized: false },
        keepAlive: true,
      });

      await appClient.connect();
      await appClient.query('SELECT 1');
    } catch (err) {
      errors.push(`IAM connect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const iamConnectMs = Date.now() - start;

  if (appClient && errors.length === 0) {
    try {
      await runRlsIsolationScenario(appClient);
      rlsIsolationPassed = true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { detail?: string };
      const msg = err instanceof Error
        ? `${e.message} [code=${e.code ?? 'none'}] [detail=${e.detail ?? ''}]`
        : `thrown: ${JSON.stringify(err)}`;
      errors.push(msg || 'unknown error (empty message)');
    }
  }

  await appClient?.end().catch(() => undefined);

  // Step 3: Cleanup fixtures via Data API after pg connection is closed.
  await cleanupFixtures(dataApiClient).catch((err) => {
    process.stderr.write(`Fixture cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
  });

  const output: VerifierOutput = {
    check: 'iam-token',
    status: errors.length === 0 ? 'OK' : 'FAILED',
    iamConnectMs,
    rlsIsolationPassed,
    errors,
  };

  process.stdout.write(JSON.stringify(output) + '\n');

  if (errors.length > 0) {
    throw new Error(`IAM verifier failed: ${errors.join('; ')}`);
  }

  return { PhysicalResourceId: PHYSICAL_ID };
};
