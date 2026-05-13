// PostgreSQL JournalRepository: saveEntriesAtomically and existsBySourceRef for pipeline workers.

import type { PoolClient } from 'pg';
import { ValidationError } from '@ym/shared-errors';
import type { JournalEntry } from '../../domain/journal-entry.entity.js';
import type { JournalRepository } from '../../application/ports/journal.repository.port.js';

export class PgJournalRepository implements Pick<JournalRepository, 'existsBySourceRef' | 'saveEntriesAtomically'> {
  async existsBySourceRef(client: PoolClient, tenantId: string, rawTransactionId: string): Promise<boolean> {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM journal_entries
        WHERE tenant_id = $1 AND source_ref_id = $2::uuid
      ) AS exists`,
      [tenantId, rawTransactionId],
    );
    return result.rows[0]?.exists ?? false;
  }

  async saveEntriesAtomically(client: PoolClient, entries: JournalEntry[]): Promise<JournalEntry[]> {
    const saved: JournalEntry[] = [];
    for (const entry of entries) {
      if (!entry.id) throw new ValidationError('Journal entry id required for atomic batch save.');
      const postingDate = entry.postingDate ?? entry.entryDate;

      const entryResult = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (id, tenant_id, entry_date, posting_date, source, description, ai_confidence, ai_model,
            created_by, source_ref_id, status, confidence_status, confidence, origin, sync_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          entry.id,
          entry.tenantId,
          entry.entryDate,
          postingDate,
          entry.source,
          entry.description ?? null,
          entry.aiConfidence ?? null,
          entry.aiModel ?? null,
          entry.createdBy ?? null,
          entry.sourceRefId ?? null,
          entry.entryStatus ?? 'posted',
          entry.confidenceStatus ?? 'certain',
          entry.confidence ?? entry.aiConfidence ?? null,
          entry.origin ?? null,
          entry.syncRunId ?? null,
        ],
      );

      const entryId = entryResult.rows[0]?.id;
      if (!entryId) continue;

      for (const line of entry.lines) {
        await client.query(
          `INSERT INTO journal_lines (entry_id, tenant_id, line_no, account_code, debit, credit, memo)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entryId, entry.tenantId, line.lineNo, line.accountCode, line.debit, line.credit, line.memo ?? null],
        );
      }

      saved.push({ ...entry, id: entryId });
    }
    return saved;
  }
}
