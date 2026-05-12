// FilingObligationGenerator: cron-triggered Lambda that materialises upcoming tax filings per corporation_profile + cadence.

import type { ScheduledEvent } from 'aws-lambda';
import { rollForwardToBusinessDay, type HolidayCalendar } from '@ym/tax-core';
import { getPool } from '../../outbound/pg/pg-pool.client.js';
import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { logger } from '../../../shared/logging/logger.js';

interface ManualInvokePayload {
  tenantId?: string;
}

const HORIZON_MONTHS = 12;
const VAT_PRELIM_DUE_DAY = 25;
const VAT_FINAL_DUE_DAY = 25;
const WH_MONTHLY_DUE_DAY = 10;
const WH_SEMIANNUAL_DUE_DAY = 10;
const CORP_FINAL_DUE_MONTHS_AFTER_YE = 3;

interface TenantRow {
  id: string;
  business_type: 'corporate' | 'sole_proprietor' | 'personal';
  fiscal_year_start_month: number;
  withholding_cadence: 'MONTHLY' | 'SEMIANNUAL';
  vat_prepayment_recipient: boolean;
  tax_type: 'general' | 'simplified' | 'tax_exempt';
}

interface Obligation {
  readonly kind: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly statutoryDueDate: string;
  readonly businessDueDate: string;
}

