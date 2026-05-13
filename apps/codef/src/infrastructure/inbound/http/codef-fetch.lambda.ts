// Lambda entry point: fetches CODEF bank transactions per tenant, records per-account outcomes (with balance snapshots), and queues new tx for classification.

import type { PoolClient } from 'pg';
import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { fetchTransactions } from '../../outbound/codef/codef-bank.client.js';
import {
  upsertBatch,
  markDispatched,
  findLatestFetchedAt,
} from '../../outbound/pg/pg-raw-transaction.repository.js';
import {
  markSyncRunRunning,
  completeSyncRun,
  failSyncRun,
  recordAccountOutcome,
  type SyncRunAccountOutcome,
} from '../../outbound/pg/pg-sync-run.repository.js';
import { sendTaskBatch } from '../../outbound/sqs/classify-dispatcher.client.js';
import {
  mapCodefErrorToUserMessage,
  NO_CONNECTION_USER_MESSAGE,
} from '../../../application/codef-error-messages.js';
import { logger } from '../../../shared/logging/logger.js';

const DEFAULT_LOOKBACK_DAYS = 2;
const INITIAL_LOOKBACK_DAYS = 31;
const SOURCE = 'codef_bank';

interface FetchPayload {
  tenantId: string;
  syncRunId?: string;
  dateRangeFrom?: string | null;
  dateRangeTo?: string | null;
  accountIds?: ReadonlyArray<string> | null;
  reclassify?: boolean;
}

interface FetchResult {
  tenantId: string;
  syncRunId: string | null;
  fetched: number;
  queued: number;
  outcomes: { organization: string; outcome: SyncRunAccountOutcome }[];
}

interface BankAccountRow {
  id: string;
  organization: string;
  account_number: string;
  connected_id: string | null;
  last_balance_krw: string | null;
}

interface AccountResult {
  bankAccountId: string;
  organization: string;
  accountNumber: string;
  outcome: SyncRunAccountOutcome;
  codefErrorCode?: string;
  codefErrorMessage?: string;
  userMessage?: string;
  fetchedCount: number;
  balanceUpdated: boolean;
  previousBalance: number | null;
  currentBalance: number | null;
  newRawTxIds: string[];
}

const toDateStr = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

const isoToCompact = (iso: string): string => iso.replace(/-/g, '');

const summarize = (results: AccountResult[]): string => {
  const success = results.filter((r) => r.outcome === 'success').length;
  const errors = results.filter((r) => r.outcome === 'codef_error' || r.outcome === 'no_connection').length;
  const empty = results.filter((r) => r.outcome === 'empty_result' || r.outcome === 'balance_only').length;
  const parts: string[] = [];
  if (success > 0) parts.push(`${success}개 계좌 동기화 완료`);
  if (errors > 0) parts.push(`${errors}개 계좌 처리 필요`);
  if (empty > 0) parts.push(`${empty}개 계좌 거래 내역 없음`);
  return parts.length > 0 ? parts.join(', ') : '동기화할 계좌가 없습니다';
};

const updateBalance = async (
  tenantId: string,
  account: BankAccountRow,
  balance: { currentBalanceKrw: number; withdrawableKrw: number | null; syncedAt: Date },
): Promise<boolean> => {
  await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
    client.query(
      `UPDATE tenant_bank_accounts
          SET last_balance_krw      = $1,
              last_withdrawable_krw = $2,
              balance_synced_at     = $3
        WHERE tenant_id = $4 AND organization = $5 AND account_number = $6`,
      [
        balance.currentBalanceKrw,
        balance.withdrawableKrw,
        balance.syncedAt,
        tenantId,
        account.organization,
        account.account_number,
      ],
    ),
  );
  return true;
};

interface ProcessAccountInput {
  tenantId: string;
  account: BankAccountRow;
  syncRunId: string | null;
  startDate: string;
  endDate: string;
}

