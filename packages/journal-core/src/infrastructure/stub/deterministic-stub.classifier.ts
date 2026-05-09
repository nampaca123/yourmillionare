// Deterministic stub classifier: balanced two-line expense pattern for dev/E2E without Bedrock.

import type { TransactionClassifier, ClassifyInput, ClassifyResult } from '../../application/ports/transaction-classifier.port.js';
import { createJournalLine } from '../../domain/journal-line.value-object.js';

const STUB_MODEL_ID = 'stub.k-ifrs-expense';

export class DeterministicStubClassifier implements TransactionClassifier {
  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const amount = input.amount;
    const lines = [
      createJournalLine({ lineNo: 1, accountCode: '5501', debit: amount, credit: 0 }),
      createJournalLine({ lineNo: 2, accountCode: '1002', debit: 0, credit: amount }),
    ];
    return {
      lines,
      confidence: 0.85,
      modelId: STUB_MODEL_ID,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}
