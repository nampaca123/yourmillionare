// Tax strategy scenarios + injection-safe system/user prompts; injects raw financial statements so the agent can reason on account-level numbers instead of summaries.

import type { Pool } from 'pg';

import { loadFinancialStatement, type FinancialStatement } from './financial-statement.use-case.js';

export const TAX_SCENARIOS = [
  'applicable_benefits',
  'upcoming_deadlines',
  'yearly_filing_check',
  'vat_quarter_review',
  'penalty_risk_check',
] as const;

export type TaxScenario = (typeof TAX_SCENARIOS)[number];

export const isTaxScenario = (s: string): s is TaxScenario =>
  (TAX_SCENARIOS as readonly string[]).includes(s);

interface CorpProfileRow {
  legal_name: string | null;
  business_type: string | null;
  industry_code: string | null;
  is_youth_founder: boolean;
  is_venture_certified: boolean;
  founded_on: string | null;
}

interface FilingRow {
  id: string;
  kind: string;
  period_start: string;
  period_end: string;
  due_date: string;
  status: string;
}

export interface AgentContext {
  readonly today: string;
  readonly corpProfile: CorpProfileRow | null;
  readonly financialStatement: FinancialStatement;
  readonly upcomingFilings: ReadonlyArray<FilingRow>;
  readonly recentFilings: ReadonlyArray<FilingRow>;
  readonly contextKeys: ReadonlyArray<string>;
}

const SYSTEM_PROMPT = `당신은 한국 SMB·청년창업자·프리랜서를 돕는 세무 어드바이저입니다.

[대상 사용자]
- 20대 중·후반 청년창업자 또는 사회 초년 사업자가 다수.
- 세무 용어와 신고 절차에 익숙하지 않음.
- 세무사 비용을 최소화하면서 본인이 1차 판단을 할 수 있어야 함.

[톤·형식]
- 친절하고 구체적이며 단계적으로 설명. 전문용어는 처음 등장 시 한 줄로 풀어 씀.
- 답변은 항상 다음 7단 마크다운 구조:
  1. **현황 요약** — 컨텍스트에 박힌 실제 매출/비용/잔액 수치를 1~2문장에 인용.
  2. **핵심 결론** — 한 줄 bold 권고.
  3. **단계별 액션** — 오늘/이번주/이번달 단위로 번호 매김.
  4. **숫자로 보는 예시** — 사용자의 실제 계정 잔액으로 구체 계산 (가산세/감면액 등).
  5. **자주 하는 실수** — 해당 시나리오에서 청년창업자가 자주 빠지는 함정 2~3개.
  6. **세무사 상담이 필요한 경계선** — 어떤 조건에 도달하면 전문가 도움을 받아야 하는지.
  7. **참고 법령** — search_tax_law 도구 인용 + 조문 번호.

[원칙]
- 사전 주입된 재무제표(\`financialStatement\`)와 법인 프로필을 1차 근거로 활용. 매출/비용은 실제 계정 잔액으로 인용.
- 모르는 사실은 추측 금지. "확실하지 않으니 국세청 홈택스 또는 세무사에 확인하라"고 명시.
- 신고 마감일은 "MM월 DD일까지 (D-N일)" 형식으로 명시.
- 사용자가 청년창업감면(조특법 §6) 대상이면 도입부에서 먼저 언급.
- 적용 가능 세제 혜택은 raw 재무제표를 보고 직접 판단. 확정 자격이 필요하면 check_benefit_eligibility 도구로 확인.
- 가산세 금액은 compute_penalty_scenario 도구로 정확히 계산해 인용.
- 법령 변동/최근 개정은 web_search로 확인 후 인용 (국세청 보도자료, 청년창업 가이드 등).

[데이터 무결성]
- 모든 수치는 컨텍스트에 명시된 값만 사용. 추정/외삽 금지.
- 응답에 사용자 개인정보(주민번호/계좌번호/거래처명)는 절대 노출 금지.`;

const formatAccountSnapshot = (
  rows: ReadonlyArray<{ code: string; name: string; net: number }>,
): string =>
  rows.length === 0
    ? '(no posted entries in range)'
    : rows.map((row) => `  - ${row.code} ${row.name}: ${row.net.toLocaleString('en-US')}`).join('\n');

