# YourMillionare

AWS cloud-native AI accounting agent for early-stage Korean startups and individuals. CODEF로 은행·카드·홈택스 거래내역을 자동 수집하고, Bedrock(Claude Sonnet 4.6)이 K-IFRS 복식부기 분개를 자동 생성한다. 세금·환율 어드바이저는 Opus 4.6/4.7 기반 SSE 에이전트로 동작한다.

## Repository Layout

```
yourmillionare/
├── infrastructure/           # CDK TypeScript app (6 stacks deployed in ap-northeast-2)
├── apps/
│   ├── identity/             # Cognito user / tenant + bank-connections + bank-accounts
│   ├── journal/              # Unified /entries CRUD + reports/views (HTTP API)
│   ├── codef/                # CODEF ingestion (scheduled fetch lambda + SSE Function URL fs-sync-stream)
│   ├── tax/                  # Tax filings, withholding, tax-invoices, corporation profile + tax-strategy SSE agent
│   ├── tax-knowledge/        # admin tax-rule moderation + monthly law-corpus sync (agent-* 도구는 apps/tax로 이전됨)
│   └── fx/                   # ECOS FX collector + manual FX account CRUD + fx-strategy SSE agent
├── packages/
│   ├── shared-errors/        # AppError hierarchy + toHttpErrorResponse
│   ├── shared-auth/          # Cognito JWT claims mapper + Function URL JWT verifier
│   ├── agent-core/           # SSE writers + streaming error boundary + Bedrock Converse runner
│   ├── journal-core/         # Domain (entities, classifiers, K-IFRS chart, PG journal repo)
│   ├── reports-core/         # K-IFRS builders (P&L, BS, CF, TB) with {certain, uncertain, total} breakdown
│   ├── tax-core/             # Tax calculators
│   └── tax-domain/           # Tax filing engine + Bedrock KB client
├── docs/                     # ARCHITECTURE.md, API_LIST.md, agent-architecture.md, slice reports
├── scripts/                  # sync-secrets, run-api-e2e, run-codef-e2e, run-agents-e2e, post-deploy-smoke
├── schema.sql                # Aurora PostgreSQL DDL — single source of truth (migrations 0001–0024)
└── CLAUDE.md                 # Engineering guidelines
```

## Status

All 6 stacks deployed to `ap-northeast-2` (account 823401933116). Bedrock Sonnet 4.6 classifies transactions; Opus 4.6/4.7 powers the tax + FX strategy agents.

| Stack | Status | Notes |
|-------|--------|-------|
| `Ym-Dev-Foundation` | ✅ DEPLOYED | KMS CMK + CODEF/ECOS credential secret slots |
| `Ym-Dev-Network` | ✅ DEPLOYED | VPC, fck-nat, VPC endpoints, Flow Logs |
| `Ym-Dev-Data` | ✅ DEPLOYED | Aurora Serverless v2 PG 15.10, DynamoDB tables, migrations 0001–0024 |
| `Ym-Dev-Identity` | ✅ DEPLOYED | Cognito User Pool + Hosted UI + Google IdP |
| `Ym-Dev-Api` | ✅ DEPLOYED | HTTP API + JWT Authorizer, 5 service Lambdas, 3 SSE Function URLs (codef-sync, tax-strategy, fx-strategy) |
| `Ym-Dev-Ingestion` | ✅ DEPLOYED | EventBridge schedule + SFN (scheduled CODEF fetch) + SQS classify worker + FxCollectorFn (ECOS hourly) |

## Personas

**민지 / 25세 / 청년창업 스타트업 공동창업자**

- UX/UI 디자이너 출신. Figma·Notion·Slack은 익숙하지만 회계 SW는 처음.
- 친구 2명과 법인 설립. 법인 통장 1개 + 법인카드 3장. 시드 투자금으로 운영 중.
- "재무제표"라는 단어는 들어봤지만 만들 줄도 읽을 줄도 모름. 세무사 비용 부담.
- 공포 포인트: 국세청 문자, 가산세, "이거 비용 처리 되나요?" 질문.

UX 3원칙으로 응대한다:

- **무행동 우선 (No-Action First)**: 영수증 사진·카테고리 수동 분류 없음. AI가 확신 없을 때만 카드 좌우 스와이프 한 번으로 끝.
- **친숙한 옷, 낯선 속**: 내부는 정식 복식부기, 화면은 노션 DB / 갤러리 / 칸반 / 챗. "거래원장" 대신 "이번 달 카드값".
- **챗을 메인 메뉴로**: 좌측 메뉴 트리 대신 챗이 홈. 자연어 질문 → 적절한 뷰가 펼쳐짐.

## Product Phases

