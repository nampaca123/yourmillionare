// Journal domain errors: accounting-specific failure cases.

import { AppError } from '@ym/shared-errors';

export class UnbalancedJournalError extends AppError {
  constructor(debit: number, credit: number) {
    super(
      422,
      'UNBALANCED_JOURNAL',
      'Journal entry debit and credit totals must be equal.',
      `debit=${debit} credit=${credit}`,
    );
  }
}

export class InvalidAccountCodeError extends AppError {
  constructor(code: string) {
    super(422, 'INVALID_ACCOUNT_CODE', 'Account code not found in chart of accounts.', `code=${code}`);
  }
}

export class InvalidJournalLineError extends AppError {
  constructor(logMessage?: string) {
    super(
      422,
      'INVALID_JOURNAL_LINE',
      'Journal line amount rule violated (exactly one of debit or credit must be positive).',
      logMessage,
    );
  }
}
