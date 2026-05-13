# Traffic & Security Hardening — RDS Proxy + WAF

- **작성일**: 2026-05-13
- **개정**: 2026-05-13 (외부 검토 — Well-Architected / Security 반영)
- **대상 환경**: `Ym-Dev-*` → `Ym-Prod-*`
- **선행 문서**: [docs/ARCHITECTURE.md](../../ARCHITECTURE.md) §5 / §9
- **목적**: 현 아키텍처의 트래픽 관리·보안 공백 중 우선순위가 가장 높은 두 항목을 한 spec 안에서 도입한다.

---

## 1. 범위와 비범위

### 1.1 범위 (in scope)

| 항목 | 핵심 변경 |
|---|---|
| **RDS Proxy** | Aurora writer 앞에 Proxy 1개. IAM auth 유지. Lambda 의 `CLUSTER_ENDPOINT` env 교체. |
| **RLS Proxy 호환성 정리** | `set_config(..., true)` 패턴은 이미 transaction-scoped 라 유지. `RESET app.*` 제거 (pinning 트리거). `withRlsContext` 밖의 직접 호출 정리. |
| **TLS 서버 cert 검증 강화** | `pg-pool.client.ts` 의 `ssl.rejectUnauthorized` 를 `true` 로 + RDS CA bundle pinning (외부 보안 검토 [HIGH] 이슈, Proxy 도입과 묶어 처리). |
| **WAF v2** | HTTP API 에 regional WebACL 1개. AWS Managed Rules 무료 4종 + IP rate limit. |
| **관찰가능성** | RDS Proxy / WAF CloudWatch 알람 + WAF 로그 그룹. |
| **문서화** | ARCHITECTURE.md / README.md 동일 PR 갱신 (CLAUDE.md 규칙). |

### 1.2 비범위 (out of scope)

- **Aurora Reader 추가**: DDB 4개 캐시(`MonthlySummaryCache`, `TransactionCache`, `IdempotencyKeys`, `CostCounter`) 가 이미 Aurora read 부하를 흡수하는 L1 레이어. RDS Proxy 가 connection 고갈 문제를 별도로 해결. 실제 ACU 사용률이 한도에 닿는 자료가 쌓이기 전까지 도입 유보 (YAGNI).
- **SSE Function URL WAF 보호**: WAF v2 는 Function URL 직접 연결 불가. CloudFront 경유 시 가능하나 프론트팀 영역의 별도 작업. 잔여 위험은 §4.5 에 enumerate.
- **CloudFront / Route53 / Account isolation / CDK Pipelines**: 후속 spec.

---

## 2. 현 상태와 변경 후 상태

### 2.1 현 상태 (ARCHITECTURE.md §5.3 요약)

- Lambda → Aurora 직결. 각 Lambda 인스턴스가 `pg.Pool({ max: 1 })` 로 IAM token 인증.
- Aurora Serverless v2 의 `max_connections` 는 ACU 비례 — prod 4 ACU ≈ ~870, dev 2 ACU ≈ ~430.
- 동시 Lambda 인스턴스 1000개 burst 시 prod 도 한도 근접. CODEF 자동 동기화 + SSE 에이전트 + HTTP API peak 가 겹치면 `FATAL: too many connections` 위험.
- WAF 없음 — 봇/스크레이프 / SQLi / XSS / 알려진 악성 IP 무방비.
- `pg-pool.client.ts:36` 이 `ssl: { rejectUnauthorized: false }` — TLS 가 암호화는 되지만 **인증되지 않음**. VPC 내 노드 침해 시 MitM 가능.

### 2.2 변경 후 데이터 흐름

```
Browser ──ID Token──► HTTP API ──► JWT Authorizer ──► Lambda (Identity/Journal/Fx/Tax/TaxKnowledge)
            ▲                                          │
            └── [NEW] AWS WAF v2                       ▼
                (CRS + KnownBadInputs +     [NEW] RDS Proxy (writer endpoint)
                 AmazonIpReputationList +              │   IAM auth, Secrets Manager bind
                 AnonymousIpList +                     │   TLS required (양쪽 검증), idleClientTimeout 30m
                 IpRateLimit)                          ▼
                                                Aurora writer (PRIVATE_ISOLATED)

Browser ──ID Token──► Function URL ─verifyJwt (in-Lambda)── SSE Lambda (Codef/Tax/Fx Strategy)
                            └── [NEW] RDS Proxy 동일 경로 사용
```

