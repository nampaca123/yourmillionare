// PostgreSQL JournalRepository: persists journal entries and lines in a single transaction.

import type { PoolClient } from 'pg';
import type { JournalEntry, JournalRepository, JournalEntrySummary } from '@ym/journal-core';
import { ValidationError } from '@ym/shared-errors';
import { withRlsContext } from './pg-rls.context.js';

interface EntryRow {
  id: string;
}

interface ListRow {
  id: string;
  entry_date: Date;
  source: string;
  description: string | null;
  ai_confidence: string | null;
  ai_model: string | null;
  source_ref_id: string | null;
  lines: Array<{
    line_no: number;
    account_code: string;
    debit: string;
    credit: string;
    memo: string | null;
  }>;
}

const formatDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export class PgJournalRepository implements JournalRepository {
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
      const entryResult = await client.query<EntryRow>(
        `INSERT INTO journal_entries
           (id, tenant_id, entry_date, posting_date, source, description, ai_confidence, ai_model, created_by, source_ref_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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

  async save(entry: JournalEntry, userId: string): Promise<JournalEntry> {
    return withRlsContext({ userId, tenantId: entry.tenantId }, async (c: PoolClient) => {
      const postingDate = entry.postingDate ?? entry.entryDate;
      const entryResult = await c.query<EntryRow>(
        `INSERT INTO journal_entries
           (tenant_id, entry_date, posting_date, source, description, ai_confidence, ai_model, created_by, source_ref_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          entry.tenantId,
          entry.entryDate,
          postingDate,
          entry.source,
          entry.description ?? null,
          entry.aiConfidence ?? null,
          entry.aiModel ?? null,
          entry.createdBy ?? null,
          entry.sourceRefId ?? null,
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

  async list(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    fromDate: string;
    toDate: string;
    limit: number;
    offset: number;
  }): Promise<JournalEntrySummary[]> {
    return withRlsContext(
      { userId: params.userId, cognitoSub: params.cognitoSub, tenantId: params.tenantId },
      async (c: PoolClient) => {
        const result = await c.query<ListRow>(
          `SELECT je.id,
                  je.entry_date,
                  je.source,
                  je.description,
                  je.ai_confidence,
                  je.ai_model,
                  je.source_ref_id,
                  COALESCE(
                    json_agg(
                      json_build_object(
                        'line_no', jl.line_no,
                        'account_code', jl.account_code,
                        'debit', jl.debit,
                        'credit', jl.credit,
                        'memo', jl.memo
                      ) ORDER BY jl.line_no
                    ) FILTER (WHERE jl.entry_id IS NOT NULL),
                    '[]'::json
                  ) AS lines
           FROM journal_entries je
           LEFT JOIN journal_lines jl ON jl.entry_id = je.id
           WHERE je.tenant_id = $1
             AND je.entry_date BETWEEN $2 AND $3
           GROUP BY je.id
           ORDER BY je.entry_date DESC, je.id DESC
           LIMIT $4 OFFSET $5`,
          [params.tenantId, params.fromDate, params.toDate, params.limit, params.offset],
        );
        return result.rows.map((row) => ({
          id: row.id,
          entryDate: formatDate(row.entry_date),
          source: row.source,
          description: row.description,
          aiConfidence: row.ai_confidence === null ? null : Number(row.ai_confidence),
          aiModel: row.ai_model,
          sourceRefId: row.source_ref_id,
          lines: row.lines.map((l) => ({
            lineNo: l.line_no,
            accountCode: l.account_code,
            debit: Number(l.debit),
            credit: Number(l.credit),
            memo: l.memo,
          })),
        }));
      },
    );
  }
}