const processAccount = async ({
  tenantId,
  account,
  syncRunId,
  startDate,
  endDate,
}: ProcessAccountInput): Promise<AccountResult> => {
  const previousBalance = account.last_balance_krw !== null
    ? Number.parseFloat(account.last_balance_krw)
    : null;
  const base = {
    bankAccountId: account.id,
    organization: account.organization,
    accountNumber: account.account_number,
    fetchedCount: 0,
    balanceUpdated: false,
    previousBalance,
    currentBalance: null as number | null,
    newRawTxIds: [] as string[],
  };

  if (!account.connected_id) {
    return { ...base, outcome: 'no_connection', userMessage: NO_CONNECTION_USER_MESSAGE };
  }

  const codefRes = await fetchTransactions({
    connectedId: account.connected_id,
    organization: account.organization,
    accountNumber: account.account_number,
    startDate,
    endDate,
  });

  if (!codefRes.ok) {
    return {
      ...base,
      outcome: 'codef_error',
      codefErrorCode: codefRes.code,
      codefErrorMessage: codefRes.message,
      userMessage: mapCodefErrorToUserMessage(account.organization, codefRes.code, codefRes.message),
    };
  }

  const balanceUpdated = codefRes.data.balance
    ? await updateBalance(tenantId, account, codefRes.data.balance)
    : false;
  const currentBalance = codefRes.data.balance ? codefRes.data.balance.currentBalanceKrw : null;

  if (codefRes.data.transactions.length === 0) {
    return {
      ...base,
      outcome: balanceUpdated ? 'balance_only' : 'empty_result',
      balanceUpdated,
      currentBalance,
    };
  }

  const newIds = await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
    upsertBatch({
      client,
      tenantId,
      source: SOURCE,
      bankAccountId: account.id,
      syncRunId,
      txs: codefRes.data.transactions,
    }),
  );

  return {
    ...base,
    outcome: 'success',
    balanceUpdated,
    currentBalance,
    fetchedCount: codefRes.data.transactions.length,
    newRawTxIds: newIds,
  };
};

const recordOutcomes = async (
  tenantId: string,
  syncRunId: string,
  results: AccountResult[],
): Promise<void> => {
  await withRlsContext({ cognitoSub: 'system', tenantId }, async (client) => {
    for (const result of results) {
      await recordAccountOutcome(client, {
        syncRunId,
        tenantId,
        bankAccountId: result.bankAccountId,
        organization: result.organization,
        accountNumber: result.accountNumber,
        outcome: result.outcome,
        codefErrorCode: result.codefErrorCode ?? null,
        codefErrorMessage: result.codefErrorMessage ?? null,
        userMessage: result.userMessage ?? null,
        fetchedCount: result.fetchedCount,
        balanceUpdated: result.balanceUpdated,
        previousBalance: result.previousBalance,
        currentBalance: result.currentBalance,
      });
    }
  });
};

const finalizeSyncRun = async (
  tenantId: string,
  syncRunId: string,
  results: AccountResult[],
): Promise<void> => {
  const successCount = results.filter((r) => r.outcome === 'success').length;
  const errorCount = results.filter(
    (r) => r.outcome === 'codef_error' || r.outcome === 'no_connection',
  ).length;
  const emptyCount = results.filter(
    (r) => r.outcome === 'empty_result' || r.outcome === 'balance_only',
  ).length;

  await withRlsContext({ cognitoSub: 'system', tenantId }, async (client: PoolClient) => {
    await completeSyncRun(client, {
      syncRunId,
      totalAccounts: results.length,
      successCount,
      errorCount,
      emptyCount,
      userSummary: summarize(results),
    });
  });
};

