# NexaQuill Frontend

Next.js UI for NexaQuill. The interface mirrors modern AI chat apps with voice, uploads, citations, and exports.

## Quickstart

```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev -- --port 3000
```

Ensure `NEXT_PUBLIC_BACKEND_URL` points to the FastAPI backend (e.g. `http://127.0.0.1:8000`).

## SSO Login (Azure Entra ID)

The UI supports sign-in via NextAuth. When enabled, the app sends an Entra `id_token` to the backend as a bearer token.

1) Create an App Registration in Azure Entra ID and add redirect URIs:

- Local: `http://localhost:3000/api/auth/callback/azure-ad`
- Prod: `https://<your-domain>/api/auth/callback/azure-ad`

2) Set `frontend/.env.local`:

```bash
NEXT_PUBLIC_AUTH_MODE=required
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=replace-me-with-a-random-string

AZURE_AD_TENANT_ID="<tenant-id>"
AZURE_AD_CLIENT_ID="<client-id>"
AZURE_AD_CLIENT_SECRET="<client-secret>"
```

3) Set `backend/.env`:

```bash
AUTH_MODE=required
AZURE_AD_TENANT_ID="<tenant-id>"
AZURE_AD_CLIENT_ID="<client-id>"
```

Restart `./scripts/dev.sh` and click **Sign in** in the header.

### Optional: Google Sign-In

1) Create a Google OAuth client and add redirect URIs:

- Local: `http://localhost:3000/api/auth/callback/google`
- Prod: `https://<your-domain>/api/auth/callback/google`

2) Set `frontend/.env.local`:

```bash
NEXT_PUBLIC_GOOGLE_ENABLED=1
GOOGLE_CLIENT_ID="<google-client-id>"
GOOGLE_CLIENT_SECRET="<google-client-secret>"
```

## Email + Password Login

Email/password auth uses NextAuth **Credentials** provider and a NexaQuill-issued JWT from the backend.

1) Set `backend/.env`:

```bash
AUTH_JWT_SECRET="replace-me-with-a-random-string"
AUTH_JWT_TTL_SECONDS=604800
```

2) Restart `./scripts/dev.sh`, then use the **Create account** tab on the sign-in screen.

## Azure-backed usage

The frontend only needs the backend URL. All Azure keys live in `backend/.env`. Make sure:

- Backend is configured with Azure OpenAI + Storage + Document Intelligence.
- `NEXT_PUBLIC_BACKEND_URL` matches the backend port you started.

## UX Highlights

- **Chat + voice** in the same session by default.
- **Uploads** show processing state, summary, and retry action when needed.
- **Sources panel** includes web citations and file page citations.
- **Streaming responses (SSE)** for faster perceived answers.
- **Exports**: JSON download + Markdown/PDF share links.
- **Session deletion** removes chats and associated uploads.
- **Share links** for read-only session views.
- **Skeleton loading** while sessions hydrate.
- **Guided tour** introduces key workflows the first time a user signs in.

## Admin dashboard & quotas

- Visit `/admin` to open the admin console. Sign in with the credentials defined by `ADMIN_USERNAME` / `ADMIN_PASSWORD` in the backend.
- The dashboard lets you search users, toggle `is_admin`, adjust chat/voice token limits, and reset usage counters inline.
- A live log viewer can stream from `WS /admin/logs/ws` or fall back to polling `GET /admin/logs` if websockets are blocked.
- Quota warnings from the backend surface as banners inside the main chat view; users see the remaining budget or next steps whenever a `429` response or SSE quota event arrives.
- Clearing or creating a new session automatically dismisses old quota notices so conversations begin with a clean slate.

## Key Files

- `src/app/page.tsx` — main orchestration (sessions, uploads, exports, web toggle).
- `src/components/conversation-panel.tsx` — chat UI + composer.
- `src/components/control-sidebar.tsx` — sessions + maintenance actions.
- `src/app/globals.css` — visual styling.
