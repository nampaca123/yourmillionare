// Pg-backed aggregates for K-IFRS report builders. Classifies expenses into COGS / OpEx / Non-Operating / Income Tax by account ranges.

import { withRlsContext } from './pg-rls.context.js';
import type {
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
  total_debit: string;
  total_credit: string;
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

const balanceAmount = (row: AccountAggRow): number => {
  const debit = Number.parseFloat(row.total_debit);
  const credit = Number.parseFloat(row.total_credit);
  return row.normal_balance === 'debit' ? debit - credit : credit - debit;
};

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
                COALESCE(SUM(jl.debit), 0)::text AS total_debit,
                COALESCE(SUM(jl.credit), 0)::text AS total_credit
           FROM accounts a
      LEFT JOIN journal_lines jl ON jl.tenant_id = a.tenant_id AND jl.account_code = a.code
      LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
                                  AND je.entry_date BETWEEN $2 AND $3
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
        amount: balanceAmount(row),
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
                COALESCE(SUM(jl.debit), 0)::text AS total_debit,
                COALESCE(SUM(jl.credit), 0)::text AS total_credit
           FROM accounts a
      LEFT JOIN journal_lines jl ON jl.tenant_id = a.tenant_id AND jl.account_code = a.code
      LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id AND je.entry_date <= $2
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
        amount: balanceAmount(row),
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
                COALESCE(SUM(jl.debit), 0)::text AS total_debit,
                COALESCE(SUM(jl.credit), 0)::text AS total_credit
           FROM accounts a
      LEFT JOIN journal_lines jl ON jl.tenant_id = a.tenant_id AND jl.account_code = a.code
      LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id AND je.entry_date <= $2
          WHERE a.tenant_id = $1
       GROUP BY a.code, a.name, a.type, a.normal_balance, a.is_current
       ORDER BY a.code`,
        [tenantId, asOf],
      );
      return result.rows.map((row) => ({
        accountCode: row.account_code,
        accountName: row.account_name,
        normalBalance: row.normal_balance,
        totalDebit: Number.parseFloat(row.total_debit),
        totalCredit: Number.parseFloat(row.total_credit),
      }));
    });
  }

  async cashSnapshot({ tenantId, asOf }: { tenantId: string; asOf: string }): Promise<number> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<{ balance: string }>(
        `SELECT COALESCE(
                  SUM(CASE WHEN a.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END),
                  0
                )::text AS balance
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id AND je.tenant_id = jl.tenant_id
           JOIN accounts a ON a.tenant_id = je.tenant_id AND a.code = jl.account_code
          WHERE je.tenant_id = $1 AND je.entry_date <= $2 AND a.code = ANY($3::text[])`,
        [tenantId, asOf, CASH_ACCOUNTS],
      );
      return Number.parseFloat(result.rows[0]?.balance ?? '0');
    });
  }

  async hasUnclassifiedDrafts({
    tenantId,
    fromDate: _fromDate,
    toDate: _toDate,
  }: {
    tenantId: string;
    fromDate: string;
    toDate: string;
  }): Promise<boolean> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM journal_entry_draft WHERE tenant_id = $1`,
        [tenantId],
      );
      return Number.parseInt(result.rows[0]?.count ?? '0', 10) > 0;
    });
  }
}
