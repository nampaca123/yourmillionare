// Verifier (IAM): rehearses Slice 3 connection pattern and validates RLS tenant isolation.

import {
  ExecuteStatementCommand,
  RDSDataClient,
} from '@aws-sdk/client-rds-data';
import { Signer } from '@aws-sdk/rds-signer';
import { Client } from 'pg';

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

const FIXTURE_TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FIXTURE_TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FIXTURE_LEGAL_NAME_A = '__verifier_tenant_a__';
const FIXTURE_LEGAL_NAME_B = '__verifier_tenant_b__';

async function runRlsIsolationScenario(
  appClient: Client,
  dataApiClient: RDSDataClient,
): Promise<void> {
  // 1. Insert fixture tenants via master credentials (Data API bypasses RLS).
  const insertSql = (id: string, name: string) =>
    `INSERT INTO tenants (id, biz_reg_no_encrypted, biz_reg_no_hash, legal_name, display_name)
     VALUES ('${id}', '\\x00', '\\x00', '${name}', '${name}')
     ON CONFLICT (id) DO NOTHING`;

  for (const sql of [insertSql(FIXTURE_TENANT_A, FIXTURE_LEGAL_NAME_A), insertSql(FIXTURE_TENANT_B, FIXTURE_LEGAL_NAME_B)]) {
    await dataApiClient.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        sql,
      }),
    );
  }

  // 2. With app_user + current_tenant_id = A, only tenant A should be visible.
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('app.current_tenant_id', '${FIXTURE_TENANT_A}', true)`);
  await appClient.query(`SELECT set_config('app.current_user_id', '00000000-0000-0000-0000-000000000000', true)`);

  const countA = await appClient.query(
    `SELECT COUNT(*)::int AS n FROM tenants WHERE id = '${FIXTURE_TENANT_A}'`,
  );
  if (Number(countA.rows[0]?.n) !== 1) {
    throw new Error(`RLS isolation FAIL: expected tenant A to be visible with current_tenant_id=A, got ${countA.rows[0]?.n}`);
  }

  // 3. With current_tenant_id = B, tenant A must NOT be visible (membership-based SELECT).
  await appClient.query(`SELECT set_config('app.current_tenant_id', '${FIXTURE_TENANT_B}', true)`);

  const leakCheck = await appClient.query(
    `SELECT id FROM tenants WHERE id = '${FIXTURE_TENANT_A}'`,
  );
  if (leakCheck.rowCount !== 0) {
    throw new Error(`RLS isolation FAIL: tenant A leaked with current_tenant_id=B`);
  }

  await appClient.query('ROLLBACK');

  // 4. Clean up fixture rows via master credentials.
  for (const id of [FIXTURE_TENANT_A, FIXTURE_TENANT_B]) {
    await dataApiClient.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        sql: `DELETE FROM tenants WHERE id = '${id}'`,
      }),
    );
  }
}

export const handler = async (event: CfnEvent): Promise<{ PhysicalResourceId: string }> => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? PHYSICAL_ID };
  }

  const errors: string[] = [];
  let rlsIsolationPassed = false;
  const start = Date.now();
  let appClient: Client | undefined;
  const dataApiClient = new RDSDataClient({ region: REGION });

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
    });

    await appClient.connect();
    await appClient.query('SELECT 1');
  } catch (err) {
    errors.push(`IAM connect failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const iamConnectMs = Date.now() - start;

  if (appClient && errors.length === 0) {
    try {
      await runRlsIsolationScenario(appClient, dataApiClient);
      rlsIsolationPassed = true;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  await appClient?.end().catch(() => undefined);

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