| Phase | 목표 | 주요 산출물 |
|---|---|---|
| **Phase 0 — Foundation** (현재) | 1명 베타가 "결제만 하면 장부가 써지네" 경험 | Cognito + CODEF 1개 은행 + F1 자동 기장 + F2 노션형 장부 + 알림톡 1건 |
| **Phase 1 — Tax & Chat** | 첫 분기 부가세 신고를 패닉 없이 통과 | F3 AI 매니저 챗 (Opus 4.6/4.7), F4 세금 캘린더 + 부가세 자료 자동 생성, F2에 "받을 돈 칸반" 추가 |
| **Phase 2 — Differentiation** | 글로벌 매출 있는 팀이 "이거 없으면 못 살아" 단계 | F5 FX 스마트 정산, F3 능동 알림 모드, 멀티 에이전트 코디네이터, 제휴 세무사 연계 |

## Features

| Feature | 한 줄 정의 | 본 PR 시점 상태 |
|---|---|---|
| **F1. 자동 기장 엔진** | 결제만 하면 복식부기 분개가 알아서 써짐 (Step Functions + Bedrock Sonnet 4.6) | ✅ Done (Phase 0) |
| **F2. 노션형 장부 뷰** | 거래 DB / 받을 돈 칸반 / 이번 달 요약 / 계정별 잔액 4뷰 | ✅ Done (Phase 0) |
| **F3. AI 매니저 챗** | tax-strategy + fx-strategy SSE 에이전트. 7단 구조 답변 | ✅ Phase 1 (수동 응답 모드 완료; 능동 알림 모드는 Phase 2) |
| **F4. 세금 캘린더 & 신고 자료** | 부가세·원천세·법인세·종소세 D-day + 자료 자동 생성 | 🔄 Phase 1 진행 중 |
| **F5. FX 스마트 정산** | 외화 잔액 등록(수동/CODEF) + 환율 추세 분석 + 환전 권고 | ✅ MVP Done (manual USD CRUD + fx-strategy 에이전트 3 시나리오) |

## Product Use Cases

### 여정 A — 온보딩 (5분 이내)

```
회원가입 (Cognito Hosted UI: Google OAuth)
  → GET  /me                                      — personal tenant 자동 발급
  → POST /tenants/{id}/bank-connections           — 신한 ID/PW 인증, 보유 계좌 디스커버리
  → POST /tenants/{id}/bank-accounts              — 모니터링할 계좌 confirm
  → POST /tenants/{id}/fs/sync  (SSE Function URL)
                                                  — 한 connection 에서
                                                    run-started → account → classification(certain|uncertain) → done
```

휴리스틱 1차 분류로 큰 그림이 ≤5초 안에 뜨고, Sonnet 정밀 분류는 백그라운드 (10~30분).

### 여정 B — 일상 (수동적)

- 평소처럼 법인카드로 결제만.
- 백그라운드에서 데이터 수집·분류·기장.
- 매일 오전 9시 알림톡 1개 ("오늘 확인할 거 1가지" 또는 "오늘은 다 정리됐어요!").

### 여정 C — Tax Strategy 에이전트 호출

5개 시나리오 — `POST /tenants/{id}/tax/strategy` (SSE Function URL):

- `applicable_benefits` — 청년창업감면·R&D 세액공제 등 적용 가능 혜택 평가
- `upcoming_deadlines` — 다가오는 6개월 신고 마감 점검
- `yearly_filing_check` — 연간 신고 누락 위험 평가
- `vat_quarter_review` — 부가세 분기 점검
- `penalty_risk_check` — 가산세 위험 시뮬레이션 (compute_penalty_scenario 도구)

### 여정 D — FX Strategy 에이전트 호출 (선택)

외화 입출금이 있는 사용자만:

```
POST   /tenants/{id}/fx/accounts                       — manual USD 외화계좌 등록 (currency, balance, bankLabel)
GET    /tenants/{id}/fx/accounts                       — manual + CODEF foreign union, 오늘 KRW 환산 포함
GET    /tenants/{id}/fx/accounts/discoverable          — CODEF 보유계좌(외화) 발견. 기존 connectedId 재사용
                                                         (?organization=0088). USD 외 통화/이미 연결된 계좌 플래그 포함
POST   /tenants/{id}/fx/accounts/link                  — Discoverable 응답에서 고른 외화계좌를 실제 연결
                                                         (CODEF source, is_manual=false)
PATCH  /tenants/{id}/fx/accounts/{aid}/balance         — manual 잔액 갱신 (CODEF 연결 계좌는 409)
DELETE /tenants/{id}/fx/accounts/{aid}                 — manual soft delete (CODEF 연결 계좌는 409)
POST   /tenants/{id}/fx/strategy  (SSE Function URL)   — exposure_summary / convert_now_check / monthly_outlook
```

