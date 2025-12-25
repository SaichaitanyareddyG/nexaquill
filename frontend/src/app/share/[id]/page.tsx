"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { signIn, useSession } from "next-auth/react";

type SharedMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  created_at?: string | null;
};

type SharedUpload = {
  id: string;
  filename: string;
  status: string;
  summary?: string | null;
};

type SharedSession = {
  id: string;
  title: string;
  created_at?: string | null;
  messages?: SharedMessage[];
  uploads?: SharedUpload[];
};

const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "disabled";
const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_ENABLED === "1";

export default function ShareSessionPage({ params }: { params: { id: string } }): JSX.Element {
  const { data: authSession, status: authStatus } = useSession();
  const authToken =
    typeof authSession?.apiToken === "string"
      ? authSession.apiToken
      : typeof authSession?.idToken === "string"
        ? authSession.idToken
        : null;
  const authRequired = AUTH_MODE === "required";
  const showAuthGate = authRequired && (!authToken || authStatus !== "authenticated");
  const [session, setSession] = useState<SharedSession | null>(null);
  const [downloadUrls, setDownloadUrls] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (showAuthGate) return;
    let cancelled = false;
    const fetchSession = async () => {
      setIsLoading(true);
      try {
        const resp = await fetch(`${backendBase}/sessions/${params.id}`, {
          cache: "no-store",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        });
        if (!resp.ok) {
          throw new Error(`Fetch failed (${resp.status})`);
        }
        const data = (await resp.json()) as SharedSession;
        if (!cancelled) {
          setSession(data);
        }
      } catch {
        if (!cancelled) {
          setSession(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void fetchSession();
    return () => {
      cancelled = true;
    };
  }, [authToken, params.id, showAuthGate]);

  useEffect(() => {
    if (showAuthGate) return;
    if (!session?.uploads?.length) return;
    const readyUploads = session.uploads.filter((upload) => upload.status === "ready");
    if (readyUploads.length === 0) return;
    let cancelled = false;
    const fetchDownloads = async () => {
      const entries = await Promise.all(
        readyUploads.map(async (upload) => {
          try {
            const resp = await fetch(`${backendBase}/uploads/${upload.id}/download`, {
              cache: "no-store",
              headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
            });
            if (!resp.ok) {
              return [upload.id, ""] as const;
            }
            const data = (await resp.json()) as { download_url?: string };
            return [upload.id, data.download_url ?? ""] as const;
          } catch {
            return [upload.id, ""] as const;
          }
        })
      );
      if (!cancelled) {
        setDownloadUrls((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      }
    };
    void fetchDownloads();
    return () => {
      cancelled = true;
    };
  }, [authToken, session, showAuthGate]);

  const createdLabel = useMemo(() => {
    const createdAt = session?.created_at;
    if (!createdAt) return "";
    const date = new Date(createdAt);
    return date.toLocaleString([], {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }, [session?.created_at]);

  return (
    <div className="nexa-app">
      <div className="nexa-shell">
        <header className="share-header">
          <div>
            <p className="share-title">Shared conversation</p>
            <h1>{session?.title ?? "NexaQuill session"}</h1>
            {createdLabel && <span className="share-meta">Created {createdLabel}</span>}
          </div>
          <div className="share-actions">
            <Link className="btn btn--ghost" href="/">
              Open NexaQuill
            </Link>
          </div>
        </header>

        <section className="nexa-panel share-panel">
          {showAuthGate && (
            <div className="auth-gate auth-gate--inline">
              <div className="auth-gate__card">
                <h2>Sign in to view this share link</h2>
                <p>This link requires login because NexaQuill is running with SSO enabled.</p>
                <div className="auth-gate__actions">
                  <button type="button" className="btn btn--microsoft" onClick={() => void signIn("azure-ad")}>
                    Continue with Microsoft
                  </button>
                  <button
                    type="button"
                    className="btn btn--google"
                    onClick={() => void signIn("google")}
                    disabled={!GOOGLE_ENABLED}
                    title={GOOGLE_ENABLED ? "Continue with Google" : "Google sign-in not configured"}
                  >
                    Continue with Google
                  </button>
                  {!GOOGLE_ENABLED && (
                    <span className="auth-gate__provider-note">
                      Add Google OAuth keys in <code>frontend/.env.local</code> to enable this button.
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
          {isLoading && <p className="share-status">Loading session…</p>}
          {!isLoading && !session && <p className="share-status">This share link is invalid or expired.</p>}
          {!isLoading && session && (
            <div className="chat-log">
              {(session.messages ?? []).map((message) => (
                <div key={message.id} className={`chat-message chat-message--${message.role}`}>
                  <div className="chat-message__avatar">
                    {message.role === "assistant" ? "NQ" : "You"}
                  </div>
                  <div className="chat-message__content">
                    <p className="chat-message__meta">
                      {message.role === "assistant" ? "NexaQuill" : "You"}
                    </p>
                    <div
                      className={`chat-message__bubble ${
                        message.role === "assistant" ? "chat-message__bubble--assistant" : "chat-message__bubble--user"
                      }`}
                    >
                      <div className="chat-message__text chat-message__markdown">{message.text}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {session?.uploads && session.uploads.length > 0 && (
          <section className="share-uploads">
            <h2>Uploaded files</h2>
            <div className="share-uploads__grid">
              {session.uploads.map((upload) => (
                <div key={upload.id} className="upload-card upload-card--compact">
                  <div>
                    <p className="upload-card__name">{upload.filename}</p>
                    <span className="upload-card__meta">{upload.status}</span>
                  </div>
                  <p className="upload-card__summary">
                    {upload.summary?.trim() || "No summary available yet."}
                  </p>
                  {upload.status === "ready" && downloadUrls[upload.id] ? (
                    <button
                      type="button"
                      onClick={() => window.open(downloadUrls[upload.id], "_blank", "noopener,noreferrer")}
                    >
                      Open file
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
