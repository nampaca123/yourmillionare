#!/usr/bin/env bash
# Post-deploy smoke: verifies Function URL CORS, FxCollector invokes cleanly, and API GW catch-all serves structured 404+CORS.

set -euo pipefail

PROFILE="${AWS_PROFILE:-ym-dev}"
REGION="${AWS_REGION:-ap-northeast-2}"
STACK_PREFIX="${STACK_PREFIX:-Ym-Dev}"
ORIGIN="${SMOKE_ORIGIN:-https://dashboard.yourmillionaire.kro.kr}"

red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note() { printf '%s\n' "$*"; }

failures=0
record_fail() {
  failures=$((failures + 1))
  red "FAIL: $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { red "missing command: $1"; exit 1; }
}

require_cmd aws
require_cmd curl
require_cmd jq

stack_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks --profile "$PROFILE" --region "$REGION" \
    --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey==\`$key\`].OutputValue" --output text 2>/dev/null
}

resource_physical_id() {
  local stack="$1" logical_prefix="$2"
  aws cloudformation describe-stack-resources --profile "$PROFILE" --region "$REGION" \
    --stack-name "$stack" \
    --query "StackResources[?starts_with(LogicalResourceId, \`$logical_prefix\`) && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId | [0]" \
    --output text 2>/dev/null
}

note "== Resolving stack outputs (${STACK_PREFIX}) =="
API_BASE="$(stack_output "${STACK_PREFIX}-Api" HttpApiUrl)"
[[ -n "$API_BASE" && "$API_BASE" != "None" ]] || { red "HttpApiUrl output missing on ${STACK_PREFIX}-Api"; exit 1; }
note "  API_BASE=$API_BASE"

note ""
note "== 1) API GW catch-all returns 404 + CORS headers for unknown route =="
not_found_resp="$(curl -s -o /dev/null -w '%{http_code} %header{access-control-allow-origin}' \
  -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{}' \
  "${API_BASE%/}/tenants/does-not-exist/totally/missing")"
http_code="${not_found_resp%% *}"
acao="${not_found_resp#* }"
if [[ "$http_code" == "404" && "$acao" == "$ORIGIN" ]]; then
  green "OK: catch-all returns 404 with Access-Control-Allow-Origin=$ORIGIN"
else
  record_fail "catch-all expected 404+CORS, got code=$http_code acao=$acao"
fi

note ""
note "== 2) Tax strategy Function URL preflight =="
TAX_URL="$(resource_physical_id "${STACK_PREFIX}-Api" TaxStrategyFnUrl)"
if [[ -z "$TAX_URL" || "$TAX_URL" == "None" ]]; then
  TAX_URL="$(stack_output "${STACK_PREFIX}-Api" TaxStrategyFnUrl)"
fi
if [[ -n "$TAX_URL" && "$TAX_URL" != "None" ]]; then
  pf="$(curl -s -o /dev/null -w '%{http_code} %header{access-control-allow-origin}' \
    -X OPTIONS "$TAX_URL" \
    -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: authorization,content-type')"
  if [[ "${pf%% *}" =~ ^(200|204)$ && "${pf#* }" == "$ORIGIN" ]]; then
    green "OK: TaxStrategyFn preflight passed ($pf)"
  else
    record_fail "TaxStrategyFn preflight unexpected: $pf"
  fi
else
  note "  SKIP: TaxStrategyFnUrl not found (PR4.5 not deployed?)"
fi

note ""
note "== 3) Codef SSE Function URL preflight =="
FS_URL="$(stack_output "${STACK_PREFIX}-Api" CodefSyncStreamFnUrl)"
if [[ -n "$FS_URL" && "$FS_URL" != "None" ]]; then
  pf="$(curl -s -o /dev/null -w '%{http_code} %header{access-control-allow-origin}' \
    -X OPTIONS "$FS_URL" \
    -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: authorization,content-type')"
  if [[ "${pf%% *}" =~ ^(200|204)$ && "${pf#* }" == "$ORIGIN" ]]; then
    green "OK: CodefSyncStreamFn preflight passed ($pf)"
  else
    record_fail "CodefSyncStreamFn preflight unexpected: $pf"
  fi
else
  note "  SKIP: CodefSyncStreamFnUrl not found"
fi

note ""
note "== 4) FxCollectorFn one-shot invoke =="
FX_FN="$(resource_physical_id "${STACK_PREFIX}-Ingestion" FxCollectorFn)"
if [[ -n "$FX_FN" && "$FX_FN" != "None" ]]; then
  out="$(mktemp)"
  if aws lambda invoke --profile "$PROFILE" --region "$REGION" \
      --function-name "$FX_FN" --invocation-type RequestResponse "$out" >/dev/null 2>&1; then
    if jq -e '.ok == true and (.upserted | type == "number")' "$out" >/dev/null 2>&1; then
      upserted="$(jq -r '.upserted' "$out")"
      window_from="$(jq -r '.windowFrom' "$out")"
      window_to="$(jq -r '.windowTo' "$out")"
      green "OK: FxCollectorFn ok=true upserted=$upserted window=$window_from..$window_to"
    else
      record_fail "FxCollectorFn returned unexpected payload: $(cat "$out")"
    fi
  else
    record_fail "FxCollectorFn invoke failed (see CloudWatch logs for $FX_FN)"
  fi
  rm -f "$out"
else
  record_fail "FxCollectorFn physical id not found in ${STACK_PREFIX}-Ingestion"
fi

note ""
note "== 5) FX strategy Function URL preflight =="
FX_STRATEGY_URL="$(stack_output "${STACK_PREFIX}-Api" FxStrategyFnUrl)"
if [[ -n "$FX_STRATEGY_URL" && "$FX_STRATEGY_URL" != "None" ]]; then
  pf="$(curl -s -o /dev/null -w '%{http_code} %header{access-control-allow-origin}' \
    -X OPTIONS "$FX_STRATEGY_URL" \
    -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: authorization,content-type')"
  if [[ "${pf%% *}" =~ ^(200|204)$ && "${pf#* }" == "$ORIGIN" ]]; then
    green "OK: FxStrategyFn preflight passed ($pf)"
  else
    record_fail "FxStrategyFn preflight unexpected: $pf"
  fi
else
  note "  SKIP: FxStrategyFnUrl not found"
fi

note ""
note "== 6) Strategy SSE Function URLs return SSE error+done without a token =="
for label_url in "TaxStrategyFn:$TAX_URL" "FxStrategyFn:$FX_STRATEGY_URL"; do
  label="${label_url%%:*}"
  url="${label_url#*:}"
  if [[ -z "$url" || "$url" == "None" ]]; then continue; fi
  body="$(curl -s -N -X POST "$url" -H 'Content-Type: application/json' \
    -d "{\"tenantId\":\"00000000-0000-0000-0000-000000000000\",\"scenario\":\"exposure_summary\"}" \
    --max-time 8 || true)"
  if echo "$body" | grep -q '^data: {"type":"error"' && echo "$body" | grep -q '^data: {"type":"done"'; then
    green "OK: $label tokenless POST emitted SSE error + done"
  else
    record_fail "$label tokenless POST did not emit SSE error+done. body=$(echo "$body" | head -3)"
  fi
done

note ""
note "== 7) Deleted /agent/search-tax-law + /agent/find-benefits return ROUTE_NOT_FOUND =="
for path in /agent/search-tax-law /agent/find-benefits; do
  status_body="$(curl -s -o /tmp/.deleted-route.json -w '%{http_code}' \
    -X POST "${API_BASE%/}/tenants/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa${path}" \
    -H 'Content-Type: application/json' -d '{}')"
  code="$(jq -r '.error.code // empty' /tmp/.deleted-route.json 2>/dev/null)"
  if [[ "$status_body" == "404" && "$code" == "ROUTE_NOT_FOUND" ]]; then
    green "OK: $path → 404 ROUTE_NOT_FOUND (catch-all served)"
  else
    record_fail "$path expected 404 ROUTE_NOT_FOUND, got http=$status_body code=$code"
  fi
  rm -f /tmp/.deleted-route.json
done

note ""
if [[ "$failures" -eq 0 ]]; then
  green "post-deploy smoke: all checks passed"
  exit 0
fi
red "post-deploy smoke: $failures check(s) failed"
exit 1