WAF 는 Function URL 을 거치지 않음 — 잔여 위험은 §4.5.

---

## 3. RDS Proxy 설계

### 3.1 CDK construct (`infrastructure/lib/stacks/data/aurora.construct.ts`)

| 속성 | 값 |
|---|---|
| 진입 | `cluster.addProxy('AuroraProxy', { ... })` |
| 인증 (Proxy → Aurora) | Aurora master `Secret` 바인딩 (이미 30일 rotation). |
| 인증 (Client → Proxy) | IAM token (기존 `pg-pool.client.ts` 의 `Signer` 가 hostname 만 바뀌어 그대로 작동). |
| VPC | Aurora 와 동일 `PRIVATE_ISOLATED`. |
| Security Group | 신규 `proxySg`. `auroraSg` inbound 5432 from `proxySg`. `lambdaSg` outbound 5432 to `proxySg`. |
| `requireTLS` | `true` |
| `idleClientTimeout` | `Duration.minutes(30)` |
| `maxConnectionsPercent` | **`90`** (over-allocation 방지 — 0.5 ACU baseline 에서 max_connections 가 작을 때 safety margin) |
| `maxIdleConnectionsPercent` | `50` |
| Removal policy | dev `DESTROY` / prod `RETAIN` |

### 3.2 Lambda 변경

- env: `CLUSTER_ENDPOINT` → Proxy endpoint.
- `pg.Pool({ max: 1 })` 유지 — Lambda 인스턴스 단위 RLS context 격리. Proxy 가 multiplexing 처리.

### 3.3 TLS 서버 cert 검증 강화 (`pg-pool.client.ts`)

현재:
```ts
ssl: { rejectUnauthorized: false }
```

변경:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// RDS regional CA bundle bundled into the Lambda deployment package.
const RDS_CA_PATH = join(import.meta.dirname, '../../../assets/rds/ap-northeast-2-bundle.pem');

