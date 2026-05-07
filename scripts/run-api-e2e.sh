#!/usr/bin/env bash
set -euo pipefail

BASE="${API_BASE_URL:-https://p7d9jms82f.execute-api.ap-northeast-2.amazonaws.com}"
OUT="${API_E2E_RAW:-$(dirname "$0")/../docs/api-e2e-raw.ndjson}"

: >"$OUT"

append() {
  printf '%s\n' "$1" >>"$OUT"
}

curl_json() {
  local tmp sc
  tmp="$(mktemp)"
  sc=$(curl -sS -o "$tmp" -w '%{http_code}' "$@")
  RESP_BODY="$(cat "$tmp")"
  HTTP_CODE="$sc"
  rm "$tmp"
}

TOKEN="${ID_TOKEN:?Set ID_TOKEN}"

# GET /health
curl_json "$BASE/health"
append "$(jq -nc --arg ep 'GET /health' --arg sc "$HTTP_CODE" --argjson exp 200 \
  --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"ok",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

# Unknown path
curl_json "$BASE/does-not-exist-ym"
append "$(jq -nc --arg ep 'GET /unknown' --arg sc "$HTTP_CODE" --argjson exp 404 \
  --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"unknown_path",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

# GET /me valid
curl_json -H "Authorization: Bearer $TOKEN" "$BASE/me"
append "$(jq -nc --arg ep 'GET /me' --arg sc "$HTTP_CODE" --argjson exp 200 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"valid_token",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

curl_json "$BASE/me"
append "$(jq -nc --arg ep 'GET /me' --arg sc "$HTTP_CODE" --argjson exp 401 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"no_auth",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

curl_json -H 'Authorization: Bearer junk.notajwt' "$BASE/me"
append "$(jq -nc --arg ep 'GET /me' --arg sc "$HTTP_CODE" --argjson exp 401 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"bad_token",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

read -r BIZ_FIRST BIZ_IDEM OTHER_BIZ < <(python3 - <<'PY'
import random
a = random.randint(1_000_000_000, 9_999_999_999)
b = random.randint(1_000_000_000, 9_999_999_999)
c = random.randint(1_000_000_000, 9_999_999_999)
while b == a:
    b = random.randint(1_000_000_000, 9_999_999_999)
while c in (a, b):
    c = random.randint(1_000_000_000, 9_999_999_999)
print(f'{a:010d}', f'{b:010d}', f'{c:010d}')
PY
)

curl_json -X POST "$BASE/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"legalName\":\"E2E Legal\",\"displayName\":\"E2E Disp\",\"bizRegNo\":\"$BIZ_FIRST\"}"

TENANT_FIRST="$(printf '%s' "$RESP_BODY" | jq -r '.id // empty')"
append "$(jq -nc --arg ep 'POST /tenants' --arg sc "$HTTP_CODE" --argjson exp 201 --arg body "$RESP_BODY" --arg tid "$TENANT_FIRST" \
  '{endpoint:$ep,scenario:"valid_body",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp),tenantId:$tid}')"

curl_json -X POST "$BASE/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{}'
append "$(jq -nc --arg ep 'POST /tenants' --arg sc "$HTTP_CODE" --argjson exp 422 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"empty_body",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

curl_json -X POST "$BASE/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"legalName":"x","displayName":"y","bizRegNo":"abc"}'
append "$(jq -nc --arg ep 'POST /tenants' --arg sc "$HTTP_CODE" --argjson exp 422 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"invalid_bizreg",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

curl_json -X POST "$BASE/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"legalName\":\"Dup\",\"displayName\":\"Dup\",\"bizRegNo\":\"$BIZ_FIRST\"}"
append "$(jq -nc --arg ep 'POST /tenants' --arg sc "$HTTP_CODE" --argjson exp 409 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"duplicate_bizreg",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

IDEM="$(uuidgen | tr '[:upper:]' '[:lower:]')"

curl_json -X POST "$BASE/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $IDEM" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"legalName\":\"Idem Legal\",\"displayName\":\"Idem\",\"bizRegNo\":\"$BIZ_IDEM\"}"
IDEM_BODY="$RESP_BODY"
IDEM_HTTP="$HTTP_CODE"
IDEM_ID="$(printf '%s' "$IDEM_BODY" | jq -r '.id // empty')"
append "$(jq -nc --arg ep 'POST /tenants' --arg sc "$IDEM_HTTP" --argjson exp 201 --arg body "$IDEM_BODY" \
  '{endpoint:$ep,scenario:"idempotency_first",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

curl_json -X POST "$BASE/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $IDEM" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"legalName\":\"Idem Legal\",\"displayName\":\"Idem\",\"bizRegNo\":\"$BIZ_IDEM\"}"
ID2="$(printf '%s' "$RESP_BODY" | jq -r '.id // empty')"
NOTE="id1=$IDEM_ID id2=$ID2"
PASS_JSON=false
if [[ "$IDEM_HTTP" == 200 || "$IDEM_HTTP" == 201 ]] && [[ "$HTTP_CODE" == 200 || "$HTTP_CODE" == 201 ]] && [[ "$IDEM_ID" == "$ID2" ]]; then PASS_JSON=true; fi
append "$(jq -nc --arg ep 'POST /tenants' --arg sc "$HTTP_CODE" --argjson exp 201 --arg body "$RESP_BODY" --arg note "$NOTE" --argjson p "$PASS_JSON" \
  '{endpoint:$ep,scenario:"idempotency_repeat_same_body",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:$p,note:$note}')"