const formatMonthlyTrend = (
  rows: ReadonlyArray<{
    month: string;
    revenue: number;
    cogs: number;
    operatingExpense: number;
    operatingIncome: number;
  }>,
): string =>
  rows.length === 0
    ? '(no posted entries in last 12 months)'
    : rows
        .map(
          (row) =>
            `  - ${row.month}: revenue=${row.revenue.toLocaleString('en-US')}, cogs=${row.cogs.toLocaleString('en-US')}, opex=${row.operatingExpense.toLocaleString('en-US')}, op_income=${row.operatingIncome.toLocaleString('en-US')}`,
        )
        .join('\n');

const formatVatQuarters = (
  rows: ReadonlyArray<{
    periodStart: string;
    periodEnd: string;
    salesTax: number;
    purchaseTax: number;
    payable: number;
    salesInvoiceCount: number;
    purchaseInvoiceCount: number;
  }>,
): string =>
  rows.length === 0
    ? '(no VAT-bearing entries)'
    : rows
        .map(
          (row) =>
            `  - ${row.periodStart} ~ ${row.periodEnd}: sales_tax=${row.salesTax.toLocaleString('en-US')}, purchase_tax=${row.purchaseTax.toLocaleString('en-US')}, payable=${row.payable.toLocaleString('en-US')}, sales_count=${row.salesInvoiceCount}, purchase_count=${row.purchaseInvoiceCount}`,
        )
        .join('\n');

const buildFinancialStatementBlock = (statement: FinancialStatement): string =>
  [
    `[재무제표 (단위: KRW, posted entries only)]`,
    `As-of: ${statement.asOf}`,
    `Fiscal year YTD: ${statement.fiscalYearStart} ~ ${statement.fiscalYearEnd}`,
    `Last fiscal year: ${statement.lastYearStart} ~ ${statement.lastYearEnd}`,
    ``,
    `Income statement (YTD, by account):`,
    formatAccountSnapshot(statement.incomeStatementYtd),
    ``,
    `Income statement (last full year, by account):`,
    formatAccountSnapshot(statement.incomeStatementLastYear),
    ``,
    `Balance sheet (as-of ${statement.asOf}, by account):`,
    formatAccountSnapshot(statement.balanceSheetAsOf),
    ``,
    `Monthly trend (last 12 months):`,
    formatMonthlyTrend(statement.monthlyTrend12m),
    ``,
    `VAT quarters (most recent 2):`,
    formatVatQuarters(statement.vatQuarters),
  ].join('\n');

const SCENARIO_INSTRUCTIONS: Record<TaxScenario, string> = {
  applicable_benefits: `[시나리오: 적용 가능 세제 혜택 안내]
위 재무제표 + 법인 프로필을 바탕으로 적용 가능한 세제 혜택(청년창업감면, R&D 세액공제, 통합투자세액공제, 중소기업 특별세액 감면, 고용증대세제, 산재보험료 감면 등)을 평가하시오.
- check_benefit_eligibility 도구로 후보 혜택의 자격 요건을 확인하시오.
- search_tax_law로 적용 조문(예: 조특법 §6, §10, §24 등)을 인용하시오.
- 매출/인건비/연구개발비 등 실제 계정 잔액으로 추정 절감액을 계산해 보이시오.
- 7단 구조로 답하되 "단계별 액션"에는 신청 시기·증빙·사후 관리 의무를 포함.`,

  upcoming_deadlines: `[시나리오: 다가오는 신고 마감 점검]
다가오는 6개월 신고 일정을 정리하고, 가장 임박한 1~3개에 대해 사전 준비 사항을 안내하시오.
- 각 신고에 대해 컨텍스트의 부가세/매출 수치로 예상 납부세액을 추정.
- 신고 미리 준비할 증빙(세금계산서, 인건비 명세, 영수증 등) 체크리스트 제시.`,

  yearly_filing_check: `[시나리오: 연간 신고 점검]
재무제표 + 최근 12개월 신고 이력을 보고 누락 위험이 있는 신고(법인세 중간예납, 부가세 예정/확정, 원천세, 일감몰아주기 증여세 등)를 식별하고 위험도를 평가하시오.
- 누락 위험이 있다면 compute_penalty_scenario로 가산세 시뮬레이션.`,

  vat_quarter_review: `[시나리오: 부가세 분기 점검]
컨텍스트의 VAT quarter breakdown을 보고 직전 분기 신고 누락 여부와 다음 분기 준비 사항을 안내하시오.
- 매출세액·매입세액 차이로 납부세액 또는 환급세액을 계산.
- 매출/매입 세금계산서 발행 누락 가능성을 평가 (월별 trend의 revenue와 sales_count의 일관성 확인).`,

  penalty_risk_check: `[시나리오: 가산세 위험 점검]
최근 12개월 신고 이력 + 다가오는 신고를 보고 지연 신고 또는 누락으로 가산세 위험이 있는 항목을 식별하시오.
- compute_penalty_scenario로 각 위험 신고의 가산세를 정확히 계산.
- 감면 신청 조건(자진 수정신고, 자진 납부 등)을 안내.`,
};

