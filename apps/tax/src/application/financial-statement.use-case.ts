// Loads the tenant's full taxable-scope financial statements (income statement YTD + last year, balance sheet today, monthly trend 12m, VAT quarter breakdown) so the strategy agent can reason on raw account-level numbers instead of pre-summarised aggregates.

import type { Pool, PoolClient } from 'pg';

const MONTHS_PER_TREND = 12;
const VAT_QUARTERS_PER_BREAKDOWN = 2;

export interface AccountSnapshotRow {
  readonly code: string;
  readonly name: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  readonly normalBalance: 'debit' | 'credit';
  readonly debit: number;
  readonly credit: number;
  readonly net: number;
}

export interface MonthlyTrendRow {
  readonly month: string;
  readonly revenue: number;
  readonly cogs: number;
  readonly operatingExpense: number;
  readonly operatingIncome: number;
  readonly netIncome: number;
}

export interface VatQuarterRow {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly salesTax: number;
  readonly purchaseTax: number;
  readonly payable: number;
  readonly salesInvoiceCount: number;
  readonly purchaseInvoiceCount: number;
}

export interface FinancialStatement {
  readonly asOf: string;
  readonly fiscalYearStart: string;
  readonly fiscalYearEnd: string;
  readonly lastYearStart: string;
  readonly lastYearEnd: string;
  readonly incomeStatementYtd: ReadonlyArray<AccountSnapshotRow>;
  readonly incomeStatementLastYear: ReadonlyArray<AccountSnapshotRow>;
  readonly balanceSheetAsOf: ReadonlyArray<AccountSnapshotRow>;
  readonly monthlyTrend12m: ReadonlyArray<MonthlyTrendRow>;
  readonly vatQuarters: ReadonlyArray<VatQuarterRow>;
}

const toNumber = (raw: string | number | null | undefined): number => {
  if (raw === null || raw === undefined) return 0;
  return typeof raw === 'number' ? raw : Number.parseFloat(raw);
};

const loadIncomeStatement = async (
  client: PoolClient,
  tenantId: string,
  from: string,
  to: string,
): Promise<AccountSnapshotRow[]> => {
  const result = await client.query<{
    code: string;
    name: string;
    type: AccountSnapshotRow['type'];
    normal_balance: AccountSnapshotRow['normalBalance'];
    debit: string;
    credit: string;
  }>(
    `SELECT a.code, a.name, a.type::text AS type, a.normal_balance::text AS normal_balance,
            COALESCE(SUM(jl.debit), 0)::text  AS debit,
            COALESCE(SUM(jl.credit), 0)::text AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl
         ON jl.tenant_id = a.tenant_id AND jl.account_code = a.code
       LEFT JOIN journal_entries je
         ON je.id = jl.entry_id AND je.tenant_id = a.tenant_id
            AND je.entry_date >= $2::date AND je.entry_date <= $3::date
            AND je.status = 'posted'
      WHERE a.tenant_id = $1 AND a.is_active = TRUE AND a.type IN ('revenue', 'expense')
      GROUP BY a.code, a.name, a.type, a.normal_balance
      HAVING COALESCE(SUM(jl.debit), 0) + COALESCE(SUM(jl.credit), 0) > 0
      ORDER BY a.type, a.code`,
    [tenantId, from, to],
  );
  return result.rows.map((row) => {
    const debit = toNumber(row.debit);
    const credit = toNumber(row.credit);
    const net = row.normal_balance === 'credit' ? credit - debit : debit - credit;
    return {
      code: row.code,
      name: row.name,
      type: row.type,
      normalBalance: row.normal_balance,
      debit,
      credit,
      net,
    };
  });
};

