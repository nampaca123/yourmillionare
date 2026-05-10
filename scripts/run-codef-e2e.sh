#!/usr/bin/env bash
set -euo pipefail

# CODEF E2E test: signs in via Cognito, exercises bank-connections / bank-accounts / journal flow with a real Shinhan account,
# triggers the ingestion Step Functions execution, and verifies classified journal entries.
# Strict safeguard: hits CODEF with the real Shinhan password EXACTLY ONCE (scenario 05) to avoid 5-attempt lockout.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT}/.env}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

REGION="${AWS_REGION:-ap-northeast-2}"
PROFILE_FLAG=()
if [[ -n "${AWS_PROFILE:-}" ]]; then
  PROFILE_FLAG=(--profile "${AWS_PROFILE}")
fi
OUT="${CODEF_E2E_RAW:-${ROOT}/docs/codef-e2e-raw.ndjson}"
META="${CODEF_E2E_META:-${ROOT}/docs/codef-e2e-meta.json}"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: ${name} is required (set in .env or env)" >&2
    exit 1
  fi
}

require_env SHINHAN_MY_ID
require_env SHINHAN_MY_PASSWORD
require_env API_E2E_USERNAME
require_env API_E2E_PASSWORD
SHINHAN_TARGET_ACCOUNT="${SHINHAN_TARGET_ACCOUNT:-110443478154}"

# Discover stack outputs
discover_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks "${PROFILE_FLAG[@]}" --region "${REGION}" \
    --stack-name "${stack}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" --output text
}

API_BASE="${API_BASE_URL:-$(discover_output Ym-Dev-Api HttpApiUrl)}"
API_BASE="${API_BASE%/}"
POOL_ID="$(discover_output Ym-Dev-Identity UserPoolId)"
CLIENT_ID="$(discover_output Ym-Dev-Identity UserPoolClientId)"
SFN_ARN="$(discover_output Ym-Dev-Ingestion IngestionStateMachineArn)"

if [[ -z "${API_BASE}" || -z "${POOL_ID}" || -z "${CLIENT_ID}" || -z "${SFN_ARN}" ]]; then
  echo "ERROR: failed to resolve CDK outputs (API_BASE=${API_BASE} POOL_ID=${POOL_ID} CLIENT_ID=${CLIENT_ID} SFN_ARN=${SFN_ARN})" >&2
  exit 1
fi

echo "API_BASE=${API_BASE}"
echo "SFN_ARN=${SFN_ARN}"

# Cognito sign-in
echo 'Signing in to Cognito...'
ID_TOKEN="$(aws cognito-idp admin-initiate-auth "${PROFILE_FLAG[@]}" --region "${REGION}" \
  --user-pool-id "${POOL_ID}" --client-id "${CLIENT_ID}" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=${API_E2E_USERNAME},PASSWORD=${API_E2E_PASSWORD}" \
  --query 'AuthenticationResult.IdToken' --output text)"
if [[ -z "${ID_TOKEN}" || "${ID_TOKEN}" == "None" ]]; then
  echo 'ERROR: Cognito did not return an ID token (check API_E2E_USERNAME / API_E2E_PASSWORD)' >&2
  exit 1
fi

: >"${OUT}"

PASS=0
FAIL=0

append_result() {
  local id="$1" name="$2" expect="$3" got="$4" pass="$5" extra="${6:-}"
  jq -nc \
    --arg id "${id}" --arg name "${name}" --arg expect "${expect}" \
    --arg got "${got}" --argjson pass "${pass}" --arg extra "${extra}" \
    '{id:$id,scenario:$name,expect:$expect,got:$got,pass:$pass,extra:$extra}' >>"${OUT}"
  if [[ "${pass}" == "true" ]]; then
    PASS=$((PASS + 1))
    printf '  PASS [%s] %s\n' "${id}" "${name}"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL [%s] %s — expected %s, got %s %s\n' "${id}" "${name}" "${expect}" "${got}" "${extra}"
  fi
}

