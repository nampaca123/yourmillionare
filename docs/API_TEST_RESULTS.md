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

## Cleanup (RDS)

반복 실행 전 깨끗한 상태가 필요하면:

```sql
TRUNCATE TABLE
  journal_lines,
  journal_entries,
  accounts,
  raw_transactions,
  tenant_bank_accounts,
  tenant_members,
  tenants,
  user_profiles,
  users
  CASCADE;
```

멱등성 간섭 시 DynamoDB **`Ym-Dev-Data-*IdempotencyKeys*`** 정리.
