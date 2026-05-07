# API terminal E2E — 2026-05-07

## Summary

- **Base URL:** `https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com` (Ym-Dev-Api)
- **Auth:** Cognito ID token (`ADMIN_USER_PASSWORD_AUTH`) for user `api-e2e-6a639eee@ym-e2e.test` (`sub`: `14d8cd8c-3061-701f-9ae6-ccb45ba75c03`; password managed out-of-repo)
- **Runner:** `./scripts/run-api-e2e.sh` → NDJSON audit `docs/api-e2e-raw.ndjson` (2026-05-07 dry run **after DB TRUNCATE** + randomized 10-digit `bizRegNo` per run so journal paths receive a valid `tenantId`).
- **Result:** **22 / 22** scripted assertions `pass:true` (`expectHttp` aligned with automation).
- **401 vs app JSON:** JWT authorizer returns API Gateway `{ "message": "Unauthorized" }`; lambda routes return `{ "error": { "code", "message" } }` per `toHttpErrorResponse`.

## GET /health

| Scenario | Expected HTTP | Actual HTTP | Result |
|----------|---------------|-------------|--------|
| ok | 200 | 200 | Pass (`status: ok`) |

## GET /unknown (bonus)

| Scenario | Expected HTTP | Actual HTTP | Result |
|----------|---------------|-------------|--------|
| unknown_path | 404 | 404 | Pass |

## GET /me

| Scenario | Expected HTTP | Actual HTTP | Result |
|----------|---------------|-------------|--------|
| valid_token | 200 | 200 | Pass (`id`, `cognitoSub`, `email`) |
| no_auth | 401 | 401 | Pass (Gateway shape) |
| bad_token | 401 | 401 | Pass |

## POST /tenants

| Scenario | Expected HTTP | Actual HTTP | Result |
|----------|---------------|-------------|--------|
| valid_body | 201 | 201 | Pass (`tenantId` captured for Journal) |
| empty_body | 422 | 422 | Pass (`VALIDATION_ERROR`) |
| invalid_bizreg | 422 | 422 | Pass |
| duplicate_bizreg | 409 | 409 | Pass (`CONFLICT`) |
| idempotency_first | 201 | 201 | Pass |
| idempotency_repeat_same_body | 201 | 201 | Pass (same `id` replay; note cached `pk` `tenant-create`) |
| idempotency_key_body_mismatch | 409 or 500 | 500 | Pass (Powertools surfaced as **`INTERNAL_ERROR`**, not typed `IDEMPOTENCY_KEY_REUSED`) |

## GET /me/tenants

| Scenario | Expected HTTP | Actual HTTP | Result |
|----------|---------------|-------------|--------|
| after_creates | 200 | 200 | Pass (two tenants in array) |
| no_auth | 401 | 401 | Pass |

## POST /tenants/{tenantId}/journal/classify

| Scenario | Expected HTTP | Actual HTTP | Result |
|----------|---------------|-------------|--------|
| forbidden_wrong_tenant | 403 | 403 | Pass (`FORBIDDEN`; not 404 per spec) |
| amount_zero | 422 | 422 | Pass (`VALIDATION_ERROR` / Zod) |
| valid_classify | 201 | 201 | Pass (`lines`, Bedrock **`global.anthropic.claude-sonnet-4-6`**, seed accounts); **cost:** one Bedrock Converse |

## POST /tenants/{tenantId}/journal/entries

| Scenario | Expected HTTP | Actual HTTP | Result |
|----------|---------------|-------------|--------|
| unbalanced | 422 | 422 | Pass (`UNBALANCED_JOURNAL`) |
| valid_manual_entry | 201 | 201 | Pass |
| entries_wrong_tenant | 403 | 403 | Pass |
| too_few_lines | 422 | 422 | Pass |
| line_debit_and_credit_same_side | 500 | 500 | Pass (domain guard → unhandled **`INTERNAL_ERROR`**; matches doc “may be 500”) |

## Gaps / follow-ups

1. **`POST /tenants` idempotency body mismatch:** map Powertools **`IdempotencyKeyReused`** (or mismatch) through `toHttpErrorResponse` → **409** `IDEMPOTENCY_KEY_REUSED` instead of generic 500.
2. **`line_debit_and_credit_same_side`:** Prefer **422** `VALIDATION_ERROR` if validated at boundary; otherwise keep documented 500.
3. **`HTTP API` headers:** Stored key path must use lowercased `headers."idempotency-key"` — API Gateway HTTP API lowers header names before Lambda.
4. **Infra/schema fixes exercised during bring-up:** `0005-rls-app-guc-uuid.sql` (`app_uuid_from_setting`), tenant `CREATE` must set **`cognito_sub` GUC** for FK visibility, classify idempotency key `|| raw body`.

## Cleanup (RDS)

Ran **before** final green run:

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

(`schema_migrations` retained.)

**Post-report (2026-05-07, KST):** repeated **`TRUNCATE … CASCADE`**; row counts **`0`** on `users`, `tenants`, `tenant_members`, `journal_entries`, `journal_lines`, `accounts`, `raw_transactions`, `user_profiles`; **`schema_migrations`** left at **7** rows. DynamoDB **`Ym-Dev-Data-CacheIdempotencyKeys…`** cleared (**`batch-write-item` delete**, final scan count **`0`**).
