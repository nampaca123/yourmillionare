// CreateJournalEntryUseCase: manual double-entry creation with balance validation.

import { createJournalEntry } from '../domain/journal-entry.entity.js';
import type { JournalEntry } from '../domain/journal-entry.entity.js';
import type { JournalLine } from '../domain/journal-line.value-object.js';
import type { JournalRepository } from './ports/journal.repository.port.js';

export class CreateJournalEntryUseCase {
  constructor(private readonly journals: JournalRepository) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    entryDate: string;
    description?: string;
    lines: JournalLine[];
  }): Promise<JournalEntry> {
    const entry = createJournalEntry({
      tenantId: params.tenantId,
      entryDate: params.entryDate,
      source: 'manual',
      description: params.description,
      lines: params.lines,
      createdBy: params.userId,
    });
    return this.journals.save(entry, params.userId);
  }
}
