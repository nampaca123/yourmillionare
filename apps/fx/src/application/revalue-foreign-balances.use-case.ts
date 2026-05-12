// Use case: IAS 21 month-end revaluation — reads open FX balances, applies closing rates, posts unrealised gain/loss entry.

import type { PoolClient } from 'pg';
import { buildRevaluationLines, resolveRateWithWalkback, type ExchangeRate, type ExchangeRateClient, type OpenFxBalance } from '@ym/fx-core';
import { getPool } from '../infrastructure/outbound/pg/pg-pool.client.js';

const FX_SOURCE = 'fx_revaluation';

export interface RevaluationResult {
  readonly asOf: string;
  readonly entryId: string | null;
  readonly lines: ReadonlyArray<{ accountCode: string; debit: number; credit: number; fcyCurrency: string; fxRate: number }>;
  readonly currenciesProcessed: ReadonlyArray<string>;
  readonly netKrwImpact: number;
}

interface OpenBalanceRow {
  account_code: string;
  fcy_currency: string;
  fcy_amount: string;
  booked_krw: string;
}

const setRlsContext = async (
  client: PoolClient,
  tenantId: string,
): Promise<void> => {
  await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
};

const readOpenBalances = async (
  client: PoolClient,
  tenantId: string,
): Promise<ReadonlyArray<OpenFxBalance>> => {
  const result = await client.query<OpenBalanceRow>(
    `SELECT jl.account_code,
            jl.fcy_currency,
            COALESCE(SUM(jl.fcy_amount * CASE WHEN jl.debit > 0 THEN 1 ELSE -1 END), 0)::text AS fcy_amount,
            COALESCE(SUM(jl.debit - jl.credit), 0)::text AS booked_krw
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.tenant_id = $1
        AND jl.fcy_currency IS NOT NULL
        AND je.source != $2
   GROUP BY jl.account_code, jl.fcy_currency
     HAVING COALESCE(SUM(jl.fcy_amount * CASE WHEN jl.debit > 0 THEN 1 ELSE -1 END), 0) != 0`,
    [tenantId, FX_SOURCE],
  );
  return result.rows.map((r) => ({
    accountCode: r.account_code,
    fcyCurrency: r.fcy_currency,
    fcyAmount: Number.parseFloat(r.fcy_amount),
    bookedKrw: Number.parseFloat(r.booked_krw),
  }));
};

const resolveClosingRates = async (
  ratesClient: ExchangeRateClient,
  currencies: ReadonlyArray<string>,
  asOf: string,
): Promise<Map<string, ExchangeRate>> => {
  const rates = new Map<string, ExchangeRate>();
  for (const ccy of currencies) {
    const rate = await resolveRateWithWalkback(ratesClient, ccy, asOf);
    rates.set(ccy, rate);
  }
  return rates;
};

export class RevalueForeignBalancesUseCase {
  constructor(private readonly ratesClient: ExchangeRateClient) {}

  async execute({ tenantId, asOf }: { tenantId: string; asOf: string }): Promise<RevaluationResult> {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setRlsContext(client, tenantId);

      const balances = await readOpenBalances(client, tenantId);
      if (balances.length === 0) {
        await client.query('COMMIT');
        return { asOf, entryId: null, lines: [], currenciesProcessed: [], netKrwImpact: 0 };
      }

      const currencies = Array.from(new Set(balances.map((b) => b.fcyCurrency)));
      const rates = await resolveClosingRates(this.ratesClient, currencies, asOf);
      const lines = buildRevaluationLines(balances, rates);

      if (lines.length === 0) {
        await client.query('COMMIT');
        return { asOf, entryId: null, lines: [], currenciesProcessed: currencies, netKrwImpact: 0 };
      }

      const entryResult = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (tenant_id, entry_date, source, source_ref_id, description, ai_confidence, ai_model)
         VALUES ($1, $2::date, $3, NULL, $4, 1.0, 'deterministic.fx-revaluation')
         RETURNING id`,
        [tenantId, asOf, FX_SOURCE, `IAS 21 외화환산 평가 (asOf=${asOf})`],
      );
      const entryId = entryResult.rows[0]?.id;
      if (!entryId) throw new Error('Failed to insert journal_entry for fx revaluation');

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        await client.query(
          `INSERT INTO journal_lines
             (entry_id, tenant_id, line_no, account_code, debit, credit, fcy_currency, fcy_amount, fx_rate, memo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            entryId,
            tenantId,
            i + 1,
            line.accountCode,
            line.debit,
            line.credit,
            line.fcyCurrency,
            line.fcyAmount,
            line.fxRate,
            line.memo,
          ],
        );
      }

      await client.query('COMMIT');

      const netKrwImpact = lines.reduce((s, l) => {
        if (l.accountCode === '4301') return s + l.credit;
        if (l.accountCode === '5701') return s - l.debit;
        return s;
      }, 0);

      return {
        asOf,
        entryId,
        currenciesProcessed: currencies,
        netKrwImpact,
        lines: lines.map((l) => ({
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
          fcyCurrency: l.fcyCurrency,
          fxRate: l.fxRate,
        })),
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
