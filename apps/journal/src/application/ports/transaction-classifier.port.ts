// TransactionClassifier port: AI classification of a transaction into journal lines.

import type { JournalLine } from '../../domain/journal-line.value-object.js';

export interface ClassifyInput {
  readonly date: string;
  readonly amount: number;
  readonly counterparty: string;
  readonly memo: string;
}

export interface ClassifyResult {
  readonly lines: JournalLine[];
  readonly confidence: number;
  readonly modelId: string;
}

export interface TransactionClassifier {
  classify(input: ClassifyInput): Promise<ClassifyResult>;
}
