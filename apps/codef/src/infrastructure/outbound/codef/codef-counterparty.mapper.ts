// Mapper: pick the most merchant-like counterparty from a CODEF transaction row.

import type { CodefTxRow } from './codef.types.js';

const trimToUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const pickCounterparty = (row: CodefTxRow): string | undefined => {
  return (
    trimToUndefined(row.resAccountDesc3) ??
    trimToUndefined(row.resAccountDesc1) ??
    trimToUndefined(row.resAccountDesc4) ??
    trimToUndefined(row.resAccountDesc2)
  );
};

export const buildClassifierMemo = (row: CodefTxRow): string => {
  const parts = [
    trimToUndefined(row.resAccountDesc1),
    trimToUndefined(row.resAccountDesc2),
    trimToUndefined(row.resAccountDesc3),
    trimToUndefined(row.resAccountDesc4),
  ].filter((v): v is string => v !== undefined);
  return parts.join(' | ');
};
