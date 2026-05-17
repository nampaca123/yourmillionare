# Architecture

YourMillionare 의 AWS 아키텍처, 데이터 흐름, 부하 분산·스케일링 전략을 한 자리에서 정리한 문서. 코드(`infrastructure/lib/`, `apps/`, `packages/`)가 단일 진실 공급원이며, 본 문서는 그 단면을 잘라 보여준다.

- **리전**: `ap-northeast-2` (Seoul)
- **계정**: `823401933116` (단일 계정, `Ym-Dev-*` / `Ym-Prod-*` 스택 prefix 로 환경 분리)
- **IaC**: CDK v2 (TypeScript) + cdk-nag (`AwsSolutionsChecks`)
- **런타임**: Lambda Node.js 20 ARM64, Aurora PostgreSQL 15.10, Bedrock (Sonnet 4.6 / Opus 4.6)
- **상위 레벨 형태**: 단일 VPC 안의 fully-serverless 모노레포 — ALB/NLB 없음, EC2 워크로드는 fck-nat 인스턴스뿐

---

## 1. 스택 토폴로지

6개 스택을 의존 순서대로 배포한다. 한 스택의 export 가 다른 스택의 prop 으로 흐른다 — 명시적 `addDependency` 로 cycle 을 차단했다.

```
Foundation ──┬── Network ──┬── Data ──┬── Ingestion
             │             │          │
             │             │          └── Api
             │             │
             └── Identity ─┘
```

| Stack | 주요 리소스 | 다운스트림이 받아가는 것 |
|---|---|---|
| `Ym-Dev-Foundation` | Shared KMS CMK, CODEF/ECOS Secret slot | `sharedKey`, `codefCredentialSecret`, `ecosCredentialSecret` |
| `Ym-Dev-Network` | VPC (`10.20.0.0/16`, 3 AZ), fck-nat, 4 VPC endpoints, Flow Logs | `vpc`, `lambdaSg`, `auroraSg` |
| `Ym-Dev-Data` | Aurora Serverless v2 + 4 DynamoDB 테이블 + 스키마 마이그레이터 | `aurora.cluster`, `cache.*` |
| `Ym-Dev-Identity` | Cognito User Pool + Google IdP + Hosted UI | `userPool`, `userPoolClient`, `issuerUrl` |
| `Ym-Dev-Ingestion` | EventBridge + Step Functions + SQS + 7 Lambda + Bedrock KB | `legalKbId`, `filingGeneratorFn`, `legalSyncStateMachineArn` |
| `Ym-Dev-Api` | HTTP API + JWT Authorizer + 5 service Lambda + 3 SSE Function URL | (terminal) |

---

## 2. 컴포넌트별 상세

### 2.1 Foundation Stack ([infrastructure/lib/stacks/foundation.stack.ts](../infrastructure/lib/stacks/foundation.stack.ts))

- **SharedKey**: CMK with rotation. DynamoDB 4종 + (가용한 경우) Secret 의 디폴트 암호화.
- **CodefCredentialSecret / EcosCredentialSecret**: AWS-managed `aws/secretsmanager` 키로 암호화 — Foundation→Api KMS 키 policy 사이클을 피하기 위한 의도된 선택. 값은 `scripts/sync-secrets-from-env.sh` 로 외부 주입.
- 외부 발급 자격증명이므로 **자동 rotation 미적용** (Phase 1 의 AgentCore Identity 90일 cycle 에서 대체).

### 2.2 Network Stack ([infrastructure/lib/stacks/network.stack.ts](../infrastructure/lib/stacks/network.stack.ts))

```
VPC 10.20.0.0/16  (3 AZ — a/b/c)
├── public      10.20.0-2.0/24    → fck-nat instance(s)
├── isolated    10.20.3-5.0/24    → Aurora, VPC Endpoint ENI
└── egress      10.20.6-8.0/24    → 모든 애플리케이션 Lambda
```

- **NAT**: `NatProvider.instanceV2` (fck-nat AMI, t4g.nano, ARM64).
  - dev: 1 인스턴스 (azs[0]) — SPOF 의도적으로 수용, ~$3.5/월.
  - prod: 3 인스턴스 — AZ 당 하나, ~$10.5/월. NAT Gateway 대비 약 1/3 비용.
  - IMDSv2 강제 (`HttpTokens: required`).
- **VPC Endpoints**:
  - Interface: Secrets Manager, KMS — `PRIVATE_ISOLATED`, `privateDnsEnabled`. Lambda 가 인터넷 거치지 않고 시크릿/KMS 호출.
  - Gateway: S3, DynamoDB — 무료.
