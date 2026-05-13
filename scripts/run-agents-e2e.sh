#!/usr/bin/env bash
# End-to-end agent regression: hits 5 tax + 3 fx scenarios via SSE and checks final payload keywords.

set -euo pipefail

PROFILE="${AWS_PROFILE:-ym-dev}"
REGION="${AWS_REGION:-ap-northeast-2}"
STACK_PREFIX="${STACK_PREFIX:-Ym-Dev}"
TENANT_ID="${TENANT_ID:-}"
SCENARIO_TIMEOUT_S="${SCENARIO_TIMEOUT_S:-180}"

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note() { printf '%s\n' "$*"; }

require() { [[ -n "${!1:-}" ]] || { red "missing env: $1"; exit 1; }; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || { red "missing command: $1"; exit 1; }; }

require API_E2E_USERNAME
require API_E2E_PASSWORD
require_cmd aws
require_cmd curl
require_cmd jq

failures=0
record_fail() {
  failures=$((failures + 1))
  red "FAIL: $*"
}

stack_output() {
  aws cloudformation describe-stacks --profile "$PROFILE" --region "$REGION" \
    --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey==\`$2\`].OutputValue" --output text 2>/dev/null
}

# --- 1) Cognito SRP login -----------------------------------------------------
note "== Cognito SRP login as $API_E2E_USERNAME =="
POOL_ID="$(stack_output "${STACK_PREFIX}-Identity" UserPoolId)"
CLIENT_ID="$(stack_output "${STACK_PREFIX}-Identity" UserPoolClientId)"
[[ -n "$POOL_ID" && "$POOL_ID" != "None" ]] || { red "UserPoolId output missing"; exit 1; }
[[ -n "$CLIENT_ID" && "$CLIENT_ID" != "None" ]] || { red "UserPoolClientId output missing"; exit 1; }

JWT="$(aws cognito-idp admin-initiate-auth --profile "$PROFILE" --region "$REGION" \
  --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="$API_E2E_USERNAME",PASSWORD="$API_E2E_PASSWORD" \
  --query 'AuthenticationResult.IdToken' --output text 2>/dev/null)"
[[ -n "$JWT" && "$JWT" != "None" ]] || { red "Cognito login failed"; exit 1; }
green "OK: JWT (${#JWT} bytes)"

API_BASE="$(stack_output "${STACK_PREFIX}-Api" HttpApiUrl)"
[[ -n "$API_BASE" && "$API_BASE" != "None" ]] || { red "HttpApiUrl output missing"; exit 1; }
API_BASE="${API_BASE%/}"

if [[ -z "$TENANT_ID" ]]; then
  TENANT_ID="$(curl -fsS -H "Authorization: Bearer $JWT" "$API_BASE/me" | jq -r '.defaultTenantId')"
  [[ -n "$TENANT_ID" && "$TENANT_ID" != "null" ]] || { red "could not resolve defaultTenantId via /me"; exit 1; }
fi
note "  TENANT_ID=$TENANT_ID"

# --- 2) Ensure at least one USD manual FX account exists ----------------------
note ""
note "== Ensure manual USD account for FX scenarios =="
fx_list="$(curl -fsS -H "Authorization: Bearer $JWT" "$API_BASE/tenants/$TENANT_ID/fx/accounts")"
if [[ "$(echo "$fx_list" | jq '.accounts | length')" -eq 0 ]]; then
  note "  no FX accounts found → registering one"
  curl -fsS -X POST "$API_BASE/tenants/$TENANT_ID/fx/accounts" \
    -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
    -d '{"currency":"USD","balance":3000,"bankLabel":"E2E Citi USD"}' >/dev/null
  green "  OK: registered manual USD 3000"
else
  green "  OK: existing FX account(s) present"
fi

# --- 3) Helper: run one SSE scenario and capture final payload ----------------
TAX_URL="$(stack_output "${STACK_PREFIX}-Api" TaxStrategyFnUrl)"
FX_URL="$(stack_output "${STACK_PREFIX}-Api" FxStrategyFnUrl)"
[[ -n "$TAX_URL" && "$TAX_URL" != "None" ]] || { red "TaxStrategyFnUrl missing"; exit 1; }
[[ -n "$FX_URL"  && "$FX_URL"  != "None" ]] || { red "FxStrategyFnUrl missing"; exit 1; }
TAX_URL="${TAX_URL%/}"
FX_URL="${FX_URL%/}"

run_scenario() {
  local agent="$1" scenario="$2" out="$3"
  local url
  if [[ "$agent" == "tax" ]]; then url="$TAX_URL"; else url="$FX_URL"; fi
  : >"$out"
  curl -sS -N -X POST "$url/tenants/$TENANT_ID/$agent/strategy" \
    -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
    -d "{\"tenantId\":\"$TENANT_ID\",\"scenario\":\"$scenario\"}" \
    --max-time "$SCENARIO_TIMEOUT_S" >>"$out" || true
}

extract_final_text() {
  local file="$1"
  # Reassemble the streamed answer from text_delta chunks — final.summary is truncated to 1500 chars.
  local assembled
  assembled="$(grep '^data: {"type":"text_delta"' "$file" \
    | sed 's/^data: //' \
    | jq -r '.chunk // empty' 2>/dev/null \
    | tr -d '\n')"
  if [[ -n "$assembled" ]]; then
    printf '%s' "$assembled"
    return
  fi
  # Fallback: take whatever the final event carried.
  grep '^data: {"type":"final"' "$file" | head -1 \
    | sed 's/^data: //' \
    | jq -r '.summary // empty' 2>/dev/null
}

has_done_no_error() {
  local file="$1"
  grep -q '^data: {"type":"done"' "$file" \
    && ! grep -q '^data: {"type":"error"' "$file"
}

# --- 4) Run scenarios ---------------------------------------------------------

TAX_SCENARIOS=(applicable_benefits upcoming_deadlines yearly_filing_check vat_quarter_review penalty_risk_check)
FX_SCENARIOS=(exposure_summary convert_now_check monthly_outlook)

# 7-section markdown keywords shared per agent type.
TAX_REQUIRED_KW=("현황 요약" "핵심 결론" "단계별 액션" "숫자로 보는 예시" "자주 하는 실수" "세무사 상담" "참고 법령")
FX_REQUIRED_KW=("현재 노출 요약" "핵심 결론" "근거" "권고 옵션 비교" "숫자로 보는 예시" "위험 경고" "참고 자료")

check_keywords() {
  local agent="$1" scenario="$2" text="$3" kws=("${@:4}")
  local missing=()
  local kw
  for kw in "${kws[@]}"; do
    if ! echo "$text" | grep -q "$kw"; then
      missing+=("$kw")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    record_fail "$agent/$scenario missing keywords: ${missing[*]}"
  else
    green "OK: $agent/$scenario — all 7 markdown sections present"
  fi
}

note ""
note "== Tax scenarios =="
for scenario in "${TAX_SCENARIOS[@]}"; do
  note "  → tax/$scenario"
  out="$(mktemp)"
  run_scenario tax "$scenario" "$out"
  if ! has_done_no_error "$out"; then
    record_fail "tax/$scenario did not produce a clean done event"
    rm -f "$out"; continue
  fi
  final_text="$(extract_final_text "$out")"
  if [[ -z "$final_text" ]]; then
    record_fail "tax/$scenario produced no final payload"
    rm -f "$out"; continue
  fi
  check_keywords tax "$scenario" "$final_text" "${TAX_REQUIRED_KW[@]}"
  rm -f "$out"
done

note ""
note "== FX scenarios =="
for scenario in "${FX_SCENARIOS[@]}"; do
  note "  → fx/$scenario"
  out="$(mktemp)"
  run_scenario fx "$scenario" "$out"
  if ! has_done_no_error "$out"; then
    record_fail "fx/$scenario did not produce a clean done event"
    rm -f "$out"; continue
  fi
  final_text="$(extract_final_text "$out")"
  if [[ -z "$final_text" ]]; then
    record_fail "fx/$scenario produced no final payload"
    rm -f "$out"; continue
  fi
  # FX-specific: also require risk disclaimer phrase.
  check_keywords fx "$scenario" "$final_text" "${FX_REQUIRED_KW[@]}"
  if ! echo "$final_text" | grep -q "환율은"; then
    record_fail "fx/$scenario missing the explicit '환율은' uncertainty disclaimer"
  fi
  rm -f "$out"
done

note ""
if [[ "$failures" -eq 0 ]]; then
  green "run-agents-e2e: all 8 scenarios passed keyword regression"
  exit 0
fi
red "run-agents-e2e: $failures scenario check(s) failed"
exit 1