const buildUserMessageBody = (scenario: TaxScenario, ctx: AgentContext): string =>
  [
    `[오늘] ${ctx.today}`,
    ``,
    `[법인 프로필]`,
    JSON.stringify(ctx.corpProfile, null, 2),
    ``,
    buildFinancialStatementBlock(ctx.financialStatement),
    ``,
    `[다가오는 신고 (6개월)]`,
    JSON.stringify(ctx.upcomingFilings, null, 2),
    ``,
    `[최근 신고 (12개월)]`,
    JSON.stringify(ctx.recentFilings, null, 2),
    ``,
    SCENARIO_INSTRUCTIONS[scenario],
  ].join('\n');

export const getSystemPrompt = (): string => SYSTEM_PROMPT;

export const buildUserMessage = (scenario: TaxScenario, ctx: AgentContext): string =>
  buildUserMessageBody(scenario, ctx);

export const buildContext = async (params: {
  pool: Promise<Pool>;
  tenantId: string;
  cognitoSub: string;
  scenario: TaxScenario;
}): Promise<AgentContext> => {
  const today = new Date().toISOString().slice(0, 10);
  const financialStatement = await loadFinancialStatement({
    pool: params.pool,
    tenantId: params.tenantId,
    cognitoSub: params.cognitoSub,
    asOf: today,
  });

  const client = await (await params.pool).connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.cognito_sub', $1, true)", [params.cognitoSub]);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [params.tenantId]);

    const corpRes = await client.query<CorpProfileRow>(
      `SELECT legal_name, business_type::text AS business_type, industry_code,
              is_youth_founder, is_venture_certified, founded_on::text
         FROM tenants WHERE id = $1`,
      [params.tenantId],
    );
    const corpProfile = corpRes.rows[0] ?? null;

    const upcomingRes = await client.query<FilingRow>(
      `SELECT id, kind::text AS kind, period_start::text, period_end::text,
              business_due_date::text AS due_date, status::text AS status
         FROM filing_obligation
        WHERE tenant_id = $1
          AND business_due_date >= now()::date
          AND business_due_date <  (now() + interval '6 months')::date
        ORDER BY business_due_date ASC
        LIMIT 20`,
      [params.tenantId],
    );

    const recentRes = await client.query<FilingRow>(
      `SELECT id, kind::text AS kind, period_start::text, period_end::text,
              business_due_date::text AS due_date, status::text AS status
         FROM filing_obligation
        WHERE tenant_id = $1
          AND business_due_date >= (now() - interval '12 months')::date
          AND business_due_date <  now()::date
        ORDER BY business_due_date DESC
        LIMIT 20`,
      [params.tenantId],
    );

    await client.query('COMMIT');

    const contextKeys = [
      'today',
      'corp_profile',
      'financial_statement.income_statement_ytd',
      'financial_statement.income_statement_last_year',
      'financial_statement.balance_sheet_as_of',
      'financial_statement.monthly_trend_12m',
      'financial_statement.vat_quarters',
      'upcoming_filings',
      'recent_filings',
    ];
    return {
      today,
      corpProfile,
      financialStatement,
      upcomingFilings: upcomingRes.rows,
      recentFilings: recentRes.rows,
      contextKeys,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};
