// Port: read a single pending draft and mark it accepted in one transactional path.

import type { PoolClient } from 'pg';

export interface DraftToAccept {
  readonly rawTransactionId: string;
  readonly tenantId: string;
  readonly draftLines: ReadonlyArray<{
    lineNo: number;
    accountCode: string;
    debit: number;
    credit: number;
    memo: string | null;
  }>;
  readonly origin: 'heuristic' | 'ai_low_conf';
  readonly aiConfidence: number | null;
  readonly ruleId: string | null;
  readonly occurredAt: Date;
  readonly counterparty: string | null;
}

export interface DraftRepository {
  findPending(input: { tenantId: string; rawTransactionId: string }): Promise<DraftToAccept | null>;
  acceptInTransaction(input: {
    tenantId: string;
    rawTransactionId: string;
    journalEntryId: string;
    correctedLines: ReadonlyArray<{ lineNo: number; accountCode: string; debit: number; credit: number; memo?: string | null | undefined }> | null;
    aiConfidence: number | null;
    aiModel: string | null;
    aiInputTokens: number | null;
    aiOutputTokens: number | null;
    counterparty: string | null;
    entryDate: string;
    work: (client: PoolClient) => Promise<void>;
  }): Promise<void>;
  markDiscarded(input: { tenantId: string; rawTransactionId: string }): Promise<boolean>;
}
