# Slice 6 — CODEF 실연동 MVP · 개인 사용자 온보딩 · Bedrock 일원화

Slice 6는 Slice 5의 **비HTTP 스택 골격**을 실제로 동작하는 파이프라인으로 채우고, 1인 사용자가 본인 신한 통장을 연결해 거래내역이 K-IFRS 분개로 자동 변환되는 흐름을 16/16 시나리오로 검증한 단계다. 추가로 dev에서 사용하던 stub classifier를 제거하고 모든 환경에서 실 Bedrock(Claude Sonnet 4.6)을 사용하도록 일원화했다.

---

## 1. 목표와 범위

| 영역 | 내용 |
|------|------|
| **개인 사용자 온보딩** | `/me` 첫 호출 시 personal tenant 자동 발급. BRN nullable + `business_type='personal'` ENUM 추가. 사용자는 별도 가입 단계 없이 바로 은행 연결로 진입 |
| **2단계 은행 연결** | `POST /bank-connections` — 신한 ID/PW로 1회 인증해 `connectedId` 발급 + 보유 계좌 디스커버리 → `POST /bank-accounts` — 사용자가 모니터링할 계좌 confirm. 두 번째 호출은 자격증명 재입력 없이 캐시된 `connectedId` 사용 |
| **CODEF 어댑터** | RSA-PKCS1 (`node:crypto`) → CODEF `account/create` (loginType=1) → `account-list` 디스커버리 → DB 저장. 응답은 URL-encoded라 모든 클라이언트에서 `decodeURIComponent` |
| **분개 결과 조회** | `GET /tenants/{id}/journal/entries` — from/to/limit/offset, 멤버십 검증, lines + ai_model + ai_confidence + sourceRefId join |
| **Bedrock 일원화** | dev/prod 무관하게 `BedrockConverseClassifier` 사용. `DeterministicStubClassifier`는 unit test 전용으로 격리 |
| **Cognito Google IdP** | `UserPoolIdentityProviderGoogle` + Hosted UI domain `yourmillionare-dev`. Cognito → Google authorize redirect 302 검증 완료 |
| **운영 도구** | `scripts/run-codef-e2e.sh` — 16 시나리오 자동 검증, 신한 5회 PW 잠금 방지 single-attempt safeguard |

---

## 2. 워크플로우 (사용자 관점)

```
1. Google OAuth 로그인 (Cognito Hosted UI)
2. GET /me                                       → user upsert + personal tenant 자동 발급, defaultTenantId 응답
3. POST /tenants/{tid}/bank-connections           → ID/PW로 신한 인증
   { organization:"0088", loginId, loginPassword } → connectedId 저장 + Shinhan 계좌 리스트 반환
4. POST /tenants/{tid}/bank-accounts              → 사용자가 어떤 계좌를 모니터링할지 선택
   { organization:"0088", accountNumber:"110xxxxxxxxx" }  → DB INSERT
5. (자동) Step Functions 6h마다: codef-fetch → SQS → Bedrock 분류 → journal_entries
6. GET /tenants/{tid}/journal/entries?from=...&to=... → 분류된 분개 조회
```

사용자 액션은 1, 3, 4, 6. 5는 백그라운드 자동.

---

## 3. 검수에서 발견한 갭과 반영

| 갭 | 반영 |
|----|------|
| 기존 코드는 `tenants.biz_reg_no_*` NOT NULL UNIQUE 강제 → 사업자등록번호 없는 개인 사용자는 가입 불가 | Migration 0010 — BRN 컬럼 nullable + `business_type` ENUM에 `'personal'` 추가 + EnsurePersonalTenantUseCase 자동 발급 |
| 사용자가 보유한 계좌 중 **어떤 것을** 연결할지 선택할 단계가 없었음 | 2단계 분리 — `POST /bank-connections`로 디스커버리, `POST /bank-accounts`로 confirm. 자격증명 재입력 불필요 |
| CODEF 응답이 URL-encoded인데 `response.json()` 직접 호출 → 파싱 실패 | 모든 CODEF 클라이언트(`account.client.ts`, `bank.client.ts`)에서 `JSON.parse(decodeURIComponent(await res.text()))` |
| Identity Lambda가 PRIVATE_ISOLATED 서브넷 → CODEF 인터넷 호출 불가 | PRIVATE_WITH_EGRESS로 전환 (NAT instance 경유) |
| 신한 5회 PW 오류 시 인터넷뱅킹 잠금 | E2E 스크립트 single-attempt 가드 + CODEF userError 필드 파싱해 경고 메시지 매핑 |

