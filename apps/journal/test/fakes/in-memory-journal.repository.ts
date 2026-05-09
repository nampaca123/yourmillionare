// In-memory JournalRepository for unit tests.

import type { PoolClient } from 'pg';
import type { JournalEntry, JournalRepository } from '@ym/journal-core';

export class InMemoryJournalRepository implements JournalRepository {
  private entries: JournalEntry[] = [];

  async existsBySourceRef(_c: PoolClient, tenantId: string, rawTransactionId: string): Promise<boolean> {
    return this.entries.some((e) => e.tenantId === tenantId && e.sourceRefId === rawTransactionId);
  }

  async saveEntriesAtomically(_c: PoolClient, batch: JournalEntry[]): Promise<JournalEntry[]> {
    const saved: JournalEntry[] = [];
    for (const entry of batch) {
      if (!entry.id) continue;
      if (this.entries.some((e) => e.id === entry.id)) continue;
      this.entries.push(entry);
      saved.push(entry);
    }
    return saved;
  }

  async save(entry: JournalEntry, _userId: string): Promise<JournalEntry> {
    const persisted = { ...entry, id: entry.id ?? `entry-${this.entries.length + 1}` };
    this.entries.push(persisted);
    return persisted;
  }

  all(): JournalEntry[] {
    return [...this.entries];
  }
}
