"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, HTMLAttributes } from "react";
import AddCommentOutlinedIcon from "@mui/icons-material/AddCommentOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import ShareOutlinedIcon from "@mui/icons-material/ShareOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { DigitalAvatar, type DigitalAvatarMode } from "./digital-avatar";

export type VoiceIndicatorOverride = {
  mode: DigitalAvatarMode;
  title: string;
  caption: string;
  isVisible: boolean;
};

export type ConversationMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  timestamp: string;
  status?: "streaming" | "complete";
};

type AttachmentPreview = {
  id: string;
  name: string;
  size: number;
  type: string;
  previewUrl?: string | null;
};

export type AttachmentUploadStatus = AttachmentPreview & {
  status: "processing" | "complete" | "error";
  summary?: string;
};

export type ResponseSource = {
  label: string;
  url: string;
};

export type UploadCard = {
  id: string;
  name: string;
  size: number;
  status: "processing" | "ready" | "error";
  summary?: string | null;
  downloadUrl?: string | null;
};

type MarkdownCodeProps = HTMLAttributes<HTMLElement> & {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
};

type ConversationPanelProps = {
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (value: string) => Promise<void> | void;
  canSend: boolean;
  isDictating: boolean;
  onDictate: () => void | Promise<void>;
  attachments: AttachmentPreview[];
  onAttachmentRemove: (id: string) => void;
  uploadStatuses: AttachmentUploadStatus[];
  messages: ConversationMessage[];
  onFileUpload: (files: File[]) => Promise<void> | void;
  isSending: boolean;
  onNewSession: () => void;
  activeSessionTitle: string;
  voiceIndicatorOverride?: VoiceIndicatorOverride | null;
  onDownloadSession: () => void | Promise<void>;
  inlineSuggestions: string[];
  inlineSuggestionsBusy: boolean;
  onInlineSuggestionSelect: (value: string) => void;
  onExport: (format: "md" | "pdf") => void | Promise<void>;
  onShareSession?: () => void | Promise<void>;
  shareLabel?: string;
  exportBusy: boolean;
  newSessionBusy: boolean;
  responseSources: ResponseSource[];
  uploadSources: ResponseSource[];
  uploads: UploadCard[];
  onRetryUpload?: (id: string) => void | Promise<void>;
  onDeleteUpload?: (id: string) => void | Promise<void>;
  onCancelUpload?: (id: string) => void | Promise<void>;
  useWebSources: boolean;
  onToggleWebSources: (value: boolean) => void;
  isLoading?: boolean;
};

