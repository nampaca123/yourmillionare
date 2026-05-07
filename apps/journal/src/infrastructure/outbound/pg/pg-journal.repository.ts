// PostgreSQL JournalRepository: persists journal entries and lines in a single transaction.

import type { PoolClient } from 'pg';
import type { JournalEntry } from '../../../domain/journal-entry.entity.js';
import type { JournalRepository } from '../../../application/ports/journal.repository.port.js';
import { withRlsContext } from './pg-rls.context.js';

interface EntryRow {
  id: string;
}

export class PgJournalRepository implements JournalRepository {
  async save(entry: JournalEntry, userId: string): Promise<JournalEntry> {
    return withRlsContext({ userId, tenantId: entry.tenantId }, async (c: PoolClient) => {
      const entryResult = await c.query<EntryRow>(
        `INSERT INTO journal_entries
           (tenant_id, entry_date, posting_date, source, description, ai_confidence, ai_model, created_by)
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          entry.tenantId,
          entry.entryDate,
          entry.source,
          entry.description ?? null,
          entry.aiConfidence ?? null,
          entry.aiModel ?? null,
          entry.createdBy ?? null,
        ],
      );

      const entryId = entryResult.rows[0]?.id;
      if (!entryId) throw new Error('Failed to insert journal entry');

      for (const line of entry.lines) {
        await c.query(
          `INSERT INTO journal_lines (entry_id, tenant_id, line_no, account_code, debit, credit, memo)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entryId, entry.tenantId, line.lineNo, line.accountCode, line.debit, line.credit, line.memo ?? null],
        );
      }

      return { ...entry, id: entryId };
    });
  }
}
