// Pg implementation of the uncertain queue (pending journal_entry_draft enriched with raw_tx + bank account + account names).

import { withRlsContext } from './pg-rls.context.js';
import type {
  UncertainItem,
  UncertainLine,
  UncertainRepository,
} from '../../../application/ports/uncertain.repository.port.js';

const MASK_TAIL_VISIBLE = 4;

interface UncertainRow {
  raw_transaction_id: string;
  tenant_id: string;
  sync_run_id: string | null;
  source_bank_account_id: string | null;
  source_organization: string | null;
  source_account_number: string | null;
  occurred_at: Date;
  counterparty: string | null;
  amount: string;
  origin: 'heuristic' | 'ai_low_conf';
  confidence: string | null;
  rule_id: string | null;
  lines: unknown;
  created_at: Date;
}

const maskAccountNumber = (raw: string | null): string | null => {
  if (!raw) return null;
  if (raw.length <= MASK_TAIL_VISIBLE) return raw;
  const tail = raw.slice(-MASK_TAIL_VISIBLE);
  return `${'*'.repeat(raw.length - MASK_TAIL_VISIBLE)}${tail}`;
};

const parseLines = (raw: unknown): ReadonlyArray<UncertainLine> => {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const obj = entry as Record<string, unknown>;
    return {
      lineNo: typeof obj.lineNo === 'number' ? obj.lineNo : 0,
      accountCode: typeof obj.accountCode === 'string' ? obj.accountCode : '',
      accountName: typeof obj.accountName === 'string' ? obj.accountName : null,
      accountType: typeof obj.accountType === 'string' ? obj.accountType : null,
      debit: typeof obj.debit === 'number' ? obj.debit : Number.parseFloat(String(obj.debit ?? '0')),
      credit: typeof obj.credit === 'number' ? obj.credit : Number.parseFloat(String(obj.credit ?? '0')),
      memo: typeof obj.memo === 'string' ? obj.memo : null,
    };
  });
};

const directionOf = (lines: ReadonlyArray<UncertainLine>, fallbackAmount: number): 'debit' | 'credit' => {
  const cashLine = lines.find((l) => l.accountCode === '1001' || l.accountType === 'asset');
  if (cashLine) return cashLine.debit > 0 ? 'credit' : 'debit';
  return fallbackAmount < 0 ? 'debit' : 'credit';
};

export class PgUncertainRepository implements UncertainRepository {
  async list({ tenantId, limit }: { tenantId: string; limit: number }): Promise<ReadonlyArray<UncertainItem>> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<UncertainRow>(
        `SELECT jed.raw_transaction_id,
                jed.tenant_id,
                jed.sync_run_id,
                rt.bank_account_id   AS source_bank_account_id,
                tba.organization     AS source_organization,
                tba.account_number   AS source_account_number,
                rt.occurred_at,
                rt.counterparty,
                rt.amount::text,
                jed.origin,
                COALESCE(jed.ai_confidence, jed.heuristic_confidence)::text AS confidence,
                jed.rule_id,
                (
                  SELECT jsonb_agg(
                           jsonb_build_object(
                             'lineNo',      (line->>'lineNo')::int,
                             'accountCode', line->>'accountCode',
                             'accountName', a.name,
                             'accountType', a.type,
                             'debit',       COALESCE((line->>'debit')::float,  0),
                             'credit',      COALESCE((line->>'credit')::float, 0),
                             'memo',        line->>'memo'
                           )
                           ORDER BY (line->>'lineNo')::int
                         )
                    FROM jsonb_array_elements(jed.draft_lines) AS line
                    LEFT JOIN accounts a
                      ON a.tenant_id = jed.tenant_id
                     AND a.code = line->>'accountCode'
                )                    AS lines,
                jed.created_at
           FROM journal_entry_draft jed
           JOIN raw_transactions rt
             ON rt.id = jed.raw_transaction_id AND rt.tenant_id = jed.tenant_id
           LEFT JOIN tenant_bank_accounts tba ON tba.id = rt.bank_account_id
          WHERE jed.tenant_id = $1 AND jed.status = 'pending'
          ORDER BY jed.created_at DESC
          LIMIT $2`,
        [tenantId, limit],
      );

      return result.rows.map((row) => {
        const lines = parseLines(row.lines);
        const amount = Number.parseFloat(row.amount);
        return {
          rawTransactionId: row.raw_transaction_id,
          tenantId: row.tenant_id,
          syncRunId: row.sync_run_id,
          sourceAccount: {
            bankAccountId: row.source_bank_account_id,
            organization: row.source_organization,
            accountNumberMasked: maskAccountNumber(row.source_account_number),
          },
          occurredAt: row.occurred_at.toISOString(),
          entryDate: row.occurred_at.toISOString().slice(0, 10),
          counterparty: row.counterparty,
          memo: row.counterparty,
          amount: Math.abs(amount),
          direction: directionOf(lines, amount),
          currency: 'KRW',
          origin: row.origin,
          confidence: row.confidence !== null ? Number.parseFloat(row.confidence) : null,
          ruleId: row.rule_id,
          lines,
          createdAt: row.created_at.toISOString(),
        };
      });
    });
  }
}
