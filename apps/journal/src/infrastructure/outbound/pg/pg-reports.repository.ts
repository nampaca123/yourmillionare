// Pg-backed aggregates for K-IFRS report builders. Each account amount carries certain/uncertain/total breakdown.

import { withRlsContext } from './pg-rls.context.js';
import type {
  AmountBreakdown,
  BalanceSheetInputRow,
  JournalLineAggregate,
  PnlInputRow,
} from '@ym/reports-core';
import type { ReportsRepository } from '../../../application/ports/reports.repository.port.js';

interface AccountAggRow {
  account_code: string;
  account_name: string;
  account_type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normal_balance: 'debit' | 'credit';
  is_current: boolean | null;
  total_debit_certain: string;
  total_credit_certain: string;
  total_debit_uncertain: string;
  total_credit_uncertain: string;
}

const COGS_PREFIX = '5001';
const NON_OPERATING_PREFIXES = ['41', '42', '43', '57', '58'];
const INCOME_TAX_PREFIX = '5601';
const CASH_ACCOUNTS = ['1001', '1002', '1003', '1004'];

const classifyPnlRow = (row: AccountAggRow): PnlInputRow['accountKind'] => {
  if (row.account_type === 'revenue') return 'revenue';
  if (row.account_code === INCOME_TAX_PREFIX) return 'income_tax';
  if (row.account_code === COGS_PREFIX) return 'cogs';
  if (NON_OPERATING_PREFIXES.some((p) => row.account_code.startsWith(p))) return 'non_operating';
  return 'operating_expense';
};

const num = (raw: string): number => Number.parseFloat(raw);

const balanceFor = (
  row: AccountAggRow,
  side: 'certain' | 'uncertain',
): number => {
  const d = num(side === 'certain' ? row.total_debit_certain : row.total_debit_uncertain);
  const c = num(side === 'certain' ? row.total_credit_certain : row.total_credit_uncertain);
  return row.normal_balance === 'debit' ? d - c : c - d;
};

const breakdownAmount = (row: AccountAggRow): AmountBreakdown => {
  const certain = balanceFor(row, 'certain');
  const uncertain = balanceFor(row, 'uncertain');
  return { certain, uncertain, total: certain + uncertain };
};

const breakdownDebit = (row: AccountAggRow): AmountBreakdown => {
  const certain = num(row.total_debit_certain);
  const uncertain = num(row.total_debit_uncertain);
  return { certain, uncertain, total: certain + uncertain };
};

const breakdownCredit = (row: AccountAggRow): AmountBreakdown => {
  const certain = num(row.total_credit_certain);
  const uncertain = num(row.total_credit_uncertain);
  return { certain, uncertain, total: certain + uncertain };
};

// SQL fragments — every aggregation splits by je.confidence_status.
const BREAKDOWN_AGG = `
  COALESCE(SUM(CASE WHEN je.confidence_status = 'certain'   THEN jl.debit  ELSE 0 END), 0)::text AS total_debit_certain,
  COALESCE(SUM(CASE WHEN je.confidence_status = 'certain'   THEN jl.credit ELSE 0 END), 0)::text AS total_credit_certain,
  COALESCE(SUM(CASE WHEN je.confidence_status = 'uncertain' THEN jl.debit  ELSE 0 END), 0)::text AS total_debit_uncertain,
  COALESCE(SUM(CASE WHEN je.confidence_status = 'uncertain' THEN jl.credit ELSE 0 END), 0)::text AS total_credit_uncertain
`;

