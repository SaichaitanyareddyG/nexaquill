# NexaQuill Backend

FastAPI service that brokers NexaQuill realtime sessions and supporting tool APIs.

## Quickstart

```bash
uv sync --extra dev
uv run uvicorn nexaquill_api.main:app --reload --port 8000
```

If you are using the Azure Queue worker for OCR, start it in another terminal:

```bash
uv run python -m nexaquill_api.worker
```

Copy `.env.example` to `.env` and populate secrets before running locally. At minimum you’ll
need an `OPENAI_API_KEY`; the other values have useful defaults for testing with OpenAI’s
realtime and responses endpoints.

## Core Responsibilities

- Session storage (Postgres).
- Upload intake (Azure Blob).
- OCR per-page extraction (Azure Document Intelligence).
- Chat + suggestions + realtime (Azure OpenAI / OpenAI fallback).
- Document Q&A with citations.
- Session cleanup (delete session + uploads).
- URL ingestion for on-demand link reading.
- Streaming responses (SSE) for faster UI updates.

## Azure resources (recommended)

Create these services in your Azure subscription:

- **Azure OpenAI** resource (deploy `gpt-4o`, `gpt-4o-mini`, `gpt-4o-realtime`).
- **Storage account** (Blob Storage) with a private container (e.g., `nexa-uploads`).
- **Azure Queue** (for OCR jobs).
- **Document Intelligence** (formerly Form Recognizer).
- **Azure Database for PostgreSQL** (flexible server).

Suggested regions: keep everything in the same region (e.g., `swedencentral`) to reduce latency.

### Storage CORS (browser uploads)

Because uploads go directly from the browser to Azure Blob Storage, the storage account must allow CORS for your
frontend origin (e.g., `http://localhost:3000`). Example:

```bash
az storage cors add \
  --services b \
  --methods GET PUT POST HEAD OPTIONS \
  --origins "http://localhost:3000" "http://127.0.0.1:3000" \
  --allowed-headers "*" \
  --exposed-headers "*" \
  --max-age 3600 \
  --account-name <storage-account>
```

## Environment configuration

Minimum Azure-backed config for the backend:

```bash
# Azure OpenAI
AZURE_OPENAI_API_KEY="..."
AZURE_OPENAI_ENDPOINT="https://<your-aoai>.openai.azure.com"
AZURE_OPENAI_API_VERSION="2025-04-01-preview"
AZURE_OPENAI_DEPLOYMENT_CHAT="gpt-4o"
AZURE_OPENAI_DEPLOYMENT_SUGGEST="gpt-4o-mini"
AZURE_OPENAI_DEPLOYMENT_EMBEDDING="text-embedding-3-small"
AZURE_OPENAI_REALTIME_MODEL="gpt-4o-realtime"
AZURE_OPENAI_REALTIME_SESSIONS_URL="https://<your-aoai>.openai.azure.com/openai/realtimeapi/sessions?api-version=2025-04-01-preview"
AZURE_OPENAI_REALTIME_WEBRTC_URL="https://<your-aoai>.openai.azure.com/openai/realtime?api-version=2025-04-01-preview"

# CORS (lock to your frontend origin)
CORS_ALLOW_ORIGINS="https://your-frontend.example.com"

# Storage
AZURE_STORAGE_ACCOUNT_URL="https://<account>.blob.core.windows.net"
AZURE_STORAGE_ACCOUNT_NAME="<account>"
AZURE_STORAGE_ACCOUNT_KEY="..."
AZURE_STORAGE_CONTAINER="nexa-uploads"

# Queue (optional but recommended)
AZURE_QUEUE_NAME="nexaquill-ocr"
AZURE_QUEUE_CONNECTION_STRING="..."

# Document Intelligence
AZURE_FORM_RECOGNIZER_ENDPOINT="https://<region>.api.cognitive.microsoft.com"
AZURE_FORM_RECOGNIZER_KEY="..."

# Database
DATABASE_URL="postgresql+psycopg://user:pass@host:5432/nexaquill"
```

## Auth (Azure Entra ID SSO)

The backend can enforce end-user login using bearer tokens from Azure Entra ID.

Set these in `backend/.env`:

```bash
# disabled | optional | required
AUTH_MODE=disabled

AZURE_AD_TENANT_ID="<tenant-id>"
AZURE_AD_CLIENT_ID="<client-id>"
# Optional; default is https://login.microsoftonline.com/<tenantId>/v2.0
AZURE_AD_ISSUER=""
```