const iso = (y: number, m: number, d: number): string =>
  `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;

const lastDayOfMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

const addMonths = (y: number, m: number, delta: number): { y: number; m: number } => {
  const total = y * 12 + (m - 1) + delta;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
};

const loadHolidayCalendar = async (years: ReadonlyArray<number>): Promise<HolidayCalendar> => {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    const result = await client.query<{ d: string }>(
      `SELECT date::text AS d FROM holiday_cache WHERE year = ANY($1::int[]) AND is_holiday = TRUE`,
      [years],
    );
    const set = new Set(result.rows.map((r) => r.d));
    return { isHoliday: (date: string) => set.has(date) };
  } finally {
    client.release();
  }
};

const buildVatObligations = (
  fromYear: number,
  fromMonth: number,
  taxType: TenantRow['tax_type'],
  vatPrepaymentRecipient: boolean,
  calendar: HolidayCalendar,
): ReadonlyArray<Obligation> => {
  if (taxType === 'tax_exempt') return [];
  const out: Obligation[] = [];
  const quarters: ReadonlyArray<{ start: [number, number]; end: [number, number]; due: [number, number]; kind: string }> = [
    { start: [1, 1], end: [3, 31], due: [4, VAT_PRELIM_DUE_DAY], kind: 'VAT_PRELIM' },
    { start: [4, 1], end: [6, 30], due: [7, VAT_FINAL_DUE_DAY], kind: 'VAT_FINAL' },
    { start: [7, 1], end: [9, 30], due: [10, VAT_PRELIM_DUE_DAY], kind: 'VAT_PRELIM' },
    { start: [10, 1], end: [12, 31], due: [1, VAT_FINAL_DUE_DAY], kind: 'VAT_FINAL' },
  ];

  for (let yearOffset = 0; yearOffset <= 1; yearOffset += 1) {
    const year = fromYear + yearOffset;
    for (const q of quarters) {
      const periodStart = iso(year, q.start[0], q.start[1]);
      const periodEnd = iso(year, q.end[0], q.end[1]);
      const dueYear = q.kind === 'VAT_FINAL' && q.start[0] === 10 ? year + 1 : year;
      const statutoryDue = iso(dueYear, q.due[0], q.due[1]);
      const businessDue = rollForwardToBusinessDay(statutoryDue, calendar);
      if (q.kind === 'VAT_PRELIM' && vatPrepaymentRecipient) {
        out.push({ kind: 'VAT_PREPAYMENT_NOTICE', periodStart, periodEnd, statutoryDueDate: statutoryDue, businessDueDate: businessDue });
        continue;
      }
      out.push({ kind: q.kind, periodStart, periodEnd, statutoryDueDate: statutoryDue, businessDueDate: businessDue });
    }
  }

  return out.filter((o) => {
    const dueYM = Number.parseInt(o.businessDueDate.slice(0, 4), 10) * 12 + Number.parseInt(o.businessDueDate.slice(5, 7), 10);
    const fromYM = fromYear * 12 + fromMonth;
    return dueYM >= fromYM && dueYM < fromYM + HORIZON_MONTHS;
  });
};

const buildWithholdingObligations = (
  fromYear: number,
  fromMonth: number,
  cadence: 'MONTHLY' | 'SEMIANNUAL',
  calendar: HolidayCalendar,
): ReadonlyArray<Obligation> => {
  const out: Obligation[] = [];
  const monthsAhead = HORIZON_MONTHS;

  for (let i = 0; i < monthsAhead; i += 1) {
    const { y: py, m: pm } = addMonths(fromYear, fromMonth, i);
    const periodStart = iso(py, pm, 1);
    const periodEnd = iso(py, pm, lastDayOfMonth(py, pm));
    const { y: dy, m: dm } = addMonths(py, pm, 1);

    if (cadence === 'MONTHLY') {
      const statutoryDue = iso(dy, dm, WH_MONTHLY_DUE_DAY);
      out.push({
        kind: 'WH_MONTHLY',
        periodStart,
        periodEnd,
        statutoryDueDate: statutoryDue,
        businessDueDate: rollForwardToBusinessDay(statutoryDue, calendar),
      });
    } else if (pm === 6 || pm === 12) {
      const halfStartMonth = pm === 6 ? 1 : 7;
      const halfStart = iso(py, halfStartMonth, 1);
      const statutoryDue = iso(dy, dm, WH_SEMIANNUAL_DUE_DAY);
      out.push({
        kind: 'WH_SEMIANNUAL',
        periodStart: halfStart,
        periodEnd,
        statutoryDueDate: statutoryDue,
        businessDueDate: rollForwardToBusinessDay(statutoryDue, calendar),
      });
    }
  }
  return out;
};

const buildComprehensiveIncomeObligations = (
  fromYear: number,
  calendar: HolidayCalendar,
): ReadonlyArray<Obligation> => {
  // 종합소득세: 매년 5월 1일~31일 신고 (전년 1.1~12.31 귀속). 1년치 + 다음년치 모두 생성.
  const out: Obligation[] = [];
  for (let yearOffset = -1; yearOffset <= 1; yearOffset += 1) {
    const incomeYear = fromYear + yearOffset;
    const periodStart = iso(incomeYear, 1, 1);
    const periodEnd = iso(incomeYear, 12, 31);
    const statutoryDue = iso(incomeYear + 1, 5, 31);
    out.push({
      kind: 'COMPREHENSIVE_INCOME',
      periodStart,
      periodEnd,
      statutoryDueDate: statutoryDue,
      businessDueDate: rollForwardToBusinessDay(statutoryDue, calendar),
    });
  }
  return out;
};

const buildCorpFinalObligation = (
  fromYear: number,
  fiscalYearStartMonth: number,
  calendar: HolidayCalendar,
): ReadonlyArray<Obligation> => {
  const out: Obligation[] = [];
  for (let yearOffset = 0; yearOffset <= 1; yearOffset += 1) {
    const fyStart = { y: fromYear - 1 + yearOffset, m: fiscalYearStartMonth };
    const fyEndPrev = addMonths(fyStart.y, fyStart.m, 12);
    const periodEnd = iso(fyEndPrev.y, fyEndPrev.m - 1 || 12, lastDayOfMonth(fyEndPrev.y, fyEndPrev.m - 1 || 12));
    const periodStart = iso(fyStart.y, fyStart.m, 1);
    const dueYM = addMonths(fyEndPrev.y, fyEndPrev.m, CORP_FINAL_DUE_MONTHS_AFTER_YE - 1);
    const statutoryDue = iso(dueYM.y, dueYM.m, lastDayOfMonth(dueYM.y, dueYM.m));
    out.push({
      kind: 'CORP_FINAL',
      periodStart,
      periodEnd,
      statutoryDueDate: statutoryDue,
      businessDueDate: rollForwardToBusinessDay(statutoryDue, calendar),
    });
  }
  return out;
};

const insertObligations = async (
  tenantId: string,
  obligations: ReadonlyArray<Obligation>,
): Promise<number> => {
  if (obligations.length === 0) return 0;
  return withRlsContext({ tenantId, isTaxAdmin: true }, async (client) => {
    let inserted = 0;
    for (const o of obligations) {
      const result = await client.query(
        `INSERT INTO filing_obligation
           (tenant_id, kind, period_start, period_end, statutory_due_date, business_due_date)
         VALUES ($1, $2::filing_kind, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, kind, period_start, period_end) DO NOTHING`,
        [tenantId, o.kind, o.periodStart, o.periodEnd, o.statutoryDueDate, o.businessDueDate],
      );
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  });
};

const listAllTenants = async (tenantId?: string): Promise<ReadonlyArray<TenantRow>> => {
  // For tenant-scoped invocations, set app.current_tenant_id so RLS allows the SELECT.
  // For full-pool scan (cron), isTaxAdmin bypasses tenant_isolation policy.
  const rlsCtx = tenantId
    ? { tenantId, isTaxAdmin: true, cognitoSub: 'system' }
    : { isTaxAdmin: true, cognitoSub: 'system' };
  return withRlsContext(rlsCtx, async (client) => {
    const sql = tenantId
      ? `SELECT id, business_type::text AS business_type, fiscal_year_start_month, withholding_cadence,
                vat_prepayment_recipient, tax_type::text AS tax_type
           FROM tenants WHERE id = $1`
      : `SELECT id, business_type::text AS business_type, fiscal_year_start_month, withholding_cadence,
                vat_prepayment_recipient, tax_type::text AS tax_type
           FROM tenants
          WHERE business_type IN ('corporate', 'sole_proprietor', 'personal')`;
    const result = tenantId
      ? await client.query<TenantRow>(sql, [tenantId])
      : await client.query<TenantRow>(sql);
    return result.rows;
  });
};

const obligationsForTenant = (
  t: TenantRow,
  fromYear: number,
  fromMonth: number,
  calendar: HolidayCalendar,
): ReadonlyArray<Obligation> => {
  if (t.business_type === 'personal') {
    return buildComprehensiveIncomeObligations(fromYear, calendar);
  }
  const vat = buildVatObligations(fromYear, fromMonth, t.tax_type, t.vat_prepayment_recipient, calendar);
  const wh = buildWithholdingObligations(fromYear, fromMonth, t.withholding_cadence, calendar);
  const corp = t.business_type === 'corporate'
    ? buildCorpFinalObligation(fromYear, t.fiscal_year_start_month, calendar)
    : [];
  return [...vat, ...wh, ...corp];
};

export const handler = async (
  event: ScheduledEvent | ManualInvokePayload,
): Promise<{ tenantsProcessed: number; obligationsInserted: number }> => {
  const now = new Date();
  const fromYear = now.getUTCFullYear();
  const fromMonth = now.getUTCMonth() + 1;
  const calendar = await loadHolidayCalendar([fromYear - 1, fromYear, fromYear + 1]);

  const targetTenantId = (event as ManualInvokePayload).tenantId;
  const tenants = await listAllTenants(targetTenantId);
  let totalInserted = 0;

  for (const t of tenants) {
    const obligations = obligationsForTenant(t, fromYear, fromMonth, calendar);
    const inserted = await insertObligations(t.id, obligations);
    totalInserted += inserted;
    if (inserted > 0) {
      logger.info(
        { tenantId: t.id, businessType: t.business_type, inserted, total: obligations.length },
        'Inserted filing obligations',
      );
    }
  }

  return { tenantsProcessed: tenants.length, obligationsInserted: totalInserted };
};