curl_json() {
  local tmp sc
  tmp="$(mktemp)"
  sc=$(curl -sS -o "${tmp}" -w '%{http_code}' "$@")
  RESP_BODY="$(cat "${tmp}")"
  HTTP_CODE="${sc}"
  rm "${tmp}"
}

# 01 — GET /health
echo '--- 01 GET /health ---'
curl_json "${API_BASE}/health"
[[ "${HTTP_CODE}" == "200" ]] && p=true || p=false
append_result 01 'GET /health' '200' "${HTTP_CODE}" "${p}"

# 02 — GET /me with valid token (defaultTenantId auto-provisioned)
echo '--- 02 GET /me valid token ---'
curl_json -H "Authorization: Bearer ${ID_TOKEN}" "${API_BASE}/me"
TENANT_ID="$(printf '%s' "${RESP_BODY}" | jq -r '.defaultTenantId // empty')"
if [[ "${HTTP_CODE}" == "200" && -n "${TENANT_ID}" ]]; then p=true; else p=false; fi
append_result 02 'GET /me defaultTenantId provisioned' '200 + tenantId' "${HTTP_CODE} body=${RESP_BODY}" "${p}"

if [[ "${p}" != "true" ]]; then
  echo 'ABORT: cannot proceed without defaultTenantId.' >&2
  exit 1
fi

# 03 — GET /me again (idempotent personal tenant)
echo '--- 03 GET /me idempotent ---'
curl_json -H "Authorization: Bearer ${ID_TOKEN}" "${API_BASE}/me"
TENANT_ID2="$(printf '%s' "${RESP_BODY}" | jq -r '.defaultTenantId // empty')"
if [[ "${HTTP_CODE}" == "200" && "${TENANT_ID2}" == "${TENANT_ID}" ]]; then p=true; else p=false; fi
append_result 03 'GET /me returns same defaultTenantId' "200 + ${TENANT_ID}" "${HTTP_CODE} ${TENANT_ID2}" "${p}"

# 04 — GET /me without token
echo '--- 04 GET /me no auth ---'
curl_json "${API_BASE}/me"
[[ "${HTTP_CODE}" == "401" ]] && p=true || p=false
append_result 04 'GET /me unauthenticated' '401' "${HTTP_CODE}" "${p}"

CONNECTIONS_URL="${API_BASE}/tenants/${TENANT_ID}/bank-connections"
ACCOUNTS_URL="${API_BASE}/tenants/${TENANT_ID}/bank-accounts"
ENTRIES_URL="${API_BASE}/tenants/${TENANT_ID}/journal/entries"
FAKE_TENANT='00000000-0000-4000-a000-000000000001'

# Negative cases FIRST so we never burn a Shinhan attempt before the safeguards.

# 05 — POST /bank-connections missing loginPassword (validation, no CODEF call)
echo '--- 05 bank-connections validation: missing loginPassword ---'
curl_json -X POST "${CONNECTIONS_URL}" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "{\"organization\":\"0088\",\"loginId\":\"${SHINHAN_MY_ID}\"}"
[[ "${HTTP_CODE}" == "422" ]] && p=true || p=false
append_result 05 'POST /bank-connections missing password (validation)' '422' "${HTTP_CODE}" "${p}"

# 06 — POST /bank-connections wrong tenant (forbidden, no CODEF call)
echo '--- 06 bank-connections wrong tenant ---'
curl_json -X POST "${API_BASE}/tenants/${FAKE_TENANT}/bank-connections" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "{\"organization\":\"0088\",\"loginId\":\"will-not-be-used\",\"loginPassword\":\"never-sent-to-codef\"}"
[[ "${HTTP_CODE}" == "403" ]] && p=true || p=false
append_result 06 'POST /bank-connections wrong tenant' '403' "${HTTP_CODE}" "${p}"

# 07 — THE one and only real Shinhan auth call
echo '--- 07 bank-connections REAL Shinhan auth (single attempt) ---'
PAYLOAD="$(jq -nc \
  --arg id "${SHINHAN_MY_ID}" \
  --arg pw "${SHINHAN_MY_PASSWORD}" \
  '{organization:"0088",loginId:$id,loginPassword:$pw}')"
