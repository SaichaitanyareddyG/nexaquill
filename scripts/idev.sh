#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${ROOT_DIR}/backend"
FRONTEND_DIR="${ROOT_DIR}/frontend"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-1}"
CHECK_AZURE_HEALTH="${CHECK_AZURE_HEALTH:-1}"
RUN_OCR_WORKER="${RUN_OCR_WORKER:-1}"
AUTO_UPDATE_AZURE_PG_FIREWALL="${AUTO_UPDATE_AZURE_PG_FIREWALL:-1}"

# Default Azure PostgreSQL settings (can be overridden by user)
AZURE_PG_RESOURCE_GROUP="${AZURE_PG_RESOURCE_GROUP:-nexaquill-rg}"
AZURE_PG_SERVER_NAME="${AZURE_PG_SERVER_NAME:-nexaquill-pg}"
AZURE_PG_FIREWALL_RULE="${AZURE_PG_FIREWALL_RULE:-allow-home}"

# Default Azure Resource Group for health checks
AZURE_RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-nexaquill-rg}"

BACKEND_PID=""
FRONTEND_PID=""
WORKER_PID=""

stop_processes() {
  pkill -f "uvicorn nexaquill_api.main" >/dev/null 2>&1 || true
  pkill -f "nexaquill_api.worker" >/dev/null 2>&1 || true
  pkill -f "next dev" >/dev/null 2>&1 || true
}

kill_listeners_on_port() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  local pids=""
  pids="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -z "${pids}" ]]; then
    return 0
  fi
  echo "[idev] stopping processes listening on :${port} (${pids})..."
  # shellcheck disable=SC2086
  kill ${pids} >/dev/null 2>&1 || true
}

cleanup() {
  if [[ -n "${BACKEND_PID}" ]]; then
    kill "${BACKEND_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WORKER_PID}" ]]; then
    kill "${WORKER_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${FRONTEND_PID}" ]]; then
    kill "${FRONTEND_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

check_backend_env() {
  local env_file="${BACKEND_DIR}/.env"
  local missing=()
  if [[ ! -f "${env_file}" ]]; then
    echo "[idev] ERROR: ${env_file} not found. Copy backend/.env.example and populate secrets." >&2
    exit 1
  fi

  local keys=(
    "DATABASE_URL"
    "AUTH_JWT_SECRET"
    "AZURE_OPENAI_API_KEY"
    "AZURE_OPENAI_ENDPOINT"
    "AZURE_OPENAI_DEPLOYMENT_CHAT"
    "AZURE_OPENAI_DEPLOYMENT_SUGGEST"
    "AZURE_OPENAI_DEPLOYMENT_EMBEDDING"
    "AZURE_OPENAI_REALTIME_MODEL"
    "AZURE_OPENAI_REALTIME_SESSIONS_URL"
    "AZURE_STORAGE_ACCOUNT_NAME"
    "AZURE_STORAGE_ACCOUNT_KEY"
    "AZURE_STORAGE_CONTAINER"
    "AZURE_FORM_RECOGNIZER_ENDPOINT"
    "AZURE_FORM_RECOGNIZER_KEY"
    "CORS_ALLOW_ORIGINS"
  )

  for key in "${keys[@]}"; do
    if ! grep -q "^${key}=" "${env_file}"; then
      missing+=("${key}")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "[idev] WARNING: missing keys in backend/.env:"
    printf '  - %s\n' "${missing[@]}"
  fi
}

