// Pg implementation of EntriesRepository: unified journal_entries reads + line edits + confidence_status transitions.

import type { PoolClient } from 'pg';
import { withRlsContext } from './pg-rls.context.js';
import type {
  ClassificationOrigin,
  ConfidenceStatus,
  CorrectedLineInput,
  EntriesRepository,
  EntryRow,
  ListEntriesInput,
} from '../../../application/ports/entries.repository.port.js';

interface EntryDbRow {
  id: string;
  tenant_id: string;
  entry_date: Date;
  posting_date: Date;
  source: string;
  source_ref_id: string | null;
  description: string | null;
  status: 'draft' | 'posted' | 'reversed';
  confidence_status: ConfidenceStatus;
  confidence: string | null;
  origin: ClassificationOrigin | null;
  sync_run_id: string | null;
  ai_model: string | null;
  created_at: Date;
  created_by: string | null;
  lines: unknown;
}

interface LineJson {
  line_no: number;
  account_code: string;
  account_name: string | null;
  account_type: string | null;
  debit: string | number;
  credit: string | number;
  memo: string | null;
}

const formatDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseNumber = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number.parseFloat(v);
};

const mapRow = (row: EntryDbRow): EntryRow => {
  const lines = Array.isArray(row.lines) ? (row.lines as LineJson[]) : [];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    entryDate: formatDate(row.entry_date),
    postingDate: formatDate(row.posting_date),
    source: row.source,
    sourceRefId: row.source_ref_id,
    description: row.description,
    status: row.status,
    confidenceStatus: row.confidence_status,
    confidence: row.confidence === null ? null : Number.parseFloat(row.confidence),
    origin: row.origin,
    syncRunId: row.sync_run_id,
    aiModel: row.ai_model,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      accountCode: l.account_code,
      accountName: l.account_name,
      accountType: l.account_type,
      debit: parseNumber(l.debit),
      credit: parseNumber(l.credit),
      memo: l.memo,
    })),
  };
};

const BASE_SELECT = `
  SELECT je.id, je.tenant_id, je.entry_date, je.posting_date, je.source, je.source_ref_id, je.description,
         je.status, je.confidence_status, je.confidence::text, je.origin, je.sync_run_id, je.ai_model,
         je.created_at, je.created_by,
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'line_no',      jl.line_no,
                     'account_code', jl.account_code,
                     'account_name', a.name,
                     'account_type', a.type,
                     'debit',        jl.debit,
                     'credit',       jl.credit,
                     'memo',         jl.memo
                   ) ORDER BY jl.line_no)
              FROM journal_lines jl
              LEFT JOIN accounts a ON a.tenant_id = jl.tenant_id AND a.code = jl.account_code
             WHERE jl.entry_id = je.id),
           '[]'::json
         ) AS lines
    FROM journal_entries je
`;

export class PgEntriesRepository implements EntriesRepository {
  async list(input: ListEntriesInput): Promise<ReadonlyArray<EntryRow>> {
    return withRlsContext(
      { userId: input.userId, cognitoSub: input.cognitoSub, tenantId: input.tenantId },
      async (client: PoolClient) => {
        const filterClause =
          input.confidenceStatus === 'all' ? '' : 'AND je.confidence_status = $6';
        const params: (string | number)[] = [
          input.tenantId,
          input.fromDate,
          input.toDate,
          input.limit,
          input.offset,
        ];
        if (input.confidenceStatus !== 'all') params.push(input.confidenceStatus);

        const result = await client.query<EntryDbRow>(
          `${BASE_SELECT}
           WHERE je.tenant_id = $1
             AND je.entry_date BETWEEN $2 AND $3
             ${filterClause}
           ORDER BY je.entry_date DESC, je.id DESC
           LIMIT $4 OFFSET $5`,
          params,
        );
        return result.rows.map(mapRow);
      },
    );
  }

  async findById({
    tenantId,
    entryId,
  }: {
    tenantId: string;
    entryId: string;
  }): Promise<EntryRow | null> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<EntryDbRow>(
        `${BASE_SELECT} WHERE je.tenant_id = $1 AND je.id = $2`,
        [tenantId, entryId],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    });
  }

  async replaceLines({
    tenantId,
    entryId,
    lines,
    work,
  }: {
    tenantId: string;
    entryId: string;
    lines: ReadonlyArray<CorrectedLineInput>;
    work?: (client: PoolClient) => Promise<void>;
  }): Promise<void> {
    await withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      await client.query(
        `DELETE FROM journal_lines WHERE entry_id = $1 AND tenant_id = $2`,
        [entryId, tenantId],
      );
      for (const line of lines) {
        await client.query(
          `INSERT INTO journal_lines (entry_id, tenant_id, line_no, account_code, debit, credit, memo)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entryId, tenantId, line.lineNo, line.accountCode, line.debit, line.credit, line.memo ?? null],
        );
      }
      if (work) await work(client);
    });
  }

  async updateConfidenceStatus({
    tenantId,
    entryId,
    fromStatus,
    toStatus,
    promoteToPosted,
  }: {
    tenantId: string;
    entryId: string;
    fromStatus: ConfidenceStatus;
    toStatus: ConfidenceStatus;
    promoteToPosted: boolean;
  }): Promise<boolean> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query(
        `UPDATE journal_entries
            SET confidence_status = $4,
                status = CASE WHEN $5::boolean THEN 'posted'::journal_status ELSE status END,
                posting_date = CASE WHEN $5::boolean THEN now()::date ELSE posting_date END
          WHERE id = $1 AND tenant_id = $2 AND confidence_status = $3`,
        [entryId, tenantId, fromStatus, toStatus, promoteToPosted],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
