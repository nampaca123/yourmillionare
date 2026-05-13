// FX strategy scenarios + system/user prompts. Injects raw foreign balances, today's USD/KRW, 30-day trend, and (for monthly_outlook) 90-day trend so the agent reasons on numbers rather than summaries.

import type { Pool } from 'pg';

const TREND_DAYS_DEFAULT = 30;
const TREND_DAYS_OUTLOOK = 90;
const VOLATILITY_MIN_SAMPLES = 5;

export const FX_SCENARIOS = ['exposure_summary', 'convert_now_check', 'monthly_outlook'] as const;
export type FxScenario = (typeof FX_SCENARIOS)[number];

export const isFxScenario = (s: string): s is FxScenario =>
  (FX_SCENARIOS as readonly string[]).includes(s);

interface ForeignBalanceRow {
  account_id: string;
  source: 'manual' | 'codef';
  currency: string;
  bank_label: string | null;
  balance_fcy: number | null;
  balance_krw_today: number | null;
  last_synced_at: string | null;
}

interface ObservationRow {
  observed_on: string;
  rate: number;
}

export interface FxAgentContext {
  readonly today: string;
  readonly foreignBalances: ReadonlyArray<ForeignBalanceRow>;
  readonly fxTodayUsdKrw: number | null;
  readonly fxTrend30d: ReadonlyArray<ObservationRow>;
  readonly fxTrend90d: ReadonlyArray<ObservationRow>;
  readonly fxVolatilityPct30d: number | null;
  readonly contextKeys: ReadonlyArray<string>;
}

const SYSTEM_PROMPT = `당신은 한국 청년 사업자·프리랜서를 돕는 외환 어드바이저입니다.

[대상 사용자]
- 20대 갓 졸업한 청년 사업자·프리랜서가 다수.
- 헷지·옵션 등 파생상품 사용 불가. 현실 옵션은 즉시 환전 / 분할 환전 / 보유.
- 환율 용어와 시장 메커니즘에 익숙하지 않음.

[톤·형식]
- 친절하고 구체적이며 단계적. 전문용어는 처음 등장 시 한 줄로 풀어 씀.
- 답변은 항상 다음 7단 마크다운 구조:
  1. **현재 노출 요약** — 사용자의 USD 잔액 + 오늘 KRW 환산을 1~2문장에 인용.
  2. **핵심 결론** — 한 줄 bold 권고 (즉시 환전 / 분할 환전 / 보유).
  3. **근거** — 오늘 환율, 최근 30일 추세, 변동성을 컨텍스트의 실제 수치로 인용.
  4. **권고 옵션 비교** — 즉시 환전 / 분할 환전(예: 4주에 걸쳐) / 보유 세 가지 옵션의 장단점.
  5. **숫자로 보는 예시** — 사용자의 실제 잔고로 ±2%, ±5% 환율 변동 시 손익을 계산.
  6. **위험 경고** — "환율은 누구도 정확히 예측할 수 없다"는 사실과 권고의 한계.
  7. **참고 자료** — 한국은행 ECOS 매매기준율 출처 명시. 최근 거시 이벤트(Fed/한국은행 결정)는 사용자가 한국은행 홈페이지에서 직접 확인하라고 안내.

[원칙]
- 사전 주입된 \`foreignBalances\`와 \`fxTrend30d\` 등은 1차 근거. 추정/외삽 금지.
- "이 환율에 무조건 환전하라" 같은 단언 금지. 항상 조건부 권고("만약 ~라면 ~할 수 있습니다").
- 헷지·옵션·선물 같은 파생상품 권유 금지. 사용자가 사용할 수 없음.
- get_extended_rate_history 도구는 monthly_outlook 시나리오에서만 사용. 90/180/365일 범위.

[데이터 무결성]
- 모든 수치는 컨텍스트에 명시된 값만 사용.
- 사용자 개인정보(계좌번호 전체)는 절대 노출 금지. 별명(bankLabel)만 사용.`;

