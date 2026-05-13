// Repository: raw_transactions upsert (with sync_run + bank_account tagging + optional FCY columns), dispatch mark, and single-row fetch.

import type { PoolClient } from 'pg';
import type { RawBankTransaction, RawForeignTransaction } from '../codef/codef.types.js';

export interface RawTransactionRow {
  id: string;
  tenant_id: string;
  source: string;
  external_id: string;
  occurred_at: Date;
  amount: number;
  counterparty: string | null;
  raw_payload: unknown;
  fetched_at: Date;
  dispatched_at: Date | null;
  first_sync_run_id: string | null;
  bank_account_id: string | null;
}

export interface UpsertBatchInput {
  client: PoolClient;
  tenantId: string;
  source: string;
  bankAccountId: string;
  syncRunId: string | null;
  txs: ReadonlyArray<RawBankTransaction>;
}

export const upsertBatch = async ({
  client,
  tenantId,
  source,
  bankAccountId,
  syncRunId,
  txs,
}: UpsertBatchInput): Promise<string[]> => {
  if (txs.length === 0) return [];

  const ids: string[] = [];
  for (const tx of txs) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO raw_transactions
         (tenant_id, source, external_id, occurred_at, amount, counterparty, raw_payload,
          first_sync_run_id, bank_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, source, external_id) DO UPDATE
         SET bank_account_id = COALESCE(raw_transactions.bank_account_id, EXCLUDED.bank_account_id)
       RETURNING id, xmax = 0 AS inserted`,
      [
        tenantId,
        source,
        tx.externalId,
        tx.occurredAt.toISOString(),
        tx.amount,
        tx.counterparty ?? null,
        JSON.stringify(tx.rawPayload),
        syncRunId,
        bankAccountId,
      ],
    );
    const row = result.rows[0] as { id: string; inserted: boolean } | undefined;
    if (row?.inserted) {
      ids.push(row.id);
    }
  }
  return ids;
};

export interface ForeignUpsertTx {
  tx: RawForeignTransaction;
  amountKrw: number;
  fxRate: number;
}

export interface UpsertForeignBatchInput {
  client: PoolClient;
  tenantId: string;
  source: string;
  bankAccountId: string;
  syncRunId: string | null;
  fcyCurrency: string;
  rows: ReadonlyArray<ForeignUpsertTx>;
}

export const upsertForeignBatch = async ({
  client,
  tenantId,
  source,
  bankAccountId,
  syncRunId,
  fcyCurrency,
  rows,
}: UpsertForeignBatchInput): Promise<string[]> => {
  if (rows.length === 0) return [];

  const ids: string[] = [];
  for (const { tx, amountKrw, fxRate } of rows) {
    const result = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO raw_transactions
         (tenant_id, source, external_id, occurred_at, amount, counterparty, raw_payload,
          first_sync_run_id, bank_account_id, fcy_currency, fcy_amount, fx_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id, source, external_id) DO UPDATE
         SET bank_account_id = COALESCE(raw_transactions.bank_account_id, EXCLUDED.bank_account_id)
       RETURNING id, xmax = 0 AS inserted`,
      [
        tenantId,
        source,
        tx.externalId,
        tx.occurredAt.toISOString(),
        amountKrw,
        tx.counterparty ?? null,
        JSON.stringify(tx.rawPayload),
        syncRunId,
        bankAccountId,
        fcyCurrency,
        tx.fcyAmount,
        fxRate,
      ],
    );
    const row = result.rows[0];
    if (row?.inserted) ids.push(row.id);
  }
  return ids;
};

export const markDispatched = async (client: PoolClient, ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE raw_transactions
     SET dispatched_at = NOW()
     WHERE id = ANY($1::uuid[]) AND dispatched_at IS NULL`,
    [ids],
  );
};

export const findById = async (client: PoolClient, id: string): Promise<RawTransactionRow | undefined> => {
  const result = await client.query<RawTransactionRow>(
    `SELECT id, tenant_id, source, external_id, occurred_at, amount, counterparty, raw_payload,
            fetched_at, dispatched_at, first_sync_run_id, bank_account_id
     FROM raw_transactions
     WHERE id = $1`,
    [id],
  );
  return result.rows[0];
};

export const findLatestFetchedAt = async (
  client: PoolClient,
  tenantId: string,
  source: string,
): Promise<Date | undefined> => {
  const result = await client.query<{ fetched_at: Date }>(
    `SELECT MAX(fetched_at) AS fetched_at
     FROM raw_transactions
     WHERE tenant_id = $1 AND source = $2`,
    [tenantId, source],
  );
  return result.rows[0]?.fetched_at ?? undefined;
};
