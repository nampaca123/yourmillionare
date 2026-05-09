// CreateJournalEntryUseCase: manual double-entry creation with balance validation.

import type { CacheProjector, JournalEntry, JournalLine, JournalRepository } from '@ym/journal-core';
import { createJournalEntry, InvalidAccountCodeError } from '@ym/journal-core';
import type { AccountRepository } from './ports/account.repository.port.js';

export class CreateJournalEntryUseCase {
  constructor(
    private readonly journals: JournalRepository,
    private readonly accounts: AccountRepository,
    private readonly cache: CacheProjector,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    entryDate: string;
    description?: string;
    lines: JournalLine[];
  }): Promise<JournalEntry> {
    const distinctCodes = [...new Set(params.lines.map((l) => l.accountCode))];
    const missing = await this.accounts.findMissingCodes(params.tenantId, params.userId, distinctCodes);
    if (missing.length > 0) throw new InvalidAccountCodeError(missing.join(','));

    const entry = createJournalEntry({
      tenantId: params.tenantId,
      entryDate: params.entryDate,
      source: 'manual',
      lines: params.lines,
      createdBy: params.userId,
      ...(params.description !== undefined ? { description: params.description } : {}),
    });
    const saved = await this.journals.save(entry, params.userId);
    try {
      await this.cache.projectEntry(params.tenantId, saved);
    } catch {
      // Non-fatal: cache projection failure must not roll back a committed journal entry.
    }
    return saved;
  }
}
