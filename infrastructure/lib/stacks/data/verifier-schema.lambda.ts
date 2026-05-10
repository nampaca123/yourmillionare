// Verifier (schema): validates table count and exact RLS policy whitelist via Data API.

import {
  ExecuteStatementCommand,
  RDSDataClient,
} from '@aws-sdk/client-rds-data';

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
}

interface VerifierOutput {
  check: 'schema';
  status: 'OK' | 'FAILED';
  actualTableCount: number;
  missingPolicies: string[];
  extraPolicies: string[];
  errors: string[];
}

const CLUSTER_ARN = process.env.CLUSTER_ARN ?? '';
const SECRET_ARN = process.env.SECRET_ARN ?? '';
const DATABASE = process.env.DATABASE_NAME ?? 'yourmillionare';
const REGION = process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';
const PHYSICAL_ID = 'verifier-schema';

const EXPECTED_TABLE_COUNT = 13;

// Exact whitelist of (tablename:policyname) pairs that must exist after all migrations.
// Removing or renaming any policy causes deployment to fail — intentional regression gate.
const EXPECTED_POLICIES: ReadonlySet<string> = new Set([
  'users:users_select_by_sub',
  'users:users_update_self',
  'users:users_delete_self',
  'users:users_insert_by_sub',
  'user_profiles:profile_self_only',
  'tenants:tenants_select_by_membership',
  'tenants:tenants_system_select',
  'tenants:tenants_modify_current',
  'tenants:tenants_insert_authenticated',
  'tenant_members:tenant_members_visible',
  'tenant_members:tenant_members_self_insert',
  'tenant_members:tenant_members_admin_modify',
  'tenant_members:tenant_members_admin_delete',
  'accounts:tenant_isolation',
  'journal_entries:tenant_isolation',
  'journal_lines:tenant_isolation',
  'raw_transactions:tenant_isolation',
  'ai_decisions:tenant_isolation',
  'tenant_bank_accounts:tenant_isolation',
  'tenant_bank_accounts:system_select',
  'tenant_bank_connections:tenant_isolation',
  'tenant_bank_connections:system_select',
]);

export const handler = async (event: CfnEvent): Promise<{ PhysicalResourceId: string }> => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? PHYSICAL_ID };
  }

  const errors: string[] = [];
  const client = new RDSDataClient({ region: REGION });

  const exec = (sql: string) =>
    client.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE,
        sql,
      }),
    );

  let actualTableCount = 0;
  let missingPolicies: string[] = [];
  let extraPolicies: string[] = [];

  try {
    const tableResult = await exec(
      `SELECT COUNT(*) FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    actualTableCount = Number(tableResult.records?.[0]?.[0]?.longValue ?? 0);
    if (actualTableCount !== EXPECTED_TABLE_COUNT) {
      errors.push(`Expected ${EXPECTED_TABLE_COUNT} tables, found ${actualTableCount}`);
    }
  } catch (err) {
    errors.push(`Table count query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const policyResult = await exec(
      `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
    );

    const actualPolicies = new Set<string>(
      (policyResult.records ?? []).map(
        (row) => `${row[0]?.stringValue ?? ''}:${row[1]?.stringValue ?? ''}`,
      ),
    );

    missingPolicies = [...EXPECTED_POLICIES].filter((p) => !actualPolicies.has(p));
    extraPolicies = [...actualPolicies].filter((p) => !EXPECTED_POLICIES.has(p));

    if (missingPolicies.length > 0) {
      errors.push(`Missing RLS policies: ${missingPolicies.join(', ')}`);
    }
    if (extraPolicies.length > 0) {
      errors.push(`Unexpected RLS policies (whitelist mismatch): ${extraPolicies.join(', ')}`);
    }
  } catch (err) {
    errors.push(`Policy query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const output: VerifierOutput = {
    check: 'schema',
    status: errors.length === 0 ? 'OK' : 'FAILED',
    actualTableCount,
    missingPolicies,
    extraPolicies,
    errors,
  };

  process.stdout.write(JSON.stringify(output) + '\n');

  if (errors.length > 0) {
    throw new Error(`Schema verification failed: ${errors.join('; ')}`);
  }

  return { PhysicalResourceId: PHYSICAL_ID };
};