How it works:

- Frontend (NextAuth) signs the user in and gets an Entra `id_token`.
- Frontend sends `Authorization: Bearer <id_token>` to the backend.
- Backend verifies the JWT using Entra JWKS and **auto-creates a user row** by email.

If `AUTH_MODE=required` and the header is missing/invalid, the backend returns `401`.

### Optional: Google SSO

If you enable Google sign-in in the frontend (NextAuth), also set the Google client ID in the backend so it can
validate Google `id_token`s:

```bash
GOOGLE_OAUTH_CLIENT_ID="<google-client-id>"
```

## Auth (Email + Password)

NexaQuill also supports email/password login. The backend issues a signed NexaQuill JWT which the frontend sends as:

```
Authorization: Bearer <nexaquill-jwt>
```

Environment variables (in `backend/.env`):

```bash
AUTH_JWT_SECRET="replace-me-with-a-random-string"
AUTH_JWT_TTL_SECONDS=604800
AUTH_PASSWORD_RESET_TOKEN_TTL_MINUTES=60
AUTH_PASSWORD_RESET_URL="https://your-frontend.example.com/reset-password?token={token}"
```

Endpoints:

- `POST /auth/register` → creates a user + returns a JWT
- `POST /auth/login` → returns a JWT
- `GET /auth/me` → returns the current user
- `POST /auth/forgot-password` → sends a reset link if the account exists
- `POST /auth/reset-password` → updates the password using a valid reset token

Password reset links default to `http://localhost:3000/reset-password?token={token}`. Override the link template with
`AUTH_PASSWORD_RESET_URL` (include `{token}` if you need a placeholder). Until a mail provider is wired up, reset links
are written to the API logs—replace `dispatch_reset_email` in `password_reset_service.py` when you integrate email.

### Database & migrations

1. Set `DATABASE_URL` in `backend/.env` (or export it in your shell). Any Postgres-compatible URL works, e.g. `postgresql+psycopg://user:pass@localhost:5432/nexaquill`.
2. Apply the initial schema:

```bash
cd backend
uv run alembic upgrade head
```

The latest migrations enable the `pgvector` extension for embedding search.

### Azure Postgres: enable pgvector extension

Azure Database for PostgreSQL uses an allow-list. Enable `vector` via the `azure.extensions` parameter:

```bash
az postgres flexible-server parameter set \
  --resource-group <rg> \
  --server-name <server> \
  --name azure.extensions \
  --value vector
```

3. Whenever you change the models under `src/nexaquill_api/db/models.py`, create a new migration:

```bash
uv run alembic revision --autogenerate -m "describe change"
uv run alembic upgrade head
```

The FastAPI app reads the same `DATABASE_URL` for runtime queries.

## Upload pipeline (PDF/image)

1. `POST /uploads/presign` creates an upload row and returns a SAS URL.
2. Client uploads bytes directly to Azure Blob.
3. `POST /uploads/{id}/complete` marks the upload `processing` and enqueues OCR + summarisation.
4. Run the worker (`uv run python -m nexaquill_api.worker`) to process queue jobs.
5. Upload status becomes `ready/error`, and an assistant message is appended.
6. `DELETE /uploads/{id}` removes the file + metadata if you need to discard an upload.

### Session deletion

`DELETE /sessions/{id}` removes the session, messages, upload metadata, and OCR chunks. Any upload blobs for the
session are deleted when storage is configured.

Per-page OCR text is stored in `upload_chunks` to enable file citations.
If a file fails to process, you can re-run it with `POST /uploads/{id}/reprocess`.

## Document Q&A + citations

`POST /nexa/respond` accepts `upload_ids`. The backend retrieves relevant OCR pages and inserts them as a
grounding system prompt. Responses include `sources` with a label like `filename (p2)` and a blob download URL.
The streaming variant is `POST /nexa/respond/stream` (SSE).

If the prompt contains HTTP(S) URLs, the backend fetches those pages, extracts text, and adds them as
grounding sources with URL citations.

## Admin maintenance

`POST /admin/flush` truncates the backend log file. This requires `NEXA_SERVICE_SECRET` and a header:

```
x-nexa-admin-secret: <secret>
```

Call it with curl or use `scripts/flush-logs.sh`.

Logs are written to `backend/logs/nexaquill.log`.
