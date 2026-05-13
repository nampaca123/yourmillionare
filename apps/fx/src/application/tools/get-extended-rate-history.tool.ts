// Agent tool: returns USD/KRW closing observations over a longer window than the pre-injected 30-day context.

import type { Pool } from 'pg';
import type { Tool } from '@ym/agent-core';

const SUPPORTED_CURRENCIES = ['USD'] as const;
const MIN_DAYS = 1;
const MAX_DAYS = 365;

type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

const inputSchema = {
  type: 'object' as const,
  required: ['currency', 'days'],
  properties: {
    currency: { type: 'string', enum: [...SUPPORTED_CURRENCIES], description: '조회할 외화 (현재 USD만 지원)' },
    days: {
      type: 'number',
      description: '오늘 기준으로 며칠 전까지의 ECOS closing 환율을 가져올지 (1~365).',
    },
  },
};

interface GetExtendedRateHistoryInput {
  currency: SupportedCurrency;
  days: number;
}

interface RateRow {
  observed_on: string;
  rate: number;
}

export interface GetExtendedRateHistoryResult {
  readonly summary: string;
  readonly currency: SupportedCurrency;
  readonly fromDate: string;
  readonly toDate: string;
  readonly observations: ReadonlyArray<RateRow>;
}

const isSupportedCurrency = (c: string): c is SupportedCurrency =>
  (SUPPORTED_CURRENCIES as readonly string[]).includes(c);

export const buildGetExtendedRateHistoryTool = (
  pool: Promise<Pool>,
): Tool<GetExtendedRateHistoryInput, GetExtendedRateHistoryResult> => ({
  name: 'get_extended_rate_history',
  description:
    '한국은행 ECOS의 closing 환율을 1~365일 범위로 조회한다. monthly_outlook 시나리오에서 90~365일 추세를 확인할 때 호출.',
  inputSchema,
  execute: async (input) => {
    if (!isSupportedCurrency(input.currency)) {
      throw new Error(`Unsupported currency: ${input.currency}`);
    }
    if (!Number.isFinite(input.days) || input.days < MIN_DAYS || input.days > MAX_DAYS) {
      throw new Error(`days must be between ${MIN_DAYS} and ${MAX_DAYS}`);
    }
    const client = await (await pool).connect();
    try {
      const result = await client.query<{ observed_on: string; rate: string }>(
        `SELECT observed_on::text AS observed_on, rate::text AS rate
           FROM fx_observations
          WHERE quote_currency = $1 AND rate_type = 'closing'
            AND observed_on >= (current_date - ($2 || ' days')::interval)::date
       ORDER BY observed_on ASC`,
        [input.currency, input.days],
      );
      const observations: RateRow[] = result.rows.map((r) => ({
        observed_on: r.observed_on,
        rate: Number.parseFloat(r.rate),
      }));
      const fromDate = observations[0]?.observed_on ?? '(none)';
      const toDate = observations[observations.length - 1]?.observed_on ?? '(none)';
      return {
        summary: `${observations.length} observations between ${fromDate} and ${toDate}`,
        currency: input.currency,
        fromDate,
        toDate,
        observations,
      };
    } finally {
      client.release();
    }
  },
});
