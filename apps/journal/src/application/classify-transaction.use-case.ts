// ClassifyTransactionUseCase: AI-classifies a transaction, checks daily limit, persists entry.

import type {
  ClassifyInput,
  JournalEntry,
  JournalRepository,
  TransactionClassifier,
} from '@ym/journal-core';
import { createJournalEntry } from '@ym/journal-core';
import type { CostCounter } from './ports/cost-counter.port.js';
import { RateLimitError } from '@ym/shared-errors';

const DAILY_LIMIT_DEFAULT = 100;

export class ClassifyTransactionUseCase {
  constructor(
    private readonly classifier: TransactionClassifier,
    private readonly journals: JournalRepository,
    private readonly costs: CostCounter,
    private readonly dailyLimit = DAILY_LIMIT_DEFAULT,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    input: ClassifyInput;
  }): Promise<JournalEntry> {
    const today = new Date().toISOString().slice(0, 10);
    const { allowed } = await this.costs.incrementAndCheck(params.userId, today, this.dailyLimit);
    if (!allowed) throw new RateLimitError('BEDROCK_DAILY_LIMIT_EXCEEDED', 'Daily AI classification limit reached. Try again tomorrow.');

    const result = await this.classifier.classify(params.input);

    const entry = createJournalEntry({
      tenantId: params.tenantId,
      entryDate: params.input.date,
      source: 'manual',
      description: params.input.memo,
      lines: result.lines,
      aiConfidence: result.confidence,
      aiModel: result.modelId,
      createdBy: params.userId,
    });

    return this.journals.save(entry, params.userId);
  }
}
