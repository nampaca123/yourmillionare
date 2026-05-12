// Unit tests for the FX revaluation policy and ECOS walk-back resolver.

import { describe, it, expect } from 'vitest';
import {
  buildRevaluationLines,
  resolveRateWithWalkback,
  ExchangeRateUnavailableError,
  type ExchangeRate,
  type ExchangeRateClient,
  type OpenFxBalance,
} from '../src/index.js';

const usdRate = (rate: number, effectiveDate: string, requestedDate = effectiveDate): ExchangeRate => ({
  baseCurrency: 'KRW',
  quoteCurrency: 'USD',
  rate,
  rateType: 'closing',
  requestedDate,
  effectiveDate,
  source: 'ECOS',
});

describe('buildRevaluationLines', () => {
  it('should emit a gain entry when closing rate moves the asset balance up', () => {
    const balances: OpenFxBalance[] = [
      { accountCode: '1402', fcyCurrency: 'USD', fcyAmount: 100, bookedKrw: 130_000 },
    ];
    const rates = new Map<string, ExchangeRate>([['USD', usdRate(1400, '2026-05-31')]]);

    const lines = buildRevaluationLines(balances, rates);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountCode: '1402', debit: 10_000, credit: 0 });
    expect(lines[1]).toMatchObject({ accountCode: '4301', debit: 0, credit: 10_000 });
  });

  it('should emit a loss entry when closing rate moves the asset balance down', () => {
    const balances: OpenFxBalance[] = [
      { accountCode: '1402', fcyCurrency: 'USD', fcyAmount: 100, bookedKrw: 145_000 },
    ];
    const rates = new Map<string, ExchangeRate>([['USD', usdRate(1400, '2026-05-31')]]);

    const lines = buildRevaluationLines(balances, rates);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountCode: '5701', debit: 5_000, credit: 0 });
    expect(lines[1]).toMatchObject({ accountCode: '1402', debit: 0, credit: 5_000 });
  });

  it('should skip the balance when no closing rate is supplied for its currency', () => {
    const balances: OpenFxBalance[] = [
      { accountCode: '1402', fcyCurrency: 'JPY', fcyAmount: 1000, bookedKrw: 9_000 },
    ];
    const rates = new Map<string, ExchangeRate>([['USD', usdRate(1400, '2026-05-31')]]);

    const lines = buildRevaluationLines(balances, rates);

    expect(lines).toEqual([]);
  });

  it('should skip when revaluation produces zero delta', () => {
    const balances: OpenFxBalance[] = [
      { accountCode: '1402', fcyCurrency: 'USD', fcyAmount: 100, bookedKrw: 140_000 },
    ];
    const rates = new Map<string, ExchangeRate>([['USD', usdRate(1400, '2026-05-31')]]);

    const lines = buildRevaluationLines(balances, rates);

    expect(lines).toEqual([]);
  });
});

describe('resolveRateWithWalkback', () => {
  const buildClient = (rateByDate: Record<string, number>): ExchangeRateClient => ({
    getRate: async ({ date }) => {
      const r = rateByDate[date];
      return r === undefined ? null : usdRate(r, date);
    },
    getRange: async () => [],
  });

  it('should return the rate for the requested date when available', async () => {
    const client = buildClient({ '2026-05-08': 1450.8 });

    const result = await resolveRateWithWalkback(client, 'USD', '2026-05-08');

    expect(result.rate).toBe(1450.8);
    expect(result.requestedDate).toBe('2026-05-08');
    expect(result.effectiveDate).toBe('2026-05-08');
  });

  it('should walk back to the previous business day when the requested date has no rate', async () => {
    const client = buildClient({ '2026-05-08': 1452.3 });

    const result = await resolveRateWithWalkback(client, 'USD', '2026-05-10');

    expect(result.rate).toBe(1452.3);
    expect(result.requestedDate).toBe('2026-05-10');
    expect(result.effectiveDate).toBe('2026-05-08');
  });

  it('should throw ExchangeRateUnavailableError when no rate exists within the walk-back window', async () => {
    const client = buildClient({});

    const promise = resolveRateWithWalkback(client, 'USD', '2026-05-10');

    await expect(promise).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
  });
});