> **CODEF 연결 외화계좌**는 `POST /tenants/{id}/bank-connections` 로 발급된 `connectedId` 를 재사용한다.
> 동일 보유계좌 API(`account-list`) 응답의 `resForeignCurrency` 를 추출하므로 별도 인증 단계가 없다.
> 같은 은행 KRW 계좌를 먼저 connect 한 뒤에만 해당 은행의 외화계좌를 link 할 수 있다.

7단 구조 답변 (현재 노출 / 핵심 결론 / 근거 / 권고 옵션 비교 / 숫자로 보는 예시 / 위험 경고 / 참고 자료). 헷지·옵션 권유 금지, 환율 예측 불가 명시.

### 분개의 confidence model (migration 0023)

모든 거래는 단일 `journal_entries` 테이블에 들어가고 `confidence_status` 컬럼으로 분류된다:

- **`certain`** — 자동 분류 완료 or 사용자가 confirm
- **`uncertain`** — AI 가 확신 없이 분류. PATCH 로 라인 수정 후 confirm 또는 discard
- **`discarded`** — 사용자가 폐기. row 는 audit 용으로 보존, 집계에서 제외

별도 draft 테이블 없음. 재무제표(P&L, BS, CF, TB)도 certain/uncertain/total 로 분해해서 반환. 자세한 응답 형식은 `docs/API_LIST.md` 참조.

## Architecture

전체 아키텍처(6개 CDK 스택, 데이터 흐름, 부하 분산·스케일링 평가, RDS Proxy 부재 리스크 분석)는 `docs/ARCHITECTURE.md` 에 정리되어 있다.

## Agent Architecture

두 SSE 에이전트(tax-strategy, fx-strategy)는 같은 설계를 따른다 — `docs/agent-architecture.md` 참조. 핵심:

- raw context first: 7단 마크다운 답변을 위해 사용자 실제 데이터(분개·잔액·환율 30일)를 prompt에 직접 박는다. 요약하지 않음.
- shared infrastructure: `@ym/agent-core` (`withStreamingErrorBoundary` + `runAgent`), `@ym/shared-auth` (`verifyJwt`), `infrastructure/lib/config/cors.config.ts` (`buildFunctionUrlCors`).
- 모델: Sonnet 4.6 (transaction classifier), Opus 4.6 (advisory; 4.7 fallback 활성화).

## AWS Credentials Setup

AWS keys live in `~/.aws/credentials` (never in `.env`).

```bash
aws configure --profile ym-dev
# AWS Access Key ID: <your-key>
# AWS Secret Access Key: <your-secret>
# Default region: ap-northeast-2
# Default output: json
```

`.env`은 비-AWS 자격증명만 보관 (CODEF, Google OAuth, ECOS 등). 예:

```
ECOS_API_KEY=...
CODEF_CLIENT_ID=...
CODEF_CLIENT_SECRET=...
CODEF_PUBLIC_KEY=...
GOOGLE_OAUTH_CLIENT=...
GOOGLE_OAUTH_SECRET=...
CODEF_CREDENTIAL_SECRET_ARN=arn:aws:secretsmanager:ap-northeast-2:...:secret:CodefCredentialSecret...
ECOS_CREDENTIAL_SECRET_ARN=arn:aws:secretsmanager:ap-northeast-2:...:secret:EcosCredentialSecret...
HOLIDAY_API_SERVICE_KEY=...
# E2E 테스트용 (선택)
SHINHAN_MY_ID=...
SHINHAN_MY_PASSWORD=...
SHINHAN_TARGET_ACCOUNT=110xxxxxxxxx
API_E2E_USERNAME=api-e2e-...@ym-e2e.test
API_E2E_PASSWORD=...
```

`.env`는 `.gitignore`로 보호된다. 절대 커밋하지 않는다.

## Local Development

Required: Node.js 20+, npm 10+.

```bash
npm install
npm test                                                                                  # 전체 워크스페이스
CDK_ENV=dev AWS_ACCOUNT_ID=823401933116 AWS_REGION=ap-northeast-2 npx --workspace=@ym/infrastructure cdk synth --strict  # CI 검증
```

## Deploy

```bash
# 환경변수는 운영자 셸에서 export하거나 .env에서 읽어 export
AWS_PROFILE=ym-dev AWS_REGION=ap-northeast-2 \
  CDK_ENV=dev AWS_ACCOUNT_ID=823401933116 \
  GOOGLE_OAUTH_CLIENT=$GOOGLE_OAUTH_CLIENT GOOGLE_OAUTH_SECRET=$GOOGLE_OAUTH_SECRET \
  npx --workspace=@ym/infrastructure cdk deploy --all --require-approval never --concurrency 1

# Secrets Manager 동기화 (.env에 raw 자격증명 + ARN 모두 있어야 함)
./scripts/sync-secrets-from-env.sh /Users/.../yourmillionare/.env
```

스택 의존성 때문에 부분 배포 시에는 다음 순서를 권장:

