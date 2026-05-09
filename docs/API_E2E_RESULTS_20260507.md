# API terminal E2E — 2026-05-07

## Summary

- **Base URL:** `https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com` (Ym-Dev-Api)
- **Auth:** Cognito ID token via **`API_E2E_PASSWORD`** + **`API_E2E_USERNAME`** (optional; pool/client resolved from **`Ym-Dev-Identity`**) or explicit **`ID_TOKEN`**. (`AWS_PROFILE` default `ym-dev`, `AWS_REGION` default `ap-northeast-2`)
- **Runner:** `./scripts/run-api-e2e.sh` → NDJSON audit **`docs/api-e2e-raw.ndjson`**
- **Latest green run:** **26 / 26** scripted rows `pass:true` (after **`Ym-Dev-Api` deploy** with Identity timeout **30s**, Journal **`JOURNAL_STUB_CLASSIFIER=1`** for dev, Powertools **`registerLambdaContext`**, Bedrock SDK errors → **`BEDROCK_UNAVAILABLE`** when stub off).
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

## Gaps / follow-ups

1. **프로덕션 분류:** `JOURNAL_STUB_CLASSIFIER=0` 배포 전 Bedrock 콘솔에서 모델 접근·Anthropic use-case 제출 완료 필요.
2. **`POST .../journal/entries`:** 멱등 키 없음 — 동일 POST 중복 시 중복 분개 가능.
3. **스케줄·비HTTP 스택:** `Ym-Dev-Ingestion` 의 CODEF/FX Lambda 는 HTTP API 가 아니며 본 스크립트 범위 밖.

## Cleanup (RDS)

반복 실행 전 깨끗한 상태가 필요하면:

```sql
TRUNCATE TABLE
  journal_lines,
  journal_entries,
  accounts,
  raw_transactions,
  tenant_members,
  tenants,
  user_profiles,
  users
  CASCADE;
```

멱등성 간섭 시 DynamoDB **`Ym-Dev-Data-*IdempotencyKeys*`** 정리.