ssl: {
  rejectUnauthorized: true,
  ca: readFileSync(RDS_CA_PATH, 'utf8'),
}
```

- AWS 가 발급한 region 별 RDS CA bundle (`ap-northeast-2-bundle.pem`) 을 `assets/rds/` 아래 commit 하고 esbuild bundling 대상에 포함.
- CA bundle 갱신 (AWS 가 주기적으로 회전)은 README 의 운영 노트로 등록.
- Proxy `requireTLS: true` 와 client `rejectUnauthorized: true` 가 양방향 매칭되어 in-VPC MitM 차단.

### 3.4 IAM 정책

`rds-db:connect` resource:

| 시점 | Resource ARNs |
|---|---|
| PR-A 머지 후 (마이그레이션 중) | `arn:aws:rds-db:...:dbuser:{clusterResourceId}/app_user` **AND** `arn:aws:rds-db:...:dbuser:{proxyResourceId}/app_user` |
| PR-C 머지 후 (정상화) | proxy ARN 만 유지 |

### 3.5 RLS GUC ↔ Proxy 호환성

분석 결과 (`apps/{journal,identity,fx,tax,tax-knowledge,codef}/src/infrastructure/outbound/pg/pg-rls.context.ts`):

```ts
await client.query('BEGIN');
await client.query('RESET app.cognito_sub');               // PR-A 에서 제거
await client.query('RESET app.current_user_id');           // PR-A 에서 제거
await client.query('RESET app.current_tenant_id');         // PR-A 에서 제거
await client.query("SELECT set_config('app.cognito_sub', $1, true)", [ctx.cognitoSub]);
// ...
await client.query('COMMIT');
```

세 번째 인자 `true` 는 PostgreSQL `is_local` 플래그 — SET LOCAL 과 등가. 트랜잭션 commit/rollback 시 자동 해제. **RDS Proxy 의 transaction pinning 트리거가 아니다.**

| 패턴 | Proxy pinning? | 액션 |
|---|---|---|
| `set_config(name, value, true)` | No | 유지 |
| `RESET app.*` | **Yes** (session-level statement) | **제거 (PR-A 와 같은 시점, env cutover 전에)** |
| `withRlsContext` 외부 직접 `set_config` 호출 (8개 위치) | 호출자가 트랜잭션 안이면 OK | 각 지점 확인 후 트랜잭션 외부면 wrap |

**`RESET` 제거 시점을 PR-A 와 동시로 앞당기는 이유**: 만약 PR-A 에서 Proxy 가 살아 있고 일부 Lambda 가 env 를 통해 Proxy 로 연결되는 일이 (실수든 staging 이든) 발생하면, `RESET` 호출이 connection pinning 을 일으켜 multiplexing benefit 을 무력화한다. PR-A 머지 전에 cluster-direct 상태에서 RESET 을 제거해도 트랜잭션 semantics 는 무변경이라 안전.

#### 직접 호출 지점 (정리 대상 후보)

- `apps/fx/src/application/fx-strategy-templates.ts:149-150`
- `apps/fx/src/application/revalue-foreign-balances.use-case.ts:28`
- `apps/tax/src/application/strategy-templates.ts:214-215`
- `apps/tax/src/application/financial-statement.use-case.ts:267-268`
- `apps/tax/src/application/tools/get-filing-draft-detail.tool.ts:47-48`
- `apps/codef/src/infrastructure/inbound/http/codef-classify-worker.lambda.ts:56-60`
- `apps/journal/src/infrastructure/outbound/pg/pg-user.repository.ts:19, 31`
- `apps/identity/src/infrastructure/outbound/pg/pg-user.repository.ts:37, 52`

각 위치를 읽어 트랜잭션 컨텍스트를 확정. 안에 있으면 무변경, 밖이면 `withRlsContext` 로 wrap 하거나 explicit `BEGIN/COMMIT` 추가.

### 3.6 cutover 단계 (PR 분할 정렬)

| 단계 | PR | 변경 | 영향 |
|---|---|---|---|
| 1 | **PR-A** | CDK — Proxy 리소스 + IAM 양쪽 허용 + WAF (Count) + 알람. **RLS 코드 정리(RESET 제거 + 직접 호출 wrap) 포함**. Lambda env 미변경. | 비파괴 |
| 2 | **PR-B1** | TLS 검증 강화 (pg-pool.client.ts → `rejectUnauthorized: true` + CA bundle). cluster 직결 상태에서 dev/prod 양쪽 deploy. | TLS 동작 변화만, endpoint 동일 |
| 3 | **PR-B2** | dev Lambda env `CLUSTER_ENDPOINT` → Proxy. | dev 만 영향 |
| 4 | **PR-C** | prod Lambda env cutover + WAF Block 전환 + cluster 직결 IAM ARN 제거 + `lambdaSg → auroraSg 5432` 인바운드 제거 (proxySg 만 유지). | prod 영향 |

### 3.7 비용 (재계산)

Aurora Serverless v2 의 RDS Proxy 과금은 **max ACU 기준**, 시간당 `$0.015 per ACU`:

| 환경 | max ACU | 월 비용 (24/7) |
|---|---|---|
| dev | 2 | 2 × $0.015 × 730 ≈ **~$22** |
| prod | 4 | 4 × $0.015 × 730 ≈ **~$44** |

이전 추정 (baseline 0.5 ACU 기준 ~$5/월) 은 오류였음 — 외부 검토 반영.

---

## 4. WAF 설계

### 4.1 CDK construct (`infrastructure/lib/stacks/api/waf.construct.ts` 신규)

| 속성 | 값 |
|---|---|
| Scope | `REGIONAL` (HTTP API v2 는 regional) |
| Default action | `Allow` |
| Logging | CloudWatch Log Group `aws-waf-logs-yourmillionare-{env}`, CMK 암호화, prod 90d / dev 14d |
| Association | `CfnWebACLAssociation` → HTTP API stage ARN |

### 4.2 Rule 구성

| Priority | 이름 | 종류 | dev action | prod action |
|---|---|---|---|---|
| 0 | `AWS-Managed-Common` | `AWSManagedRulesCommonRuleSet` (CRS) | Count → 4주 후 Block | Block (PR-C 시점) |
| 1 | `AWS-Managed-KnownBadInputs` | `AWSManagedRulesKnownBadInputsRuleSet` | 동일 | 동일 |
| 2 | `AWS-Managed-AmazonIpReputation` | `AWSManagedRulesAmazonIpReputationList` | 동일 | 동일 |
| 3 | `AWS-Managed-AnonymousIp` | `AWSManagedRulesAnonymousIpList` | 동일 | 동일 |
| 4 | `IpRateLimit` | Custom rate-based (IP aggregate, dev `5000` / prod `2000` req per 5min) | Block | Block |

WCU 합계 ~980, 계정 한도 1500 안.

### 4.3 단계적 활성화

```
Phase 1 (PR-A 머지 시): dev/prod 모두 managed rules = Count. IpRateLimit 만 Block.
Phase 2 (PR-C 시점): false positive 룰만 ruleActionOverrides 로 Count 유지,
                     나머지는 dev/prod 모두 Block.