function normalizeMarkdown(raw: string): string {
  if (!raw) return raw;
  let text = raw.replace(/\r\n/g, "\n");
  text = text.replace(/([^\n])```/g, "$1\n\n```");
  text = text.replace(
    /```(python|py|javascript|js|typescript|ts|tsx|jsx|java|kotlin|scala|go|rust|csharp|cpp|c|sql|bash|sh|json|yaml|yml|html|css|xml|markdown|md)(?=[A-Za-z])/gi,
    "```$1\n"
  );
  text = text.replace(/```\s+([A-Za-z0-9+-]+)/g, "```$1\n");
  text = text.replace(/```([A-Za-z0-9+-]+)[ \t]+/g, "```$1\n");
  text = text.replace(/```(?![A-Za-z0-9+\-\n])/g, "```\n");
  const parts = text.split("```");
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) {
      const lines = parts[i]
        .split("\n")
        .filter((line) => {
          const cleaned = line.trim().toLowerCase();
          return cleaned !== "copy code";
        })
        .join("\n");
      parts[i] = lines
        .replace(/([^\n])\s*(#{2,6}\s+)/g, "$1\n\n$2")
        .replace(/\n{3,}/g, "\n\n");
    }
  }
  return parts.join("```");
}

function CodeBlock({ inline, className, children, ...props }: MarkdownCodeProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const languageMatch = /language-(\w+)/.exec(className ?? "");
  const language = languageMatch ? languageMatch[1] : "";
  
  if (inline) {
    return (
      <code className="chat-message__inline-code" {...props}>
        {children}
      </code>
    );
  }
  
  const text = String(children ?? "").trim();
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  
  return (
    <div className="chat-message__code-block">
      {language && (
        <div className="chat-message__code-header">
          <span className="chat-message__code-language">{language}</span>
        </div>
      )}
      <button 
        type="button" 
        className="chat-message__code-copy" 
        onClick={handleCopy}
        style={language ? { top: '10px' } : { top: '8px' }}
      >
        {copied ? "✓ Copied!" : "Copy code"}
      </button>
      <pre className={`chat-message__code ${language ? `chat-message__code--${language}` : ""}`}>
        <code {...props}>{children}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  code: CodeBlock,
  a({ children, ...props }) {
    return (
      <a
        {...props}
        className="chat-message__link"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  ul({ children, ...props }) {
    return (
      <ul className="chat-message__list" {...props}>
        {children}
      </ul>
    );
  },
  ol({ children, ...props }) {
    return (
      <ol className="chat-message__list chat-message__list--ordered" {...props}>
        {children}
      </ol>
    );
  },
};

export function ConversationPanel({
  input,
  onInputChange,
  onSubmit,
  canSend,
  isDictating,
  onDictate,
  attachments,
  onAttachmentRemove,
  uploadStatuses,
  messages,
  onFileUpload,
  isSending,
  onNewSession,
  activeSessionTitle,
  voiceIndicatorOverride,
  onDownloadSession,
  inlineSuggestions,
  inlineSuggestionsBusy,
  onInlineSuggestionSelect,
  onExport,
  onShareSession,
  shareLabel,
  exportBusy,
  newSessionBusy,
  responseSources,
  uploadSources,
  uploads,
  onRetryUpload,
  onDeleteUpload,
  onCancelUpload,
  useWebSources,
  onToggleWebSources,
  isLoading = false,
}: ConversationPanelProps): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const theme = useTheme();
  const isSmallScreen = useMediaQuery(theme.breakpoints.down("md"));
  const assistantStreaming = useMemo(
    () => messages.some((message) => message.role === "assistant" && message.status === "streaming"),
    [messages]
  );
  const voiceMode: DigitalAvatarMode = voiceIndicatorOverride?.mode
    ? voiceIndicatorOverride.mode
    : assistantStreaming
      ? "speaking"
      : "idle";

  const handleMobileActionChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const { value } = event.target;
    if (!value) return;

    if (value === "export:pdf") {
      if (!exportBusy) {
        void onExport("pdf");
      }
    } else if (value === "export:md") {
      if (!exportBusy) {
        void onExport("md");
      }
    } else if (value === "download:json") {
      void onDownloadSession();
    } else if (value === "share:link" && onShareSession) {
      void onShareSession();
    }

    event.target.value = "";
  };

  const MicIcon = ({ active }: { active: boolean }): JSX.Element => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={active ? "mic-icon mic-icon--active" : "mic-icon"}
    >
      <path
        d="M12 2C10.343 2 9 3.343 9 5V11C9 12.657 10.343 14 12 14C13.657 14 15 12.657 15 11V5C15 3.343 13.657 2 12 2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 11C19 14.3137 16.3137 17 13 17H11C7.68629 17 5 14.3137 5 11"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 17V21"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 21H16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );

  const handleFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      void onFileUpload(files);
    }
    event.target.value = "";
  };

  const handleCopy = async (text: string, id: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1600);
    } catch {
      // clipboard unavailable, ignore quietly
    }
  };

  useEffect(() => {
    const container = chatLogRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const lastAssistantId = useMemo(() => {
    const last = [...messages].reverse().find((message) => message.role === "assistant" && message.text.trim());
    return last?.id ?? null;
  }, [messages]);

  return (
    <article className="nexa-panel">
      <header className="panel-head">
        <Box>
          <h2>Conversation canvas</h2>
          <p>Chat, upload documents, and capture the highlights in one place.</p>
        </Box>
        <Box className="panel-head__actions">
          <Tooltip title={activeSessionTitle} arrow placement="top">
            <Chip
              label={activeSessionTitle}
              variant="outlined"
              color="primary"
              className="panel-head__session-chip"
            />
          </Tooltip>
          {!isSmallScreen && (
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Button
                variant="outlined"
                color="inherit"
                startIcon={<PictureAsPdfOutlinedIcon />}
                onClick={() => void onExport("pdf")}
                disabled={exportBusy}
              >
                {exportBusy ? "Exporting…" : "Export PDF"}
              </Button>
              <Button
                variant="outlined"
                color="inherit"
                startIcon={<DescriptionOutlinedIcon />}
                onClick={() => void onExport("md")}
                disabled={exportBusy}
              >
                {exportBusy ? "Exporting…" : "Export MD"}
              </Button>
              <Button
                variant="outlined"
                color="inherit"
                startIcon={<FileDownloadOutlinedIcon />}
                onClick={() => void onDownloadSession()}
              >
                Download JSON
              </Button>
              {onShareSession && (
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={<ShareOutlinedIcon />}
                  onClick={() => void onShareSession()}
                >
                  {shareLabel ?? "Share link"}
                </Button>
              )}
            </Stack>
          )}
          {isSmallScreen && (
            <Box className="panel-head__actions-select-wrapper">
              <select
                id="panel-head-actions-select"
                className="panel-head__actions-select"
                defaultValue=""
                aria-label="Conversation actions"
                onChange={handleMobileActionChange}
              >
                <option value="">Quick actions…</option>
                <option value="export:pdf" disabled={exportBusy}>
                  {exportBusy ? "Exporting…" : "Export PDF"}
                </option>
                <option value="export:md" disabled={exportBusy}>
                  {exportBusy ? "Exporting…" : "Export Markdown"}
                </option>
                <option value="download:json">Download JSON</option>
                {onShareSession ? (
                  <option value="share:link">{shareLabel ?? "Share link"}</option>
                ) : null}
              </select>
            </Box>
          )}
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddCommentOutlinedIcon />}
            onClick={onNewSession}
            disabled={newSessionBusy}
          >
            {newSessionBusy ? "Creating…" : "New chat"}
          </Button>
        </Box>
      </header>

      {voiceIndicatorOverride?.isVisible && (
        <div className="composer__voice-indicator">
          <div className="composer__voice-avatar" aria-hidden="true">
            <DigitalAvatar mode={voiceMode} />
          </div>
          <div className="composer__voice-copy">
            <p>{voiceIndicatorOverride.title}</p>
            <span>{voiceIndicatorOverride.caption}</span>
          </div>
          <div
            className={`composer__voice-wave ${
              voiceMode === "speaking" ? "composer__voice-wave--speaking" : "composer__voice-wave--listening"
            }`}
            aria-hidden="true"
          >
            <span />
            <span />
            <span />
            <span />
          </div>
          <span className={`composer__voice-pill ${voiceMode !== "idle" ? "composer__voice-pill--active" : ""}`}>
            {voiceMode === "speaking" ? "Speaking" : "Listening"}
          </span>
        </div>
      )}

      <div className="chat-log" ref={chatLogRef}>
        {!isLoading && messages.length <= 1 && (
          <div className="chat-empty">
            <h3>Start a focused conversation</h3>
            <p>
              Ask a question, drop a PDF/image, or record a note. NexaQuill will summarize, cite pages, and keep the
              thread organized.
            </p>
          </div>
        )}
        {!isLoading && assistantStreaming && (
          <div className="chat-log__notice">Generating response…</div>
        )}
        {isLoading && (
          <div className="chat-log__skeleton" aria-hidden="true">
            <div className="chat-skeleton chat-skeleton--assistant">
              <span className="skeleton skeleton--avatar" />
              <div className="chat-skeleton__bubble">
                <span className="skeleton skeleton--line" />
                <span className="skeleton skeleton--line skeleton--line-short" />
              </div>
            </div>
            <div className="chat-skeleton chat-skeleton--user">
              <span className="skeleton skeleton--avatar" />
              <div className="chat-skeleton__bubble">
                <span className="skeleton skeleton--line" />
                <span className="skeleton skeleton--line skeleton--line-short" />
              </div>
            </div>
          </div>
        )}
        {messages.map((message) => {
          const displayText =
            message.role === "assistant" ? normalizeMarkdown(message.text) : message.text;
          return (
            <div
              key={message.id}
              className={`chat-message chat-message--${message.role}`}
            >
              <span className="chat-message__avatar">
                {message.role === "assistant" ? "NQ" : "You"}
              </span>
              <div className="chat-message__content">
                <p className="chat-message__meta">
                  {message.role === "assistant" ? "NexaQuill" : "You"} · {message.timestamp}
                </p>
                <div
                  className={`chat-message__bubble ${
                    message.role === "assistant" ? "chat-message__bubble--assistant" : "chat-message__bubble--user"
                  }`}
                >
                  {message.role === "assistant" && displayText && (
                    <button
                      type="button"
                      className={`chat-message__copy ${copiedId === message.id ? "chat-message__copy--copied" : ""}`}
                      onClick={() => handleCopy(displayText, message.id)}
                      title="Copy response"
                    >
                      {copiedId === message.id ? "Copied" : "Copy"}
                    </button>
                  )}
                  {displayText &&
                    (message.role === "assistant" ? (
                      <div
                        className={`chat-message__text chat-message__markdown ${
                          message.status === "streaming" ? "chat-message__text--streaming" : ""
                        }`}
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {displayText}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="chat-message__text chat-message__plain">{displayText}</div>
                    ))}
                  {message.role === "assistant" &&
                    message.id === lastAssistantId &&
                    (responseSources.length > 0 || uploadSources.length > 0) && (
                    <div className="chat-message__sources" aria-label="Response sources">
                      <p className="chat-message__sources-title">Sources</p>
                      <ul className="chat-message__sources-list">
                        {responseSources.map((source) => (
                          <li key={source.url}>
                            <a className="chat-message__link" target="_blank" rel="noopener noreferrer" href={source.url}>
                              {source.label}
                            </a>
                          </li>
                        ))}
                        {uploadSources.map((source) => (
                          <li key={source.url}>
                            <a className="chat-message__link" target="_blank" rel="noopener noreferrer" href={source.url}>
                              {source.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {message.role === "assistant" && message.status === "streaming" && (
                    <span className="typing-indicator" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {uploads.length > 0 && (
          <div className="chat-upload-history">
            {uploads.map((upload) => {
              const badgeText =
                upload.status === "ready"
                  ? "Ready"
                  : upload.status === "error"
                    ? "Needs attention"
                    : "Processing";
              const cardClass =
                upload.status === "ready"
                  ? "upload-card upload-card--complete"
                  : upload.status === "error"
                    ? "upload-card upload-card--error"
                    : "upload-card upload-card--processing";
              return (
                <div key={upload.id} className={cardClass}>
                  <div className="upload-card__header">
                    <div>
                      <p className="upload-card__name">{upload.name}</p>
                      <span className="upload-card__meta">{formatBytes(upload.size)}</span>
                    </div>
                    <span
                      className={`upload-card__badge ${
                        upload.status === "ready"
                          ? "upload-card__badge--complete"
                          : upload.status === "error"
                            ? "upload-card__badge--error"
                            : ""
                      }`}
                    >
                      {badgeText}
                    </span>
                  </div>
                  <p className="upload-card__summary">
                    {upload.summary?.trim() ||
                      (upload.status === "processing"
                        ? "OCR + summarisation is running in the background."
                        : "No summary available yet.")}
                  </p>
                  <div className="upload-card__actions">
                    {upload.status === "ready" && upload.downloadUrl ? (
                      <button
                        type="button"
                        onClick={() => window.open(upload.downloadUrl ?? "#", "_blank", "noopener,noreferrer")}
                      >
                        Open file
                      </button>
                    ) : null}
                    {upload.status === "error" && onRetryUpload ? (
                      <button
                        type="button"
                        onClick={() => {
                          void onRetryUpload(upload.id);
                        }}
                      >
                        Retry processing
                      </button>
                    ) : null}
                    {onDeleteUpload ? (
                      <button
                        type="button"
                        onClick={() => {
                          void onDeleteUpload(upload.id);
                        }}
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSend) return;
          void onSubmit(input);
        }}
      >
        <div className="composer__shell">
          <textarea
            className="composer__input"
            placeholder="Ask a question, record a summary, or drop a note for later…"
            rows={1}
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void onSubmit(input);
              }
            }}
          />
          <div className="composer__actions">
            <label className="composer__toggle" title="Include web citations via Tavily (slower)">
              <input
                type="checkbox"
                checked={useWebSources}
                onChange={(event) => onToggleWebSources(event.target.checked)}
              />
              Web sources
            </label>
            <button
              type="button"
              className={`icon-btn ${isDictating ? "icon-btn--dictating" : ""}`}
              title={isDictating ? "Stop microphone" : "Dictate into composer"}
              onClick={() => {
                void onDictate();
              }}
            >
              <MicIcon active={isDictating} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Attach file"
              onClick={handleFileClick}
            >
              📎
            </button>
            <button
              type="submit"
              className={`composer__send btn btn--primary ${isSending ? "btn--loading" : ""}`}
              disabled={isSending || !canSend}
            >
              {isSending ? <span className="btn__spinner" aria-hidden="true" /> : "Send"}
            </button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          hidden
          accept="application/pdf,image/*"
          multiple
          onChange={handleFileChange}
        />
        {attachments.length > 0 && (
          <div className="composer__attachments">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="attachment-pill">
                <div className="attachment-pill__icon" aria-hidden="true">
                  {attachment.previewUrl && attachment.type.startsWith("image/") ? (
                    <Image
                      src={attachment.previewUrl}
                      alt=""
                      width={48}
                      height={48}
                      className="attachment-pill__thumb"
                      unoptimized
                    />
                  ) : (
                    <span className="attachment-pill__file-icon">
                      {attachment.type === "application/pdf" ? "PDF" : "FILE"}
                    </span>
                  )}
                </div>
                <div className="attachment-pill__meta">
                  <span className="attachment-pill__name">{attachment.name}</span>
                  <span className="attachment-pill__size">{formatBytes(attachment.size)}</span>
                </div>
                <button
                  type="button"
                  className="attachment-pill__remove"
                  onClick={() => onAttachmentRemove(attachment.id)}
                  aria-label={`Remove ${attachment.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {uploadStatuses.length > 0 && (
          <div className="composer__uploads">
            {uploadStatuses.map((upload) => (
              <div key={upload.id} className="upload-pill upload-pill--processing">
                <div className="upload-pill__meta">
                  <span className="upload-pill__name">{upload.name}</span>
                  <span className="upload-pill__status">Uploading</span>
                </div>
                {onCancelUpload && (
                  <div className="upload-pill__actions">
                    <button
                      type="button"
                      onClick={() => {
                        void onCancelUpload(upload.id);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {inlineSuggestions.length > 0 && (
          <div className="composer__autocomplete">
            {inlineSuggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="chip chip--ghost"
                onClick={() => onInlineSuggestionSelect(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </form>
    </article>
  );
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
