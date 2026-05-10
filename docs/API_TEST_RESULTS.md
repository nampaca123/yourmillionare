# API terminal E2E — 2026-05-09

## Summary

- **Base URL:** `https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com` (Ym-Dev-Api)
- **Auth:** Cognito ID token via **`API_E2E_PASSWORD`** + **`API_E2E_USERNAME`** (optional; pool/client resolved from **`Ym-Dev-Identity`**) or explicit **`ID_TOKEN`**. (`AWS_PROFILE` default `ym-dev`, `AWS_REGION` default `ap-northeast-2`)
- **Runner:** `./scripts/run-api-e2e.sh` → NDJSON audit **`docs/api-e2e-raw.ndjson`**
- **Latest green run:** **33 / 33** scripted rows `pass:true` (Slice 6 deploy: CODEF ingestion pipeline + `POST /tenants/{tenantId}/bank-accounts` added; `Ym-Dev-Data` migration 0009, `Ym-Dev-Ingestion` VPC upgrade, `Ym-Dev-Api` route added).
- **Dev classify model:** 응답 `aiModel` 은 **`stub.k-ifrs-expense`** (실 Bedrock 미사용). 프로덕션(`JOURNAL_STUB_CLASSIFIER=0`)에서는 **`BEDROCK_MODEL_ID`** 프로파일(예: Sonnet inference profile) 사용.
- **401 vs app JSON:** JWT Authorizer 실패 시 Gateway `{ "message": "Unauthorized" }`; Lambda 경로는 `{ "error": { "code", "message" } }`.

## GET /health

| Scenario | Expected HTTP | Actual (green run) |
|----------|---------------|---------------------|
| ok | 200 | Pass |

## GET /unknown (bonus)

| Scenario | Expected HTTP | Actual |
|----------|---------------|--------|
| unknown_path | 404 | Pass |

## GET /me

| Scenario | Expected HTTP | Actual |
|----------|---------------|--------|
| valid_token | 200 | Pass (`id`, `cognitoSub`, `email`) |
| no_auth | 401 | Pass |
| bad_token | 401 | Pass |

## POST /tenants

| Scenario | Expected HTTP | Actual |
|----------|---------------|--------|
| valid_body | 201 | Pass |
| empty_body | 422 | Pass (`VALIDATION_ERROR`) |
| invalid_bizreg | 422 | Pass |
| duplicate_bizreg | 409 | Pass (`CONFLICT`) |
| idempotency_first | 201 | Pass |
| idempotency_repeat_same_body | 201 | Pass (same `id`) |
| idempotency_key_body_mismatch | 409 | Pass (`IDEMPOTENCY_KEY_REUSED`) |

## GET /me/tenants

| Scenario | Expected HTTP | Actual |
|----------|---------------|--------|
| after_creates | 200 | Pass |
| no_auth | 401 | Pass |

## POST /tenants/{tenantId}/bank-accounts

| Scenario | Expected HTTP | Actual |
|----------|---------------|--------|
| valid_bank_account | 201 | Pass (`id`, `tenantId`, `organization`, `accountNumber`, `isActive: true`) |
| duplicate_account | 409 | Pass (`CONFLICT`) |
| org_too_short | 422 | Pass (`VALIDATION_ERROR`) |
| account_empty | 422 | Pass (`VALIDATION_ERROR`) |
| missing_body | 422 | Pass (`VALIDATION_ERROR`) |
| wrong_tenant | 403 | Pass (`FORBIDDEN`) |
| no_auth | 401 | Pass |

## POST /tenants/{tenantId}/journal/classify

| Scenario | Expected HTTP | Actual |
|----------|---------------|--------|
| forbidden_wrong_tenant | 403 | Pass |
| amount_zero | 422 | Pass |
| valid_classify | 201 | Pass (**stub** lines; `aiModel`: **`stub.k-ifrs-expense`**) |
| classify_idempotency_first | 201 | Pass |
| classify_idempotency_repeat_same_body | 201 | Pass (same entry `id`) |
| classify_idempotency_key_body_mismatch | 409 | Pass (`IDEMPOTENCY_KEY_REUSED`) |

## POST /tenants/{tenantId}/journal/entries

| Scenario | Expected HTTP | Actual |
|----------|---------------|--------|
| unbalanced | 422 | Pass (`UNBALANCED_JOURNAL`) |
| valid_manual_entry | 201 | Pass |
| invalid_account_codes | 422 | Pass (`INVALID_ACCOUNT_CODE`) |
| entries_wrong_tenant | 403 | Pass |
| too_few_lines | 422 | Pass |
| line_debit_and_credit_same_side | 422 | Pass (`INVALID_JOURNAL_LINE`) |

