// Persists ECOS responses into fx_observations and reads them as a fast cache layer.

import type { Pool } from 'pg';
import type { ExchangeRate } from '@ym/fx-core';
import { getPool } from './pg-pool.client.js';

interface ObservationRow {
  observed_on: string;
  base_currency: string;
  quote_currency: string;
  rate: string;
  rate_type: string;
  source: string;
}

const toExchangeRate = (row: ObservationRow, requestedDate: string): ExchangeRate => ({
  baseCurrency: row.base_currency,
  quoteCurrency: row.quote_currency,
  rate: Number.parseFloat(row.rate),
  rateType: row.rate_type as ExchangeRate['rateType'],
  requestedDate,
  effectiveDate: row.observed_on,
  source: row.source as ExchangeRate['source'],
});

export class PgFxObservationsRepository {
  private async pool(): Promise<Pool> {
    return getPool();
  }

  async findLatestOnOrBefore(input: {
    quoteCurrency: string;
    onOrBefore: string;
    rateType?: string;
  }): Promise<ExchangeRate | null> {
    const client = await this.pool();
    const result = await client.query<ObservationRow>(
      `SELECT observed_on::text, base_currency, quote_currency, rate::text, rate_type, source
         FROM fx_observations
        WHERE quote_currency = $1
          AND rate_type = $2
          AND observed_on <= $3
     ORDER BY observed_on DESC
        LIMIT 1`,
      [input.quoteCurrency, input.rateType ?? 'closing', input.onOrBefore],
    );
    const row = result.rows[0];
    return row ? toExchangeRate(row, input.onOrBefore) : null;
  }

  async listRange(input: {
    quoteCurrency: string;
    fromDate: string;
    toDate: string;
    rateType?: string;
  }): Promise<ReadonlyArray<ExchangeRate>> {
    const client = await this.pool();
    const result = await client.query<ObservationRow>(
      `SELECT observed_on::text, base_currency, quote_currency, rate::text, rate_type, source
         FROM fx_observations
        WHERE quote_currency = $1
          AND rate_type = $2
          AND observed_on BETWEEN $3 AND $4
     ORDER BY observed_on ASC`,
      [input.quoteCurrency, input.rateType ?? 'closing', input.fromDate, input.toDate],
    );
    return result.rows.map((row) => toExchangeRate(row, row.observed_on));
  }

  async upsertMany(rates: ReadonlyArray<ExchangeRate>): Promise<void> {
    if (rates.length === 0) return;
    const client = await this.pool();
    await client.query('BEGIN');
    try {
      for (const r of rates) {
        await client.query(
          `INSERT INTO fx_observations (observed_on, base_currency, quote_currency, rate, rate_type, source)
           VALUES ($1::date, $2, $3, $4, $5, $6)
           ON CONFLICT (observed_on, base_currency, quote_currency, rate_type, source) DO UPDATE
             SET rate = EXCLUDED.rate, fetched_at = now()`,
          [r.effectiveDate, r.baseCurrency, r.quoteCurrency, r.rate, r.rateType, r.source],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
}
