"use client";

import { useEffect, useMemo, useState } from "react";
import type { DigitalAvatarMode } from "./digital-avatar";
import { DigitalAvatar } from "./digital-avatar";
import type { JSX } from "react";

type SidebarSession = {
  id: string;
  title: string;
  createdAtLabel: string;
  lastSnippet: string | null;
};

type ControlSidebarProps = {
  sessions: SidebarSession[];
  activeSessionId: string;
  onSessionSelect: (id: string) => void;
  onRenameSession?: (id: string, title: string) => void;
  onDeleteSession?: (id: string) => void | Promise<void>;
  sessionTurns: number;
  tokenEstimate: number;
  isVoiceActive: boolean;
  isVoiceMuted: boolean;
  onToggleVoice: () => void | Promise<void>;
  onStopVoice?: () => void | Promise<void>;
  isLoading?: boolean;
};

export function ControlSidebar({
  sessions,
  activeSessionId,
  onSessionSelect,
  onRenameSession,
  onDeleteSession,
  sessionTurns,
  tokenEstimate,
  isVoiceActive,
  isVoiceMuted,
  onToggleVoice,
  onStopVoice,
  isLoading = false,
}: ControlSidebarProps): JSX.Element {
  const [draftTitle, setDraftTitle] = useState<string>("");
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [sessions, activeSessionId]
  );

  useEffect(() => {
    if (activeSession) {
      setDraftTitle(activeSession.title);
    }
  }, [activeSession]);

  const handleTitleBlur = () => {
    if (!activeSession || !onRenameSession) return;
    const trimmed = draftTitle.trim() || activeSession.title;
    onRenameSession(activeSession.id, trimmed);
    setDraftTitle(trimmed);
  };

  const handleDelete = () => {
    if (!activeSession || !onDeleteSession) return;
    const confirmed = window.confirm(
      `Delete "${activeSession.title}"? This removes its messages and uploaded files.`
    );
    if (!confirmed) return;
    void onDeleteSession(activeSession.id);
  };

  const skeletonRows = Array.from({ length: 4 }, (_, index) => (
    <li key={`session-skeleton-${index}`} className="session-history__item session-history__item--skeleton">
      <div className="session-history__skeleton">
        <span className="skeleton skeleton--title" />
        <span className="skeleton skeleton--meta" />
        <span className="skeleton skeleton--line" />
      </div>
    </li>
  ));

  return (
    <aside className="control-sidebar">
      <div className="control-card">
        <p className="control-label">Sessions</p>
        <p className="control-desc">
          Keep quick access to recent chats. Switching will restore the conversation instantly.
        </p>

        <select
          className="session-picker"
          value={activeSessionId}
          onChange={(event) => onSessionSelect(event.target.value)}
          disabled={isLoading}
        >
          {isLoading
            ? [<option key="loading">Loading sessions…</option>]
            : sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
        </select>

        <label className="session-rename">
          <span>Rename session</span>
          <input
            type="text"
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={handleTitleBlur}
            disabled={isLoading}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleTitleBlur();
              }
            }}
            placeholder="Session title"
          />
        </label>

        {onDeleteSession && (
          <button
            type="button"
            className="btn btn--danger session-delete"
            onClick={handleDelete}
            disabled={isLoading || !activeSession}
          >
            Delete session
          </button>
        )}

        <ul className="session-history">
          {isLoading
            ? skeletonRows
            : sessions.map((session) => (
                <li
                  key={session.id}
                  className={`session-history__item ${
                    session.id === activeSessionId ? "session-history__item--active" : ""
                  }`}
                >
                  <button type="button" onClick={() => onSessionSelect(session.id)}>
                    <span className="session-history__title">{session.title}</span>
                    <span className="session-history__timestamp">{session.createdAtLabel}</span>
                    {session.lastSnippet && (
                      <span className="session-history__snippet">{session.lastSnippet}</span>
                    )}
                  </button>
                </li>
              ))}
          {!isLoading && sessions.length === 0 && (
            <li className="session-history__empty">No sessions yet. Start a new chat.</li>
          )}
        </ul>

        <div className="session-stats">
          {isLoading ? (
            <>
              <span className="skeleton skeleton--pill" />
              <span className="skeleton skeleton--pill" />
            </>
          ) : (
            <>
              <span>{sessionTurns} turns tracked</span>
              <span>≈{tokenEstimate} tokens</span>
            </>
          )}
        </div>
      </div>

      <div className={`voice-card voice-card--sidebar ${isVoiceActive ? "voice-card--active" : ""}`}>
        <VoiceAvatar active={isVoiceActive} muted={isVoiceMuted} />
        <div className="voice-card__summary">
          <p className="voice-card__title">Voice mode</p>
          <span className={`voice-card__badge ${isVoiceActive ? "voice-card__badge--on" : ""}`}>
            {isVoiceActive ? (isVoiceMuted ? "Muted" : "Live") : "Idle"}
          </span>
        </div>
        <div className="voice-card__actions">
          <button
            type="button"
            className={`btn ${isVoiceActive ? "btn--ghost" : "btn--primary"}`}
            onClick={() => {
              void onToggleVoice();
            }}
          >
            {isVoiceActive ? (isVoiceMuted ? "Unmute mic" : "Mute mic") : "Enable voice"}
          </button>
          {isVoiceActive && onStopVoice && (
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                void onStopVoice();
              }}
            >
              End voice
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function VoiceAvatar({ active, muted }: { active: boolean; muted: boolean }): JSX.Element {
  const [mode, setMode] = useState<DigitalAvatarMode>("idle");

  useEffect(() => {
    if (!active || muted) {
      setMode("idle");
      return;
    }

    setMode("listening");
    const interval = window.setInterval(() => {
      setMode((prev) => (prev === "listening" ? "speaking" : "listening"));
    }, 1700);

    return () => {
      window.clearInterval(interval);
    };
  }, [active, muted]);

  return (
    <div className="voice-avatar-container">
      <DigitalAvatar mode={mode} />
    </div>
  );
}
