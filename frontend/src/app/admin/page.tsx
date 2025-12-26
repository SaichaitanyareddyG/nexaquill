"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
const TOKEN_KEY = "nexa-admin-token";

const POLL_OPTIONS = [
  { label: "5s", value: 5 },
  { label: "10s", value: 10 },
  { label: "30s", value: 30 },
  { label: "60s", value: 60 },
  { label: "Live", value: 0 },
];

const LOG_SOURCES = [
  { label: "Backend", value: "backend" },
  { label: "Frontend", value: "frontend" },
];

type LogSource = "backend" | "frontend";

type AdminUser = {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  chat_tokens_limit: number;
  chat_tokens_used: number;
  voice_tokens_limit: number;
  voice_tokens_used: number;
  tokens_reset_at?: string | null;
  created_at?: string | null;
};

type AdminLoginResponse = {
  access_token: string;
  expires_in: number;
};

type AdminLogPayload = {
  lines: string[];
  cursor: number;
  reset?: boolean;
};

const FRONTEND_POLL_FALLBACK_SECONDS = 15;

export default function AdminPage(): JSX.Element {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("pass");
  const [token, setToken] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [userForm, setUserForm] = useState({
    displayName: "",
    isAdmin: false,
    chatLimit: 10000,
    voiceLimit: 10000,
    resetChat: false,
    resetVoice: false,
  });
  const [logLines, setLogLines] = useState<Record<LogSource, string[]>>({
    backend: [],
    frontend: [],
  });
  const [logCursor, setLogCursor] = useState<Record<LogSource, number>>({
    backend: 0,
    frontend: 0,
  });
  const [pollInterval, setPollInterval] = useState(10);
  const [autoScroll, setAutoScroll] = useState(true);
  const [logError, setLogError] = useState<Record<LogSource, string | null>>({
    backend: null,
    frontend: null,
  });
  const fetchControllersRef = useRef<Record<LogSource, AbortController | null>>({
    backend: null,
    frontend: null,
  });
  const fetchInFlightRef = useRef<Record<LogSource, boolean>>({
    backend: false,
    frontend: false,
  });
  const backendLogsRef = useRef<HTMLDivElement | null>(null);
  const frontendLogsRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const frontendPollInterval = pollInterval === 0 ? FRONTEND_POLL_FALLBACK_SECONDS : pollInterval;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const saved = window.sessionStorage.getItem(TOKEN_KEY);
    if (saved) {
      setToken(saved);
    }
  }, []);

  useEffect(() => {
    if (!autoScroll) {
      return;
    }
    if (backendLogsRef.current) {
      backendLogsRef.current.scrollTop = backendLogsRef.current.scrollHeight;
    }
    if (frontendLogsRef.current) {
      frontendLogsRef.current.scrollTop = frontendLogsRef.current.scrollHeight;
    }
  }, [logLines, autoScroll]);

  const logout = useCallback(() => {
    setToken(null);
    setUsers([]);
    setSelectedUserId(null);
    setLogLines({ backend: [], frontend: [] });
    setLogCursor({ backend: 0, frontend: 0 });
    setLogError({ backend: null, frontend: null });
    setLoginError(null);
    setUserForm({
      displayName: "",
      isAdmin: false,
      chatLimit: 10000,
      voiceLimit: 10000,
      resetChat: false,
      resetVoice: false,
    });
    wsRef.current?.close();
    wsRef.current = null;
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(TOKEN_KEY);
    }
  }, []);

  useEffect(() => {
    if (!token || typeof window === "undefined") {
      return;
    }
    window.sessionStorage.setItem(TOKEN_KEY, token);
  }, [token]);

  const handleLogin = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setLoginError(null);
      try {
        const response = await fetch(`${API_BASE}/admin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        if (!response.ok) {
          throw new Error("Invalid credentials");
        }
        const data = (await response.json()) as AdminLoginResponse;
        setToken(data.access_token);
        setPassword("pass");
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : "Login failed");
      }
    },
    [username, password]
  );

  const fetchUsers = useCallback(async () => {
    if (!token) return;
    setLoadingUsers(true);
    setLoginError(null);
    try {
      const response = await fetch(`${API_BASE}/admin/users`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.status === 401) {
        logout();
        return;
      }
      if (!response.ok) {
        throw new Error("Failed to load users");
      }
      const data = (await response.json()) as AdminUser[];
      setUsers(data);
      if (selectedUserId) {
        const current = data.find((user) => user.id === selectedUserId);
        if (current) {
          setUserForm({
            displayName: current.display_name ?? "",
            isAdmin: current.is_admin,
            chatLimit: current.chat_tokens_limit,
            voiceLimit: current.voice_tokens_limit,
            resetChat: false,
            resetVoice: false,
          });
        }
      }
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Failed to load users");
    } finally {
      setLoadingUsers(false);
    }
  }, [logout, selectedUserId, token]);

  useEffect(() => {
    if (!token) return;
    void fetchUsers();
  }, [token, fetchUsers]);

  const openEditor = useCallback(
    (user: AdminUser) => {
      setSelectedUserId(user.id);
      setUserForm({
        displayName: user.display_name ?? "",
        isAdmin: user.is_admin,
        chatLimit: user.chat_tokens_limit,
        voiceLimit: user.voice_tokens_limit,
        resetChat: false,
        resetVoice: false,
      });
    },
    []
  );

  const handleUserUpdate = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!selectedUserId || !token) return;
      setUpdateBusy(true);
      try {
        const payload = {
          display_name: userForm.displayName,
          is_admin: userForm.isAdmin,
          chat_tokens_limit: userForm.chatLimit,
          voice_tokens_limit: userForm.voiceLimit,
          reset_chat_tokens: userForm.resetChat,
          reset_voice_tokens: userForm.resetVoice,
        };
        const response = await fetch(`${API_BASE}/admin/users/${selectedUserId}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (response.status === 401) {
          logout();
          return;
        }
        if (!response.ok) {
          throw new Error("Update failed");
        }
        await fetchUsers();
        setUserForm((prev) => ({ ...prev, resetChat: false, resetVoice: false }));
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : "Update failed");
      } finally {
        setUpdateBusy(false);
      }
    },
    [fetchUsers, logout, selectedUserId, token, userForm]
  );

  const fetchLogs = useCallback(
    async (source: LogSource, initial = false) => {
      if (!token) return;
      if (fetchInFlightRef.current[source]) {
        return;
      }
      fetchControllersRef.current[source]?.abort();
      const controller = new AbortController();
      fetchControllersRef.current[source] = controller;
      fetchInFlightRef.current[source] = true;
      const params = new URLSearchParams({ limit: "200", source });
      const cursor = logCursor[source];
      if (!initial && cursor && source === "backend") {
        params.set("cursor", String(cursor));
      }
      try {
        const response = await fetch(`${API_BASE}/admin/logs?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (response.status === 401) {
          logout();
          return;
        }
        if (!response.ok) {
          let detail = "Failed to load logs";
          try {
            const payload = (await response.json()) as { detail?: string };
            if (payload?.detail) {
              detail = payload.detail;
            }
          } catch {
            // ignore parse errors
          }
          throw new Error(detail);
        }
        const data = (await response.json()) as AdminLogPayload;
        setLogCursor((current) => ({
          ...current,
          [source]: source === "backend" ? data.cursor : 0,
        }));
        setLogError((current) => ({ ...current, [source]: null }));
        setLogLines((current) => {
          const existing = current[source];
          let nextLines = existing;
          if (initial || source === "frontend") {
            nextLines = data.lines;
          } else if (data.lines.length > 0) {
            nextLines = [...existing, ...data.lines];
          }
          return { ...current, [source]: nextLines };
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setLogError((current) => ({
          ...current,
          [source]: error instanceof Error ? error.message : "Failed to load logs",
        }));
      } finally {
        if (fetchControllersRef.current[source] === controller) {
          fetchControllersRef.current[source] = null;
        }
        fetchInFlightRef.current[source] = false;
      }
    },
    [logCursor, logout, token]
  );

  useEffect(() => {
    if (!token) {
      return () => undefined;
    }

    if (pollInterval === 0) {
      const url = new URL("/admin/logs/ws", API_BASE);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", token);
      url.searchParams.set("source", "backend");
      const socket = new WebSocket(url.toString());
      wsRef.current = socket;
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as AdminLogPayload;
          setLogCursor((current) => ({ ...current, backend: payload.cursor }));
          setLogError((current) => ({ ...current, backend: null }));
          setLogLines((current) => {
            if (payload.reset) {
              return { ...current, backend: payload.lines };
            }
            if (payload.lines.length === 0) {
              return current;
            }
            return { ...current, backend: [...current.backend, ...payload.lines] };
          });
        } catch (error) {
          setLogError((current) => ({
            ...current,
            backend: error instanceof Error ? error.message : "Log stream error",
          }));
        }
      };
      socket.onerror = () => setLogError((current) => ({ ...current, backend: "Log stream error" }));
      socket.onclose = () => {
        if (wsRef.current === socket) {
          wsRef.current = null;
        }
      };
      return () => {
        socket.close();
        wsRef.current = null;
      };
    }

    wsRef.current?.close();
    wsRef.current = null;

    const intervalId = window.setInterval(() => {
      void fetchLogs("backend");
    }, pollInterval * 1000);
    void fetchLogs("backend", true);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchLogs, pollInterval, token]);

  useEffect(() => {
    if (!token) {
      return () => undefined;
    }

    const intervalId = window.setInterval(() => {
      void fetchLogs("frontend");
    }, frontendPollInterval * 1000);
    void fetchLogs("frontend", true);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchLogs, frontendPollInterval, token]);

  const handleFlushBackendLogs = useCallback(async () => {
    if (!token) return;
    try {
      const params = new URLSearchParams({ source: "backend" });
      const response = await fetch(`${API_BASE}/admin/logs/flush?${params.toString()}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error("Failed to clear logs");
      }
      setLogLines((current) => ({ ...current, backend: [] }));
      setLogCursor((current) => ({ ...current, backend: 0 }));
    } catch (error) {
      setLogError((current) => ({
        ...current,
        backend: error instanceof Error ? error.message : "Failed to clear logs",
      }));
    }
  }, [token]);

  const quotaSummary = useMemo(() => {
    if (!selectedUserId) return null;
    const current = users.find((user) => user.id === selectedUserId);
    if (!current) return null;
    const chatRemaining = Math.max(0, current.chat_tokens_limit - current.chat_tokens_used);
    const voiceRemaining = Math.max(0, current.voice_tokens_limit - current.voice_tokens_used);
    return { chatRemaining, voiceRemaining };
  }, [selectedUserId, users]);

  if (!token) {
    return (
      <main className="admin-page admin-page--login">
        <section className="admin-card admin-login">
          <h1>Admin Console Access</h1>
          <p>Sign in with the bootstrap admin credentials to manage NexaQuill.</p>
          <form onSubmit={handleLogin} className="admin-form">
            <label className="admin-label">
              Username
              <input
                className="admin-input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="admin-label">
              Password
              <input
                className="admin-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {loginError && <p className="admin-error">{loginError}</p>}
            <button type="submit" className="admin-button admin-button--primary">
              Sign in
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div>
          <h1>NexaQuill Admin Console</h1>
          <p>Manage users, quotas, and monitor live system logs.</p>
        </div>
        <button type="button" className="admin-button" onClick={logout}>
          Sign out
        </button>
      </header>

      <section className="admin-card admin-section">
        <div className="admin-section__head">
          <h2>Users</h2>
          <div className="admin-actions">
            <button type="button" className="admin-button" onClick={() => void fetchUsers()} disabled={loadingUsers}>
              {loadingUsers ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        {loginError && <p className="admin-error">{loginError}</p>}
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Chat usage</th>
                <th>Voice usage</th>
                <th>Role</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const chatRemaining = Math.max(0, user.chat_tokens_limit - user.chat_tokens_used);
                const voiceRemaining = Math.max(0, user.voice_tokens_limit - user.voice_tokens_used);
                return (
                  <tr key={user.id} className={selectedUserId === user.id ? "admin-table__row--active" : undefined}>
                    <td>{user.email}</td>
                    <td>{user.display_name ?? "—"}</td>
                    <td>
                      <span className="admin-metric">{user.chat_tokens_used.toLocaleString()} used</span>
                      <span className="admin-metric admin-metric--muted">{chatRemaining.toLocaleString()} left</span>
                    </td>
                    <td>
                      <span className="admin-metric">{user.voice_tokens_used.toLocaleString()} used</span>
                      <span className="admin-metric admin-metric--muted">{voiceRemaining.toLocaleString()} left</span>
                    </td>
                    <td>{user.is_admin ? "Admin" : "Member"}</td>
                    <td>{user.created_at ? new Date(user.created_at).toLocaleString() : "—"}</td>
                    <td>
                      <button type="button" className="admin-button admin-button--ghost" onClick={() => openEditor(user)}>
                        Configure
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {selectedUserId && quotaSummary && (
          <form className="admin-form admin-form--inline" onSubmit={handleUserUpdate}>
            <h3>Update user</h3>
            <div className="admin-form__grid">
              <label className="admin-label">
                Display name
                <input
                  className="admin-input"
                  value={userForm.displayName}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, displayName: event.target.value }))}
                />
              </label>
              <label className="admin-label">
                Chat token limit
                <input
                  className="admin-input"
                  type="number"
                  min={0}
                  value={userForm.chatLimit}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, chatLimit: Number(event.target.value) }))}
                />
                <span className="admin-hint">Remaining: {quotaSummary.chatRemaining.toLocaleString()}</span>
              </label>
              <label className="admin-label">
                Voice token limit
                <input
                  className="admin-input"
                  type="number"
                  min={0}
                  value={userForm.voiceLimit}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, voiceLimit: Number(event.target.value) }))}
                />
                <span className="admin-hint">Remaining: {quotaSummary.voiceRemaining.toLocaleString()}</span>
              </label>
              <label className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={userForm.isAdmin}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, isAdmin: event.target.checked }))}
                />
                Grant admin access
              </label>
              <label className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={userForm.resetChat}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, resetChat: event.target.checked }))}
                />
                Reset chat usage
              </label>
              <label className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={userForm.resetVoice}
                  onChange={(event) => setUserForm((prev) => ({ ...prev, resetVoice: event.target.checked }))}
                />
                Reset voice usage
              </label>
            </div>
            <div className="admin-actions">
              <button type="submit" className="admin-button admin-button--primary" disabled={updateBusy}>
                {updateBusy ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="admin-card admin-section">
        <div className="admin-section__head">
          <h2>System logs</h2>
          <div className="admin-actions">
            <label className="admin-label admin-label--inline">
              Polling
              <select
                className="admin-input admin-input--select"
                value={pollInterval}
                onChange={(event) => setPollInterval(Number(event.target.value))}
              >
                {POLL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="admin-checkbox">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(event) => setAutoScroll(event.target.checked)}
              />
              Auto-scroll
            </label>
          </div>
        </div>
        {pollInterval === 0 && (
          <p className="admin-hint">Live mode applies to backend only; frontend continues polling.</p>
        )}
        <div className="admin-logs-grid">
          {LOG_SOURCES.map((option) => {
            const source = option.value as LogSource;
            const isBackend = source === "backend";
            const lines = logLines[source];
            const error = logError[source];
            const logRef = isBackend ? backendLogsRef : frontendLogsRef;
            return (
              <div key={source} className="admin-logs-panel">
                <div className="admin-logs-panel__head">
                  <h3 className="admin-logs-panel__title">{option.label}</h3>
                  <div className="admin-actions">
                    <button
                      type="button"
                      className="admin-button admin-button--ghost admin-button--compact"
                      onClick={() => setLogLines((current) => ({ ...current, [source]: [] }))}
                    >
                      Clear
                    </button>
                    {isBackend && (
                      <button
                        type="button"
                        className="admin-button admin-button--compact"
                        onClick={handleFlushBackendLogs}
                      >
                        Flush
                      </button>
                    )}
                  </div>
                </div>
                {error && <p className="admin-error">{error}</p>}
                <div className="admin-logs" ref={logRef}>
                  {lines.length === 0 ? (
                    <p className="admin-hint">Logs will appear here once activity starts.</p>
                  ) : (
                    lines.map((line, index) => (
                      <pre key={`${line}-${index}`} className="admin-log-line">
                        {line}
                      </pre>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
