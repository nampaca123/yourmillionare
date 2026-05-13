// Use case: syncs one CODEF-linked foreign-currency bank account (fetch tx in FCY, KRW-convert via fx_observations, persist with fcy_* columns, refresh balance snapshot).

import type { PoolClient } from 'pg';
import { fetchForeignTransactions } from '../infrastructure/outbound/codef/codef-fx-bank.client.js';
import { findRateOnOrBefore } from '../infrastructure/outbound/pg/pg-fx-rate.repository.js';
import {
  upsertForeignBatch,
  type ForeignUpsertTx,
} from '../infrastructure/outbound/pg/pg-raw-transaction.repository.js';
import type { SyncRunAccountOutcome } from '../infrastructure/outbound/pg/pg-sync-run.repository.js';
import {
  mapCodefErrorToUserMessage,
  NO_CONNECTION_USER_MESSAGE,
} from './codef-error-messages.js';

const SOURCE_CODEF_FX = 'codef_fx';
const FX_RATE_MISSING_USER_MESSAGE =
  'No KRW conversion rate available for this period; please backfill fx_observations or try a later range.';

export interface ForeignAccountInput {
  id: string;
  organization: string;
  account_number: string;
  connected_id: string;
  currency: string;
  last_balance_krw: string | null;
}

export interface ForeignProcessResult {
  bankAccountId: string;
  organization: string;
  accountNumber: string;
  currency: string;
  accountKind: 'foreign';
  outcome: SyncRunAccountOutcome;
  codefErrorCode: string | null;
  codefErrorMessage: string | null;
  userMessage: string | null;
  fetchedCount: number;
  balanceUpdated: boolean;
  previousBalance: number | null;
  currentBalance: number | null;
  newRawTxIds: string[];
}

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

export interface ProcessForeignAccountDeps {
  client: PoolClient;
}

export const processForeignAccount = async (
  deps: ProcessForeignAccountDeps,
  params: {
    tenantId: string;
    account: ForeignAccountInput;
    syncRunId: string | null;
    startDate: string;
    endDate: string;
  },
): Promise<ForeignProcessResult> => {
  const { client } = deps;
  const { tenantId, account, syncRunId, startDate, endDate } = params;

  const previousBalance =
    account.last_balance_krw !== null ? Number.parseFloat(account.last_balance_krw) : null;
  const base: ForeignProcessResult = {
    bankAccountId: account.id,
    organization: account.organization,
    accountNumber: account.account_number,
    currency: account.currency,
    accountKind: 'foreign',
    outcome: 'success',
    codefErrorCode: null,
    codefErrorMessage: null,
    userMessage: null,
    fetchedCount: 0,
    balanceUpdated: false,
    previousBalance,
    currentBalance: null,
    newRawTxIds: [],
  };

  if (!account.connected_id) {
    return { ...base, outcome: 'no_connection', userMessage: NO_CONNECTION_USER_MESSAGE };
  }

  const res = await fetchForeignTransactions({
    connectedId: account.connected_id,
    organization: account.organization,
    accountNumber: account.account_number,
    startDate,
    endDate,
  });

  if (!res.ok) {
    return {
      ...base,
      outcome: 'codef_error',
      codefErrorCode: res.code,
      codefErrorMessage: res.message,
      userMessage: mapCodefErrorToUserMessage(account.organization, res.code, res.message),
    };
  }

  const todayRate = await findRateOnOrBefore(client, account.currency, toIsoDate(new Date()));
  if (!todayRate) {
    return { ...base, outcome: 'codef_error', userMessage: FX_RATE_MISSING_USER_MESSAGE };
  }

  let balanceUpdated = false;
  let currentBalanceKrw: number | null = null;
  if (res.data.balance) {
    currentBalanceKrw = res.data.balance.currentBalanceFcy * todayRate.rate;
    await client.query(
      `UPDATE tenant_bank_accounts
          SET last_balance_krw  = $1,
              balance_synced_at = $2
        WHERE tenant_id = $3 AND organization = $4 AND account_number = $5
          AND account_kind = 'foreign'`,
      [
        currentBalanceKrw,
        res.data.balance.syncedAt,
        tenantId,
        account.organization,
        account.account_number,
      ],
    );
    balanceUpdated = true;
  }

  if (res.data.transactions.length === 0) {
    return {
      ...base,
      outcome: balanceUpdated ? 'balance_only' : 'empty_result',
      balanceUpdated,
      currentBalance: currentBalanceKrw,
    };
  }

  const rateCache = new Map<string, number>();
  const enriched: ForeignUpsertTx[] = [];
  for (const tx of res.data.transactions) {
    const day = toIsoDate(tx.occurredAt);
    let rate = rateCache.get(day);
    if (rate === undefined) {
      const lookup = await findRateOnOrBefore(client, account.currency, day);
      if (!lookup) {
        return { ...base, outcome: 'codef_error', userMessage: FX_RATE_MISSING_USER_MESSAGE };
      }
      rate = lookup.rate;
      rateCache.set(day, rate);
    }
    enriched.push({ tx, amountKrw: tx.fcyAmount * rate, fxRate: rate });
  }

  const newIds = await upsertForeignBatch({
    client,
    tenantId,
    source: SOURCE_CODEF_FX,
    bankAccountId: account.id,
    syncRunId,
    fcyCurrency: account.currency,
    rows: enriched,
  });

  return {
    ...base,
    outcome: 'success',
    balanceUpdated,
    currentBalance: currentBalanceKrw,
    fetchedCount: res.data.transactions.length,
    newRawTxIds: newIds,
  };
};