```

### 4.4 비용

| 항목 | 환경당 월 |
|---|---|
| WebACL | $5.00 |
| 5 rules × $1 | $5.00 |
| Requests (1M/월 가정) | ~$0.60 |
| **합계** | **~$10.60** |

dev + prod = **~$21/월**. Premium ruleset (Bot Control 등) 미사용.

### 4.5 SSE Function URL — 잔여 위험 enumerate

3개 Function URL (`CodefSyncStream`, `TaxStrategy`, `FxStrategy`) 은 WAF 보호 밖. 의존하는 보호:

- in-Lambda `verifyJwt` (Cognito ID Token 검증)
- 애플리케이션 rate limit (`CostCounter`, `BEDROCK_DAILY_LIMIT_PER_USER`, `RERANK_DAILY_LIMIT_PER_USER`)

**구체적 잔여 공격 벡터** (이번 spec 에서 차단되지 않음 — Phase 1 CloudFront 도입 시 보완):

1. **유효 토큰 abuse**: 탈취된 Cognito ID token 으로 SSE 호출 → 매 호출이 Lambda 10~14분 timeout 보유 + Bedrock Opus 슬롯 점유. `CostCounter` 의 **per-user-per-day** 한도 안에서는 무제한.
2. **Connection hold**: 위 long-running 호출이 Proxy backend connection 1개 + Bedrock concurrency 1슬롯을 14분 점유. 동일 사용자 N개 token 으로 N배 증폭.
3. **Function URL 발견**: URL 호스트는 안정 — 한 번 leak 되면 영구. JWT 검증 통과 못 한 요청도 Lambda invocation 비용 발생 (cold start + verifyJwt 실행).

**잔여 위험 평가**: 짧은 Cognito token TTL (1h) + 알려진 tenant 사용자풀 (B2B SaaS) → 현 시점 acceptable. 추후 강화: per-IP per-minute DynamoDB counter (CostCounter 와 별도), 또는 CloudFront + WAF 경유. ARCHITECTURE.md §6.2 / §9 에 반영.

---

## 5. 관찰가능성

### 5.1 RDS Proxy 알람 (`Ym-{env}-Data` 스택)

| Metric | 임계 | 액션 |
|---|---|---|
| `DatabaseConnections` | Aurora `max_connections` 의 80% 5분 | SNS `IngestionAlarmTopic` |
| `ConnectionBorrowLatency` p99 | **> 50ms 10분** (외부 검토 반영 — healthy 시 보통 <10ms) | 동일 |
| `ClientConnectionsBorrowingFromProxy` | baseline 의 5배 | 동일 |

### 5.2 WAF 알람 (`Ym-{env}-Api` 스택)

| Metric | 임계 | 액션 |
|---|---|---|
| `BlockedRequests` (전체) | > 500 / 5분 | SNS (DDoS 의심) |
| Rule 별 `BlockedRequests` | 알람 X | CloudWatch Insights 쿼리 템플릿만 docs 에 등록 |

### 5.3 PR-C 의 alarm-driven gate (calendar 기반 보완)

PR-C 시작 조건 (둘 다 만족):

1. `ConnectionBorrowLatency p99 > 50ms` 알람이 PR-B2 dev cutover 후 **0회** 발생 (≥ 1주 무알람)
2. WAF dev Count mode 에서 **4주** 동안 false positive rule profile 확정 (운영자가 ruleActionOverrides 결정)

calendar (1주 / 4주) 는 floor, alarm gate 가 ceiling.

### 5.4 ARCHITECTURE.md §7 갱신

`WAF logs`, `RDS Proxy metrics` 두 행 추가.

---

## 6. 테스트

### 6.1 CDK snapshot test

- `infrastructure/test/data.stack.test.ts`: Proxy 리소스 / 알람 / Security Group 규칙 검증
- `infrastructure/test/api.stack.test.ts`: WebACL / Association / 로그 그룹 검증
- cdk-nag: `AwsSolutionsChecks` 통과 (필요시 명시적 suppression with reason)

### 6.2 dev 배포 후 E2E 회귀 검증 (PR-B2 머지 직후)

```
1. AWS_PROFILE=yn-dev npm run synth
2. AWS_PROFILE=yn-dev cdk deploy 'Ym-Dev-*'
3. ./scripts/sync-secrets-from-env.sh dev
4. ./scripts/post-deploy-smoke.sh dev
5. ./scripts/run-api-e2e.sh dev
6. ./scripts/run-agents-e2e.sh dev
7. ./scripts/run-codef-e2e.sh dev          # 1회만, CODEF 계좌 잠금 보호
8. 1시간 CloudWatch 메트릭 관찰:
   - RDS Proxy: DatabaseConnections, ConnectionBorrowLatency, ConnectionAttempts (특히 pinning 신호)
   - WAF: BlockedRequests (Count mode 라 0 기대)
   - Aurora: max_connections 압박 없음
