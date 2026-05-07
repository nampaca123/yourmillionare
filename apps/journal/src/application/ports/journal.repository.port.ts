// JournalRepository port: persist and retrieve journal entries.

import type { JournalEntry } from '../../domain/journal-entry.entity.js';

export interface JournalRepository {
  save(entry: JournalEntry, userId: string): Promise<JournalEntry>;
}