## Operational fixes reflected in this run

1. **Identity Lambda timeout:** VPC + RDS IAM 첫 연결이 **10s**를 넘겨 `/me` 가 Gateway **500** 으로 떨어지던 문제 → **30s** 로 상향.
2. **Powertools:** `IdempotencyConfig.registerLambdaContext(context)` 를 두 Lambda 핸들러 시작 시 호출 → remaining-time 경고 및 비정상 동작 여지 감소.
3. **Dev Bedrock 계정 미설정:** Anthropic use-case 미제출 시 **`ResourceNotFoundException`** → **`503` `BEDROCK_UNAVAILABLE`** 로 매핑(프로덕션·스텁 해제 시 클라이언트 메시지 명확화). **`CDK_ENV=dev`** Journal 에 **`JOURNAL_STUB_CLASSIFIER=1`** 로 결정적 스텁 분류기 사용 → E2E·비용 안정.
4. **신규 Cognito 사용자:** 비밀번호 정책(특수문자 등) 충족 필요; ID 토큰에 `email` 클레임이 있어야 `parseClaims` 통과.

## CODEF Ingestion Pipeline (SFN → Lambda → Aurora)

> 비HTTP 파이프라인이므로 별도 섹션으로 정리. 파이프라인 오류는 `ClassifyDlqDepthAlarm` CloudWatch 알람 + Lambda CW Logs로 모니터링.

| Component | Scenario | Expected | Status |
|-----------|----------|----------|--------|
| TenantsListFn | active bank accounts exist | `{ tenantIds: ["<uuid>"] }` | Verified (CloudWatch Logs) |
| TenantsListFn | no active accounts | `{ tenantIds: [] }`, SFN Map 0회 반복 | Verified |
| CodefFetchFn | connectedId 미등록 | Lambda error log (CODEF_AUTH_ERROR 또는 설정 누락) | Pending (connectedId 미설정) |
| CodefFetchFn | duplicate re-fetch | `{ queued: 0 }` (ON CONFLICT DO NOTHING) | Pending |
| ClassifyWorkerFn (stub) | normal classify | `journal_entries`, `journal_lines`, `ai_decisions` row 생성 | Pending (connectedId 설정 후) |
| ClassifyWorkerFn (bedrock) | Bedrock 호출 | `ai_decisions.model_id = 'global.anthropic.claude-sonnet-4-6'` | Pending (prod 배포 후) |
| DLQ | 3회 실패 후 | `ClassifyDlqDepthAlarm` 트리거 | Pending |

> **파이프라인 전체 E2E** 는 `connectedIds` Secret에 실제 CODEF `connectedId`를 등록한 뒤 Step Functions 수동 실행으로 검증한다.

## Gaps / follow-ups

1. **CODEF connectedId 등록:** `CodefCredentialSecret`의 `connectedIds[tenantId]` 에 실제 CODEF `connectedId`를 추가해야 파이프라인 E2E 완성.
2. **프로덕션 분류:** `JOURNAL_STUB_CLASSIFIER=0` 배포 전 Bedrock 콘솔에서 모델 접근·Anthropic use-case 제출 완료 필요.
3. **`POST .../journal/entries`:** 멱등 키 없음 — 동일 POST 중복 시 중복 분개 가능.

---

# CODEF Live E2E — 2026-05-11

## Summary

- **Base URL:** `https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com`
- **Auth:** Cognito ID token via `admin-initiate-auth` (ADMIN_USER_PASSWORD_AUTH flow). User: `api-e2e-6a639eee@ym-e2e.test`. Password reset to known value via `admin-set-user-password` and stored in `.env` (`API_E2E_PASSWORD`).
- **Runner:** `./scripts/run-codef-e2e.sh` → NDJSON `docs/codef-e2e-raw.ndjson` + summary `docs/codef-e2e-meta.json`
- **Test target account:** Shinhan `110443478154` (loginType=1, organization `0088`)
- **Safeguard:** Real Shinhan password used **exactly once** (scenario 07) to avoid 5-attempt internet-banking lockout. All subsequent scenarios reuse the cached `connectedId` or use placeholder values.
- **Result:** **16 / 16 scenarios validated PASS** (1차 run에서 13/14가 실패했으나 SFN payload + CODEF success code + secret CMK + classify worker accounts seed의 4개 운영 이슈 수정 후 재트리거로 복구; 신한 PW 재사용 없이 SFN 재실행 + GET 검증으로 마무리).

## Workflow validated end-to-end

