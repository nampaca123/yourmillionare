// Repository: persists sync_run lifecycle (queued → running → completed/failed/timed_out) and per-account outcomes.

import type { PoolClient } from 'pg';

export type SyncRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out';

export type SyncRunAccountOutcome =
  | 'success'
  | 'no_connection'
  | 'codef_error'
  | 'empty_result'
  | 'balance_only';

export interface SyncRunRow {
  id: string;
  tenantId: string;
  triggeredBy: 'manual' | 'schedule';
  triggeredAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  status: SyncRunStatus;
  sfnExecutionArn: string | null;
  totalAccounts: number;
  successCount: number;
  errorCount: number;
  emptyCount: number;
  userSummary: string | null;
}

export interface SyncRunAccountRow {
  id: string;
  syncRunId: string;
  organization: string;
  accountNumber: string | null;
  outcome: SyncRunAccountOutcome;
  codefErrorCode: string | null;
  codefErrorMessage: string | null;
  userMessage: string | null;
  fetchedCount: number;
  balanceUpdated: boolean;
  recordedAt: Date;
}

export interface CreateSyncRunInput {
  tenantId: string;
  triggeredBy: 'manual' | 'schedule';
}

export interface RecordAccountOutcomeInput {
  syncRunId: string;
  tenantId: string;
  organization: string;
  accountNumber: string | null;
  outcome: SyncRunAccountOutcome;
  codefErrorCode?: string | null;
  codefErrorMessage?: string | null;
  userMessage?: string | null;
  fetchedCount?: number;
  balanceUpdated?: boolean;
}

export interface CompleteSyncRunInput {
  syncRunId: string;
  totalAccounts: number;
  successCount: number;
  errorCount: number;
  emptyCount: number;
  userSummary: string;
}

interface SyncRunDbRow {
  id: string;
  tenant_id: string;
  triggered_by: 'manual' | 'schedule';
  triggered_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  status: SyncRunStatus;
  sfn_execution_arn: string | null;
  total_accounts: number;
  success_count: number;
  error_count: number;
  empty_count: number;
  user_summary: string | null;
}

interface SyncRunAccountDbRow {
  id: string;
  sync_run_id: string;
  organization: string;
  account_number: string | null;
  outcome: SyncRunAccountOutcome;
  codef_error_code: string | null;
  codef_error_message: string | null;
  user_message: string | null;
  fetched_count: number;
  balance_updated: boolean;
  recorded_at: Date;
}

const mapSyncRun = (row: SyncRunDbRow): SyncRunRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  triggeredBy: row.triggered_by,
  triggeredAt: row.triggered_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  status: row.status,
  sfnExecutionArn: row.sfn_execution_arn,
  totalAccounts: row.total_accounts,
  successCount: row.success_count,
  errorCount: row.error_count,
  emptyCount: row.empty_count,
  userSummary: row.user_summary,
});

const mapSyncRunAccount = (row: SyncRunAccountDbRow): SyncRunAccountRow => ({
  id: row.id,
  syncRunId: row.sync_run_id,
  organization: row.organization,
  accountNumber: row.account_number,
  outcome: row.outcome,
  codefErrorCode: row.codef_error_code,
  codefErrorMessage: row.codef_error_message,
  userMessage: row.user_message,
  fetchedCount: row.fetched_count,
  balanceUpdated: row.balance_updated,
  recordedAt: row.recorded_at,
});

export const createSyncRun = async (client: PoolClient, input: CreateSyncRunInput): Promise<string> => {
  const result = await client.query<{ id: string }>(
    `INSERT INTO sync_run (tenant_id, triggered_by, status)
     VALUES ($1, $2, 'queued')
     RETURNING id`,
    [input.tenantId, input.triggeredBy],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error('Failed to insert sync_run row');
  }
  return id;
};

export const setSyncRunExecutionArn = async (
  client: PoolClient,
  syncRunId: string,
  executionArn: string,
): Promise<void> => {
  await client.query(`UPDATE sync_run SET sfn_execution_arn = $1 WHERE id = $2`, [executionArn, syncRunId]);
};