```

**중단 기준**: 4번 실패 또는 5/6/7 중 하나라도 회귀 → 즉시 Lambda env 를 cluster endpoint 로 되돌림 (cluster 직결 IAM ARN 이 PR-A 시점부터 살아있어 가능).

### 6.3 prod 적용 게이트

dev 8번까지 통과 + §5.3 alarm-driven gate 만족 → PR-C 로 prod 동일 순서. prod CODEF E2E 는 한 번만 (계좌 잠금 5회 한도).

---

## 7. 롤백 (대칭성)

| 시점 | 롤백 방법 |
|---|---|
| PR-A 머지 후 | CDK revert. Proxy 리소스 / RLS 코드 정리 / WAF 가 모두 무파괴라 안전. |
| PR-B1 머지 후 | `git revert` — TLS 검증 자체는 endpoint 무관 변화. 다만 RDS CA bundle 이 잘못된 경우 `ssl: { rejectUnauthorized: false }` 임시 hotfix 가능. |
| PR-B2 머지 후 (dev cutover) | Lambda env `CLUSTER_ENDPOINT` → cluster endpoint 로 되돌림. cluster 직결 IAM ARN 살아있어 즉시 동작. |
| PR-C 머지 후 (prod cutover) | **주의**: PR-C 가 cluster 직결 IAM ARN 을 제거하므로, rollback 시 (a) IAM 정책 ARN 재추가 후 (b) Lambda env 되돌림 의 **2 step 필요**. 단순 env revert 만으로는 cluster 접속 권한 없음. |

전체 롤백: `cdk deploy --rollback` 또는 이전 commit 재배포.

---

## 8. PR 분할 (개정)

| PR | 변경 | 영향 |
|---|---|---|
| **PR-A** `[infra-and-rls-cleanup]` | RDS Proxy 리소스 + IAM 양쪽 허용 + WAF resources (Count mode) + WebACLAssociation + 알람 + ARCHITECTURE/README 갱신 + **RLS 코드 정리 (RESET 제거 + `withRlsContext` 외부 직접 호출 wrap)**. Lambda env 미변경. | 비파괴. RLS 변경은 트랜잭션 semantics 무변경. |
| **PR-B1** `[tls-hardening]` | `pg-pool.client.ts` 의 `rejectUnauthorized: true` + RDS CA bundle pinning. dev/prod 양쪽 cluster 직결 상태에서 deploy. | endpoint 무관 — TLS 검증만 강화. |
| **PR-B2** `[dev-cutover]` | dev Lambda env `CLUSTER_ENDPOINT` → Proxy. dev E2E 회귀 검증. | dev 만. |
| **PR-C** `[prod-cutover-and-block]` | prod Lambda env cutover. WAF managed rules dev/prod 모두 Block 전환. cluster 직결 IAM ARN 제거. `lambdaSg → auroraSg:5432` 인바운드 제거. | prod 영향. **시작 조건**: §5.3 alarm-driven gate 만족 (PR-B2 안정화 ≥ 1주 + WAF dev Count ≥ 4주). |

---

## 9. 문서화 deliverable

이 spec 의 의무 변경 (PR-A 안에 포함, PR-C 에서 최종 표 갱신):

### 9.1 ARCHITECTURE.md

- §1 토폴로지 다이어그램에 Proxy 노드 추가
- §2.3 Aurora — Proxy endpoint / `pg.Pool max:1` 유지 근거 명시
- §5.1 부하분산 표 — Lambda→Aurora 행 "via RDS Proxy (multiplexed)" 로 갱신
- §5.3 "RDS Proxy 부재" 섹션 **삭제** → "RDS Proxy 도입 / 효과 측정" 으로 교체
- §5.4 트래픽 관리 표 — WAF 행을 "있음 (managed rules 4종 + IP rate limit)" 로 갱신
- §6 보안 모델 — WAF 인벤토리, **TLS pinning 강화**, SSE Function URL 의 잔여 공격 벡터 (§4.5) 명시
- §7 관찰가능성 표 — WAF logs, RDS Proxy metrics 두 행 추가
- §9 알려진 한계 — RDS Proxy / WAF 행 **삭제**. "SSE Function URL WAF 미적용" 만 유지 (잔여 공격 벡터 enumerate 와 함께)

### 9.2 README.md

- 환경 변수 표 — `CLUSTER_ENDPOINT` 가 Proxy endpoint 임을 명시
- 폴더 구조 요약 — `waf.construct.ts`, `assets/rds/ap-northeast-2-bundle.pem` 신규 항목 추가
- 운영 노트 — RDS CA bundle 갱신 절차 (AWS 가 회전 시점에 bundle 교체 + redeploy)
- 비용 노트 — Proxy + WAF 항목 추가 (README 에 해당 섹션이 없으면 신설)

### 9.3 schema.sql

무변경 (DB schema 변동 없음).

---

## 10. 의존 / 가정 / 검증 필요 항목

- `yn-dev` AWS CLI 프로파일이 로컬에 구성됨 (`AWS_PROFILE=yn-dev`).
- `scripts/sync-secrets-from-env.sh`, `post-deploy-smoke.sh`, `run-api-e2e.sh`, `run-agents-e2e.sh`, `run-codef-e2e.sh` 가 dev 환경에 대해 정상 동작.
- Aurora Serverless v2 의 `cluster.addProxy()` 가 CDK v2 에서 지원됨.
- WAF v2 가 ap-northeast-2 REGIONAL scope 로 HTTP API v2 stage 에 association 가능.
- CDK Aspect 의 `AwsSolutionsChecks` (cdk-nag) 가 신규 리소스에 대해 통과 또는 명시적 suppression 가능.
- **PR-A 구현 시 확인**: Aurora master secret 의 `addRotationSingleUser()` 가 `vpc` prop 을 받고 있어 rotation Lambda 가 같은 VPC 안에 배치되는지 (Proxy 가 path 에 추가된 후에도 rotation Lambda 가 Aurora 에 도달 가능해야 함). 외부 검토 [LOW] 항목.
- **PR-A 구현 시 확인**: `assets/rds/ap-northeast-2-bundle.pem` 의 최신 버전 (AWS 공식 다운로드) 을 commit. esbuild bundling 에서 `assets/` 가 deployment package 에 포함되도록 `bundling.commandHooks` 설정.

---

## 11. 외부 검토 이력

- 2026-05-13 Well-Architected reviewer (revise → 모두 반영 완료): PR-B 분할, 비용 재계산, `maxConnectionsPercent 90`, alarm 50ms, alarm-driven PR-C gate, 롤백 대칭성, `auroraSg` cleanup.
- 2026-05-13 Security reviewer (minor concerns, 1 high → 모두 반영 완료): TLS pinning 강화 (PR-B1), RESET 제거 PR-A 로 이동, SSE 공격 벡터 enumerate, rotation Lambda VPC 검증 task.