- **Security Groups**:
  - `lambdaSg`: outbound 전체 허용.
  - `auroraSg`: inbound 5432 from `lambdaSg` **만** (no CIDR ingress).
- **Flow Logs**: ALL 트래픽 → CMK 암호화 CloudWatch Log Group (prod 90d / dev 14d).

### 2.3 Data Stack ([infrastructure/lib/stacks/data.stack.ts](../infrastructure/lib/stacks/data.stack.ts))

#### Aurora Serverless v2 ([infrastructure/lib/stacks/data/aurora.construct.ts](../infrastructure/lib/stacks/data/aurora.construct.ts))

| 속성 | dev | prod |
|---|---|---|
| Engine | Aurora PostgreSQL 15.10 | 동일 |
| Capacity (ACU) | 0.5 ~ **2** | 0.5 ~ **4** |
| Writer | 1 (Serverless v2) | 1 (Serverless v2) — reader 없음 |
| 서브넷 | `PRIVATE_ISOLATED` | 동일 |
| 인증 | IAM auth + Data API + master secret | 동일 |
| Performance Insights | enabled (7 days) | enabled |
| Backup | 1 day | 14 days |
| Master secret rotation | 30 days (Hosted Rotation, single-user) | 동일 |
| Storage 암호화 키 | 전용 CMK (rotation) | 동일 |
| Deletion protection | OFF | ON |

- **연결**: `pg.Pool` (`max: 1`) per Lambda instance — [apps/journal/src/infrastructure/outbound/pg/pg-pool.client.ts](../apps/journal/src/infrastructure/outbound/pg/pg-pool.client.ts).
  - IAM auth token 을 15분 TTL 로 캐시, 만료 3분 전 갱신.
  - 동시 refresh 는 in-flight Promise 로 dedup.
  - **`max:1` 이유**: 한 connection 에서 `app.current_tenant_id` / `app.cognito_sub` GUC 를 set 해 PostgreSQL RLS 를 거는 구조이므로, connection sharing 은 안전하지 않다.
- **RDS Proxy 도입 (PR-A 머지 후)**: Aurora writer 앞에 RDS Proxy 1개.
  - IAM auth (client), Secrets Manager (backend), TLS 양방향 검증 (PR-B1 부터).
  - `maxConnectionsPercent: 90` / `maxIdleConnectionsPercent: 50` / `idleClientTimeout: 30m`.
  - Lambda 의 `pg.Pool({ max: 1 })` 은 유지 — Lambda 인스턴스 단위 RLS 컨텍스트 격리는 Proxy 와 무관.

#### DynamoDB 캐시 ([infrastructure/lib/stacks/data/cache.construct.ts](../infrastructure/lib/stacks/data/cache.construct.ts))

4개 테이블 모두 `(pk, sk)` 파티션+정렬 키, `PAY_PER_REQUEST`, Shared CMK 암호화.

| Table | 용도 | TTL |
|---|---|---|
| `MonthlySummaryCache` | 월별 P&L 프로젝션 캐시 | — |
| `TransactionCache` | CODEF raw 거래 dedup / 분류 결과 캐시 | — |
| `IdempotencyKeys` | `@aws-lambda-powertools/idempotency` persistence store | `expires_at` |
| `CostCounter` | 사용자당 일일 Bedrock 호출 카운트 | `expires_at` |

#### 마이그레이터 ([infrastructure/lib/stacks/data/schema-migrator.lambda.ts](../infrastructure/lib/stacks/data/schema-migrator.lambda.ts))

- CDK Custom Resource → Provider Lambda. `schema.sql` + `migrations/*.sql` 의 sha256 이 properties 에 박혀 있어 변경 시 자동 re-run.
- `reservedConcurrentExecutions: 1` — 동시 마이그레이션 차단.
- Data API 사용 → VPC 없이도 cluster 에 접속 가능. Aurora resume cold-start 시 15초 백오프 retry.

### 2.4 Identity Stack ([infrastructure/lib/stacks/identity.stack.ts](../infrastructure/lib/stacks/identity.stack.ts))

- **Cognito User Pool**: 이메일 sign-in, 12자 강한 password policy.
  - dev: MFA OFF / AdvancedSecurity OFF (비용 절감 — $0.05/MAU).
  - prod: MFA OPTIONAL / AdvancedSecurity **ENFORCED**.
