# YourMillionare

AWS cloud-native AI accounting agent for early-stage Korean startups and individuals. CODEF로 은행 거래내역을 자동 수집하고, Bedrock(Claude Sonnet 4.6)이 K-IFRS 복식부기 분개를 자동 생성한다. See `PLAN.md` for the full product and architecture spec.

## Repository Layout

```
yourmillionare/
├── infrastructure/   # CDK TypeScript app (6 stacks deployed in ap-northeast-2)
├── apps/
│   ├── identity/     # Cognito user / tenant + bank-connections + bank-accounts
│   ├── journal/      # AI accounting journal (HTTP classify + entries listing)
│   ├── codef/        # CODEF ingestion Lambdas (tenants-list, fetch, classify-worker)
│   └── fx/           # ECOS FX collector (skeleton)
├── packages/
│   ├── shared-errors/  # AppError hierarchy + toHttpErrorResponse
│   └── journal-core/   # Shared domain (entities, classifiers, K-IFRS chart, repos)
├── docs/             # Slice implementation reports (01–06)
├── scripts/          # sync-secrets, run-api-e2e, run-codef-e2e
├── PLAN.md           # Product and architecture plan
├── schema.sql        # Aurora PostgreSQL DDL — single source of truth
└── CLAUDE.md         # Engineering guidelines
```

## Status — Slice 6 complete (CODEF MVP end-to-end)

All 6 stacks deployed to `ap-northeast-2` (account 823401933116). 16/16 CODEF E2E scenarios verified with real Shinhan account; Bedrock Sonnet 4.6 verified live (3 transactions, model_id + token usage recorded in `ai_decisions`).

| Stack | Status | Notes |
|-------|--------|-------|
| `Ym-Dev-Foundation` | ✅ DEPLOYED | KMS CMK + CODEF/ECOS credential secret slots |
| `Ym-Dev-Network` | ✅ DEPLOYED | VPC, fck-nat (t4g.nano NAT instance), VPC endpoints, Flow Logs |
| `Ym-Dev-Data` | ✅ DEPLOYED | Aurora Serverless v2 PG 15.10, 4 DynamoDB tables, schema migrator + verifier (migrations 0001–0010) |
| `Ym-Dev-Identity` | ✅ DEPLOYED | Cognito User Pool + Hosted UI domain + Google IdP |
| `Ym-Dev-Api` | ✅ DEPLOYED | HTTP API, JWT Authorizer, Identity Lambda (PRIVATE_WITH_EGRESS for CODEF), Journal Lambda |
| `Ym-Dev-Ingestion` | ✅ DEPLOYED | SFN + SQS + EventBridge schedule + DLQ alarms; CodefFetchFn + ClassifyWorkerFn live |

User-facing flow validated end-to-end:

```
Google OAuth (Cognito Hosted UI)
  → GET /me                                       — personal tenant 자동 발급
  → POST /tenants/{id}/bank-connections           — 신한 ID/PW로 인증, 보유 계좌 디스커버리
  → POST /tenants/{id}/bank-accounts              — 모니터링할 계좌 confirm
  → (auto, 6h) SFN → CODEF transaction-list → SQS → Bedrock Sonnet 4.6 → journal_entries
  → GET /tenants/{id}/journal/entries             — 분개 결과 조회
```

Live Bedrock 검증 결과 (3건 sample): `ai_model = global.anthropic.claude-sonnet-4-6`, confidence 0.45/0.60/0.72 (가변), input ~913 / output ~110 tokens per call. Stub classifier는 unit test 전용으로만 남아 있고 deploy되는 Lambda 어디에도 wired되지 않는다 (dev/prod 모두 실 Bedrock 사용).

자세한 슬라이스별 진행 상태는 `docs/STATUS.md`, 기능별 작업 보고서는 `docs/01-foundation.ko.md` ~ `docs/06-slice6.ko.md`.

## AWS Credentials Setup

AWS keys live in `~/.aws/credentials` (never in `.env`).

```bash
aws configure --profile ym-dev
# AWS Access Key ID: <your-key>
# AWS Secret Access Key: <your-secret>
# Default region: ap-northeast-2
# Default output: json
```

`.env`은 비-AWS 자격증명만 보관 (CODEF, Google OAuth, ECOS 등). CDK output에서 받은 Secret ARN도 `.env`에 추가:

```
ECOS_API_KEY=...
CODEF_CLIENT_ID=...
CODEF_CLIENT_SECRET=...
CODEF_PUBLIC_KEY=...
GOOGLE_OAUTH_CLIENT=...
GOOGLE_OAUTH_SECRET=...
CODEF_CREDENTIAL_SECRET_ARN=arn:aws:secretsmanager:ap-northeast-2:...:secret:CodefCredentialSecret...
ECOS_CREDENTIAL_SECRET_ARN=arn:aws:secretsmanager:ap-northeast-2:...:secret:EcosCredentialSecret...
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

CI는 `npx cdk synth --strict`만 수행한다 (deploy 권한 없음). `bin/yourmillionare.ts`는 GOOGLE_OAUTH 환경변수 미설정 시 placeholder fallback으로 synth 가능하도록 구성됐다.

## E2E Tests

| Script | 용도 |
|--------|------|
| `scripts/run-api-e2e.sh` | HTTP API 회귀 테스트 (Cognito + tenants + journal classify/entries). NDJSON `docs/api-e2e-raw.ndjson` 생성 |
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

## Open Items

- **Account isolation**: 단일 AWS account에서 `Ym-Dev-*` / `Ym-Prod-*` prefix로 분리. PLAN.md §5.2가 권하는 account-level 분리는 Phase 1 이전 재검토.
- **CODEF 자격증명 마이그레이션**: 현재 loginType=1 (ID/PW). Phase 1에서 인증서 팝업(loginType=0) 또는 간편인증(loginType=5 Kakao/Toss/PASS)으로 교체. 이번 Slice의 보안 트레이드오프는 `docs/STATUS.md` 참조.
- **CDK Pipelines**: 로컬 `cdk deploy` only. GitHub Actions는 synth만 실행. PR-driven deploy는 Phase 1.
- **Foundation Secret CMK 정합성**: KmsKeyId removal이 Secrets Manager 한계로 CFN drift 발생. 운영 영향 없으나 CDK에서 `encryptionKey: alias/aws/secretsmanager`로 명시 정리 시 깔끔.
- **Domain & Route53**: 미설정. Public endpoint 노출 전 결정.
