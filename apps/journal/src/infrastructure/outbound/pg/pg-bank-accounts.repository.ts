// Reads per-tenant bank-account balance snapshots + pending journal_entry_draft counts for the dashboard envelope.

import { withRlsContext } from './pg-rls.context.js';

const BALANCE_STALE_HOURS = 7;

export interface AccountBalanceView {
  readonly id: string;
  readonly organization: string;
  readonly accountNumber: string;
  readonly currentBalance: number | null;
  readonly withdrawable: number | null;
  readonly currency: 'KRW';
  readonly syncedAt: string | null;
  readonly isStale: boolean;
}

interface AccountBalanceRow {
  id: string;
  organization: string;
  account_number: string;
  last_balance_krw: string | null;
  last_withdrawable_krw: string | null;
  balance_synced_at: Date | null;
}

export const listAccountBalances = async (tenantId: string): Promise<ReadonlyArray<AccountBalanceView>> => {
  return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
    const result = await client.query<AccountBalanceRow>(
      `SELECT id, organization, account_number,
              last_balance_krw::text, last_withdrawable_krw::text, balance_synced_at
         FROM tenant_bank_accounts
        WHERE tenant_id = $1 AND is_active = TRUE
     ORDER BY created_at ASC`,
      [tenantId],
    );
    const staleThresholdMs = BALANCE_STALE_HOURS * 60 * 60 * 1000;
    const now = Date.now();
    return result.rows.map((row) => {
      const syncedAt = row.balance_synced_at;
      const isStale = !syncedAt || now - syncedAt.getTime() > staleThresholdMs;
      return {
        id: row.id,
        organization: row.organization,
        accountNumber: row.account_number,
        currentBalance: row.last_balance_krw === null ? null : Number.parseFloat(row.last_balance_krw),
        withdrawable: row.last_withdrawable_krw === null ? null : Number.parseFloat(row.last_withdrawable_krw),
        currency: 'KRW' as const,
        syncedAt: syncedAt ? syncedAt.toISOString() : null,
        isStale,
      };
    });
  });
};

export const countUncertainEntries = async (tenantId: string): Promise<number> => {
  return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
    const result = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries
        WHERE tenant_id = $1 AND confidence_status = 'uncertain'`,
      [tenantId],
    );
    return Number.parseInt(result.rows[0]?.n ?? '0', 10);
  });
};