load_env() {
  if [[ -f "${BACKEND_DIR}/.env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${BACKEND_DIR}/.env"
    set +a
  fi
}

maybe_update_pg_firewall() {
  if [[ "${AUTO_UPDATE_AZURE_PG_FIREWALL}" != "1" ]]; then
    return 0
  fi
  if ! command -v az >/dev/null 2>&1; then
    echo "[idev] AUTO_UPDATE_AZURE_PG_FIREWALL=1 but Azure CLI not found; skipping."
    return 0
  fi
  if ! az account show >/dev/null 2>&1; then
    echo "[idev] AUTO_UPDATE_AZURE_PG_FIREWALL=1 but Azure CLI is not logged in; skipping."
    return 0
  fi
  local rg="${AZURE_PG_RESOURCE_GROUP:-}"
  local server="${AZURE_PG_SERVER_NAME:-}"
  local rule="${AZURE_PG_FIREWALL_RULE:-allow-home}"
  if [[ -z "${rg}" || -z "${server}" ]]; then
    echo "[idev] AZURE_PG_RESOURCE_GROUP/AZURE_PG_SERVER_NAME not set; skipping firewall update."
    return 0
  fi
  local ip=""
  ip="$(curl -4 -s ifconfig.me || true)"
  if [[ ! "${ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    echo "[idev] Unable to determine IPv4 address; got '${ip}'."
    return 0
  fi
  echo "[idev] updating Azure Postgres firewall rule '${rule}' on '${server}' to ${ip}..."
  az postgres flexible-server firewall-rule update \
    --resource-group "${rg}" \
    --name "${server}" \
    --rule-name "${rule}" \
    --start-ip-address "${ip}" \
    --end-ip-address "${ip}" >/dev/null 2>&1 || \
  az postgres flexible-server firewall-rule create \
    --resource-group "${rg}" \
    --name "${server}" \
    --rule-name "${rule}" \
    --start-ip-address "${ip}" \
    --end-ip-address "${ip}" >/dev/null
}

check_azure_health() {
  if [[ "${CHECK_AZURE_HEALTH}" != "1" ]]; then
    return 0
  fi
  if ! command -v az >/dev/null 2>&1; then
    echo "[idev] CHECK_AZURE_HEALTH=1 but Azure CLI not found; skipping."
    return 0
  fi

  local rg="${AZURE_RESOURCE_GROUP:-nexaquill-rg}"
  echo "[idev] checking Azure resource health in ${rg}..."
  az group show -n "${rg}" --query "{name:name,location:location,provisioningState:properties.provisioningState}" -o table || true
  az cognitiveservices account list -g "${rg}" --query "[].{name:name,kind:kind,location:location,sku:sku.name}" -o table || true

  if [[ -n "${AZURE_STORAGE_ACCOUNT_NAME:-}" ]]; then
    az storage account show -g "${rg}" -n "${AZURE_STORAGE_ACCOUNT_NAME}" --query "{name:name,location:location,sku:sku.name,kind:kind}" -o table || true
  fi

  if [[ -n "${AZURE_PG_SERVER_NAME:-}" ]]; then
    az postgres flexible-server show -g "${rg}" -n "${AZURE_PG_SERVER_NAME}" --query "{name:name,location:location,sku:sku.name,version:version,publicNetworkAccess:network.publicNetworkAccess}" -o table || true
  fi

  if [[ -n "${AZURE_OPENAI_ACCOUNT_NAME:-}" ]]; then
    az cognitiveservices account deployment list -g "${rg}" -n "${AZURE_OPENAI_ACCOUNT_NAME}" -o table || true
  fi
}

ensure_queue() {
  if [[ "${CHECK_AZURE_HEALTH}" != "1" ]]; then
    return 0
  fi
  if ! command -v az >/dev/null 2>&1; then
    return 0
  fi
  if [[ -z "${AZURE_QUEUE_NAME:-}" ]]; then
    return 0
  fi
  if [[ -n "${AZURE_QUEUE_CONNECTION_STRING:-}" ]]; then
    az storage queue create --name "${AZURE_QUEUE_NAME}" --connection-string "${AZURE_QUEUE_CONNECTION_STRING}" -o tsv >/dev/null 2>&1 || true
    return 0
  fi
  if [[ -n "${AZURE_STORAGE_ACCOUNT_NAME:-}" && -n "${AZURE_STORAGE_ACCOUNT_KEY:-}" ]]; then
    az storage queue create \
      --name "${AZURE_QUEUE_NAME}" \
      --account-name "${AZURE_STORAGE_ACCOUNT_NAME}" \
      --account-key "${AZURE_STORAGE_ACCOUNT_KEY}" -o tsv >/dev/null 2>&1 || true
  fi
}

run_migrations() {
  if [[ "${RUN_MIGRATIONS}" != "1" ]]; then
    return 0
  fi
  echo "[idev] running database migrations..."
  (cd "${BACKEND_DIR}" && uv run alembic upgrade head)
}

wait_for_backend() {
  local url="http://127.0.0.1:${BACKEND_PORT}/healthz"
  for _ in {1..12}; do
    if curl -s "${url}" >/dev/null 2>&1; then
      echo "[idev] backend OK (${url})"
      curl -s "http://127.0.0.1:${BACKEND_PORT}/nexa/status" || true
      echo ""
      return 0
    fi
    sleep 0.5
  done
  echo "[idev] backend did not respond on ${url}"
}

stop_processes
kill_listeners_on_port "${BACKEND_PORT}"
kill_listeners_on_port "${FRONTEND_PORT}"

check_backend_env
load_env
check_azure_health
maybe_update_pg_firewall
ensure_queue
run_migrations

if lsof -Pi :"${BACKEND_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "[idev] ERROR: backend port ${BACKEND_PORT} already in use." >&2
  exit 1
fi

cd "${BACKEND_DIR}"
uv run uvicorn nexaquill_api.main:app --reload --port "${BACKEND_PORT}" &
BACKEND_PID=$!
cd "${ROOT_DIR}"

if [[ "${RUN_OCR_WORKER}" == "1" ]]; then
  echo "[idev] starting OCR worker..."
  cd "${BACKEND_DIR}"
  uv run python -m nexaquill_api.worker &
  WORKER_PID=$!
  cd "${ROOT_DIR}"
fi

wait_for_backend

echo "[idev] prepping frontend env..."
if [[ ! -f "${FRONTEND_DIR}/.env.local" ]]; then
  cp "${FRONTEND_DIR}/.env.local.example" "${FRONTEND_DIR}/.env.local"
fi
if grep -q "^NEXT_PUBLIC_BACKEND_URL=" "${FRONTEND_DIR}/.env.local"; then
  sed -i '' "s|^NEXT_PUBLIC_BACKEND_URL=.*|NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:${BACKEND_PORT}|" "${FRONTEND_DIR}/.env.local"
else
  echo "NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:${BACKEND_PORT}" >> "${FRONTEND_DIR}/.env.local"
fi

# Keep NextAuth and frontend auth mode aligned with current local ports and backend AUTH_MODE.
if grep -q "^NEXTAUTH_URL=" "${FRONTEND_DIR}/.env.local"; then
  sed -i '' "s|^NEXTAUTH_URL=.*|NEXTAUTH_URL=http://localhost:${FRONTEND_PORT}|" "${FRONTEND_DIR}/.env.local"
else
  echo "NEXTAUTH_URL=http://localhost:${FRONTEND_PORT}" >> "${FRONTEND_DIR}/.env.local"
fi

if [[ -n "${AUTH_MODE:-}" ]]; then
  if grep -q "^NEXT_PUBLIC_AUTH_MODE=" "${FRONTEND_DIR}/.env.local"; then
    sed -i '' "s|^NEXT_PUBLIC_AUTH_MODE=.*|NEXT_PUBLIC_AUTH_MODE=${AUTH_MODE}|" "${FRONTEND_DIR}/.env.local"
  else
    echo "NEXT_PUBLIC_AUTH_MODE=${AUTH_MODE}" >> "${FRONTEND_DIR}/.env.local"
  fi
fi

echo "[idev] starting frontend on ${FRONTEND_PORT}..."
cd "${FRONTEND_DIR}"
npm run dev -- --port "${FRONTEND_PORT}" &
FRONTEND_PID=$!
cd "${ROOT_DIR}"

wait "${FRONTEND_PID}"
