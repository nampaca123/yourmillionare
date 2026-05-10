#!/usr/bin/env bash
set -euo pipefail

# Copies CODEF / ECOS JSON payloads from `.env` into Secrets Manager ARNs referenced by Ym stacks.
# Required in .env: raw credentials (CODEF_CLIENT_ID/SECRET/PUBLIC_KEY, ECOS_API_KEY) and
# the Secret ARNs (CODEF_CREDENTIAL_SECRET_ARN, ECOS_CREDENTIAL_SECRET_ARN) emitted by CDK.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-${ROOT}/.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required in ${ENV_FILE}" >&2
    exit 1
  fi
}

require_var CODEF_CREDENTIAL_SECRET_ARN
require_var ECOS_CREDENTIAL_SECRET_ARN
require_var CODEF_CLIENT_ID
require_var CODEF_CLIENT_SECRET
require_var CODEF_PUBLIC_KEY
require_var ECOS_API_KEY

CODEF_CREDENTIAL_SECRET_JSON=$(jq -n \
  --arg cid "${CODEF_CLIENT_ID}" \
  --arg cs  "${CODEF_CLIENT_SECRET}" \
  --arg pk  "${CODEF_PUBLIC_KEY}" \
  '{clientId:$cid,clientSecret:$cs,publicKey:$pk}')

ECOS_CREDENTIAL_SECRET_JSON=$(jq -n --arg key "${ECOS_API_KEY}" '{apiKey:$key}')

aws secretsmanager put-secret-value \
  --secret-id "${CODEF_CREDENTIAL_SECRET_ARN}" \
  --secret-string "${CODEF_CREDENTIAL_SECRET_JSON}" >/dev/null

aws secretsmanager put-secret-value \
  --secret-id "${ECOS_CREDENTIAL_SECRET_ARN}" \
  --secret-string "${ECOS_CREDENTIAL_SECRET_JSON}" >/dev/null

echo 'Secrets synced: CODEF + ECOS credential slots'