curl_json -X POST "${CONNECTIONS_URL}" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "${PAYLOAD}"
PAYLOAD=''  # scrub
CONNECT_HTTP="${HTTP_CODE}"
CONNECT_BODY="${RESP_BODY}"
ACCOUNTS_LIST="$(printf '%s' "${CONNECT_BODY}" | jq -c '.accounts // []' 2>/dev/null || echo '[]')"
ACCOUNTS_COUNT="$(printf '%s' "${ACCOUNTS_LIST}" | jq 'length')"
if [[ "${CONNECT_HTTP}" == "200" && "${ACCOUNTS_COUNT}" -gt 0 ]]; then p=true; else p=false; fi
append_result 07 'POST /bank-connections valid Shinhan auth' '200 + accounts[]' "${CONNECT_HTTP} count=${ACCOUNTS_COUNT}" "${p}"

if [[ "${CONNECT_HTTP}" != "200" ]]; then
  echo 'ABORT: Shinhan auth failed. Stopping immediately to avoid additional attempts (5-attempt lockout).' >&2
  echo "Response: ${CONNECT_BODY}" >&2
  exit 2
fi

# 08 — Verify target account 110443478154 is in the list
echo '--- 08 discovered accounts contain target ---'
HAS_TARGET="$(printf '%s' "${ACCOUNTS_LIST}" | jq --arg n "${SHINHAN_TARGET_ACCOUNT}" 'any(.accountNumber == $n)')"
if [[ "${HAS_TARGET}" == "true" ]]; then p=true; else p=false; fi
append_result 08 "Discovered accounts include ${SHINHAN_TARGET_ACCOUNT}" 'true' "${HAS_TARGET}" "${p}" "list=${ACCOUNTS_LIST}"

# 09 — POST /bank-accounts confirm target (uses cached connectedId, no creds resent)
echo '--- 09 bank-accounts confirm target ---'
curl_json -X POST "${ACCOUNTS_URL}" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "{\"organization\":\"0088\",\"accountNumber\":\"${SHINHAN_TARGET_ACCOUNT}\"}"
ACCOUNT_BODY="${RESP_BODY}"
if [[ "${HTTP_CODE}" == "201" ]]; then p=true; else p=false; fi
append_result 09 "POST /bank-accounts confirm ${SHINHAN_TARGET_ACCOUNT}" '201' "${HTTP_CODE} body=${ACCOUNT_BODY}" "${p}"

# 10 — POST /bank-accounts with no prior connection for org=0020 → 422 NO_BANK_CONNECTION
echo '--- 10 bank-accounts no connection ---'
curl_json -X POST "${ACCOUNTS_URL}" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"organization":"0020","accountNumber":"220-001-000099"}'
[[ "${HTTP_CODE}" == "422" ]] && p=true || p=false
append_result 10 'POST /bank-accounts no prior connection' '422' "${HTTP_CODE}" "${p}"

# 11 — POST /bank-accounts duplicate
echo '--- 11 bank-accounts duplicate ---'
curl_json -X POST "${ACCOUNTS_URL}" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "{\"organization\":\"0088\",\"accountNumber\":\"${SHINHAN_TARGET_ACCOUNT}\"}"
[[ "${HTTP_CODE}" == "409" ]] && p=true || p=false
append_result 11 'POST /bank-accounts duplicate' '409' "${HTTP_CODE}" "${p}"

# 12 — Trigger Step Functions execution
echo '--- 12 SFN trigger ---'
SFN_INPUT="$(jq -nc --arg t "${TENANT_ID}" '{tenantId:$t}')"
EXEC_ARN="$(aws stepfunctions start-execution "${PROFILE_FLAG[@]}" --region "${REGION}" \
  --state-machine-arn "${SFN_ARN}" \
  --input "${SFN_INPUT}" \
  --query 'executionArn' --output text)"
