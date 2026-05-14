// Unit tests for the CODEF counterparty/memo mapper.

import { describe, it, expect } from 'vitest';
import {
  buildClassifierMemo,
  pickCounterparty,
} from '../src/infrastructure/outbound/codef/codef-counterparty.mapper.js';
import type { CodefTxRow } from '../src/infrastructure/outbound/codef/codef.types.js';

const baseRow: CodefTxRow = {
  resAccountTrDate: '20260513',
  resAccountTrTime: '131057',
  resAccountOut: '3600',
  resAccountIn: '0',
  resAfterTranBalance: '382760',
};

describe('pickCounterparty', () => {
  it('should prefer resAccountDesc3 when present because it carries the merchant name for Shinhan card rows', () => {
    const row: CodefTxRow = {
      ...baseRow,
      resAccountDesc1: '',
      resAccountDesc2: '신한체',
      resAccountDesc3: '빽다방+강남역',
      resAccountDesc4: '원신한',
    };

    const result = pickCounterparty(row);

    expect(result).toBe('빽다방+강남역');
  });

  it('should fall back to resAccountDesc1 when resAccountDesc3 is missing', () => {
    const row: CodefTxRow = { ...baseRow, resAccountDesc1: 'ACME Corp' };

    const result = pickCounterparty(row);

    expect(result).toBe('ACME Corp');
  });

  it('should fall back to resAccountDesc4 when resAccountDesc1 and resAccountDesc3 are missing', () => {
    const row: CodefTxRow = { ...baseRow, resAccountDesc4: 'processor-only' };

    const result = pickCounterparty(row);

    expect(result).toBe('processor-only');
  });

  it('should fall back to resAccountDesc2 only as a last resort', () => {
    const row: CodefTxRow = { ...baseRow, resAccountDesc2: '신한체' };

    const result = pickCounterparty(row);

    expect(result).toBe('신한체');
  });

  it('should treat whitespace-only strings as missing', () => {
    const row: CodefTxRow = {
      ...baseRow,
      resAccountDesc1: '   ',
      resAccountDesc3: '\t',
      resAccountDesc2: '신한체',
    };

    const result = pickCounterparty(row);

    expect(result).toBe('신한체');
  });

  it('should return undefined when all desc fields are missing or empty', () => {
    const result = pickCounterparty(baseRow);

    expect(result).toBeUndefined();
  });

  it('should trim surrounding whitespace before returning', () => {
    const row: CodefTxRow = { ...baseRow, resAccountDesc3: '  스타벅스 강남점  ' };

    const result = pickCounterparty(row);

    expect(result).toBe('스타벅스 강남점');
  });
});

describe('buildClassifierMemo', () => {
  it('should join all non-empty desc fields in order with a pipe separator', () => {
    const row: CodefTxRow = {
      ...baseRow,
      resAccountDesc1: '',
      resAccountDesc2: '신한체',
      resAccountDesc3: '빽다방+강남역',
      resAccountDesc4: '원신한',
    };

    const result = buildClassifierMemo(row);

    expect(result).toBe('신한체 | 빽다방+강남역 | 원신한');
  });

  it('should return an empty string when no desc fields are present', () => {
    const result = buildClassifierMemo(baseRow);

    expect(result).toBe('');
  });

  it('should include all four desc fields when each has content', () => {
    const row: CodefTxRow = {
      ...baseRow,
      resAccountDesc1: 'd1',
      resAccountDesc2: 'd2',
      resAccountDesc3: 'd3',
      resAccountDesc4: 'd4',
    };

    const result = buildClassifierMemo(row);

    expect(result).toBe('d1 | d2 | d3 | d4');
  });
});
