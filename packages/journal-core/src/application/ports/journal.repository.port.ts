// JournalRepository port: persist journal entries (single connection batch helpers for worker TX composition).

import type { PoolClient } from 'pg';

import type { JournalEntry } from '../../domain/journal-entry.entity.js';

export interface JournalEntrySummary {
  id: string;
  entryDate: string;
  source: string;
  description: string | null;
  aiConfidence: number | null;
  aiModel: string | null;
  sourceRefId: string | null;
  lines: Array<{
    lineNo: number;
    accountCode: string;
    debit: number;
    credit: number;
    memo: string | null;
  }>;
}

export interface JournalRepository {
  save(entry: JournalEntry, userId: string): Promise<JournalEntry>;
  existsBySourceRef(client: PoolClient, tenantId: string, rawTransactionId: string): Promise<boolean>;
  saveEntriesAtomically(client: PoolClient, entries: JournalEntry[]): Promise<JournalEntry[]>;
  list(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    fromDate: string;
    toDate: string;
    limit: number;
    offset: number;
  }): Promise<JournalEntrySummary[]>;
}
