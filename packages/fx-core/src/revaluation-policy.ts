// IAS 21 month-end revaluation policy — produces unrealised gain/loss journal lines from open FX balances.

import type { ExchangeRate } from './exchange-rate.value-object.js';

const ACCOUNT_FX_GAIN = '4301';
const ACCOUNT_FX_LOSS = '5701';
const SCALE = 1_000_000;

export interface OpenFxBalance {
  readonly accountCode: string;
  readonly fcyCurrency: string;
  readonly fcyAmount: number;
  readonly bookedKrw: number;
}

export interface RevaluationLine {
  readonly accountCode: string;
  readonly debit: number;
  readonly credit: number;
  readonly fcyCurrency: string;
  readonly fcyAmount: number;
  readonly fxRate: number;
  readonly memo: string;
}

export const buildRevaluationLines = (
  balances: ReadonlyArray<OpenFxBalance>,
  closingRates: ReadonlyMap<string, ExchangeRate>,
): ReadonlyArray<RevaluationLine> => {
  const lines: RevaluationLine[] = [];
  for (const balance of balances) {
    const rate = closingRates.get(balance.fcyCurrency);
    if (!rate) continue;
    const reBookedKrw = Math.round(balance.fcyAmount * rate.rate * SCALE) / SCALE;
    const delta = reBookedKrw - balance.bookedKrw;
    if (delta === 0) continue;
    const memo = `IAS 21 month-end revaluation ${balance.fcyCurrency} @ ${rate.effectiveDate}`;
    if (delta > 0) {
      lines.push({
        accountCode: balance.accountCode,
        debit: delta,
        credit: 0,
        fcyCurrency: balance.fcyCurrency,
        fcyAmount: balance.fcyAmount,
        fxRate: rate.rate,
        memo,
      });
      lines.push({ accountCode: ACCOUNT_FX_GAIN, debit: 0, credit: delta, fcyCurrency: balance.fcyCurrency, fcyAmount: 0, fxRate: rate.rate, memo });
    } else {
      const absDelta = -delta;
      lines.push({ accountCode: ACCOUNT_FX_LOSS, debit: absDelta, credit: 0, fcyCurrency: balance.fcyCurrency, fcyAmount: 0, fxRate: rate.rate, memo });
      lines.push({
        accountCode: balance.accountCode,
        debit: 0,
        credit: absDelta,
        fcyCurrency: balance.fcyCurrency,
        fcyAmount: balance.fcyAmount,
        fxRate: rate.rate,
        memo,
      });
    }
  }
  return lines;
};
