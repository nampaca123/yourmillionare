// Fake TransactionClassifier for unit tests with configurable responses.

import type { ClassifyInput, ClassifyResult, TransactionClassifier } from '@ym/journal-core';
import { createJournalLine } from '@ym/journal-core';

export class FakeTransactionClassifier implements TransactionClassifier {
  private response: ClassifyResult = {
    lines: [
      createJournalLine({ lineNo: 1, accountCode: '5401', debit: 50000, credit: 0 }),
      createJournalLine({ lineNo: 2, accountCode: '1002', debit: 0, credit: 50000 }),
    ],
    confidence: 0.95,
    modelId: 'fake-model',
  };

  setResponse(response: ClassifyResult): void {
    this.response = response;
  }

  async classify(_input: ClassifyInput): Promise<ClassifyResult> {
    return this.response;
  }
}