- **Google IdP**: scope `openid email profile`, attribute mapping.
- **Hosted UI**: `yourmillionare-{env}.auth.ap-northeast-2.amazoncognito.com`, Authorization Code Grant.
- **App Client**: secret 없음 (SPA-style). User Pool Client 가 `googleIdp` 와 `domain` 둘 다 의존.
- **Issuer URL** 은 HTTP API JWT Authorizer 의 `iss` claim 검증에 사용.

### 2.5 Ingestion Stack ([infrastructure/lib/stacks/ingestion.stack.ts](../infrastructure/lib/stacks/ingestion.stack.ts))

```
EventBridge (rate 6h) ──► IngestionStateMachine (SFN)
                              │
                              ├─ ListTenantsTask     (TenantsListFn)
                              └─ Map maxConcurrency=3
                                  └─ FetchTenantTask (CodefFetchFn)
                                       │
                                       └─► SQS ClassifyTasksQueue
                                             (batchSize=10, window=5s)
                                             │
                                             ▼
                                   CodefClassifyWorkerFn
                                   (reservedConcurrency=5)
                                             │
                                             ▼
                                   Bedrock Sonnet 4.6
                                   + Aurora write
                                   + DynamoDB TransactionCache

EventBridge (rate 1h) ──► FxCollectorFn ──► ECOS API ──► Aurora fx_observations

EventBridge (cron 매월 1일) ──► LegalSyncStateMachine
                                 ├─ MonthlyLawSyncFn  → S3 LegalKbBucket
                                 └─ StartLegalKbIngestion (Bedrock KB)

EventBridge (cron 12/31 + 매월 1일) ──► HolidayYearlySyncFn  → 공휴일 테이블
EventBridge (cron 매월 1일)         ──► FilingObligationGeneratorFn
```

- **SQS ClassifyTasksQueue**: `visibilityTimeout` 180s (= worker timeout 30s × 6 margin), `maxReceiveCount` 3 → DLQ 14d 보관.
- **DLQ depth alarm**: 메시지 ≥ 1 5분 → SNS topic `IngestionAlarmTopic`.
- **Legal Knowledge Base** ([ingestion/legal-kb.construct.ts](../infrastructure/lib/stacks/ingestion/legal-kb.construct.ts)):
  - 백엔드: **Aurora pgvector** (PostgreSQL 15.10, pgvector 0.8.0, pg_bigm 1.2).
  - 벡터 테이블: `bedrock_integration.bedrock_kb_legal` — `vector(1024)`, cosine, HNSW 인덱스.
  - 한국어 키워드 검색: `chunks` 컬럼에 pg_bigm GIN 인덱스. KB 호출 시 `overrideSearchType: 'HYBRID'`로 벡터+키워드 혼합 검색 활성화.
  - KB → DB 연결: RDS Data API (HTTPS 퍼블릭 엔드포인트, VPC 피어링 불필요).
  - KB 인증: 전용 스코프 역할 `bedrock_kb_user` — 비밀은 AWS Secrets Manager (`bedrock-kb-db-credentials`).
  - Embed: `amazon.titan-embed-text-v2:0` (ap-northeast-2), 1024 차원, cosine.
  - Data source: `s3://...legal-kb-bucket/chunks/` (사전 chunking, `ChunkingStrategy: 'NONE'`).
  - 월 1회 SFN 이 (1) OPEN_LAW 페치 → S3 업로드, (2) `StartIngestionJob` 호출.
  - Rerank: `cohere.rerank-v3-5:0` in `ap-northeast-1` (KB 와 다른 리전 — 비용 최적화).
  - **마이그레이션 이력**: 2026-05-12 ~ 2026-05-17 S3 Vectors 백엔드 사용. S3 Vectors의 필터가능 메타데이터 2KB 제한으로 한국 법령 코퍼스 수집 92.7% 실패 → Aurora pgvector 로 전환.

### 2.6 Api Stack ([infrastructure/lib/stacks/api.stack.ts](../infrastructure/lib/stacks/api.stack.ts))

#### HTTP API (v2)

- **JWT Authorizer**: Cognito Issuer URL, `jwtAudience = [userPoolClientId]` — **ID Token 만 통과** (Access Token 은 `aud` 없음).
- 라우트는 `addRoutes` 로 explicit 등록 (현재 43개 explicit + catch-all 12 = 총 55). 매핑은 [docs/API_LIST.md](API_LIST.md) 참조.
- **CORS**: `buildApiGwCors` 로 단일 source — `Authorization`, `Idempotency-Key`, `Last-Event-Id` 등 SSE 헤더 포함.
- **Access logs**: CloudWatch Log Group, JSON 형식 (`requestId`, `routeKey`, `status`, `responseLatency`).
- **Catch-all 404 Lambda** ([infrastructure/lib/lambdas/api-not-found.lambda.ts](../infrastructure/lib/lambdas/api-not-found.lambda.ts)): unmatched route 에 CORS 헤더 포함 404 + `/fs/sync` `/tax/strategy` `/fx/strategy` 의 movedTo URL 힌트.