```
Google OAuth (or admin-initiate-auth) → Cognito ID Token
GET /me                                 → personal tenant 자동 발급, defaultTenantId 응답
POST /tenants/{id}/bank-connections     → 신한 ID/PW 1회 인증, 6개 계좌 디스커버리
POST /tenants/{id}/bank-accounts        → 110443478154 confirm, connected_id 자동 결합
SFN start-execution                     → tenants-list → codef-fetch (15 raw_transactions) → SQS
                                          → classify-worker (Bedrock stub, K-IFRS 분개) → 15 journal_entries
GET /tenants/{id}/journal/entries       → entries[] 조회 (entry + lines 포함)
```

## Scenarios (16/16 PASS)

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 01 | GET /health | 200 | Pass |
| 02 | GET /me valid token, defaultTenantId 자동 발급 | 200 + tenantId | Pass (`881efe03-...`) |
| 03 | GET /me 두 번째 호출 동일 tenantId (idempotent personal tenant) | same id | Pass |
| 04 | GET /me 토큰 없음 | 401 | Pass |
| 05 | POST /bank-connections loginPassword 누락 (validation, no CODEF call) | 422 | Pass (`VALIDATION_ERROR`) |
| 06 | POST /bank-connections 다른 테넌트 (no CODEF call) | 403 | Pass (`FORBIDDEN`) |
| 07 | POST /bank-connections **신한 ID/PW 1회 정상 인증** | 200 + accounts[] | Pass (6 accounts discovered) |
| 08 | accounts에 110443478154 포함 확인 | true | Pass |
| 09 | POST /bank-accounts confirm 110443478154 (connection cache 사용) | 201 | Pass (`connected_id` 자동) |
| 10 | POST /bank-accounts org=0020 (connection 없음) | 422 `NO_BANK_CONNECTION` | Pass |
| 11 | POST /bank-accounts duplicate 110443478154 | 409 | Pass (`CONFLICT`) |
| 12 | SFN start-execution | executionArn 반환 | Pass |
| 13 | SFN execution status SUCCEEDED | SUCCEEDED | Pass (재트리거 후 fetched=15, queued=15) |
| 14 | GET /journal/entries 분개 결과 조회 | 200 + entries[]>0 | Pass (15 entries, K-IFRS lines + aiModel) |
| 15 | GET /journal/entries 토큰 없음 | 401 | Pass |
| 16 | GET /journal/entries 다른 테넌트 | 403 | Pass |

## Sample classified entry

신한체크카드 결제 거래(5,000원)에 대한 자동 분개:

```json
{
  "id": "d3d1e1a0-8f30-486d-8b57-e3712a29f52d",
  "entryDate": "2026-05-10",
  "source": "codef_bank",
  "sourceRefId": "1dc13113-3871-4995-889e-8569a30430b9",
  "description": "신한체",
  "aiConfidence": 0.85,
  "aiModel": "stub.k-ifrs-expense",
  "lines": [
    { "lineNo": 1, "accountCode": "5501", "debit": 5000, "credit": 0 },
    { "lineNo": 2, "accountCode": "1002", "debit": 0,    "credit": 5000 }
  ]
}
```

## Operational fixes deployed during this run

1. **Identity `authFlows.adminUserPassword`**: Slice 6에서 OAuth 흐름 도입 시 admin auth flow가 빠져 `admin-initiate-auth` 호출이 `Auth flow not enabled`로 실패. `userSrp: true, adminUserPassword: true`로 복원.
2. **SFN Map ItemsPath / ItemSelector**: `payload: TaskInput.fromJsonPathAt('$')`이 ASL에 literal `"$"`로 emit되어 Lambda가 string `$`를 받음. `itemSelector + JsonPath.stringAt('$.tenantId')` 패턴으로 교체.
3. **CODEF success code**: 기존 코드는 `00000`로 비교했으나 실제 CODEF 응답은 `CF-00000`. 성공 케이스가 매번 `CODEF_API_ERROR` 502로 떨어지던 사일런트 버그를 수정.
4. **Foundation Secret CMK**: CFN이 `KmsKeyId` attribute removal을 Secrets Manager에 전파하지 못하는 한계로 옛 SharedKey가 attached로 남아 codef-fetch Lambda가 `AccessDeniedException: Access to KMS is not allowed`. `aws secretsmanager update-secret --kms-key-id alias/aws/secretsmanager`로 AWS-managed key 전환 + `sync-secrets-from-env.sh` 재실행.
5. **Classify worker accounts seeding**: HTTP `POST /journal/classify` 경로는 `EnsureAccountsSeededUseCase`를 호출하지만 SQS-driven `codef-classify-worker`는 호출 안 함 → `journal_lines_tenant_id_account_code_fkey` 위반. Worker 시작부에 `K_IFRS_DEFAULT_ACCOUNTS` bulk-insert (ON CONFLICT DO NOTHING) 추가.

