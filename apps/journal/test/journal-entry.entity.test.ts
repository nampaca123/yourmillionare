// Unit tests for the JournalEntry entity balance validation.

import { describe, it, expect } from 'vitest';
import { assertBalanced, createJournalEntry, createJournalLine, UnbalancedJournalError } from '@ym/journal-core';

const debitLine = createJournalLine({ lineNo: 1, accountCode: '5401', debit: 50000, credit: 0 });
const creditLine = createJournalLine({ lineNo: 2, accountCode: '1002', debit: 0, credit: 50000 });

describe('assertBalanced', () => {
  it('should pass when debit total equals credit total', () => {
    expect(() => assertBalanced([debitLine, creditLine])).not.toThrow();
  });

  it('should throw UnbalancedJournalError when totals differ', () => {
    const mismatch = createJournalLine({ lineNo: 2, accountCode: '1002', debit: 0, credit: 40000 });
    expect(() => assertBalanced([debitLine, mismatch])).toThrow(UnbalancedJournalError);
  });
});

describe('createJournalEntry', () => {
  it('should create entry when lines are balanced', () => {
    const entry = createJournalEntry({
      tenantId: 'tenant-1',
      entryDate: '2026-05-07',
      source: 'manual',
      lines: [debitLine, creditLine],
    });
    expect(entry.lines).toHaveLength(2);
  });

  it('should throw UnbalancedJournalError when lines are unbalanced', () => {
    const unbalanced = createJournalLine({ lineNo: 2, accountCode: '1002', debit: 0, credit: 1 });
    expect(() =>
      createJournalEntry({ tenantId: 'tenant-1', entryDate: '2026-05-07', source: 'manual', lines: [debitLine, unbalanced] }),
    ).toThrow(UnbalancedJournalError);
  });
});