---

## 4. 데이터 모델 변경 (Migration 0010)

```sql
ALTER TABLE tenants ALTER COLUMN biz_reg_no_encrypted DROP NOT NULL;
ALTER TABLE tenants ALTER COLUMN biz_reg_no_hash      DROP NOT NULL;
ALTER TYPE  business_type ADD VALUE IF NOT EXISTS 'personal';
ALTER TABLE tenant_bank_accounts ADD COLUMN IF NOT EXISTS connected_id VARCHAR(100);

CREATE TABLE IF NOT EXISTS tenant_bank_connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  organization  CHAR(4) NOT NULL,
  connected_id  VARCHAR(100) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, organization)
);
```

Verifier-schema 화이트리스트도 12 → 13 테이블로 갱신.

---

## 5. 운영 중 발견·수정한 5개 버그

1. **Identity `authFlows.adminUserPassword` 누락** — Slice 6에서 OAuth flow 도입 시 admin auth flow가 빠져 `admin-initiate-auth`가 `Auth flow not enabled`로 실패. `userSrp: true, adminUserPassword: true`로 복원.
2. **SFN Map ItemSelector 패턴** — `payload: TaskInput.fromJsonPathAt('$')`이 ASL에 literal `"$"`로 emit되어 Lambda가 string `$`를 받음. `itemSelector + JsonPath.stringAt('$.tenantId')` + `payload: TaskInput.fromObject(...)` 패턴으로 교체.
3. **CODEF 성공 코드 비교 오류** — 코드는 `'00000'`로 비교했으나 실제 CODEF 응답은 `'CF-00000'`. 성공 케이스가 매번 `CODEF_API_ERROR 502`로 떨어지던 사일런트 버그.
4. **Foundation Secret CMK** — CFN이 `KmsKeyId` attribute removal을 Secrets Manager에 전파하지 못하는 한계로 옛 SharedKey가 attached로 남아 codef-fetch Lambda가 `AccessDeniedException: Access to KMS is not allowed`. `aws secretsmanager update-secret --kms-key-id alias/aws/secretsmanager`로 AWS-managed key 전환.
5. **Classify worker accounts 시드** — HTTP `POST /journal/classify` 경로는 `EnsureAccountsSeededUseCase`를 호출하지만 SQS-driven `codef-classify-worker`는 호출 안 함 → `journal_lines_tenant_id_account_code_fkey` 위반. Worker 시작부에 `K_IFRS_DEFAULT_ACCOUNTS` bulk-insert (ON CONFLICT DO NOTHING) 추가.

---

## 6. 테스트와 E2E

### 단위·인프라 (npm test)

```
infrastructure: 5 files / 46 tests passed
apps/identity:  4 files / 23 tests passed (BankConnection + ConnectBank UC + EnsurePersonalTenant 추가)
apps/journal:   4 files / 13 tests passed
journal-core:   passed
shared-errors:  passed
```

### 16-scenario CODEF E2E (`scripts/run-codef-e2e.sh`)

| # | 시나리오 | 결과 |
|---|----------|------|
| 01 | GET /health | ✅ 200 |
| 02 | GET /me — defaultTenantId 자동 발급 | ✅ |
| 03 | GET /me 두 번째 호출 idempotent | ✅ same id |
| 04 | GET /me 토큰 없음 | ✅ 401 |
| 05 | POST /bank-connections loginPassword 누락 (no CODEF call) | ✅ 422 |
| 06 | POST /bank-connections 다른 테넌트 (no CODEF call) | ✅ 403 |
| 07 | **POST /bank-connections 신한 ID/PW 1회 정상 인증** | ✅ 200 + 6 accounts |
| 08 | accounts에 target accountNumber 포함 확인 | ✅ |
| 09 | POST /bank-accounts confirm target | ✅ 201, connected_id 자동 |
| 10 | POST /bank-accounts org 0020 (connection 없음) | ✅ 422 NO_BANK_CONNECTION |
| 11 | POST /bank-accounts duplicate | ✅ 409 |
| 12 | SFN start-execution | ✅ executionArn |
| 13 | SFN execution SUCCEEDED | ✅ fetched=15, queued=15 |
| 14 | GET /journal/entries 분개 결과 | ✅ 200 + entries[]>0 |
| 15 | GET /journal/entries 토큰 없음 | ✅ 401 |
| 16 | GET /journal/entries 다른 테넌트 | ✅ 403 |

