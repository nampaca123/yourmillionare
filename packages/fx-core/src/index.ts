// Barrel export for @ym/fx-core.

export type {
  ExchangeRate,
  ExchangeRateClient,
  FxRateType,
  FxSource,
} from './exchange-rate.value-object.js';
export { ExchangeRateUnavailableError, resolveRateWithWalkback } from './exchange-rate.value-object.js';

export type { OpenFxBalance, RevaluationLine } from './revaluation-policy.js';
export { buildRevaluationLines } from './revaluation-policy.js';