if [[ -n "${EXEC_ARN}" && "${EXEC_ARN}" != "None" ]]; then p=true; else p=false; fi
append_result 12 'SFN start-execution' 'executionArn returned' "${EXEC_ARN}" "${p}"

# 13 — Poll SFN until SUCCEEDED (max 10min)
echo '--- 13 SFN wait for completion ---'
EXEC_STATUS=''
for i in $(seq 1 20); do
  EXEC_STATUS="$(aws stepfunctions describe-execution "${PROFILE_FLAG[@]}" --region "${REGION}" \
    --execution-arn "${EXEC_ARN}" --query 'status' --output text)"
  echo "  poll #${i}: status=${EXEC_STATUS}"
  if [[ "${EXEC_STATUS}" == "SUCCEEDED" || "${EXEC_STATUS}" == "FAILED" || "${EXEC_STATUS}" == "TIMED_OUT" || "${EXEC_STATUS}" == "ABORTED" ]]; then
    break
  fi
  sleep 30
done
[[ "${EXEC_STATUS}" == "SUCCEEDED" ]] && p=true || p=false
append_result 13 'SFN execution completes successfully' 'SUCCEEDED' "${EXEC_STATUS}" "${p}"

# 14 — GET /journal/entries — last 7 days
echo '--- 14 GET /journal/entries last 7 days ---'
TO_DATE="$(date -u +%Y-%m-%d)"
FROM_DATE="$(date -u -v-7d +%Y-%m-%d 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%d)"
curl_json -H "Authorization: Bearer ${ID_TOKEN}" \
  "${ENTRIES_URL}?from=${FROM_DATE}&to=${TO_DATE}&limit=50"
ENTRY_BODY="${RESP_BODY}"
ENTRY_COUNT="$(printf '%s' "${ENTRY_BODY}" | jq '.entries | length' 2>/dev/null || echo 0)"
if [[ "${HTTP_CODE}" == "200" && "${ENTRY_COUNT}" -gt 0 ]]; then p=true; else p=false; fi
append_result 14 'GET /journal/entries returns classified entries' "200 + entries[]>0" "${HTTP_CODE} count=${ENTRY_COUNT}" "${p}" "from=${FROM_DATE} to=${TO_DATE}"

# 15 — GET /journal/entries no auth
echo '--- 15 GET /journal/entries no auth ---'
curl_json "${ENTRIES_URL}?from=${FROM_DATE}&to=${TO_DATE}"
[[ "${HTTP_CODE}" == "401" ]] && p=true || p=false
append_result 15 'GET /journal/entries unauthenticated' '401' "${HTTP_CODE}" "${p}"

# 16 — GET /journal/entries wrong tenant
echo '--- 16 GET /journal/entries wrong tenant ---'
curl_json -H "Authorization: Bearer ${ID_TOKEN}" \
  "${API_BASE}/tenants/${FAKE_TENANT}/journal/entries?from=${FROM_DATE}&to=${TO_DATE}"
[[ "${HTTP_CODE}" == "403" ]] && p=true || p=false
append_result 16 'GET /journal/entries wrong tenant' '403' "${HTTP_CODE}" "${p}"

# Summary
TOTAL=$((PASS + FAIL))
printf '\n=== CODEF E2E summary ===\n'
printf 'PASS=%d  FAIL=%d  TOTAL=%d\n' "${PASS}" "${FAIL}" "${TOTAL}"

jq -nc \
  --arg tenantId "${TENANT_ID}" \
  --arg execArn "${EXEC_ARN}" \
  --arg execStatus "${EXEC_STATUS}" \
  --argjson entries "${ENTRY_COUNT}" \
  --argjson accounts "${ACCOUNTS_COUNT}" \
  --argjson pass "${PASS}" --argjson fail "${FAIL}" --argjson total "${TOTAL}" \
  '{tenantId:$tenantId,sfnExecutionArn:$execArn,sfnStatus:$execStatus,journalEntryCount:$entries,discoveredAccountCount:$accounts,pass:$pass,fail:$fail,total:$total}' \
  >"${META}"

echo "raw  : ${OUT}"
echo "meta : ${META}"

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