export class PgReportsRepository implements ReportsRepository {
  async pnlAggregates({
    tenantId,
    fromDate,
    toDate,
  }: {
    tenantId: string;
    fromDate: string;
    toDate: string;
  }): Promise<ReadonlyArray<PnlInputRow>> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<AccountAggRow>(
        `SELECT a.code AS account_code, a.name AS account_name, a.type AS account_type,
                a.normal_balance, a.is_current,
                ${BREAKDOWN_AGG}
           FROM accounts a
      LEFT JOIN journal_lines jl ON jl.tenant_id = a.tenant_id AND jl.account_code = a.code
      LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
                                  AND je.entry_date BETWEEN $2 AND $3
                                  AND je.confidence_status IN ('certain', 'uncertain')
          WHERE a.tenant_id = $1 AND a.type IN ('revenue', 'expense')
       GROUP BY a.code, a.name, a.type, a.normal_balance, a.is_current
       HAVING COALESCE(SUM(jl.debit), 0) > 0 OR COALESCE(SUM(jl.credit), 0) > 0
       ORDER BY a.code`,
        [tenantId, fromDate, toDate],
      );
      return result.rows.map((row) => ({
        accountCode: row.account_code,
        accountName: row.account_name,
        accountKind: classifyPnlRow(row),
        amount: breakdownAmount(row),
      }));
    });
  }

  async balanceSheetAggregates({
    tenantId,
    asOf,
  }: {
    tenantId: string;
    asOf: string;
  }): Promise<ReadonlyArray<BalanceSheetInputRow>> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<AccountAggRow>(
        `SELECT a.code AS account_code, a.name AS account_name, a.type AS account_type,
                a.normal_balance, a.is_current,
                ${BREAKDOWN_AGG}
           FROM accounts a
      LEFT JOIN journal_lines jl ON jl.tenant_id = a.tenant_id AND jl.account_code = a.code
      LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
                                  AND je.entry_date <= $2
                                  AND je.confidence_status IN ('certain', 'uncertain')
          WHERE a.tenant_id = $1 AND a.type IN ('asset', 'liability', 'equity')
       GROUP BY a.code, a.name, a.type, a.normal_balance, a.is_current
       ORDER BY a.code`,
        [tenantId, asOf],
      );
      return result.rows.map((row) => ({
        accountCode: row.account_code,
        accountName: row.account_name,
        accountKind: row.account_type as 'asset' | 'liability' | 'equity',
        isCurrent: row.is_current,
        amount: breakdownAmount(row),
      }));
    });
  }

  async trialBalanceAggregates({
    tenantId,
    asOf,
  }: {
    tenantId: string;
    asOf: string;
  }): Promise<ReadonlyArray<JournalLineAggregate>> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<AccountAggRow>(
        `SELECT a.code AS account_code, a.name AS account_name, a.type AS account_type,
                a.normal_balance, a.is_current,
                ${BREAKDOWN_AGG}
           FROM accounts a
      LEFT JOIN journal_lines jl ON jl.tenant_id = a.tenant_id AND jl.account_code = a.code
      LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
                                  AND je.entry_date <= $2
                                  AND je.confidence_status IN ('certain', 'uncertain')
          WHERE a.tenant_id = $1
       GROUP BY a.code, a.name, a.type, a.normal_balance, a.is_current
       ORDER BY a.code`,
        [tenantId, asOf],
      );
      return result.rows.map((row) => ({
        accountCode: row.account_code,
        accountName: row.account_name,
        normalBalance: row.normal_balance,
        totalDebit: breakdownDebit(row),
        totalCredit: breakdownCredit(row),
      }));
    });
  }

  async cashSnapshot({ tenantId, asOf }: { tenantId: string; asOf: string }): Promise<AmountBreakdown> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<{
        certain: string;
        uncertain: string;
      }>(
        `SELECT
            COALESCE(SUM(CASE WHEN je.confidence_status = 'certain'
                              THEN (CASE WHEN a.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END)
                              ELSE 0 END), 0)::text AS certain,
            COALESCE(SUM(CASE WHEN je.confidence_status = 'uncertain'
                              THEN (CASE WHEN a.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END)
                              ELSE 0 END), 0)::text AS uncertain
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
                                  AND je.confidence_status IN ('certain', 'uncertain')
           JOIN accounts a ON a.tenant_id = je.tenant_id AND a.code = jl.account_code
          WHERE je.tenant_id = $1 AND je.entry_date <= $2 AND a.code = ANY($3::text[])`,
        [tenantId, asOf, CASH_ACCOUNTS],
      );
      const row = result.rows[0];
      const certain = num(row?.certain ?? '0');
      const uncertain = num(row?.uncertain ?? '0');
      return { certain, uncertain, total: certain + uncertain };
    });
  }

  async countUncertain({ tenantId }: { tenantId: string }): Promise<number> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM journal_entries
          WHERE tenant_id = $1 AND confidence_status = 'uncertain'`,
        [tenantId],
      );
      return Number.parseInt(result.rows[0]?.n ?? '0', 10);
    });
  }
}