#### 서비스 Lambda (HTTP integration)

모두 `PRIVATE_WITH_EGRESS` 서브넷 + `lambdaSg` 부착, ARM64, NODEJS_20_X.

| Lambda | Memory | Timeout | 주 의존성 |
|---|---|---|---|
| `IdentityFn` | 256 MB | 30 s | Cognito claims → tenant/account CRUD + CODEF discovery |
| `JournalFn` | 512 MB | 30 s | Bedrock Sonnet (classifier), entries CRUD, reports |
| `FxFn` | 256 MB | 15 s | ECOS rate proxy, manual USD 계좌 CRUD |
| `TaxFn` | 384 MB | 20 s | Filings, withholding, tax-invoices, corporation-profile |
| `TaxKnowledgeFn` | 512 MB | 30 s | 관리자 룰 moderation, KB sync trigger |

각 Lambda 는 `rds-db:connect` 를 `app_user` 로만 scope (`arn:aws:rds-db:...:dbuser:{clusterResourceIdentifier}/app_user`).

#### SSE Function URL (3개)

표준 패턴: `FunctionUrlAuthType.NONE` + `InvokeMode.RESPONSE_STREAM` + 람다 내부에서 `verifyJwt` 로 직접 Cognito ID Token 검증. API Gateway 의 JWT Authorizer 는 streaming response 와 호환되지 않아 우회. 공통 시퀀스는 [docs/agent-architecture.md](agent-architecture.md) 참조.

| Function URL | Memory | Timeout | 모델 | maxIterations |
|---|---|---|---|---|
| `CodefSyncStreamFn` | 1024 MB | 14 min | Sonnet 4.6 (classifier) | — (분류 N건 inline) |
| `TaxStrategyFn` | 512 MB | 10 min | Opus 4.6 | 12 |
| `FxStrategyFn` | 512 MB | 10 min | Opus 4.6 | 8 |

`TaxStrategyFn` 만 KB Retrieve + Rerank 권한을 추가로 가진다 (`bedrock:Retrieve`, `bedrock:RetrieveAndGenerate`, `bedrock:Rerank`).

---

## 3. 데이터 흐름

### 3.1 온보딩 + CRUD (HTTP API 경로)

```
Browser (SPA, localhost:3000 등)
  │
  │  1. Cognito Hosted UI Google OAuth → Authorization Code → ID Token
  ▼
HTTP API (regional)
  │  Authorization: Bearer <ID Token>
  │  JWT Authorizer (audience=clientId)
  ▼
Lambda (Identity/Journal/Fx/Tax)
  │  RLS GUC set: app.current_tenant_id, app.cognito_sub
  ▼
RDS Proxy (writer endpoint)
  │  IAM auth (client), Secrets Manager (backend)
  │  TLS required (both sides — pinning from PR-B1)
  ▼
Aurora Serverless v2 (PRIVATE_ISOLATED)
   ── 또는 ──
DynamoDB (Idempotency / Cost / Cache)
```

- **Idempotency** ([apps/journal/src/main.ts](../apps/journal/src/main.ts)): `Idempotency-Key` 헤더가 들어오면 `@aws-lambda-powertools/idempotency` + DynamoDB persistence 가 in-progress / 재사용을 처리한다 (각각 `IdempotencyInProgressError` 409, `IdempotencyKeyReusedError` 409 로 매핑).

### 3.2 CODEF 자동 기장 (EDA 파이프라인)

```
EventBridge (rate 6h)
  ▼
Step Functions IngestionStateMachine
  ▼ ListTenants
  ▼ Map (maxConcurrency=3)
     │
     └─ CodefFetchFn ─► Secrets Manager (CODEF token)
                    └─► CODEF API (외부) — listAccount / transactionList
                    └─► SQS ClassifyTasksQueue
                            │
                            ▼ (batchSize=10, maxBatchingWindow=5s, reportBatchItemFailures)
                       CodefClassifyWorkerFn (reservedConcurrency=5)
                            ├─ Bedrock Sonnet 4.6 (cross-region inference profile)
                            ├─ DynamoDB TransactionCache  (dedup + 분류 결과)
                            └─ Aurora journal_entries     (status=certain | uncertain)
```