const loadBalanceSheet = async (
  client: PoolClient,
  tenantId: string,
  asOf: string,
): Promise<AccountSnapshotRow[]> => {
  const result = await client.query<{
    code: string;
    name: string;
    type: AccountSnapshotRow['type'];
    normal_balance: AccountSnapshotRow['normalBalance'];
    debit: string;
    credit: string;
  }>(
    `SELECT a.code, a.name, a.type::text AS type, a.normal_balance::text AS normal_balance,
            COALESCE(SUM(jl.debit), 0)::text  AS debit,
            COALESCE(SUM(jl.credit), 0)::text AS credit
       FROM accounts a
       LEFT JOIN journal_lines jl
         ON jl.tenant_id = a.tenant_id AND jl.account_code = a.code
       LEFT JOIN journal_entries je
         ON je.id = jl.entry_id AND je.tenant_id = a.tenant_id
            AND je.entry_date <= $2::date AND je.status = 'posted'
      WHERE a.tenant_id = $1 AND a.is_active = TRUE AND a.type IN ('asset', 'liability', 'equity')
      GROUP BY a.code, a.name, a.type, a.normal_balance
      HAVING COALESCE(SUM(jl.debit), 0) + COALESCE(SUM(jl.credit), 0) > 0
      ORDER BY a.type, a.code`,
    [tenantId, asOf],
  );
  return result.rows.map((row) => {
    const debit = toNumber(row.debit);
    const credit = toNumber(row.credit);
    const net = row.normal_balance === 'credit' ? credit - debit : debit - credit;
    return {
      code: row.code,
      name: row.name,
      type: row.type,
      normalBalance: row.normal_balance,
      debit,
      credit,
      net,
    };
  });
};

const loadMonthlyTrend = async (
  client: PoolClient,
  tenantId: string,
  asOf: string,
): Promise<MonthlyTrendRow[]> => {
  const result = await client.query<{
    month: string;
    revenue: string;
    cogs: string;
    operating_expense: string;
  }>(
    `WITH months AS (
       SELECT to_char(generate_series(
         date_trunc('month', $2::date) - interval '${MONTHS_PER_TREND - 1} months',
         date_trunc('month', $2::date),
         interval '1 month'
       ), 'YYYY-MM') AS month
     ),
     line_agg AS (
       SELECT to_char(date_trunc('month', je.entry_date), 'YYYY-MM') AS month,
              SUM(CASE WHEN a.code BETWEEN '4000' AND '4999' THEN jl.credit - jl.debit ELSE 0 END) AS revenue,
              SUM(CASE WHEN a.code BETWEEN '5000' AND '5099' THEN jl.debit - jl.credit ELSE 0 END) AS cogs,
              SUM(CASE WHEN a.code BETWEEN '5100' AND '5999' THEN jl.debit - jl.credit ELSE 0 END) AS operating_expense
         FROM journal_entries je
         JOIN journal_lines jl ON jl.entry_id = je.id
         JOIN accounts a ON a.tenant_id = je.tenant_id AND a.code = jl.account_code
        WHERE je.tenant_id = $1
          AND je.status = 'posted'
          AND je.entry_date >= date_trunc('month', $2::date) - interval '${MONTHS_PER_TREND - 1} months'
          AND je.entry_date <  date_trunc('month', $2::date) + interval '1 month'
        GROUP BY 1
     )
     SELECT m.month,
            COALESCE(la.revenue, 0)::text          AS revenue,
            COALESCE(la.cogs, 0)::text             AS cogs,
            COALESCE(la.operating_expense, 0)::text AS operating_expense
       FROM months m
       LEFT JOIN line_agg la ON la.month = m.month
       ORDER BY m.month ASC`,
    [tenantId, asOf],
  );
  return result.rows.map((row) => {
    const revenue = toNumber(row.revenue);
    const cogs = toNumber(row.cogs);
    const operatingExpense = toNumber(row.operating_expense);
    const operatingIncome = revenue - cogs - operatingExpense;
    return {
      month: row.month,
      revenue,
      cogs,
      operatingExpense,
      operatingIncome,
      netIncome: operatingIncome,
    };
  });
};

