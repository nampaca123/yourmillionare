// Verifier (schema): confirms table list and RLS policies via Aurora Data API — no VPC needed.

import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
}

interface VerifierOutput {
  check: 'schema';
  status: 'OK' | 'FAILED';
  tables: string[];
  policies: Array<{ table: string; name: string }>;
  version: string;
  expectedTableCount: number;
  actualTableCount: number;
  expectedPolicyCount: number;
  actualPolicyCount: number;
  errors: string[];
}

const CLUSTER_ARN = process.env.CLUSTER_ARN ?? '';
const SECRET_ARN = process.env.SECRET_ARN ?? '';
const DATABASE = process.env.DATABASE_NAME ?? 'yourmillionare';
const REGION = process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';
const PHYSICAL_ID = 'verifier-schema';

const EXPECTED_TABLES = [
  'accounts',
  'fx_observations',
  'journal_entries',
  'journal_lines',
  'raw_transactions',
  'schema_migrations',
  'tenant_members',
  'tenants',
  'user_profiles',
  'users',
];

const EXPECTED_POLICY_COUNT = 8;

export const handler = async (event: CfnEvent): Promise<{ PhysicalResourceId: string }> => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? PHYSICAL_ID };
  }

  const client = new RDSDataClient({ region: REGION });
  const errors: string[] = [];

  const exec = (sql: string) =>
    client.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        sql,
      }),
    );

  const tablesRes = await exec(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
  );
  const tables = (tablesRes.records ?? []).map((r) => r[0]?.stringValue ?? '').filter(Boolean);

  const policiesRes = await exec(
    `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`,
  );
  const policies = (policiesRes.records ?? []).map((r) => ({
    table: r[0]?.stringValue ?? '',
    name: r[1]?.stringValue ?? '',
  }));

  const versionRes = await exec(`SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1`);
  const version = versionRes.records?.[0]?.[0]?.stringValue ?? 'unknown';

  const missingTables = EXPECTED_TABLES.filter((t) => !tables.includes(t));
  if (missingTables.length > 0) {
    errors.push(`Missing tables: ${missingTables.join(', ')}`);
  }
  if (policies.length < EXPECTED_POLICY_COUNT) {
    errors.push(`Expected at least ${EXPECTED_POLICY_COUNT} RLS policies, found ${policies.length}`);
  }

  const output: VerifierOutput = {
    check: 'schema',
    status: errors.length === 0 ? 'OK' : 'FAILED',
    tables,
    policies,
    version,
    expectedTableCount: EXPECTED_TABLES.length,
    actualTableCount: tables.length,
    expectedPolicyCount: EXPECTED_POLICY_COUNT,
    actualPolicyCount: policies.length,
    errors,
  };

  console.log(JSON.stringify(output));

  if (errors.length > 0) {
    throw new Error(`Schema verification failed: ${errors.join('; ')}`);
  }

  return { PhysicalResourceId: PHYSICAL_ID };
};