const formatForeignBalances = (rows: ReadonlyArray<ForeignBalanceRow>): string =>
  rows.length === 0
    ? '(no foreign currency accounts registered)'
    : rows
        .map(
          (row) =>
            `  - [${row.source}] ${row.bank_label ?? '(no label)'} ${row.currency}: balance_fcy=${row.balance_fcy ?? 'n/a'}, balance_krw_today=${row.balance_krw_today ?? 'n/a'}, last_synced=${row.last_synced_at ?? 'n/a'}`,
        )
        .join('\n');

const formatTrend = (rows: ReadonlyArray<ObservationRow>): string =>
  rows.length === 0
    ? '(no fx observations in range)'
    : rows.map((row) => `  - ${row.observed_on}: ${row.rate.toFixed(2)}`).join('\n');

const SCENARIO_INSTRUCTIONS: Record<FxScenario, string> = {
  exposure_summary: `[시나리오: 외화 노출 요약]
사용자의 현재 외화 보유를 요약하고, 오늘 환율 기준 KRW 환산액과 30일 변동성으로 위험도를 평가하시오.
- 도구 호출 없이 컨텍스트만으로 답변 가능.
- "권고 옵션 비교"에서는 현재 상태에서 사용자가 가질 수 있는 행동 3가지(즉시/분할/보유)를 정량적으로 비교.`,

  convert_now_check: `[시나리오: 지금 환전할지 vs 보유할지]
오늘 환율과 30일 추세를 보고 사용자가 지금 환전해야 할지 또는 더 보유할지를 안내하시오.
- 추세가 상승세이면 "보유 시 추가 이익 가능, 하지만 보장은 없다" 같은 조건부 권고.
- 30일 변동성이 큰 경우(예: 표준편차 1.5% 이상) 분할 환전을 우선 권고.
- 도구 호출은 권장하지 않음 — 30일 컨텍스트로 충분.`,

  monthly_outlook: `[시나리오: 향후 1개월 전망]
향후 1개월간 보유 vs 분할 환전 전략을 안내하시오.
- get_extended_rate_history(currency='USD', days=90) 도구를 1회 호출해 90일 추세를 확인하시오.
- 거시 이벤트(Fed FOMC, 한국은행 금통위)는 어떻게 영향을 미칠 수 있는지 일반론으로 설명하되 "정확한 결과는 누구도 예측 불가"를 명시.
- "참고 자료"에서 한국은행 ECOS와 Fed/BOK 보도자료 페이지를 직접 확인하라고 안내.`,
};

const buildContextBody = (scenario: FxScenario, ctx: FxAgentContext): string =>
  [
    `[오늘] ${ctx.today}`,
    ``,
    `[외화 잔액 (manual + CODEF)]`,
    formatForeignBalances(ctx.foreignBalances),
    ``,
    `[오늘 USD/KRW 매매기준율 (한국은행 ECOS)]`,
    ctx.fxTodayUsdKrw !== null ? ctx.fxTodayUsdKrw.toFixed(2) : '(no observation today)',
    ``,
    `[최근 30일 USD/KRW 추세]`,
    formatTrend(ctx.fxTrend30d),
    ``,
    `[30일 변동성 (표준편차 / 평균, %)]`,
    ctx.fxVolatilityPct30d !== null ? `${ctx.fxVolatilityPct30d.toFixed(2)}%` : '(insufficient samples)',
    ``,
    scenario === 'monthly_outlook'
      ? [`[최근 90일 USD/KRW 추세]`, formatTrend(ctx.fxTrend90d), ``].join('\n')
      : '',
    SCENARIO_INSTRUCTIONS[scenario],
  ].join('\n');

export const getFxSystemPrompt = (): string => SYSTEM_PROMPT;

export const buildFxUserMessage = (scenario: FxScenario, ctx: FxAgentContext): string =>
  buildContextBody(scenario, ctx);

