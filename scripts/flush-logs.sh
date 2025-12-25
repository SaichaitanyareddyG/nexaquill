#!/usr/bin/env bash
set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:8000}"
SECRET="${NEXA_SERVICE_SECRET:-}"

if [[ -z "${SECRET}" ]]; then
  echo "NEXA_SERVICE_SECRET is not set. Export it before running."
  exit 1
fi

curl -sS -X POST "${BACKEND_URL}/admin/flush" \
  -H "x-nexa-admin-secret: ${SECRET}" | sed 's/\\\\n/\\n/g'
echo
