#!/usr/bin/env bash
set -euo pipefail

# Copies CODEF / ECOS JSON payloads from `.env` into Secrets Manager ARNs referenced by Ym stacks.

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
require_var CODEF_CREDENTIAL_SECRET_JSON
require_var ECOS_CREDENTIAL_SECRET_JSON

aws secretsmanager put-secret-value \
  --secret-id "${CODEF_CREDENTIAL_SECRET_ARN}" \
  --secret-string "${CODEF_CREDENTIAL_SECRET_JSON}" >/dev/null

aws secretsmanager put-secret-value \
  --secret-id "${ECOS_CREDENTIAL_SECRET_ARN}" \
  --secret-string "${ECOS_CREDENTIAL_SECRET_JSON}" >/dev/null

echo 'Secrets synced: CODEF + ECOS credential slots'