export const markSyncRunRunning = async (client: PoolClient, syncRunId: string): Promise<void> => {
  await client.query(
    `UPDATE sync_run SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'`,
    [syncRunId],
  );
};

export const completeSyncRun = async (client: PoolClient, input: CompleteSyncRunInput): Promise<void> => {
  await client.query(
    `UPDATE sync_run
        SET status         = 'completed',
            finished_at    = now(),
            total_accounts = $2,
            success_count  = $3,
            error_count    = $4,
            empty_count    = $5,
            user_summary   = $6
      WHERE id = $1`,
    [
      input.syncRunId,
      input.totalAccounts,
      input.successCount,
      input.errorCount,
      input.emptyCount,
      input.userSummary,
    ],
  );
};

export const failSyncRun = async (
  client: PoolClient,
  syncRunId: string,
  reason: string,
): Promise<void> => {
  await client.query(
    `UPDATE sync_run
        SET status       = 'failed',
            finished_at  = now(),
            user_summary = COALESCE(user_summary, $2)
      WHERE id = $1`,
    [syncRunId, `동기화 중 오류 발생: ${reason.slice(0, 200)}`],
  );
};

export const recordAccountOutcome = async (
  client: PoolClient,
  input: RecordAccountOutcomeInput,
): Promise<void> => {
  await client.query(
    `INSERT INTO sync_run_account
       (sync_run_id, tenant_id, organization, account_number, outcome,
        codef_error_code, codef_error_message, user_message, fetched_count, balance_updated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.syncRunId,
      input.tenantId,
      input.organization,
      input.accountNumber,
      input.outcome,
      input.codefErrorCode ?? null,
      input.codefErrorMessage ?? null,
      input.userMessage ?? null,
      input.fetchedCount ?? 0,
      input.balanceUpdated ?? false,
    ],
  );
};

export const getSyncRun = async (
  client: PoolClient,
  tenantId: string,
  syncRunId: string,
): Promise<{ run: SyncRunRow; accounts: SyncRunAccountRow[] } | null> => {
  const runResult = await client.query<SyncRunDbRow>(
    `SELECT * FROM sync_run WHERE id = $1 AND tenant_id = $2`,
    [syncRunId, tenantId],
  );
  const runRow = runResult.rows[0];
  if (!runRow) return null;

  const accountsResult = await client.query<SyncRunAccountDbRow>(
    `SELECT * FROM sync_run_account WHERE sync_run_id = $1 ORDER BY recorded_at ASC`,
    [syncRunId],
  );

  return {
    run: mapSyncRun(runRow),
    accounts: accountsResult.rows.map(mapSyncRunAccount),
  };
};

export const listSyncRuns = async (
  client: PoolClient,
  tenantId: string,
  limit: number,
): Promise<SyncRunRow[]> => {
  const result = await client.query<SyncRunDbRow>(
    `SELECT * FROM sync_run
      WHERE tenant_id = $1
      ORDER BY triggered_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows.map(mapSyncRun);
};

export const getLatestSyncRun = async (
  client: PoolClient,
  tenantId: string,
): Promise<{ run: SyncRunRow; accounts: SyncRunAccountRow[] } | null> => {
  const runResult = await client.query<SyncRunDbRow>(
    `SELECT * FROM sync_run
      WHERE tenant_id = $1
      ORDER BY triggered_at DESC
      LIMIT 1`,
    [tenantId],
  );
  const runRow = runResult.rows[0];
  if (!runRow) return null;

  const accountsResult = await client.query<SyncRunAccountDbRow>(
    `SELECT * FROM sync_run_account WHERE sync_run_id = $1 ORDER BY recorded_at ASC`,
    [runRow.id],
  );

  return {
    run: mapSyncRun(runRow),
    accounts: accountsResult.rows.map(mapSyncRunAccount),
  };
};
