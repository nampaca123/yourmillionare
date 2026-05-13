# YourMillionare

AWS cloud-native AI accounting agent for early-stage Korean startups and individuals. CODEF로 은행 거래내역을 자동 수집하고, Bedrock(Claude Sonnet 4.6)이 K-IFRS 복식부기 분개를 자동 생성한다. See `PLAN.md` for the full product and architecture spec.

## Repository Layout

```
yourmillionare/
├── infrastructure/           # CDK TypeScript app (6 stacks deployed in ap-northeast-2)
├── apps/
│   ├── identity/             # Cognito user / tenant + bank-connections + bank-accounts
│   ├── journal/              # Unified /entries CRUD + reports/views (HTTP API)
│   ├── codef/                # CODEF ingestion (scheduled fetch lambda + SSE Function URL fs-sync-stream)
│   ├── tax/                  # Tax filings, withholding, tax-invoices, corporation profile
│   ├── tax-knowledge/        # AgentCore-style tools + admin (search-tax-law, find-benefits)
│   └── fx/                   # ECOS FX collector
├── packages/
│   ├── shared-errors/        # AppError hierarchy + toHttpErrorResponse
│   ├── shared-auth/          # Cognito JWT claims mapper
│   ├── agent-core/           # SSE writers + JWT verifier for Function URL Lambdas (tax-strategy, fs-sync-stream)
│   ├── journal-core/         # Domain (entities, classifiers, K-IFRS chart, PG journal repo)
│   ├── reports-core/         # K-IFRS builders (P&L, BS, CF, TB) with {certain, uncertain, total} breakdown
│   ├── tax-core/             # Tax calculators
│   └── tax-domain/           # Tax filing engine
├── docs/                     # Slice implementation reports + API_LIST.md (FE integration guide)
├── scripts/                  # sync-secrets, run-api-e2e, run-codef-e2e
├── PLAN.md                   # Product and architecture plan
├── schema.sql                # Aurora PostgreSQL DDL — single source of truth
└── CLAUDE.md                 # Engineering guidelines
```

## Status

All 6 stacks deployed to `ap-northeast-2` (account 823401933116). Bedrock Sonnet 4.6 verified live (model_id + token usage recorded in `ai_decisions`).

| Stack | Status | Notes |
|-------|--------|-------|
| `Ym-Dev-Foundation` | ✅ DEPLOYED | KMS CMK + CODEF/ECOS credential secret slots |
| `Ym-Dev-Network` | ✅ DEPLOYED | VPC, fck-nat, VPC endpoints, Flow Logs |
| `Ym-Dev-Data` | ✅ DEPLOYED | Aurora Serverless v2 PG 15.10, DynamoDB tables, migrations 0001–0023 |
| `Ym-Dev-Identity` | ✅ DEPLOYED | Cognito User Pool + Hosted UI + Google IdP |
| `Ym-Dev-Api` | ✅ DEPLOYED | HTTP API + JWT Authorizer, 4 service Lambdas, 2 SSE Function URLs |
| `Ym-Dev-Ingestion` | ✅ DEPLOYED | EventBridge schedule + SFN (scheduled CODEF fetch) + SQS classify worker; manual sync now goes via SSE Function URL in Api stack |

## User-facing flow

```
Google OAuth (Cognito Hosted UI)
  → GET  /me                                       — personal tenant 자동 발급
  → POST /tenants/{id}/bank-connections            — 신한 ID/PW 인증, 보유 계좌 디스커버리
  → POST /tenants/{id}/bank-accounts               — 모니터링할 계좌 confirm

  → POST /tenants/{id}/fs/sync  (SSE Function URL) — body로 from/to/accountIds 선택. 한 connection 에서
                                                     run-started → account → classification(certain|uncertain) → done

  → GET    /tenants/{id}/entries                   — 모든 분개 (confidenceStatus 포함). 별도 drafts API 없음.
  → PATCH  /tenants/{id}/entries/{entryId}         — uncertain 항목 라인 정정
  → POST   /tenants/{id}/entries/{entryId}/confirm — uncertain → certain
  → POST   /tenants/{id}/entries/{entryId}/discard — uncertain → discarded
  → GET    /tenants/{id}/reports/pnl|balance-sheet|cash-flow|trial-balance — 모든 금액이 {certain,uncertain,total} 분해
  → GET    /tenants/{id}/summary/monthly | /accounts/balances | /receivables — 동일하게 분해
```

### 분개의 confidence model (0023)

모든 거래는 단일 `journal_entries` 테이블에 들어가고, `confidence_status` 컬럼으로 분류된다:

- **`certain`** — 자동 분류 완료 or 사용자가 confirm. 회계 원장으로 신뢰 가능.
- **`uncertain`** — AI 가 확신 없이 분류. 사용자가 PATCH 로 라인 수정 후 confirm 하거나 discard. 모든 read 응답에 함께 포함되며 라벨링된다.
- **`discarded`** — 사용자가 폐기. row 는 audit 용으로 보존, 모든 집계에서 제외.

별도 draft 테이블 없음. 재무제표(P&L, BS, CF, TB)도 certain/uncertain/total 로 분해해서 반환 — 백엔드가 데이터를 숨기지 않는다. 자세한 응답 형식은 `docs/API_LIST.md` 참조.

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
# 2) Api (CodefSyncStreamFn Function URL, journal/tax/identity Lambda 갱신)
npx cdk deploy Ym-Dev-Api --exclusively
# 3) Ingestion (scheduled CODEF fetch SM, classify worker)
npx cdk deploy Ym-Dev-Ingestion --exclusively
```

CI는 `npx cdk synth --strict`만 수행 (deploy 권한 없음). `bin/yourmillionare.ts`는 GOOGLE_OAUTH 환경변수 미설정 시 placeholder fallback으로 synth 가능하도록 구성됐다.

## E2E Tests

| Script | 용도 |
|--------|------|
| `scripts/run-api-e2e.sh` | HTTP API 회귀 테스트 (Cognito + tenants + entries). NDJSON `docs/api-e2e-raw.ndjson` 생성 |
| `scripts/run-codef-e2e.sh` | CODEF 엔드 투 엔드 (신한 ID/PW 1회 + SFN + Bedrock + 조회). NDJSON `docs/codef-e2e-raw.ndjson` (gitignored — 실제 계좌 데이터 포함) |

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

## Open Items

- **Account isolation**: 단일 AWS account에서 `Ym-Dev-*` / `Ym-Prod-*` prefix로 분리. PLAN.md §5.2가 권하는 account-level 분리는 Phase 1 이전 재검토.
- **CODEF 자격증명 마이그레이션**: 현재 loginType=1 (ID/PW). Phase 1에서 인증서 팝업(loginType=0) 또는 간편인증(loginType=5 Kakao/Toss/PASS)으로 교체.
- **PATCH /entries idempotency**: 라인 정정 + confirm 흐름에 `Idempotency-Key` 추가 검토. 현재 PATCH 는 stateless 하므로 중복 호출 시 마지막 라인 그대로 유지되어 큰 위험은 없으나 confirm 은 중복 시 새 entry 가 만들어질 위험이 있음.
- **`reclassify: true` 처리**: SSE body 에 받기는 하나 lambda 가 아직 활용 안 함. 이미 fetch 된 raw_tx 의 dispatched_at 을 reset 하고 재분류 트리거하는 로직 필요.
- **CDK Pipelines**: 로컬 `cdk deploy` only. GitHub Actions는 synth만 실행. PR-driven deploy는 Phase 1.
- **Domain & Route53**: 미설정. Public endpoint 노출 전 결정.