병렬성 상한:
- SFN Map maxConcurrency **3** — CODEF 외부 API rate 보호.
- 워커 reserved concurrency **5** — Bedrock 비용 ceiling. 큐가 쌓이면 Lambda 가 throttle 하고 SQS 가 자연 buffering.
- 워커 batchSize 10 + 5s window — 한 invocation 당 최대 10개 거래를 처리, partial batch failure 는 큐에 남는다.

수동 동기화 (`POST /tenants/{id}/fs/sync`) 는 같은 파이프라인이 아니라 SSE Function URL `CodefSyncStreamFn` 에서 inline 으로 CODEF fetch + Bedrock 분류를 수행한다 — 사용자가 lock-screen 동안 progress 를 받을 수 있게.

### 3.3 SSE Agent (Tax / FX Strategy)

```
Browser
  │  POST /tenants/{id}/{tax|fx}/strategy
  │  Authorization: Bearer <ID Token>
  ▼
Function URL (regional, no API GW)
  ▼ verifyJwt (in-Lambda)
  ▼ withStreamingErrorBoundary
  ▼ buildContext(tenantId, cognitoSub, scenario)
     │  └─ Aurora: journal_entries, balances, fx_observations, filings ...
     │  └─ DynamoDB CostCounter  (일일 사용량 enforce)
     ▼
  runAgent loop (packages/agent-core/src/agent-runner.ts)
     │
     │  iteration ≤ maxIterations (Tax 12 / FX 8)
     │  ├─ Bedrock Converse (Opus 4.6)
     │  ├─ ToolUse:
     │  │   - search_tax_law   → Bedrock KB Retrieve + Rerank (Tax)
     │  │   - compute_penalty_scenario / check_benefit_eligibility / get_filing_draft_detail (Tax)
     │  │   - get_extended_rate_history (FX)
     │  └─ ContentBlocks → SSE chunks
     ▼
  events: started → context_ready → heartbeat(10s) → tool_call/tool_result* → text_delta* → final → done
```

에러 처리: `ThrottlingException` → `RateLimitError(429)` 로 변환되어 SSE `error` + `done` 페어 송신. `ServiceUnavailable / AccessDenied / ResourceNotFound` → `BedrockUnavailableError` 502/503.

---

## 4. 외부 의존성

| 시스템 | 용도 | 인증 | 호출 위치 |
|---|---|---|---|
| **CODEF** | 은행/카드/홈택스 거래 수집 | OAuth2 (client) + Connected ID (per user) | `apps/codef` Lambdas |
| **ECOS (한국은행)** | USD/KRW + 다통화 환율 | API Key | `apps/fx/.../fx-collector.lambda.ts`, `FxFn` |
| **OPEN_LAW (법제처)** | 조특법·법인세법 등 corpus | OC code | `MonthlyLawSyncFn` |
| **KASI 특일정보** | 한국 공휴일 | API Key | `HolidayYearlySyncFn` |
| **Google OAuth** | Cognito IdP | Client ID/Secret | Cognito Hosted UI |
| **AWS Bedrock** | Sonnet/Opus 추론, KB, Rerank | IAM (cross-region inference profile) | Journal, Codef, Tax/Fx Strategy, TaxKnowledge |

모든 외부 호출은 `PRIVATE_WITH_EGRESS` 서브넷 → fck-nat → public internet 경로. AWS 서비스 (Secrets Manager / KMS / S3 / DynamoDB) 는 VPC endpoint 로 NAT 를 우회한다.

---

## 5. 부하 분산 & 스케일링 평가

> 본 절은 사용자의 명시적 요청 — "부하 분산, 대규모 트래픽 관리는 어떻게 이뤄지고 있는지" — 에 대한 답이다. 이미 갖춰진 것, 부족한 것, 다음 단계를 분리해서 정리한다.

### 5.1 현재 부하 분산 메커니즘

| 경로 | 분산 방식 | 동시성 상한 |
|---|---|---|
| Browser → HTTP API | API Gateway v2 (regional, AWS-managed multi-AZ) | account-level Lambda 동시성 (기본 1000) |
| Browser → SSE Function URL | Lambda Function URL (regional, AWS-managed) | 동일 |
| EventBridge → SFN | SFN 자체가 분산 처리 | Map `maxConcurrency: 3` (CODEF 보호) |
| SFN Map → SQS → Worker | SQS poll + Lambda event source | `reservedConcurrentExecutions: 5` (Bedrock 비용 보호) |
| Lambda → Aurora | 각 인스턴스가 `pg.Pool max=1` → RDS Proxy 가 multiplex → Aurora writer | Proxy 가 connection 풀링 |
| Lambda → DynamoDB | AWS SDK (DynamoDB on-demand auto-scale) | 테이블당 ~40,000 RCU/WCU (account 한도) |
| Lambda → Bedrock | cross-region inference profile (`global.anthropic.*`) | account-level Bedrock TPS quota |

