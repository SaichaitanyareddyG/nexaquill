# NexaQuill

NexaQuill is a multimodal assistant that blends chat, voice, and document insights into a single session. It runs a
Next.js frontend with a FastAPI backend that orchestrates Azure OpenAI, Azure Blob Storage, and Azure Document
Intelligence.

## Features

- **Realtime voice + chat** in a single session.
- **File uploads (PDF/images)** with OCR + summaries.
- **Document Q&A with citations** (page-level sources for uploads).
- **Streaming responses (SSE)** for faster perceived output.
- **Web citations** via Tavily (optional).
- **URL ingestion** (paste a link to fetch and cite content).
- **Export** summaries to Markdown/PDF and download JSON.
- **Upload lifecycle controls** (reprocess or delete files).
- **Session cleanup** (delete a session and its uploads).
- **Shareable session links** (read-only view; requires sign-in when `AUTH_MODE=required`).

## Architecture (high level)

```
Browser (Next.js)
  ├─ /sessions, /uploads, /nexa/respond
  └─ Sources UI (web + file citations)
            │
            ▼
FastAPI (backend)
  ├─ Azure OpenAI (chat, suggestions, realtime)
  ├─ URL fetch + caching (link citations)
  ├─ Tavily / Bing / Wikipedia (web grounding)
  ├─ Azure Blob Storage (uploads, exports)
  └─ Azure Document Intelligence (OCR per page)
            │
            ▼
Postgres + pgvector (sessions, messages, uploads, chunks + embeddings)
            │
            ▼
Azure Queue + Worker (OCR/embedding jobs)
```

## Getting Started

```bash
cd nexaquill
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local

# Optional: auto-update Azure Postgres firewall on dev start
export AUTO_UPDATE_AZURE_PG_FIREWALL=1
export AZURE_PG_RESOURCE_GROUP=nexaquill-rg
export AZURE_PG_SERVER_NAME=nexaquill-pg

# Optional: run the OCR worker alongside the API
export RUN_OCR_WORKER=1

# Optional: run migrations + Azure health checks on dev start
export RUN_MIGRATIONS=1
export CHECK_AZURE_HEALTH=1
export AZURE_RESOURCE_GROUP=nexaquill-rg

./scripts/dev.sh
```

## SSO Login (Azure Entra ID)

NexaQuill supports optional/required SSO via Azure Entra ID:

- **Frontend**: NextAuth handles the sign-in flow.
- **Backend**: verifies the bearer token (Entra `id_token`) and **auto-creates a user** on first login.

### 1) Create an App Registration

Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**

Add Redirect URIs:

- Local: `http://localhost:3000/api/auth/callback/azure-ad`
- Prod: `https://<your-domain>/api/auth/callback/azure-ad`

Create a **Client Secret** and copy:

- Tenant ID
- Client ID
- Client Secret

### 2) Configure frontend env

Edit `frontend/.env.local`:

```bash
NEXT_PUBLIC_AUTH_MODE=required
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=replace-me-with-a-random-string

AZURE_AD_TENANT_ID="<tenant-id>"
AZURE_AD_CLIENT_ID="<client-id>"
AZURE_AD_CLIENT_SECRET="<client-secret>"
```

### 3) Configure backend env

Edit `backend/.env`:

```bash
AUTH_MODE=required
AZURE_AD_TENANT_ID="<tenant-id>"
AZURE_AD_CLIENT_ID="<client-id>"
AZURE_AD_ISSUER="" # optional
```

Restart `./scripts/dev.sh`, click **Sign in**, and NexaQuill will create your user row automatically.

### Optional: Google Sign-In

NexaQuill can also support Google OAuth via NextAuth.

1) Create a Google OAuth client (Google Cloud Console) with redirect URIs:

- Local: `http://localhost:3000/api/auth/callback/google`
- Prod: `https://<your-domain>/api/auth/callback/google`

2) Set `frontend/.env.local`:

```bash
NEXT_PUBLIC_GOOGLE_ENABLED=1
GOOGLE_CLIENT_ID="<google-client-id>"
GOOGLE_CLIENT_SECRET="<google-client-secret>"
```

3) Set `backend/.env`:

```bash
GOOGLE_OAUTH_CLIENT_ID="<google-client-id>"
```

## Email + Password Login

NexaQuill can also authenticate users with an email + password.

How it works:

- Frontend uses NextAuth **Credentials** provider.
- Backend issues a NexaQuill **JWT** (signed with `AUTH_JWT_SECRET`).
- Passwords are stored in Postgres as **hashed** values (never plaintext).

### 1) Configure backend env

Edit `backend/.env`:

```bash
AUTH_JWT_SECRET="replace-me-with-a-random-string"
AUTH_JWT_TTL_SECONDS=604800
```

### 2) Use the login screen

Restart `./scripts/dev.sh`, then use the **Create account** tab on the sign-in screen.

## Docker (local)

Use `docker-compose.yml` for a “prod-like” local run:

```bash
cd nexaquill
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
docker compose up --build
```

Open:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000/healthz`

## Azure Configuration (production or cloud-backed dev)

You can run the full stack on Azure-backed services. These are the resources NexaQuill expects:

- **Azure OpenAI** (chat, suggestions, realtime)
- **Azure Blob Storage** (uploads + exports)
- **Azure Queue** (OCR processing worker)
- **Azure Document Intelligence** (OCR for PDFs/images)
- **Azure Database for PostgreSQL** (sessions, messages, uploads, OCR chunks)

Required backend `.env` fields (example values are placeholders):

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

Tip: keep all Azure resources in the same region to reduce latency.

### Storage CORS (required for browser uploads)

Uploads go directly from the browser to Azure Blob Storage, so CORS must allow your frontend origin.

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

## Maintenance

- **Run migrations:** `cd backend && uv run alembic upgrade head`
- **Flush backend logs:** run `./scripts/flush-logs.sh` or call `POST /admin/flush` (requires `NEXA_SERVICE_SECRET`).

## Repo Layout

- `backend/` – FastAPI API + integrations + DB models/migrations.
- `frontend/` – Next.js UI.
- `scripts/` – dev helpers.

See `backend/README.md` and `frontend/README.md` for details.
