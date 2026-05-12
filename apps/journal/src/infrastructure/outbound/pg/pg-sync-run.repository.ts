// Repository: sync_run + sync_run_account reads/writes from journal app (HTTP layer side).

import { withRlsContext } from './pg-rls.context.js';
import type {
  SyncRunAccountSummary,
  SyncRunDetail,
  SyncRunRepository,
  SyncRunStatus,
  SyncRunSummary,
  SyncRunAccountOutcome,
} from '../../../application/ports/sync-run.repository.port.js';

interface SyncRunDbRow {
  id: string;
  tenant_id: string;
  triggered_by: 'manual' | 'schedule';
  triggered_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  status: SyncRunStatus;
  total_accounts: number;
  success_count: number;
  error_count: number;
  empty_count: number;
  user_summary: string | null;
}

interface SyncRunAccountDbRow {
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

const mapSummary = (row: SyncRunDbRow): SyncRunSummary => ({
  id: row.id,
  tenantId: row.tenant_id,
  triggeredBy: row.triggered_by,
  triggeredAt: row.triggered_at.toISOString(),
  startedAt: row.started_at ? row.started_at.toISOString() : null,
  finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  status: row.status,
  totalAccounts: row.total_accounts,
  successCount: row.success_count,
  errorCount: row.error_count,
  emptyCount: row.empty_count,
  userSummary: row.user_summary,
});

const mapAccount = (row: SyncRunAccountDbRow): SyncRunAccountSummary => ({
  organization: row.organization,
  accountNumber: row.account_number,
  outcome: row.outcome,
  codefErrorCode: row.codef_error_code,
  codefErrorMessage: row.codef_error_message,
  userMessage: row.user_message,
  fetchedCount: row.fetched_count,
  balanceUpdated: row.balance_updated,
  recordedAt: row.recorded_at.toISOString(),
});

export class PgSyncRunRepository implements SyncRunRepository {
  async create({
    tenantId,
    triggeredBy,
  }: {
    tenantId: string;
    triggeredBy: 'manual' | 'schedule';
  }): Promise<string> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO sync_run (tenant_id, triggered_by, status)
         VALUES ($1, $2, 'queued')
         RETURNING id`,
        [tenantId, triggeredBy],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('Failed to insert sync_run row');
      return id;
    });
  }

  async setExecutionArn({
    tenantId,
    syncRunId,
    executionArn,
  }: {
    tenantId: string;
    syncRunId: string;
    executionArn: string;
  }): Promise<void> {
    await withRlsContext({ tenantId, cognitoSub: 'system' }, (client) =>
      client.query(`UPDATE sync_run SET sfn_execution_arn = $1 WHERE id = $2 AND tenant_id = $3`, [
        executionArn,
        syncRunId,
        tenantId,
      ]),
    );
  }

  async get({
    tenantId,
    syncRunId,
  }: {
    tenantId: string;
    syncRunId: string;
  }): Promise<SyncRunDetail | null> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const runResult = await client.query<SyncRunDbRow>(
        `SELECT * FROM sync_run WHERE id = $1 AND tenant_id = $2`,
        [syncRunId, tenantId],
      );
      const runRow = runResult.rows[0];
      if (!runRow) return null;

      const accountsResult = await client.query<SyncRunAccountDbRow>(
        `SELECT organization, account_number, outcome,
                codef_error_code, codef_error_message, user_message,
                fetched_count, balance_updated, recorded_at
         FROM sync_run_account WHERE sync_run_id = $1 ORDER BY recorded_at ASC`,
        [syncRunId],
      );

      return { ...mapSummary(runRow), accounts: accountsResult.rows.map(mapAccount) };
    });
  }

  async list({ tenantId, limit }: { tenantId: string; limit: number }): Promise<SyncRunSummary[]> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<SyncRunDbRow>(
        `SELECT * FROM sync_run
          WHERE tenant_id = $1
          ORDER BY triggered_at DESC
          LIMIT $2`,
        [tenantId, limit],
      );
      return result.rows.map(mapSummary);
    });
  }

  async getLatest({ tenantId }: { tenantId: string }): Promise<SyncRunDetail | null> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
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
        `SELECT organization, account_number, outcome,
                codef_error_code, codef_error_message, user_message,
                fetched_count, balance_updated, recorded_at
         FROM sync_run_account WHERE sync_run_id = $1 ORDER BY recorded_at ASC`,
        [runRow.id],
      );

      return { ...mapSummary(runRow), accounts: accountsResult.rows.map(mapAccount) };
    });
  }
}