curl_json -X POST "$BASE/tenants" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $IDEM" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"legalName\":\"Other\",\"displayName\":\"Other\",\"bizRegNo\":\"$OTHER_BIZ\"}"
append "$(jq -nc --arg ep 'POST /tenants' --arg sc "$HTTP_CODE" --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"idempotency_key_body_mismatch",expectHttp:"500 or 409",http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==500 or ($sc|tonumber)==409)}')"

curl_json -H "Authorization: Bearer $TOKEN" "$BASE/me/tenants"
append "$(jq -nc --arg ep 'GET /me/tenants' --arg sc "$HTTP_CODE" --argjson exp 200 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"after_creates",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

curl_json "$BASE/me/tenants"
append "$(jq -nc --arg ep 'GET /me/tenants' --arg sc "$HTTP_CODE" --argjson exp 401 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"no_auth",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

FAKE_TENANT='00000000-0000-4000-a000-000000000001'
CLASSIFY_URL="$BASE/tenants/$FAKE_TENANT/journal/classify"
curl_json -X POST "$CLASSIFY_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"date":"2026-05-01","amount":1000,"counterparty":"X","memo":"Y"}'
append "$(jq -nc --arg ep 'POST .../classify' --arg sc "$HTTP_CODE" --argjson exp 403 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"forbidden_wrong_tenant",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

CLASSIFY_OWN="$BASE/tenants/$TENANT_FIRST/journal/classify"
curl_json -X POST "$CLASSIFY_OWN" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"date":"2026-05-01","amount":0,"counterparty":"Vendor","memo":"Memo text"}'
append "$(jq -nc --arg ep 'POST .../classify' --arg sc "$HTTP_CODE" --argjson exp 422 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"amount_zero",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

curl_json -X POST "$CLASSIFY_OWN" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"date":"2026-05-07","amount":15000,"counterparty":"Coffee Shop Inc","memo":"Office supplies purchase"}'
append "$(jq -nc --arg ep 'POST .../classify' --arg sc "$HTTP_CODE" --argjson exp 201 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"valid_classify",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"
CLASSIFY_OK_BODY="$RESP_BODY"

ENTRIES_URL="$BASE/tenants/$TENANT_FIRST/journal/entries"
curl_json -X POST "$ENTRIES_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"entryDate":"2026-05-02","description":"unbal","lines":[{"lineNo":1,"accountCode":"1002","debit":100,"credit":0},{"lineNo":2,"accountCode":"2201","debit":0,"credit":50}]}'
append "$(jq -nc --arg ep 'POST .../entries' --arg sc "$HTTP_CODE" --argjson exp 422 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"unbalanced",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

curl_json -X POST "$ENTRIES_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"entryDate":"2026-05-02","lines":[{"lineNo":1,"accountCode":"1002","debit":10000,"credit":0},{"lineNo":2,"accountCode":"2201","debit":0,"credit":10000}]}'
append "$(jq -nc --arg ep 'POST .../entries' --arg sc "$HTTP_CODE" --argjson exp 201 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"valid_manual_entry",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

ENTRIES_FAKE="$BASE/tenants/$FAKE_TENANT/journal/entries"
curl_json -X POST "$ENTRIES_FAKE" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"entryDate":"2026-05-03","lines":[{"lineNo":1,"accountCode":"1002","debit":1,"credit":0},{"lineNo":2,"accountCode":"2201","debit":0,"credit":1}]}'
append "$(jq -nc --arg ep 'POST .../entries' --arg sc "$HTTP_CODE" --argjson exp 403 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"entries_wrong_tenant",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

curl_json -X POST "$ENTRIES_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"entryDate":"2026-05-03","lines":[{"lineNo":1,"accountCode":"1002","debit":1,"credit":0}]}'
append "$(jq -nc --arg ep 'POST .../entries' --arg sc "$HTTP_CODE" --argjson exp 422 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"too_few_lines",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==$exp)}')"

curl_json -X POST "$ENTRIES_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"entryDate":"2026-05-03","lines":[{"lineNo":1,"accountCode":"1002","debit":100,"credit":100},{"lineNo":2,"accountCode":"2201","debit":0,"credit":0}]}'
append "$(jq -nc --arg ep 'POST .../entries' --arg sc "$HTTP_CODE" --argjson exp 500 --arg body "$RESP_BODY" \
  '{endpoint:$ep,scenario:"line_debit_and_credit_same_side",expectHttp:$exp,http:($sc|tonumber),body:$body,pass:(($sc|tonumber)==500)}')"

printf '{"primaryTenantId":"%s","classifyBody":%s}\n' "$TENANT_FIRST" "$(printf '%s' "$CLASSIFY_OK_BODY" | jq -c .)" >"$(dirname "$OUT")/api-e2e-meta.json"
echo "$OUT"
