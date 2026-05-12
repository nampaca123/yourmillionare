// Agent tool: fetches a single filing's draft details (boxes + applied rules) for the agent to drill into.

import type { Tool } from '@ym/agent-core';
import type { Pool } from 'pg';

const inputSchema = {
  type: 'object' as const,
  required: ['filingId'],
  properties: {
    filingId: { type: 'string', description: '컨텍스트에서 받은 신고 ID (filings_next_6m[].id)' },
  },
};

interface FilingDraftInput {
  filingId: string;
}

interface FilingRow {
  id: string;
  kind: string;
  period_start: string;
  period_end: string;
  due_date: string;
  status: string;
}

export interface FilingDraftToolResult {
  readonly summary: string;
  readonly filing: {
    id: string;
    kind: string;
    periodStart: string;
    periodEnd: string;
    dueDate: string;
    status: string;
  } | null;
}

export const buildGetFilingDraftTool = (pool: Promise<Pool>): Tool<FilingDraftInput, FilingDraftToolResult> => ({
  name: 'get_filing_draft_detail',
  description: '특정 신고서의 기간/마감일/상태를 조회한다. filingId는 사전 컨텍스트의 filings_next_6m에서 골라 사용.',
  inputSchema,
  execute: async (input, ctx) => {
    const client = await (await pool).connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.cognito_sub', $1, true)", [ctx.cognitoSub]);
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [ctx.tenantId]);
      const result = await client.query<FilingRow>(
        `SELECT id, kind::text AS kind, period_start::text, period_end::text,
                business_due_date::text AS due_date, status::text AS status
         FROM filing_obligation
         WHERE id = $1 AND tenant_id = $2`,
        [input.filingId, ctx.tenantId],
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      if (!row) return { summary: 'filing not found', filing: null };
      return {
        summary: `${row.kind} 신고 (마감 ${row.due_date}, 상태 ${row.status})`,
        filing: {
          id: row.id,
          kind: row.kind,
          periodStart: row.period_start,
          periodEnd: row.period_end,
          dueDate: row.due_date,
          status: row.status,
        },
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  },
});