const loadVatQuarters = async (
  client: PoolClient,
  tenantId: string,
  asOf: string,
): Promise<VatQuarterRow[]> => {
  const result = await client.query<{
    period_start: string;
    period_end: string;
    sales_tax: string;
    purchase_tax: string;
    sales_count: string;
    purchase_count: string;
  }>(
    `WITH quarters AS (
       SELECT (date_trunc('quarter', $2::date) - (n * interval '3 months')) AS period_start,
              (date_trunc('quarter', $2::date) - (n * interval '3 months') + interval '3 months' - interval '1 day') AS period_end
         FROM generate_series(0, ${VAT_QUARTERS_PER_BREAKDOWN - 1}) AS n
     )
     SELECT q.period_start::date::text AS period_start,
            q.period_end::date::text   AS period_end,
            COALESCE(SUM(CASE WHEN a.code IN ('2551') THEN jl.credit - jl.debit ELSE 0 END), 0)::text AS sales_tax,
            COALESCE(SUM(CASE WHEN a.code IN ('1351') THEN jl.debit - jl.credit ELSE 0 END), 0)::text AS purchase_tax,
            COALESCE(COUNT(DISTINCT CASE WHEN a.code IN ('2551') THEN je.id END), 0)::text AS sales_count,
            COALESCE(COUNT(DISTINCT CASE WHEN a.code IN ('1351') THEN je.id END), 0)::text AS purchase_count
       FROM quarters q
       LEFT JOIN journal_entries je ON je.tenant_id = $1 AND je.status = 'posted'
                                    AND je.entry_date BETWEEN q.period_start AND q.period_end
       LEFT JOIN journal_lines jl   ON jl.entry_id = je.id
       LEFT JOIN accounts a         ON a.tenant_id = je.tenant_id AND a.code = jl.account_code
      GROUP BY q.period_start, q.period_end
      ORDER BY q.period_start DESC`,
    [tenantId, asOf],
  );
  return result.rows.map((row) => {
    const salesTax = toNumber(row.sales_tax);
    const purchaseTax = toNumber(row.purchase_tax);
    return {
      periodStart: row.period_start,
      periodEnd: row.period_end,
      salesTax,
      purchaseTax,
      payable: salesTax - purchaseTax,
      salesInvoiceCount: Number.parseInt(row.sales_count, 10),
      purchaseInvoiceCount: Number.parseInt(row.purchase_count, 10),
    };
  });
};

export const loadFinancialStatement = async (params: {
  pool: Promise<Pool>;
  tenantId: string;
  cognitoSub: string;
  asOf?: string;
}): Promise<FinancialStatement> => {
  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);
  const asOfDate = new Date(asOf);
  const year = asOfDate.getUTCFullYear();
  const fiscalYearStart = `${year}-01-01`;
  const fiscalYearEnd = asOf;
  const lastYearStart = `${year - 1}-01-01`;
  const lastYearEnd = `${year - 1}-12-31`;

  const client = await (await params.pool).connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.cognito_sub', $1, true)", [params.cognitoSub]);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [params.tenantId]);

    const [incomeYtd, incomeLastYear, balance, monthly, vat] = await Promise.all([
      loadIncomeStatement(client, params.tenantId, fiscalYearStart, fiscalYearEnd),
      loadIncomeStatement(client, params.tenantId, lastYearStart, lastYearEnd),
      loadBalanceSheet(client, params.tenantId, asOf),
      loadMonthlyTrend(client, params.tenantId, asOf),
      loadVatQuarters(client, params.tenantId, asOf),
    ]);

    await client.query('COMMIT');
    return {
      asOf,
      fiscalYearStart,
      fiscalYearEnd,
      lastYearStart,
      lastYearEnd,
      incomeStatementYtd: incomeYtd,
      incomeStatementLastYear: incomeLastYear,
      balanceSheetAsOf: balance,
      monthlyTrend12m: monthly,
      vatQuarters: vat,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};
