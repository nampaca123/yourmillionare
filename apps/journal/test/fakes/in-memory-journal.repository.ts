// In-memory JournalRepository for unit tests.

import type { JournalEntry } from '../../src/domain/journal-entry.entity.js';
import type { JournalRepository } from '../../src/application/ports/journal.repository.port.js';

export class InMemoryJournalRepository implements JournalRepository {
  private entries: JournalEntry[] = [];

  async save(entry: JournalEntry): Promise<JournalEntry> {
    const saved = { ...entry, id: `entry-${this.entries.length + 1}` };
    this.entries.push(saved);
    return saved;
  }

  all(): JournalEntry[] {
    return [...this.entries];
  }
}
