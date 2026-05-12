// Pg implementation of the 4 core-view aggregates against journal_entries + journal_lines + accounts + journal_entry_draft.

import { withRlsContext } from './pg-rls.context.js';
import type {
  AccountBalanceCard,
  JournalEntryDraft,
  MonthlySummary,
  ReceivablesBoard,
  ReceivableCard,
  ReceivableStatus,
  ViewsRepository,
} from '../../../application/ports/views.repository.port.js';

const FORECAST_MOVING_AVERAGE_MONTHS = 3;

interface SummaryRow {
  income: string;
  expense: string;
  net_cash_balance: string;
  forecast_next_month: string;
}

interface ReceivableRow {
  id: string;
  entry_date: string;
  counterparty: string | null;
  amount: string;
  due_date: string | null;
  status: ReceivableStatus;
}

interface BalanceRow {
  account_code: string;
  account_name: string;
  display_name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  currency: string;
  balance: string;
}

interface DraftRow {
  raw_transaction_id: string;
  tenant_id: string;
  draft_lines: unknown;
  heuristic_confidence: string | null;
  rule_id: string | null;
  created_at: Date;
}

const ymRange = (ym: string): { fromDate: string; toDate: string } => {
  const [y, m] = ym.split('-').map(Number);
  const fromDate = `${ym}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { fromDate, toDate: `${ym}-${String(lastDay).padStart(2, '0')}` };
};

const daysBetween = (from: string, to: string): number =>
  Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);

const bucketCards = (rows: ReadonlyArray<ReceivableRow>, today: string, dueSoonDays: number): ReceivablesBoard => {
  const pending: ReceivableCard[] = [];
  const dueSoon: ReceivableCard[] = [];
  const overdue: ReceivableCard[] = [];
  const collected: ReceivableCard[] = [];
  for (const row of rows) {
    const daysOverdue = row.due_date ? daysBetween(row.due_date, today) : 0;
    const card: ReceivableCard = {
      entryId: row.id,
      entryDate: row.entry_date,
      counterparty: row.counterparty,
      amount: Number.parseFloat(row.amount),
      dueDate: row.due_date,
      daysOverdue,
    };
    if (row.status === 'COLLECTED') collected.push(card);
    else if (row.status === 'OVERDUE' || daysOverdue > 0) overdue.push(card);
    else if (row.due_date && daysBetween(today, row.due_date) <= dueSoonDays) dueSoon.push(card);
    else pending.push(card);
  }
  return { pending, dueSoon, overdue, collected };
};

export class PgViewsRepository implements ViewsRepository {
  async monthlySummary({ tenantId, ym }: { tenantId: string; ym: string }): Promise<MonthlySummary> {
    const { fromDate, toDate } = ymRange(ym);
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<SummaryRow>(
        `WITH period_lines AS (
           SELECT a.type AS account_type, jl.debit, jl.credit
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
           JOIN accounts a ON a.tenant_id = je.tenant_id AND a.code = jl.account_code
           WHERE je.tenant_id = $1 AND je.entry_date BETWEEN $2 AND $3
         ),
         trailing_period AS (
           SELECT je.entry_date,
                  SUM(CASE WHEN a.type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END) AS net_revenue
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
           JOIN accounts a ON a.tenant_id = je.tenant_id AND a.code = jl.account_code
           WHERE je.tenant_id = $1
             AND je.entry_date >= ($2::date - INTERVAL '${FORECAST_MOVING_AVERAGE_MONTHS} months')
             AND je.entry_date < $2::date
           GROUP BY je.entry_date
         )
         SELECT
           COALESCE(SUM(CASE WHEN account_type = 'revenue' THEN credit - debit ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN account_type = 'expense' THEN debit - credit ELSE 0 END), 0) AS expense,
           COALESCE((
             SELECT SUM(CASE WHEN a.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END)
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
             JOIN accounts a ON a.tenant_id = je.tenant_id AND a.code = jl.account_code
             WHERE je.tenant_id = $1 AND je.entry_date <= $3 AND a.code IN ('1001','1002','1003')
           ), 0) AS net_cash_balance,
           COALESCE((SELECT AVG(net_revenue) FROM trailing_period), 0) * ${FORECAST_MOVING_AVERAGE_MONTHS} AS forecast_next_month
         FROM period_lines`,
        [tenantId, fromDate, toDate],
      );
      const row = result.rows[0];
      return {
        ym,
        income: Number.parseFloat(row?.income ?? '0'),
        expense: Number.parseFloat(row?.expense ?? '0'),
        netCashBalance: Number.parseFloat(row?.net_cash_balance ?? '0'),
        forecastNextMonth: Number.parseFloat(row?.forecast_next_month ?? '0'),
        currency: 'KRW',
      };
    });
  }

  async listReceivables({
    tenantId,
    today,
    dueSoonDays,
  }: {
    tenantId: string;
    today: string;
    dueSoonDays: number;
  }): Promise<ReceivablesBoard> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<ReceivableRow>(
        `SELECT je.id, je.entry_date::text, je.receivable_counterparty AS counterparty,
                COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::text AS amount,
                je.receivable_due_date::text AS due_date,
                je.receivable_status AS status
           FROM journal_entries je
      LEFT JOIN journal_lines jl ON jl.entry_id = je.id AND jl.tenant_id = je.tenant_id
                                AND jl.account_code = '1101'
          WHERE je.tenant_id = $1 AND je.receivable_status IS NOT NULL
       GROUP BY je.id
       ORDER BY je.receivable_due_date NULLS LAST, je.entry_date DESC`,
        [tenantId],
      );
      return bucketCards(result.rows, today, dueSoonDays);
    });
  }

  async updateReceivableStatus({
    tenantId,
    entryId,
    status,
  }: {
    tenantId: string;
    entryId: string;
    status: ReceivableStatus;
    collectedAt?: string;
  }): Promise<void> {
    await withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      await client.query(
        `UPDATE journal_entries SET receivable_status = $3
          WHERE id = $1 AND tenant_id = $2 AND receivable_status IS NOT NULL`,
        [entryId, tenantId, status],
      );
    });
  }

  async listAccountBalances({ tenantId }: { tenantId: string }): Promise<ReadonlyArray<AccountBalanceCard>> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<BalanceRow>(
        `SELECT a.code AS account_code, a.name AS account_name, a.display_name, a.type, a.currency,
                COALESCE(
                  SUM(CASE WHEN a.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END),
                  0
                )::text AS balance
           FROM accounts a
      LEFT JOIN journal_lines jl ON jl.tenant_id = a.tenant_id AND jl.account_code = a.code
          WHERE a.tenant_id = $1 AND a.is_active
       GROUP BY a.code, a.name, a.display_name, a.type, a.currency, a.normal_balance
       ORDER BY a.code`,
        [tenantId],
      );
      return result.rows.map((row) => ({
        accountCode: row.account_code,
        accountName: row.account_name,
        displayName: row.display_name,
        type: row.type,
        balance: Number.parseFloat(row.balance),
        currency: row.currency,
      }));
    });
  }

  async listDrafts({ tenantId }: { tenantId: string }): Promise<ReadonlyArray<JournalEntryDraft>> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<DraftRow>(
        `SELECT raw_transaction_id, tenant_id, draft_lines, heuristic_confidence::text, rule_id, created_at
           FROM journal_entry_draft
          WHERE tenant_id = $1
       ORDER BY created_at DESC
          LIMIT 200`,
        [tenantId],
      );
      return result.rows.map((row) => ({
        rawTransactionId: row.raw_transaction_id,
        tenantId: row.tenant_id,
        draftLines: row.draft_lines as JournalEntryDraft['draftLines'],
        heuristicConfidence: row.heuristic_confidence ? Number.parseFloat(row.heuristic_confidence) : null,
        ruleId: row.rule_id,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }
}
