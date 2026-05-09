// Repository: raw_transactions upsert, dispatch mark, and single-row fetch.

import type { PoolClient } from 'pg';
import type { RawBankTransaction } from '../codef/codef.types.js';

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
}

export const upsertBatch = async (
  client: PoolClient,
  tenantId: string,
  source: string,
  txs: RawBankTransaction[],
): Promise<string[]> => {
  if (txs.length === 0) return [];

  const ids: string[] = [];
  for (const tx of txs) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO raw_transactions
         (tenant_id, source, external_id, occurred_at, amount, counterparty, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, source, external_id) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        source,
        tx.externalId,
        tx.occurredAt.toISOString(),
        tx.amount,
        tx.counterparty ?? null,
        JSON.stringify(tx.rawPayload),
      ],
    );
    if (result.rows[0]) {
      ids.push(result.rows[0].id);
    }
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
    `SELECT id, tenant_id, source, external_id, occurred_at, amount, counterparty, raw_payload, fetched_at, dispatched_at
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