```bash
# 1) Data (migration 적용)
npx cdk deploy Ym-Dev-Data --exclusively
# 2) Api (CodefSyncStreamFn / TaxStrategyFn / FxStrategyFn Function URL, journal/tax/identity/fx Lambda 갱신)
npx cdk deploy Ym-Dev-Api --exclusively
# 3) Ingestion (scheduled CODEF fetch SM, classify worker, FxCollectorFn)
npx cdk deploy Ym-Dev-Ingestion --exclusively

# 4) Post-deploy 회귀 검증 (catch-all 404 / Function URL preflight / FxCollector invoke)
./scripts/post-deploy-smoke.sh
```

CI는 `npx cdk synth --strict`만 수행 (deploy 권한 없음). `bin/yourmillionare.ts`는 GOOGLE_OAUTH 환경변수 미설정 시 placeholder fallback으로 synth 가능하도록 구성됐다.

## E2E Tests

| Script | 용도 |
|--------|------|
| `scripts/run-api-e2e.sh` | HTTP API 회귀 테스트 (Cognito + tenants + entries). NDJSON `docs/api-e2e-raw.ndjson` 생성 |
| `scripts/run-codef-e2e.sh` | CODEF 엔드 투 엔드 (신한 ID/PW 1회 + SFN + Bedrock + 조회). 실 계좌 데이터 포함 |
| `scripts/run-agents-e2e.sh` | Tax 5 + FX 3 시나리오 SSE 호출 + 7단 구조·핵심 키워드 검증 |
| `scripts/post-deploy-smoke.sh` | 매 배포 직후 호출 — catch-all 404+CORS / 3개 SSE preflight / FxCollector invoke |

CODEF E2E는 신한 인터넷뱅킹 5회 PW 오류 잠금을 막기 위해 정상 ID/PW를 정확히 1회만 사용한다. 실패 시 즉시 abort.

## Environment Variables (CDK)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CDK_ENV` | yes | — | `dev` 또는 `prod` |
| `AWS_REGION` | no | `ap-northeast-2` | Seoul region |
| `AWS_ACCOUNT_ID` | yes | — | 12-digit account number |
| `VPC_CIDR` | no | `10.20.0.0/16` | Override if CIDR conflicts |
| `GOOGLE_OAUTH_CLIENT` | deploy | placeholder | GCP OAuth 2.0 Client ID. Synth는 placeholder로 통과 |
| `GOOGLE_OAUTH_SECRET` | deploy | placeholder | GCP OAuth client secret |
| `COGNITO_DOMAIN_PREFIX` | no | `yourmillionare-{env}` | Hosted UI subdomain prefix |
| `COGNITO_CALLBACK_URLS` | no | `http://localhost:3000/callback` | comma-separated |
| `API_CORS_ALLOWED_ORIGINS` | no | `http://localhost:3000,http://localhost:5173` | HTTP API + Function URL CORS |
| `ECOS_CREDENTIAL_SECRET_ARN` | deploy | — | Secrets Manager ARN with `{ "apiKey": ... }`. fx Lambda + FxCollectorFn 둘 다 사용 |
| `CODEF_CREDENTIAL_SECRET_ARN` | deploy | — | Secrets Manager ARN for CODEF client credentials. identity + codef-sync + fx Lambda(외화계좌 discover/link) 가 사용 |

## Open Items

- **Account isolation**: 단일 AWS account에서 `Ym-Dev-*` / `Ym-Prod-*` prefix로 분리. Phase 1 이전 account-level 분리 재검토.
- **CODEF 자격증명 마이그레이션**: 현재 loginType=1 (ID/PW). Phase 1에서 인증서 팝업(loginType=0) 또는 간편인증(loginType=5 Kakao/Toss/PASS)으로 교체.
- **CODEF 외화 거래 분기**: 보유계좌(`account-list`) `resForeignCurrency` 파싱 + `/fx/accounts/discoverable` + `/fx/accounts/link` + FX 거래내역 sync (`source='codef_fx'`, `fcy_currency`/`fcy_amount`/`fx_rate` 저장, KRW 환산은 `fx_observations`의 closing rate 사용) 완료. **자동 분개(journal_entries) 매핑은 여전히 후속 작업** — 현재 FX raw_transactions 는 fetch 후 즉시 `dispatched_at`을 찍어두고 Bedrock classifier 로는 enqueue 하지 않음 (분류기가 KRW 전제로 동작하므로).
- **PATCH /entries idempotency**: 라인 정정 + confirm 흐름에 `Idempotency-Key` 추가 검토.
- **CDK Pipelines**: 로컬 `cdk deploy` only. GitHub Actions는 synth만 실행. PR-driven deploy는 Phase 1.
- **Domain & Route53**: 미설정. Public endpoint 노출 전 결정.
