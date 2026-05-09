// CacheProjector port: write-through projection into DynamoDB transaction cache after Aurora commit.

import type { JournalEntry } from '../../domain/journal-entry.entity.js';

export interface CacheProjector {
  projectEntry(tenantId: string, entry: JournalEntry): Promise<void>;
}