const resolveDateRange = async (
  tenantId: string,
  payload: FetchPayload,
): Promise<{ startDate: string; endDate: string }> => {
  if (payload.dateRangeFrom && payload.dateRangeTo) {
    return {
      startDate: isoToCompact(payload.dateRangeFrom),
      endDate: isoToCompact(payload.dateRangeTo),
    };
  }
  const latestFetchedAt = await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
    findLatestFetchedAt(client, tenantId, SOURCE),
  );
  const startDateObj = latestFetchedAt
    ? new Date(latestFetchedAt.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return { startDate: toDateStr(startDateObj), endDate: toDateStr(new Date()) };
};

const loadAccounts = async (
  tenantId: string,
  accountIds: ReadonlyArray<string> | null | undefined,
): Promise<BankAccountRow[]> =>
  withRlsContext({ cognitoSub: 'system', tenantId }, async (client) => {
    if (accountIds && accountIds.length > 0) {
      const result = await client.query<BankAccountRow>(
        `SELECT id, organization, account_number, connected_id, last_balance_krw::text
           FROM tenant_bank_accounts
          WHERE tenant_id = $1 AND is_active = TRUE AND id = ANY($2::uuid[])`,
        [tenantId, accountIds],
      );
      return result.rows;
    }
    const result = await client.query<BankAccountRow>(
      `SELECT id, organization, account_number, connected_id, last_balance_krw::text
         FROM tenant_bank_accounts
        WHERE tenant_id = $1 AND is_active = TRUE`,
      [tenantId],
    );
    return result.rows;
  });

export const handler = async (event: FetchPayload): Promise<FetchResult> => {
  const { tenantId, syncRunId } = event;
  const log = logger.child({ fn: 'codef-fetch', tenantId, syncRunId: syncRunId ?? null });

  if (syncRunId) {
    await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
      markSyncRunRunning(client, syncRunId),
    );
  }

  const results: AccountResult[] = [];

  try {
    const accounts = await loadAccounts(tenantId, event.accountIds ?? null);

    if (accounts.length === 0) {
      log.info('No active bank accounts for tenant');
      if (syncRunId) {
        await finalizeSyncRun(tenantId, syncRunId, []);
      }
      return { tenantId, syncRunId: syncRunId ?? null, fetched: 0, queued: 0, outcomes: [] };
    }

    const { startDate, endDate } = await resolveDateRange(tenantId, event);

    for (const account of accounts) {
      const result = await processAccount({
        tenantId,
        account,
        syncRunId: syncRunId ?? null,
        startDate,
        endDate,
      });
      log.info(
        {
          organization: account.organization,
          accountNumber: account.account_number,
          outcome: result.outcome,
          codefErrorCode: result.codefErrorCode,
        },
        'Account processed',
      );
      results.push(result);
    }

    const allNewIds = results.flatMap((r) => r.newRawTxIds);
    const totalFetched = results.reduce((sum, r) => sum + r.fetchedCount, 0);

    if (allNewIds.length > 0) {
      await sendTaskBatch(
        allNewIds.map((id) => ({ rawTransactionId: id, tenantId, syncRunId: syncRunId ?? null })),
      );

      await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
        markDispatched(client, allNewIds),
      );
    }

    if (syncRunId) {
      await recordOutcomes(tenantId, syncRunId, results);
      await finalizeSyncRun(tenantId, syncRunId, results);
    }

    log.info(
      { fetched: totalFetched, queued: allNewIds.length, accounts: results.length },
      'Codef fetch complete',
    );
    return {
      tenantId,
      syncRunId: syncRunId ?? null,
      fetched: totalFetched,
      queued: allNewIds.length,
      outcomes: results.map((r) => ({ organization: r.organization, outcome: r.outcome })),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ err, reason }, 'Codef fetch failed unexpectedly');

    if (syncRunId) {
      try {
        if (results.length > 0) {
          await recordOutcomes(tenantId, syncRunId, results);
        }
        await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
          failSyncRun(client, syncRunId, reason),
        );
      } catch (recordErr) {
        log.error({ err: recordErr }, 'Failed to record sync_run failure');
      }
    }
    throw err;
  }
};
