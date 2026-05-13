// Repository: read-only fx_observations lookup for KRW conversion during FX sync.

import type { PoolClient } from 'pg';

export interface RateLookup {
  rate: number;
  observedOn: string;
}

const RATE_TYPE_CLOSING = 'closing';

export const findRateOnOrBefore = async (
  client: PoolClient,
  quoteCurrency: string,
  isoDate: string,
): Promise<RateLookup | null> => {
  const result = await client.query<{ rate: string; observed_on: string }>(
    `SELECT rate::text, observed_on::text
       FROM fx_observations
      WHERE quote_currency = $1
        AND rate_type = $2
        AND observed_on <= $3::date
   ORDER BY observed_on DESC
      LIMIT 1`,
    [quoteCurrency, RATE_TYPE_CLOSING, isoDate],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { rate: Number.parseFloat(row.rate), observedOn: row.observed_on };
};
