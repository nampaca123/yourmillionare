// JournalRepository port: persist journal entries (single connection batch helpers for worker TX composition).

import type { PoolClient } from 'pg';

import type { JournalEntry } from '../../domain/journal-entry.entity.js';

export interface JournalRepository {
  save(entry: JournalEntry, userId: string): Promise<JournalEntry>;
  existsBySourceRef(client: PoolClient, tenantId: string, rawTransactionId: string): Promise<boolean>;
  saveEntriesAtomically(client: PoolClient, entries: JournalEntry[]): Promise<JournalEntry[]>;
}
