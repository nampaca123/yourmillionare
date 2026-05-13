// JournalEntry entity: double-entry header with balanced debit/credit validation.

import type { JournalLine } from './journal-line.value-object.js';
import { UnbalancedJournalError } from './journal.errors.js';

export type JournalSource =
  | 'codef_bank'
  | 'codef_card'
  | 'codef_fx'
  | 'codef_hometax'
  | 'codef_tax_invoice'
  | 'fx_revaluation'
  | 'manual';

export type ConfidenceStatus = 'certain' | 'uncertain' | 'discarded';

export type ClassificationOrigin = 'manual' | 'heuristic' | 'ai' | 'ai_low_conf';

export interface JournalEntry {
  readonly id?: string;
  readonly tenantId: string;
  readonly entryDate: string;
  readonly postingDate?: string;
  readonly source: JournalSource;
  readonly description?: string;
  readonly lines: JournalLine[];
  readonly aiConfidence?: number;
  readonly aiModel?: string;
  readonly createdBy?: string;
  readonly sourceRefId?: string;
  readonly confidenceStatus?: ConfidenceStatus;
  readonly confidence?: number;
  readonly origin?: ClassificationOrigin;
  readonly syncRunId?: string;
  readonly entryStatus?: 'draft' | 'posted' | 'reversed';
}

export const assertBalanced = (lines: JournalLine[]): void => {
  const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    throw new UnbalancedJournalError(totalDebit, totalCredit);
  }
};

export const createJournalEntry = (params: Omit<JournalEntry, 'id'>): JournalEntry => {
  assertBalanced(params.lines);
  return { ...params };
};