**ALB/NLB 는 없다.** 모든 fronting 은 API Gateway HTTP API 와 Lambda Function URL 이 담당한다 — 둘 다 AWS-managed 로드밸런서이므로 별도 인스턴스가 필요 없다. 풀스택이 serverless 이기 때문에 EC2 layer 에 분산기를 둘 자리가 없다.

### 5.2 스케일링 레버

| 컴포넌트 | 자동 확장 범위 | 어떻게 트리거 |
|---|---|---|
| **Aurora Serverless v2** | 0.5 → 4 ACU (prod) | CPU + 메모리 + 활성 connection 기반 ACU 자동 조정. cold-resume 은 15s 안팎. |
| **Lambda** | 0 → account-level concurrency limit | 요청 수에 따라 자동 (burst 1000/region/initial) |
| **DynamoDB on-demand** | 0 → 40k RCU/WCU per table | 즉시 (peak traffic 의 2배까지 적응) |
| **API Gateway HTTP API** | regional, 자동 분산 | 기본 10k RPS 계정 한도 |
| **SQS** | 무제한 buffering | producer 가 send 하면 누적 |
| **fck-nat** | 수직 확장만 (instance type 변경) | 수동. dev 1대 → 가속 시 t4g.small 등으로 교체 필요 |

### 5.3 RDS Proxy 도입 / 효과 측정

PR-A (2026-05-13) 부터 Aurora writer 앞에 RDS Proxy 가 위치한다.

- **이유**: ACU 비례 `max_connections` (dev 2 ACU ≈ ~430, prod 4 ACU ≈ ~870) 가 동시 Lambda 1000 인스턴스 burst 에 부족해질 수 있음. Proxy 가 client-side 와 backend 를 multiplex 해 connection storm 차단.
- **RLS 호환성**: `set_config(..., is_local=true)` 가 이미 transaction-scoped 라 Proxy pinning 트리거가 아님. `RESET app.*` 는 PR-A 에서 제거 (session-level statement, pinning 트리거).
- **연결 경로**: Lambda → IAM token → Proxy endpoint → master secret → Aurora writer.
- **운영 측정**: §7 의 RDS Proxy metrics 행. `ConnectionBorrowLatency p99 > 50ms`, `DatabaseConnections > 80%`, `ClientConnectionsBorrowing` spike 알람.

후속: PR-C 머지 후 cluster 직결 IAM ARN 제거, `lambdaSg → auroraSg 5432` 인바운드 제거 → Proxy 단일 경로.

### 5.4 API Gateway / Lambda 단의 트래픽 관리

| 항목 | 현재 상태 |
|---|---|
| API GW Usage Plan / Throttling | 없음 — account 기본 10,000 RPS / region |
| Per-route Throttling | 없음 |
| WAF | 없음 — AWS WAF v2 는 API Gateway HTTP API v2 association 미지원. CloudFront 도입 시점에 함께 적용 예정. 자세한 내용 [docs/error-cases/2026-05-14-pr-a-rds-proxy-and-waf.md](../error-cases/2026-05-14-pr-a-rds-proxy-and-waf.md). |
| CloudFront | 없음 — frontend (Phase 1) 도입 시 함께 검토 |
| API GW Caching | 없음 (HTTP API 는 캐싱 미지원, REST API 로 마이그레이션 필요) |
| Lambda Provisioned Concurrency | 없음 — SSE 에이전트 cold start (~500ms-2s) 는 Bedrock TTFT (~1-3s) 에 가려져 큰 문제 아님 |

### 5.5 비용·소비 제어 (애플리케이션 레벨)

| 제어 | 위치 | 한도 |
|---|---|---|
| Bedrock 일일 호출/사용자 | `JournalFn` (`BEDROCK_DAILY_LIMIT_PER_USER`) | 100 (override 가능) |
| Rerank 일일 호출/사용자 | `TaxKnowledgeFn` (`RERANK_DAILY_LIMIT_PER_USER`) | 20 |
| 인박스 Idempotency | DynamoDB `IdempotencyKeys` + Powertools | TTL `expires_at` |
| CODEF 비밀번호 잠금 보호 | E2E 테스트가 1회/run 만 사용 | hard rule |
| SFN Map 동시성 | `maxConcurrency: 3` | per-execution |
| SQS DLQ depth alarm | CloudWatch + SNS | `>= 1 over 5min` |

