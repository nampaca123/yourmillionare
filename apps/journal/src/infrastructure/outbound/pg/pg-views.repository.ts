// Pg implementation of the core-view aggregates with certain/uncertain breakdown on every monetary value.

import { withRlsContext } from './pg-rls.context.js';
import type { AmountBreakdown } from '@ym/reports-core';
import type {
  AccountBalanceCard,
  MonthlySummary,
  ReceivablesBoard,
  ReceivableCard,
  ReceivableStatus,
  ViewsRepository,
} from '../../../application/ports/views.repository.port.js';

const FORECAST_MOVING_AVERAGE_MONTHS = 3;

interface SummaryRow {
  income_certain: string;
  income_uncertain: string;
  expense_certain: string;
  expense_uncertain: string;
  cash_certain: string;
  cash_uncertain: string;
  forecast_certain: string;
  forecast_uncertain: string;
}

interface ReceivableRow {
  id: string;
  entry_date: string;
  counterparty: string | null;
  amount: string;
  due_date: string | null;
  status: ReceivableStatus;
  confidence_status: 'certain' | 'uncertain' | 'discarded';
}

interface BalanceRow {
  account_code: string;
  account_name: string;
  display_name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  currency: string;
  balance_certain: string;
  balance_uncertain: string;
}

const ymRange = (ym: string): { fromDate: string; toDate: string } => {
  const [y, m] = ym.split('-').map(Number);
  const fromDate = `${ym}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { fromDate, toDate: `${ym}-${String(lastDay).padStart(2, '0')}` };
};

const daysBetween = (from: string, to: string): number =>
  Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);

const toBreakdown = (certainRaw: string | null | undefined, uncertainRaw: string | null | undefined): AmountBreakdown => {
  const certain = Number.parseFloat(certainRaw ?? '0');
  const uncertain = Number.parseFloat(uncertainRaw ?? '0');
  return { certain, uncertain, total: certain + uncertain };
};

const bucketCards = (rows: ReadonlyArray<ReceivableRow>, today: string, dueSoonDays: number): ReceivablesBoard => {
  const pending: ReceivableCard[] = [];
  const dueSoon: ReceivableCard[] = [];
  const overdue: ReceivableCard[] = [];
  const collected: ReceivableCard[] = [];
  for (const row of rows) {
    if (row.confidence_status === 'discarded') continue;
    const daysOverdue = row.due_date ? daysBetween(row.due_date, today) : 0;
    const card: ReceivableCard = {
      entryId: row.id,
      entryDate: row.entry_date,
      counterparty: row.counterparty,
      amount: Number.parseFloat(row.amount),
      dueDate: row.due_date,
      daysOverdue,
      confidenceStatus: row.confidence_status,
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
           SELECT a.type AS account_type, jl.debit, jl.credit, je.confidence_status
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
                                    AND je.confidence_status IN ('certain', 'uncertain')
             JOIN accounts a ON a.tenant_id = je.tenant_id AND a.code = jl.account_code
            WHERE je.tenant_id = $1 AND je.entry_date BETWEEN $2 AND $3
         ),
         trailing_rev AS (
           SELECT je.confidence_status, jl.debit, jl.credit
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
                                    AND je.confidence_status IN ('certain', 'uncertain')
             JOIN accounts a ON a.tenant_id = je.tenant_id AND a.code = jl.account_code
            WHERE je.tenant_id = $1 AND a.type = 'revenue'
              AND je.entry_date >= ($2::date - INTERVAL '${FORECAST_MOVING_AVERAGE_MONTHS} months')
              AND je.entry_date <  $2::date
         ),
         cash_snap AS (
           SELECT je.confidence_status, a.normal_balance, jl.debit, jl.credit
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
                                    AND je.confidence_status IN ('certain', 'uncertain')
             JOIN accounts a ON a.tenant_id = je.tenant_id AND a.code = jl.account_code
            WHERE je.tenant_id = $1 AND je.entry_date <= $3 AND a.code IN ('1001','1002','1003')
         )
         SELECT
           COALESCE(SUM(CASE WHEN account_type = 'revenue' AND confidence_status = 'certain'   THEN credit - debit ELSE 0 END), 0)::text AS income_certain,
           COALESCE(SUM(CASE WHEN account_type = 'revenue' AND confidence_status = 'uncertain' THEN credit - debit ELSE 0 END), 0)::text AS income_uncertain,
           COALESCE(SUM(CASE WHEN account_type = 'expense' AND confidence_status = 'certain'   THEN debit - credit ELSE 0 END), 0)::text AS expense_certain,
           COALESCE(SUM(CASE WHEN account_type = 'expense' AND confidence_status = 'uncertain' THEN debit - credit ELSE 0 END), 0)::text AS expense_uncertain,
           (SELECT COALESCE(SUM(CASE WHEN confidence_status = 'certain'   AND normal_balance = 'debit'  THEN debit - credit
                                    WHEN confidence_status = 'certain'   AND normal_balance = 'credit' THEN credit - debit ELSE 0 END), 0)::text FROM cash_snap)
                                                                                                                                                          AS cash_certain,
           (SELECT COALESCE(SUM(CASE WHEN confidence_status = 'uncertain' AND normal_balance = 'debit'  THEN debit - credit
                                    WHEN confidence_status = 'uncertain' AND normal_balance = 'credit' THEN credit - debit ELSE 0 END), 0)::text FROM cash_snap)
                                                                                                                                                          AS cash_uncertain,
           GREATEST((SELECT COALESCE(SUM(CASE WHEN confidence_status = 'certain'   THEN credit - debit ELSE 0 END), 0) / ${FORECAST_MOVING_AVERAGE_MONTHS}::numeric FROM trailing_rev), 0)::text
                                                                                                                                                          AS forecast_certain,
           GREATEST((SELECT COALESCE(SUM(CASE WHEN confidence_status = 'uncertain' THEN credit - debit ELSE 0 END), 0) / ${FORECAST_MOVING_AVERAGE_MONTHS}::numeric FROM trailing_rev), 0)::text
                                                                                                                                                          AS forecast_uncertain
         FROM period_lines`,
        [tenantId, fromDate, toDate],
      );
      const row = result.rows[0];
      return {
        ym,
        income: toBreakdown(row?.income_certain, row?.income_uncertain),
        expense: toBreakdown(row?.expense_certain, row?.expense_uncertain),
        netCashBalance: toBreakdown(row?.cash_certain, row?.cash_uncertain),
        forecastNextMonth: toBreakdown(row?.forecast_certain, row?.forecast_uncertain),
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
                je.receivable_status AS status,
                je.confidence_status
           FROM journal_entries je
      LEFT JOIN journal_lines jl ON jl.entry_id = je.id AND jl.tenant_id = je.tenant_id
                                AND jl.account_code = '1101'
          WHERE je.tenant_id = $1 AND je.receivable_status IS NOT NULL
            AND je.confidence_status IN ('certain', 'uncertain')
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
                COALESCE(SUM(CASE WHEN je.confidence_status = 'certain'
                                  THEN (CASE WHEN a.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END)
                                  ELSE 0 END), 0)::text AS balance_certain,
                COALESCE(SUM(CASE WHEN je.confidence_status = 'uncertain'
                                  THEN (CASE WHEN a.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END)
                                  ELSE 0 END), 0)::text AS balance_uncertain
           FROM accounts a
      LEFT JOIN journal_lines   jl ON jl.tenant_id = a.tenant_id AND jl.account_code = a.code
      LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
                                  AND je.confidence_status IN ('certain', 'uncertain')
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
        balance: toBreakdown(row.balance_certain, row.balance_uncertain),
        currency: row.currency,
      }));
    });
  }
}