## Schema / data state after run (tenant `881efe03-8181-4ae1-b6d3-0c16d87feba1`)

| Table | Rows |
|-------|------|
| `tenants` (BRN nullable, business_type='personal') | 1 |
| `tenant_members` (owner) | 1 |
| `tenant_bank_connections` (org=0088, connected_id=`e1c1TQBAQ-...`) | 1 |
| `tenant_bank_accounts` (110443478154, connected_id 자동) | 1 |
| `accounts` (K-IFRS seed via worker) | 25 (default chart) |
| `raw_transactions` (CODEF 거래내역) | 15 |
| `journal_entries` | 15 |
| `journal_lines` | 30 (entry당 2 lines, debit/credit balanced) |
| `ai_decisions` | 15 |

## Live Bedrock validation (post-stub-removal)

E2E 1차 run은 dev 기본값이 stub이라 `aiModel: stub.k-ifrs-expense`로 분개됐다. 그 후 dev/prod 모두 실 Bedrock 사용으로 일원화 (commit `9439ada`) + 3건 sample을 재분류해 진짜 Sonnet 4.6 응답을 확인:

| source_ref_id | tx (KRW) | counterparty | ai_model | confidence | input_tokens | output_tokens |
|---|---|---|---|---|---|---|
| c33c92f5… | 2,000 | 신한체 | `global.anthropic.claude-sonnet-4-6` | 0.45 | 913 | 116 |
| 3ac8d64c… | 3,000 | 모바일 | `global.anthropic.claude-sonnet-4-6` | 0.72 | 913 | 111 |
| eda40293… | 3,200 | 신한체 | `global.anthropic.claude-sonnet-4-6` | 0.60 | 913 | 111 |

stub과의 명확한 구분:
- **모델 이름**: `global.anthropic.claude-sonnet-4-6` ↔ stub `stub.k-ifrs-expense`
- **Confidence가 가변적**: stub은 항상 0.85 고정, Bedrock은 거래마다 0.45/0.60/0.72 → 실제 LLM 응답
- **Token usage**: stub은 0/0, Bedrock은 input ~913, output ~110-116 (3건 합 ≈ $0.013, 약 17원)
- **Account code 선택**: stub은 모든 거래에 5501 (보통 비용) 고정, Bedrock은 5401 자율 선택 (다른 expense 카테고리)

`GET /tenants/{id}/journal/entries`로도 동일 데이터 정상 반환 확인 (lines + accountCode + balanced debit/credit + aiModel).

## Gaps / follow-ups

1. **Foundation CMK in CDK**: 코드에서 KmsKeyId removal은 했지만 CFN drift 발생. CDK에서 `encryptionKey: alias/aws/secretsmanager`를 명시적으로 지정하는 게 정합성 측면에서 깔끔 (운영 영향 없음).
2. **Migration 0010 ENUM 트랜잭션 제약**: Postgres `ALTER TYPE ADD VALUE`는 트랜잭션 외부 실행 권장이나, 이번 deploy에서 SchemaMigratorFn이 sequential 실행으로 처리되어 무사 통과. 향후 ENUM 변경 시 별도 마이그레이션으로 분리 고려.
3. **CODEF 인증서/간편인증 마이그레이션**: 현재 loginType=1(ID/PW) — 평문 비밀번호가 Lambda 메모리 잠시 경유. Phase 1에서 인증서 팝업 또는 간편인증(Kakao/Toss/PASS) 채택해 사용자가 우리 서버에 자격증명을 넘기지 않도록 변경 예정.
4. **Bedrock 비용/한도**: dev에서도 Bedrock을 사용하므로 분류 호출이 누적되면 비용이 발생. `BEDROCK_DAILY_LIMIT_PER_USER=100`이 기본 가드, per-tenant token quota는 향후 도입 검토.

## Cleanup (RDS)

반복 실행 전 깨끗한 상태가 필요하면:

```sql
TRUNCATE TABLE
  journal_lines,
  journal_entries,
  ai_decisions,
  accounts,
  raw_transactions,
  tenant_bank_accounts,
  tenant_bank_connections,
  tenant_members,
  tenants,
  user_profiles,
  users
  CASCADE;
```

멱등성 간섭 시 DynamoDB **`Ym-Dev-Data-*IdempotencyKeys*`** 정리.