`CostCounter` 테이블의 `(user, day)` 키로 카운트를 증가시키고, 임계 초과 시 `RateLimitError('BEDROCK_DAILY_LIMIT_EXCEEDED', ...)` 를 던져 HTTP 429 로 매핑한다 ([apps/journal/src/application/classify-transaction.use-case.ts](../apps/journal/src/application/classify-transaction.use-case.ts)).

### 5.6 재시도 & 회복 패턴

| 경로 | 패턴 |
|---|---|
| Bedrock Throttling | `ThrottlingException` → `RateLimitError(429)` 변환. 호출자 (SSE 에이전트) 가 사용자에게 즉시 표면화 — 자동 재시도 없음 (cost 보호 우선). |
| Bedrock 일시 장애 | `ServiceUnavailableException` → `BedrockUnavailableError(503)` |
| Aurora 콜드 resume | `withResumeRetry` (마이그레이터 / IAM verifier) — 15초 백오프, "Aurora resuming" 로그 |
| SQS classify worker | `reportBatchItemFailures: true` 로 partial fail. 실패 메시지만 retry, 3회 후 DLQ |
| SFN tasks | 기본 Step Functions 재시도 정책 (CDK 디폴트) |

---

## 6. 보안 모델

### 6.1 KMS 키 인벤토리

| Key | 용도 | Rotation |
|---|---|---|
| `Foundation.SharedKey` | DynamoDB 4종 암호화 | 자동 |
| `Network.FlowLogsKey` | VPC Flow Logs CloudWatch 암호화 | 자동 |
| `Data.AuroraClusterStorageKey` | Aurora 스토리지 | 자동 |
| `Data.AuroraClusterSecretKey` | Aurora master secret | 자동 |
| `Api.BizRegNoKey` | `tenants.biz_reg_no` 컬럼 암호화 | 자동 |
| `Api.BizRegNoHmacSha256Key` | `biz_reg_no_hash` deterministic HMAC | **rotation 금지** (중복 검사 결정성 유지) |

### 6.2 인증/인가 경계

```
Browser ──ID Token── HTTP API ──JwtAuthorizer(audience=clientId)── Lambda
                                                                     │
                                                                     ▼
                                                    PG RLS: SET app.current_tenant_id
                                                                  app.cognito_sub

Browser ──ID Token── Function URL ─verifyJwt (in-Lambda)── SSE handler
```

- HTTP API 는 ID Token 만 허용 (Access Token 은 `aud` claim 이 없어 audience 매칭에 실패).
- Function URL 은 streaming response 와 API GW JWT Authorizer 가 호환되지 않으므로 람다 안에서 직접 `verifyJwt` ([packages/shared-auth/src/verify-jwt.function-url.ts](../packages/shared-auth/src/verify-jwt.function-url.ts)).
- **multi-tenant isolation 은 데이터 레이어 RLS** 가 최후 방어선. 어플리케이션 버그로 wrong tenantId 가 와도 Aurora 가 row 를 가린다.

### 6.3 비밀 관리

- 모든 비밀은 Secrets Manager. 코드/저장소 하드코딩 금지.
- Aurora master: 30일 자동 rotation.
- CODEF / ECOS: 외부 발급 → 자동 rotation 불가. `scripts/sync-secrets-from-env.sh` 로 운영자가 갱신.
- AWS 키는 `~/.aws/credentials`. `.env` 에는 비-AWS 자격증명만.

### 6.4 WAF 미적용 — HTTP API v2 호환성

PR-A 시도 중 발견: **AWS WAF v2 는 API Gateway HTTP API v2 와 association 자체가 불가능** (REST API 만 지원). 즉 현 아키텍처에서 WAF 를 HTTP API 앞에 직접 부착할 수 없다. 자세한 진단은 [docs/error-cases/2026-05-14-pr-a-rds-proxy-and-waf.md](../error-cases/2026-05-14-pr-a-rds-proxy-and-waf.md) §1.

**잔여 공격 벡터** (HTTP API + SSE Function URL 모두 해당):

1. 유효 Cognito ID Token abuse — 매 호출이 Lambda timeout (HTTP API 30s / SSE 10-14분) + Bedrock 슬롯 점유, `CostCounter` 일일 한도 안에서 무제한.
2. Connection hold (SSE 만 해당) — long-running 호출이 Proxy backend connection 1 + Bedrock concurrency 1 슬롯을 14분 점유, N 토큰 으로 N 배.
3. 엔드포인트 발견 — HTTP API hostname / SSE Function URL 호스트 모두 안정, 한 번 leak 시 영구.