### 실 Bedrock 검증 (post-stub-removal)

E2E 1차 run은 stub 시점 데이터라 `aiModel: stub.k-ifrs-expense`. dev/prod 모두 실 Bedrock 사용으로 일원화 후 3건 sample 재분류:

| tx | ai_model | confidence | tokens (input/output) |
|----|----------|------------|------------------------|
| 신한체 -2,000 | `global.anthropic.claude-sonnet-4-6` | 0.45 | 913 / 116 |
| 모바일 -3,000 | `global.anthropic.claude-sonnet-4-6` | 0.72 | 913 / 111 |
| 신한체 -3,200 | `global.anthropic.claude-sonnet-4-6` | 0.60 | 913 / 111 |

stub은 항상 0.85 고정 + 5501 계정 코드. Bedrock은 confidence 가변 + 5401 자율 선택 → 진짜 LLM 응답 확인. 비용 합계 ≈ $0.013 (3건).

자세한 결과: `docs/API_TEST_RESULTS.md` "CODEF Live E2E — 2026-05-11" 섹션.

---

## 7. 보안 트레이드오프 (Phase 0 한정)

`POST /bank-connections`는 신한 인터넷뱅킹 ID/PW를 그대로 받아 CODEF로 전달한다. RSA-PKCS1로 즉시 암호화한 뒤 평문은 스코프를 벗어나며, 어떤 구조화 로그에도 기록되지 않는다. 그러나 평문이 짧은 시간 동안 Identity Lambda 메모리를 경유하는 사실은 변하지 않는다.

- 베타 사용자 1인(본인 신한 계정) 검증 한정으로 허용
- HTTPS + RSA + 로그 제외 + 즉시 스코프 해제로 노출 표면 최소화
- Phase 1에서 CODEF 인증서 팝업(loginType=0) 또는 간편인증(loginType=5)으로 교체 예정

---

## 8. CDK 변경 요약

| 스택 | 변경 |
|------|------|
| `Foundation` | CODEF/ECOS Secret에서 SharedKey CMK 제거 (cyclic dep 해결). `CodefCredentialSecret` cross-stack export 추가 |
| `Identity` | `UserPoolIdentityProviderGoogle` + Hosted UI domain. `authFlows: { userSrp: true, adminUserPassword: true }`. Callback URL 정리 |
| `Data` | Migration 0010 추가, schema verifier 13 테이블 + 4개 신규 RLS policy 인식 |
| `Api` | 신규 routes 2개 (`POST /bank-connections`, `GET /journal/entries`). Identity Lambda 서브넷 PRIVATE_WITH_EGRESS, CODEF_SECRET_ARN env, secret grantRead. **`JOURNAL_STUB_CLASSIFIER` env 제거** (Bedrock 일원화) |
| `Ingestion` | codef-fetch에서 `connectedIds` 시크릿 의존 제거 (DB로 이전). `IngestionStateMachineArn` CfnOutput 추가. SFN Map itemSelector 패턴 적용. **`CLASSIFY_MODE` env 제거** (Bedrock 일원화) |

`bin/yourmillionare.ts`는 GOOGLE_OAUTH 환경변수 미설정 시 placeholder fallback으로 CI synth 통과.

---

## 9. 관련 문서

| 문서 | 역할 |
|------|------|
| `docs/API_LIST.md` | HTTP 라우트·요청/응답·에러 코드 |
| `docs/API_TEST_RESULTS.md` | API E2E + CODEF Live E2E 검증 결과 |
| `docs/STATUS.md` | 스택별·슬라이스별 진행 상태 |
| `scripts/run-codef-e2e.sh` | 16 시나리오 자동 회귀 (single Shinhan attempt) |
| `CLAUDE.md` | 레포 공통 구현 규칙 |
