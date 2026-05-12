// Server-side scenario enum + system/user prompt templates. No free-text input from user (injection-safe).

import type { Pool } from 'pg';

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
  readonly upcomingFilings: ReadonlyArray<FilingRow>;
  readonly recentFilings: ReadonlyArray<FilingRow>;
  readonly contextKeys: ReadonlyArray<string>;
}

const SYSTEM_PROMPT_BASE = `당신은 한국 K-IFRS / K-GAAP 세무 전문가 AI 어시스턴트입니다.
법령/판례 검색 도구(search_tax_law)와 신고서 상세 조회 도구(get_filing_draft_detail)를 활용해 사용자에게 근거 있는 분석을 제공합니다.
모든 답변은 한국어로 작성하고, 인용한 법령/판례는 명시합니다.
사전에 주입된 컨텍스트(법인 프로필, 신고 일정)를 우선 활용하고, 필요한 경우에만 도구를 사용해 추가 정보를 조회합니다.`;

const SCENARIO_PROMPTS: Record<TaxScenario, (ctx: AgentContext) => string> = {
  applicable_benefits: (ctx) => `[시나리오: 적용 가능 세제 혜택 분석]
오늘: ${ctx.today}
법인 프로필: ${JSON.stringify(ctx.corpProfile)}
다가오는 신고 (6개월): ${JSON.stringify(ctx.upcomingFilings)}

Task: 위 법인 프로필을 바탕으로 적용 가능한 세제 혜택(중소기업 특별세액 감면, 청년창업 감면, R&D 세액공제, 통합투자세액공제 등)을 search_tax_law 도구로 근거 조문을 확인하면서 3~5개 추천하시오. 각 혜택은 (1) 적용 조건, (2) 절감 가능 금액 또는 비율, (3) 신청 절차, (4) 출처 법령을 포함하시오.`,

  upcoming_deadlines: (ctx) => `[시나리오: 다가오는 신고 마감 점검]
오늘: ${ctx.today}
법인 프로필: ${JSON.stringify(ctx.corpProfile)}
다가오는 신고 (6개월): ${JSON.stringify(ctx.upcomingFilings)}

Task: 위 신고 일정 중 우선순위가 높은 항목(마감일 임박, 금액 큰 부가세 등)을 정리하고, 각 신고에 필요한 사전 준비사항을 안내하시오. 필요한 경우 search_tax_law로 최신 규정을 확인하시오.`,

  yearly_filing_check: (ctx) => `[시나리오: 연간 신고 점검]
오늘: ${ctx.today}
법인 프로필: ${JSON.stringify(ctx.corpProfile)}
최근 신고 (12개월): ${JSON.stringify(ctx.recentFilings)}
다가오는 신고 (6개월): ${JSON.stringify(ctx.upcomingFilings)}

Task: 올해 누락 위험이 있는 신고(법인세 중간예납, 부가세 예정/확정, 원천세 등)를 식별하고 위험도를 평가하시오.`,

  vat_quarter_review: (ctx) => `[시나리오: 부가세 분기 점검]
오늘: ${ctx.today}
법인 프로필: ${JSON.stringify(ctx.corpProfile)}
다가오는 신고 (6개월): ${JSON.stringify(ctx.upcomingFilings)}

Task: 직전 분기 부가세 신고 누락 여부를 평가하고, 다음 분기 준비 사항을 안내하시오.`,

  penalty_risk_check: (ctx) => `[시나리오: 가산세 위험 점검]
오늘: ${ctx.today}
법인 프로필: ${JSON.stringify(ctx.corpProfile)}
최근 신고 (12개월): ${JSON.stringify(ctx.recentFilings)}
다가오는 신고 (6개월): ${JSON.stringify(ctx.upcomingFilings)}

Task: 지연 신고 또는 누락으로 가산세 위험이 있는 신고를 식별하고, 감면 신청 조건(자진납부, 수정신고 등)을 안내하시오.`,
};

export const getSystemPrompt = (): string => SYSTEM_PROMPT_BASE;

export const buildUserMessage = (scenario: TaxScenario, ctx: AgentContext): string => SCENARIO_PROMPTS[scenario](ctx);

export const buildContext = async (params: {
  pool: Promise<Pool>;
  tenantId: string;
  cognitoSub: string;
  scenario: TaxScenario;
}): Promise<AgentContext> => {
  const today = new Date().toISOString().slice(0, 10);
  const client = await (await params.pool).connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.cognito_sub', $1, true)", [params.cognitoSub]);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [params.tenantId]);

    const corpRes = await client.query<CorpProfileRow>(
      `SELECT legal_name, industry_code, is_youth_founder, is_venture_certified, founded_on::text
       FROM tenants WHERE id = $1`,
      [params.tenantId],
    );
    const corpProfile = corpRes.rows[0] ?? null;

    const upcomingRes = await client.query<FilingRow>(
      `SELECT id, kind::text AS kind, period_start::text, period_end::text,
              business_due_date::text AS due_date, status::text AS status
       FROM filing_obligation
       WHERE tenant_id = $1 AND business_due_date >= now()::date
         AND business_due_date < (now() + interval '6 months')::date
       ORDER BY business_due_date ASC LIMIT 20`,
      [params.tenantId],
    );

    const recentRes = await client.query<FilingRow>(
      `SELECT id, kind::text AS kind, period_start::text, period_end::text,
              business_due_date::text AS due_date, status::text AS status
       FROM filing_obligation
       WHERE tenant_id = $1 AND business_due_date >= (now() - interval '12 months')::date
         AND business_due_date < now()::date
       ORDER BY business_due_date DESC LIMIT 20`,
      [params.tenantId],
    );

    await client.query('COMMIT');

    const contextKeys = ['today', 'corp_profile', 'upcoming_filings', 'recent_filings'];
    return {
      today,
      corpProfile,
      upcomingFilings: upcomingRes.rows,
      recentFilings: recentRes.rows,
      contextKeys,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};