**완화 계획**: CloudFront distribution 도입 시점에 그 앞에 WAF v2 association (CloudFront 는 WAF 지원). 프론트팀이 CloudFront 진행 시 함께 수행.

---

## 7. 관찰 가능성 (Observability)

| 신호 | 위치 | 보존 |
|---|---|---|
| API Gateway access log | CloudWatch (`ApiAccessLogs` log group) | prod 90d / dev 14d |
| VPC Flow Logs | CloudWatch (CMK 암호화) | prod 90d / dev 14d |
| Aurora postgresql log | CloudWatch (`cloudwatchLogsExports`) | prod 90d / dev 14d |
| Lambda logs | CloudWatch 기본 | (CDK 기본 = 무기한) |
| SFN execution history | X-Ray (`tracingEnabled: true`) | 90d |
| Bedrock 비용/호출 | `CostCounter` DDB + Lambda 구조화 로그 (pino) | TTL |
| DLQ depth | CloudWatch alarm → SNS `IngestionAlarmTopic` | — |
| RDS Proxy metrics | CloudWatch (ConnectionBorrowLatency, DatabaseConnections, ClientConnectionsBorrowingFromProxy) + Alarms → SNS DataAlarmTopic | — |

전체 Lambda 는 `pino` 구조화 로거를 사용 — `console.*` 금지 ([CLAUDE.md](../CLAUDE.md) 의 절대 금지 항목).

---

## 8. 환경 분리 전략

| 측면 | 현재 |
|---|---|
| 계정 | 단일 (`823401933116`) |
| 스택 prefix | `Ym-Dev-*` / `Ym-Prod-*` |
| Aurora capacity | dev 0.5-2 ACU / prod 0.5-4 ACU |
| NAT instance | dev 1 (SPOF) / prod 3 (per AZ) |
| Cognito | dev MFA OFF / prod MFA OPTIONAL + AdvancedSecurity ENFORCED |
| Lambda log level | dev `debug` / prod `info` |
| Removal policy | dev `DESTROY` / prod `RETAIN` 또는 `SNAPSHOT` |
| Backup retention | dev 1d / prod 14d |
| DynamoDB PITR | dev OFF / prod ON |

**Open item**: Phase 1 이전에 account-level 분리 재검토 (현재는 stack prefix 기반).

---

## 9. 알려진 한계 / 로드맵

[README.md Open Items](../README.md) 와 [docs/STATUS.md](STATUS.md) 의 압축 버전:

| 항목 | 영향 | 예정 |
|---|---|---|
| Account isolation 부재 | dev/prod 가 같은 계정 → blast radius 확장 | Phase 1 |
| CODEF 인증 방식 | loginType=1 (ID/PW) — 5회 잠금 위험 | Phase 1 → loginType=0 (cert) 또는 5 (간편) |
| CDK Pipelines 없음 | 로컬 cdk deploy만; CI 는 synth 만 | Phase 1 |
| Domain / Route53 미설정 | Function URL / API GW execute-api 도메인 노출 | Public endpoint 이전 |
| WAF 미적용 (HTTP API + SSE) | AWS WAF v2 가 HTTP API v2 와 association 불가. HTTP API / SSE Function URL 모두 in-Lambda verifyJwt + CostCounter 만으로 보호. 잔여 공격 벡터는 §6.4 enumerate | CloudFront 도입 시 (Phase 1) |
| Aurora Reader 없음 | Read 부하가 writer 와 같이 burst | RDS Proxy 와 동시 검토 |
| API GW per-route throttling | 한 사용자 burst 가 다른 사용자에 영향 | Phase 1 |

---

## 10. Quick Reference — 어떤 코드 / 어떤 문서?

| 알고 싶은 것 | 보러 갈 곳 |
|---|---|
| 라우트 ↔ Lambda 매핑 | [docs/API_LIST.md](API_LIST.md) |
| SSE 에이전트 시퀀스 / 7단 답변 구조 | [docs/agent-architecture.md](agent-architecture.md) |
| DB 스키마 (29 tables / 44 RLS) | [schema.sql](../schema.sql) — single source of truth |
| 환경 변수 (CDK / 런타임) | [README.md](../README.md) |
| 슬라이스별 결정 이력 | [docs/01-foundation.ko.md](01-foundation.ko.md) ~ [07-slice.ko.md](07-slice.ko.md) |
| 현재 배포 상태 | [docs/STATUS.md](STATUS.md) |
| 코딩 가이드라인 (네이밍, 에러, 테스트) | [CLAUDE.md](../CLAUDE.md) |