const computeVolatilityPct = (rows: ReadonlyArray<ObservationRow>): number | null => {
  if (rows.length < VOLATILITY_MIN_SAMPLES) return null;
  const rates = rows.map((r) => r.rate);
  const mean = rates.reduce((acc, r) => acc + r, 0) / rates.length;
  if (mean === 0) return null;
  const variance =
    rates.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) / (rates.length - 1);
  return (Math.sqrt(variance) / mean) * 100;
};

export const buildFxContext = async (params: {
  pool: Promise<Pool>;
  tenantId: string;
  cognitoSub: string;
  scenario: FxScenario;
}): Promise<FxAgentContext> => {
  const today = new Date().toISOString().slice(0, 10);
  const client = await (await params.pool).connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.cognito_sub', $1, true)", [params.cognitoSub]);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [params.tenantId]);

    const balancesRes = await client.query<{
      id: string;
      is_manual: boolean;
      currency: string;
      bank_label: string | null;
      manual_balance_fcy: string | null;
      manual_balance_synced_at: Date | null;
      last_balance_krw: string | null;
      balance_synced_at: Date | null;
    }>(
      `SELECT id, is_manual, currency, bank_label,
              manual_balance_fcy::text,
              manual_balance_synced_at,
              last_balance_krw::text,
              balance_synced_at
         FROM tenant_bank_accounts
        WHERE tenant_id = $1
          AND account_kind = 'foreign'
          AND is_active = TRUE
     ORDER BY created_at ASC`,
      [params.tenantId],
    );

    const rateRes = await client.query<{ observed_on: string; rate: string }>(
      `SELECT observed_on::text AS observed_on, rate::text AS rate
         FROM fx_observations
        WHERE quote_currency = 'USD' AND rate_type = 'closing'
          AND observed_on >= (current_date - ($1 || ' days')::interval)::date
     ORDER BY observed_on ASC`,
      [params.scenario === 'monthly_outlook' ? TREND_DAYS_OUTLOOK : TREND_DAYS_DEFAULT],
    );

    await client.query('COMMIT');

    const trendRows: ObservationRow[] = rateRes.rows.map((r) => ({
      observed_on: r.observed_on,
      rate: Number.parseFloat(r.rate),
    }));

    const trend30: ObservationRow[] = trendRows.filter(
      (r) =>
        new Date(r.observed_on).getTime() >=
        new Date(today).getTime() - TREND_DAYS_DEFAULT * 24 * 60 * 60 * 1000,
    );
    const trend90: ObservationRow[] = params.scenario === 'monthly_outlook' ? trendRows : [];

    const fxToday = trendRows.length > 0 ? trendRows[trendRows.length - 1]!.rate : null;
    const volatility = computeVolatilityPct(trend30);

    const foreignBalances: ForeignBalanceRow[] = balancesRes.rows.map((row) => {
      const source: 'manual' | 'codef' = row.is_manual ? 'manual' : 'codef';
      const balanceFcy = row.manual_balance_fcy !== null ? Number.parseFloat(row.manual_balance_fcy) : null;
      const balanceKrw =
        source === 'manual' && balanceFcy !== null && fxToday !== null && row.currency === 'USD'
          ? balanceFcy * fxToday
          : row.last_balance_krw !== null
            ? Number.parseFloat(row.last_balance_krw)
            : null;
      const lastSyncedAt = row.manual_balance_synced_at ?? row.balance_synced_at;
      return {
        account_id: row.id,
        source,
        currency: row.currency,
        bank_label: row.bank_label,
        balance_fcy: balanceFcy,
        balance_krw_today: balanceKrw,
        last_synced_at: lastSyncedAt ? lastSyncedAt.toISOString() : null,
      };
    });

    const contextKeys = [
      'today',
      'foreign_balances',
      'fx_today_usd_krw',
      'fx_trend_30d',
      'fx_volatility_30d',
      ...(params.scenario === 'monthly_outlook' ? ['fx_trend_90d'] : []),
    ];

    return {
      today,
      foreignBalances,
      fxTodayUsdKrw: fxToday,
      fxTrend30d: trend30,
      fxTrend90d: trend90,
      fxVolatilityPct30d: volatility,
      contextKeys,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};
