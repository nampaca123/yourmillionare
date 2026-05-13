# Agent Architecture — Tax + FX SSE Agents

본 문서는 `apps/tax`의 `tax-strategy` 람다와 `apps/fx`의 `fx-strategy` 람다가 따르는 공통 설계를 정리한다. 두 에이전트는 같은 뼈대를 공유하고 도메인에 따라 prompt·도구·컨텍스트만 다르다.

## 공통 뼈대

| 요소 | 위치 |
|---|---|
| SSE 에러 boundary | `packages/agent-core/src/streaming-handler.ts` (`withStreamingErrorBoundary`) |
| Function URL JWT 검증 | `packages/shared-auth/src/verify-jwt.function-url.ts` (`verifyJwt`) |
| Function URL CORS | `infrastructure/lib/config/cors.config.ts` (`buildFunctionUrlCors`) |
| Bedrock Converse 루프 | `packages/agent-core/src/agent-runner.ts` (`runAgent`) |
| SSE event writer | `packages/agent-core/src/sse-writer.ts` (`writeSseEvent`) |

같은 시퀀스로 동작한다:

```
event: started   { runId, scenario }
event: context_ready { keys: [...] }    ← 사전 주입된 컨텍스트의 라벨
event: heartbeat (10s 간격)
event: tool_call  { name, input } *     ← 모델이 도구를 호출할 때
event: tool_result { name, summary } *
event: text_delta { chunk } *
event: final     { summary, metadata.tokens }
event: done      { durationMs, toolCalls, tokens }
```

에러가 발생하면 `error` event + `done` event가 항상 짝지어 발사된다 (HTTP status는 200 유지 — SSE는 stream 시작 후 status를 바꿀 수 없음).

## 설계 원칙

### 1. Raw context first

요약된 컨텍스트("최근 매출이 좋아짐")가 아니라 raw 데이터를 prompt에 박는다 — 모델이 직접 계산·인용할 수 있어야 한다.

- Tax: `apps/tax/src/application/financial-statement.use-case.ts`가 YTD/전년 손익계산서·대차대조표·12개월 trend·VAT quarter breakdown을 계정 코드 단위로 prompt에 주입.
- FX: `apps/fx/src/application/fx-strategy-templates.ts`가 외화 잔액(manual + CODEF union), 오늘 USD/KRW, 30일 trend, 30일 변동성(stddev/mean %)을 주입. `monthly_outlook` 시나리오는 90일 trend도 추가.

### 2. 7단 마크다운 답변

두 에이전트 모두 7단 구조를 강제한다. 시스템 프롬프트에 검증 가능한 키워드를 박아 PR9의 `run-agents-e2e.sh`가 자동 회귀 체크할 수 있게 한다.

| Section | Tax | FX |
|---|---|---|
| 1 | 현황 요약 (매출·비용·잔액 인용) | 현재 노출 요약 (USD 잔액 + KRW 환산) |
| 2 | 핵심 결론 (한 줄 bold) | 핵심 결론 (한 줄 bold, 즉시/분할/보유) |
| 3 | 단계별 액션 | 근거 (오늘 환율 + 30일 추세 + 변동성) |
| 4 | 숫자로 보는 예시 (사용자 잔액으로) | 권고 옵션 비교 (즉시/분할/보유) |
| 5 | 자주 하는 실수 | 숫자로 보는 예시 (±2%, ±5% 시나리오) |
| 6 | 세무사 상담이 필요한 경계선 | 위험 경고 ("환율은 누구도 예측 불가") |
| 7 | 참고 법령 | 참고 자료 (한국은행 ECOS + Fed/BOK 직접 확인 안내) |

### 3. 도구는 prompt를 보완하지 prompt를 대체하지 않는다

| Agent | 도구 | 용도 |
|---|---|---|
| Tax | `search_tax_law` | Bedrock KB에서 조특법·법인세법 등 인용 |
| Tax | `get_filing_draft_detail` | 컨텍스트의 filing ID drill-in |
| Tax | `compute_penalty_scenario` | 국기법 §47-2/§47-3/§47-4 가산세 정확 계산 |
| Tax | `check_benefit_eligibility` | 청년창업감면 등 자격 1차 판정 |
| FX | `get_extended_rate_history` | 1~365일 ECOS closing 환율 추가 조회 (90일+ 추세) |

FX 에이전트는 MVP에 web_search를 포함하지 않는다 — 변동성·트렌드는 30일 raw context로 충분하고, 거시 이벤트는 "한국은행/Fed 페이지에서 직접 확인"으로 사용자에게 위임한다.

## 람다 비교

| 항목 | TaxStrategyFn | FxStrategyFn |
|---|---|---|
| Entry | `apps/tax/src/infrastructure/inbound/streaming/tax-strategy.lambda.ts` | `apps/fx/src/infrastructure/inbound/streaming/fx-strategy.lambda.ts` |
| 시나리오 | 5 (applicable_benefits / upcoming_deadlines / yearly_filing_check / vat_quarter_review / penalty_risk_check) | 3 (exposure_summary / convert_now_check / monthly_outlook) |
| 도구 | 4 | 1 |
| 모델 ID 기본값 | `global.anthropic.claude-opus-4-6-v1` (CDK `BEDROCK_STRATEGY_MODEL_ID`) | 동일 (CDK 공유) |
| Memory | 512 MB | 512 MB |
| Timeout | 10분 | 10분 |
| Max iterations | 12 | 8 |
| Max tokens | 16,384 | 12,288 |
| Function URL CORS | `buildFunctionUrlCors` | 동일 |
| 권한 | Bedrock(Invoke/Converse/ConverseStream/Retrieve/RetrieveAndGenerate/Rerank/GetInferenceProfile) + RDS connect | Bedrock(Invoke/Converse/ConverseStream/GetInferenceProfile) + RDS connect (KB/Rerank 불필요) |
| 라우팅 | API GW 라우트 없음 — Function URL 직접. `api-not-found.lambda` 가 hint matrix로 `/tax/strategy` 매칭 시 movedTo URL 안내 | 동일 (`/fx/strategy` hint 추가) |

## 유저 데이터 흐름

```
Cognito ID Token
  ↓ (Authorization: Bearer ...)
Function URL → verifyJwt → claims.cognitoSub
  ↓
buildContext(tenantId, cognitoSub, scenario)
  ↓ (PG RLS: app.current_tenant_id + app.cognito_sub)
tenant_bank_accounts / journal_entries / filing_obligation / fx_observations
  ↓ (raw rows)
prompt = systemPrompt + injected context block + scenario instructions
  ↓
runAgent (Bedrock Converse with toolConfig)
  ↓ SSE
text_delta* → final → done
```

## 회귀 검증

`scripts/run-agents-e2e.sh` (PR9)가 8개 시나리오를 순차 호출하고 final payload에서 7단 헤더 키워드 + 시나리오별 필수 토큰(예: Tax "세무사 상담", FX "위험 경고")을 grep 한다. 빠진 키워드가 있으면 비0 exit + 어느 시나리오·어느 키워드인지 출력.

`scripts/post-deploy-smoke.sh`는 두 람다의 preflight + 무토큰 401 SSE 응답을 매 배포마다 확인.
