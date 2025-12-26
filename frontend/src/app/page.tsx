"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HeroSection } from "@/components/hero-section";
import {
  ConversationPanel,
  ConversationMessage,
  type VoiceIndicatorOverride,
  type AttachmentUploadStatus,
  type ResponseSource,
} from "@/components/conversation-panel";
import { ControlSidebar } from "@/components/control-sidebar";
import { GuidedTour } from "@/components/guided-tour";
import {
  RealtimeVoiceSession,
  type VoiceSessionState,
} from "@/lib/realtime-voice-session";
import { signIn, signOut, useSession } from "next-auth/react";

const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "disabled";
const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_ENABLED === "1";

type UploadRecord = {
  id: string;
  sessionId: string;
  filename: string;
  mimeType: string | null;
  fileSize: number;
  status: "pending" | "processing" | "ready" | "error";
  summary?: string | null;
  blobPath: string;
  createdAt?: string;
  updatedAt?: string;
};

type Session = {
  id: string;
  title: string;
  createdAt: string;
  messages: ConversationMessage[];
  suggestions: string[];
  uploads: UploadRecord[];
};

type QuotaInfo = {
  limit?: number;
  used?: number;
};

type RespondResult =
  | { ok: true; reply: string; sources: ResponseSource[]; quota?: QuotaInfo }
  | { ok: false; status: number; message: string; quota?: QuotaInfo };

type DraftMessage = Omit<ConversationMessage, "id"> & { id?: string };

type PendingAttachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  file: File;
  previewUrl?: string | null;
};

type ProcessedUploadResult = {
  session: Session | null;
  uploads: UploadRecord[];
};

const starterSuggestions = [
  "Summarise today’s focus areas",
  "Review upcoming reminders",
  "Draft a quick wellness check-in",
];

const guidedTourSteps = [
  {
    title: "Welcome to NexaQuill",
    body: "This workspace blends chat, voice, and document insights so you can move from idea to output without swapping tools.",
  },
  {
    title: "Bring context with uploads",
    body: "Drop PDFs or images into the composer. Nexa summarises them, cites sources, and lets you keep everything in one conversation.",
  },
  {
    title: "Stay in control",
    body: "Track usage, export notes, and jump into the admin console whenever you need to adjust quotas or review activity.",
    cta: "Let's go",
  },
];

const guidedTourStorageKey = "nexa-guided-tour:v1";

const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

function bearerHeaders(token?: string | null): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export default function HomePage(): JSX.Element {
  const initialSessions = useMemo<Session[]>(() => {
    const now = new Date();
    return [
      {
        id: crypto.randomUUID(),
        title: "Session 1",
        createdAt: now.toISOString(),
        messages: [
          {
            id: "assistant-welcome",
            role: "assistant",
            text:
              "Good morning! Ask a question, upload a document, or start dictation whenever you’re ready.",
            timestamp: formatTimestamp(now),
            status: "complete",
          },
        ],
        suggestions: starterSuggestions,
        uploads: [],
      },
    ];
  }, []);
  const { data: authSession, status: authStatus } = useSession();
  const resolvedUserName = useMemo(() => authSession?.user?.name?.trim() ?? "", [authSession?.user?.name]);
  const voiceParticipantName = resolvedUserName || "NexaQuill guest";
  const welcomeName = useMemo(() => {
    if (!resolvedUserName) return "there";
    const [first] = resolvedUserName.split(" ").filter(Boolean);
    return first || "there";
  }, [resolvedUserName]);
  const defaultWelcomeMessage = useMemo(() => buildVoiceGreeting(welcomeName), [welcomeName]);
  const authToken =
    typeof authSession?.apiToken === "string"
      ? authSession.apiToken
      : typeof authSession?.idToken === "string"
        ? authSession.idToken
        : null;
  const authRequired = AUTH_MODE === "required";
  const hasAuthToken = Boolean(authToken);
  const canUseApi = !authRequired || (authStatus === "authenticated" && hasAuthToken);
  const authHeaders = useMemo<Record<string, string>>(() => bearerHeaders(authToken), [authToken]);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  const [signUpDisplayName, setSignUpDisplayName] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [passwordResetBusy, setPasswordResetBusy] = useState(false);
  const [sessions, setSessions] = useState<Session[]>(initialSessions);
  const [activeSessionId, setActiveSessionId] = useState<string>(initialSessions[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [isDictating, setIsDictating] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isVoiceMuted, setIsVoiceMuted] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [uploadStatuses, setUploadStatuses] = useState<AttachmentUploadStatus[]>([]);
  const [uploadCount, setUploadCount] = useState(0);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [inlineSuggestions, setInlineSuggestions] = useState<string[]>([]);
  const [inlineSuggestionsBusy, setInlineSuggestionsBusy] = useState(false);
  const [systemStatus, setSystemStatus] = useState<{ realtime: boolean; suggestions: boolean; respond: boolean }>({
    realtime: false,
    suggestions: false,
    respond: false,
  });
  const [isSending, setIsSending] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [downloadUrls, setDownloadUrls] = useState<Record<string, string>>({});
  const [webSources, setWebSources] = useState<ResponseSource[]>([]);
  const [useWebSources, setUseWebSources] = useState(false);
  const [isHydratingSessions, setIsHydratingSessions] = useState(true);
  const [shareLabel, setShareLabel] = useState("Share link");
  const [quotaNotice, setQuotaNotice] = useState<string | null>(null);
  const [showGuidedTour, setShowGuidedTour] = useState(false);
  const [guidedTourStepIndex, setGuidedTourStepIndex] = useState(0);
  const typingTimers = useRef<number[]>([]);
  const userTouchedSessionsRef = useRef(false);
  const hasHydratedSessionsRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const dictationShouldResumeRef = useRef(false);
  const voiceSessionRef = useRef<RealtimeVoiceSession | null>(null);
  const voiceSilenceTimerRef = useRef<number | null>(null);
  const voiceAutoStartRef = useRef(false);
  const voiceGreetingSentRef = useRef(false);
  const uploadControllersRef = useRef<Map<string, AbortController>>(new Map());
  const uploadIdByClientIdRef = useRef<Map<string, string>>(new Map());
  const [voiceSessionState, setVoiceSessionState] = useState<VoiceSessionState>("idle");
  const [voiceStreamingMessageId, setVoiceStreamingMessageId] = useState<string | null>(null);
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0],
    [sessions, activeSessionId]
  );

  const messages = useMemo(() => activeSession?.messages ?? [], [activeSession]);
  const suggestions = activeSession?.suggestions ?? starterSuggestions;
  const hasProcessingUploads = Boolean(
    (activeSession?.uploads ?? []).some((upload) => upload.status === "processing" || upload.status === "pending")
  );
  const readyUploads = useMemo(
    () => (activeSession?.uploads ?? []).filter((upload) => upload.status === "ready"),
    [activeSession]
  );
  const uploadCards = useMemo(() => {
    if (!activeSession) return [];
    const uploads = [...(activeSession.uploads ?? [])];
    uploads.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    return uploads.map((upload) => {
      const status: "processing" | "ready" | "error" =
        upload.status === "ready" ? "ready" : upload.status === "error" ? "error" : "processing";
      return {
        id: upload.id,
        name: upload.filename,
        size: upload.fileSize,
        status,
        summary: upload.summary ?? null,
        downloadUrl: status === "ready" ? downloadUrls[upload.id] ?? null : null,
      };
    });
  }, [activeSession, downloadUrls]);
  const uploadSources = useMemo<ResponseSource[]>(() => {
    return readyUploads
      .map((upload) => ({
        label: upload.filename,
        url: downloadUrls[upload.id] ?? "",
      }))
      .filter((entry) => Boolean(entry.url));
  }, [downloadUrls, readyUploads]);
  const canSend = (input.trim().length > 0 || pendingAttachments.length > 0) && !isCreatingSession && canUseApi;
  const voiceIndicatorOverride = useMemo(() => {
    if (voiceSessionState === "idle") {
      return null;
    }
    const state = voiceSessionState;
    let title = "Listening for you";
    let caption = "Say anything anytime or hit mute.";
    let mode: VoiceIndicatorOverride["mode"] = "listening";
    if (state === "connecting") {
      title = "Connecting voice channel…";
      caption = "Authenticating with Azure Realtime.";
    } else if (state === "speaking") {
      title = "Responding with voice";
      caption = "Hold on, Nexa is finishing the answer.";
      mode = "speaking";
    }
    if (isVoiceMuted) {
      title = "Mic muted";
      caption = "Unmute to keep talking.";
      mode = "idle";
    }
    return {
      mode,
      title,
      caption,
      isVisible: true,
    } as VoiceIndicatorOverride | null;
  }, [isVoiceMuted, voiceSessionState]);

  const updateActiveSession = useCallback(
    (updater: (session: Session) => Session) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === activeSessionId ? updater(session) : session
        )
      );
    },
    [activeSessionId]
  );

  useEffect(() => {
    let cancelled = false;

    async function bootstrapSessions(): Promise<void> {
      try {
        let remoteSessions = await fetchSessionsFromBackend(authToken);
        if (!remoteSessions.length) {
          const seeded = await createSessionWithWelcome(authToken, undefined, defaultWelcomeMessage);
          remoteSessions = seeded ? [seeded] : [];
        }
        if (!cancelled && remoteSessions.length && !userTouchedSessionsRef.current) {
          setSessions(remoteSessions);
          setActiveSessionId(remoteSessions[0].id);
          hasHydratedSessionsRef.current = true;
        }
      } catch (error) {
        loggerWarn("sessions-init", error);
      } finally {
        if (!cancelled) {
          setIsHydratingSessions(false);
        }
      }
    }

    if (authStatus === "loading") {
      return () => {
        cancelled = true;
      };
    }
    if (!canUseApi) {
      setIsHydratingSessions(false);
      return () => {
        cancelled = true;
      };
    }
    if (!hasHydratedSessionsRef.current) {
      setIsHydratingSessions(true);
      void bootstrapSessions();
    }

    return () => {
      cancelled = true;
    };
  }, [authStatus, authToken, canUseApi, defaultWelcomeMessage]);

  useEffect(() => {
    if (!canUseApi) {
      setInlineSuggestions([]);
      return;
    }
    const trimmed = input.trim();
    if (!trimmed || trimmed.length < 3) {
      setInlineSuggestions([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setInlineSuggestionsBusy(true);
      try {
        const remote = await requestSuggestionsFromBackend(trimmed, authToken);
        if (!cancelled) {
          setInlineSuggestions(remote ?? []);
        }
      } catch (error) {
        if (!cancelled) {
          loggerWarn("inline-suggestions", error);
          setInlineSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setInlineSuggestionsBusy(false);
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [authToken, canUseApi, input]);

  const handleInlineSuggestionSelect = useCallback((value: string) => {
    setInput(value);
  }, []);

  const guidedTourTotal = guidedTourSteps.length;
  const currentGuidedTourStep =
    guidedTourSteps[Math.min(guidedTourStepIndex, guidedTourTotal - 1)] ?? guidedTourSteps[0];

  const completeGuidedTour = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(guidedTourStorageKey, new Date().toISOString());
    }
    setShowGuidedTour(false);
  }, []);

  const handleGuidedTourNext = useCallback(() => {
    setGuidedTourStepIndex((prev) => {
      const next = prev + 1;
      if (next >= guidedTourTotal) {
        completeGuidedTour();
        return prev;
      }
      return next;
    });
  }, [completeGuidedTour, guidedTourTotal]);

  const handleGuidedTourBack = useCallback(() => {
    setGuidedTourStepIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const handleGuidedTourSkip = useCallback(() => {
    completeGuidedTour();
  }, [completeGuidedTour]);

  useEffect(() => {
    let cancelled = false;

    async function loadStatus(): Promise<void> {
      try {
        const response = await fetch(`${backendBase}/nexa/status`);
        if (!response.ok) return;
        const data = (await response.json()) as { realtime?: boolean; suggestions?: boolean; respond?: boolean };
        if (!cancelled) {
          setSystemStatus({
            realtime: Boolean(data?.realtime),
            suggestions: Boolean(data?.suggestions),
            respond: Boolean(data?.respond),
          });
        }
      } catch (error) {
        loggerWarn("status", error);
      }
    }

    loadStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setShareLabel("Share link");
  }, [activeSessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!canUseApi || authStatus !== "authenticated") {
      setShowGuidedTour(false);
      return;
    }
    const seen = window.localStorage.getItem(guidedTourStorageKey);
    if (!seen) {
      setGuidedTourStepIndex(0);
      setShowGuidedTour(true);
    }
  }, [authStatus, canUseApi]);

  useEffect(() => {
    if (!canUseApi) return;
    const missing = readyUploads.filter((upload) => !downloadUrls[upload.id]);
    if (!missing.length) return;
    let cancelled = false;

    void (async () => {
      try {
        const entries = await Promise.all(
          missing.map(async (upload) => {
            const resp = await fetch(`${backendBase}/uploads/${upload.id}/download`, {
              cache: "no-store",
              headers: authHeaders,
            });
            if (!resp.ok) {
              throw new Error(`Download url failed (${resp.status})`);
            }
            const data = (await resp.json()) as { download_url?: unknown };
            return [upload.id, typeof data.download_url === "string" ? data.download_url : ""] as const;
          })
        );
        if (cancelled) return;
        setDownloadUrls((prev) => {
          const next = { ...prev };
          for (const [id, url] of entries) {
            if (url) next[id] = url;
          }
          return next;
        });
      } catch (error) {
        loggerWarn("download-urls", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authHeaders, canUseApi, downloadUrls, readyUploads]);

  const syncSessionFromRemote = useCallback((remote: Session | null) => {
    if (!remote) return;
    setSessions((prev) => {
      const exists = prev.some((session) => session.id === remote.id);
      if (!exists) {
        return [...prev, remote];
      }
      return prev.map((session) => {
        if (session.id !== remote.id) {
          return session;
        }
        const preserveMessages = session.id === activeSessionId ? session.messages : remote.messages;
        return {
          ...session,
          title: remote.title,
          createdAt: remote.createdAt,
          messages: preserveMessages,
          uploads: remote.uploads ?? session.uploads,
          suggestions: remote.suggestions?.length ? remote.suggestions : session.suggestions,
        };
      });
    });
  }, [activeSessionId]);

  const addMessage = useCallback(
    (message: DraftMessage) => {
      const nextMessage: ConversationMessage = {
        id: message.id ?? crypto.randomUUID(),
        status: message.status ?? "complete",
        ...message,
      };
      updateActiveSession((session) => ({
        ...session,
        messages: [...session.messages, nextMessage],
      }));
    },
    [updateActiveSession]
  );

  const processPendingUploads = useCallback(
    async (sessionId: string, attachments: PendingAttachment[]): Promise<ProcessedUploadResult | null> => {
      if (!sessionId || attachments.length === 0) {
        return null;
      }
      if (!canUseApi) {
        void signIn("azure-ad");
        return null;
      }

      const extractErrorDetail = async (response: Response): Promise<string> => {
        try {
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            const json = (await response.json()) as unknown;
            if (json && typeof json === "object") {
              const record = json as Record<string, unknown>;
              const detail = record.detail ?? record.message ?? record.error;
              if (typeof detail === "string") {
                return detail;
              }
              if (detail && typeof detail === "object") {
                const nested = detail as Record<string, unknown>;
                if (typeof nested.message === "string") return nested.message;
              }
            }
            return JSON.stringify(json);
          }
          const text = await response.text();
          return text.trim();
        } catch {
          return "";
        }
      };

      const stagedStatuses = attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        type: attachment.type,
        status: "processing" as const,
      }));
      setUploadStatuses((prev) => [...prev, ...stagedStatuses]);

      const completedUploads: UploadRecord[] = [];

      for (const attachment of attachments) {
        const controller = new AbortController();
        uploadControllersRef.current.set(attachment.id, controller);
        try {
          const presignResponse = await fetch(`${backendBase}/uploads/presign`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({
              session_id: sessionId,
              filename: attachment.name,
              mime_type: attachment.type || "application/octet-stream",
              file_size: attachment.size,
            }),
            signal: controller.signal,
          });
          if (!presignResponse.ok) {
            const detail = await extractErrorDetail(presignResponse);
            throw new Error(`Presign failed (${presignResponse.status})${detail ? `: ${detail}` : ""}`);
          }

          const presign = (await presignResponse.json()) as { upload_id: string; upload_url: string };
          uploadIdByClientIdRef.current.set(attachment.id, presign.upload_id);
          const uploadResp = await fetch(presign.upload_url, {
            method: "PUT",
            headers: {
              "x-ms-blob-type": "BlockBlob",
              "Content-Type": attachment.type || "application/octet-stream",
            },
            body: attachment.file,
            signal: controller.signal,
          });
          if (!uploadResp.ok) {
            const detail = await extractErrorDetail(uploadResp);
            throw new Error(`Blob upload failed (${uploadResp.status})${detail ? `: ${detail}` : ""}`);
          }

          const finalizeResp = await fetch(`${backendBase}/uploads/${presign.upload_id}/complete`, {
            method: "POST",
            headers: authHeaders,
          });
          if (!finalizeResp.ok) {
            const detail = await extractErrorDetail(finalizeResp);
            throw new Error(`Finalize upload failed (${finalizeResp.status})${detail ? `: ${detail}` : ""}`);
          }
          const payload = (await finalizeResp.json()) as ApiUploadResponse;
          completedUploads.push(toLocalUpload(payload));
          setUploadCount((prev) => prev + 1);
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            const uploadId = uploadIdByClientIdRef.current.get(attachment.id);
            if (uploadId) {
              fetch(`${backendBase}/uploads/${uploadId}`, { method: "DELETE", headers: authHeaders }).catch(() => null);
            }
          } else {
            loggerWarn("upload-file", error);
            const message = error instanceof Error ? error.message : String(error);
            addMessage({
              role: "assistant",
              text: `I couldn't process ${attachment.name}. ${message || "Please try again in a moment."}`,
              timestamp: formatTimestamp(new Date()),
            });
          }
        } finally {
          setUploadStatuses((prev) => prev.filter((item) => item.id !== attachment.id));
          uploadControllersRef.current.delete(attachment.id);
          uploadIdByClientIdRef.current.delete(attachment.id);
        }
      }

      const remote = await fetchSessionDetailFromBackend(sessionId, authToken);
      if (remote) {
        syncSessionFromRemote(remote);
      }
      return { session: remote, uploads: completedUploads };
    },
    [addMessage, authHeaders, authToken, canUseApi, setUploadCount, syncSessionFromRemote]
  );

  const ensureVoiceMessageId = useCallback((): string => {
    if (voiceStreamingMessageId) {
      return voiceStreamingMessageId;
    }
    const newId = crypto.randomUUID();
    setVoiceStreamingMessageId(newId);
    addMessage({
      id: newId,
      role: "assistant",
      text: "",
      timestamp: formatTimestamp(new Date()),
      status: "streaming",
    });
    return newId;
  }, [voiceStreamingMessageId, addMessage]);

  const applyVoiceDelta = useCallback(
    (delta: string) => {
      if (!delta) return;
      const targetId = ensureVoiceMessageId();
      updateActiveSession((session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === targetId
            ? {
                ...message,
                text: `${message.text ?? ""}${delta}`,
                status: "streaming",
              }
            : message
        ),
      }));
    },
    [ensureVoiceMessageId, updateActiveSession]
  );

  const finalizeVoiceMessage = useCallback(() => {
    if (!voiceStreamingMessageId) return;
    const targetId = voiceStreamingMessageId;
    const stamped = formatTimestamp(new Date());
    let finalText = "";
    updateActiveSession((session) => ({
      ...session,
      messages: session.messages.map((message) => {
        if (message.id === targetId) {
          finalText = message.text ?? "";
          return {
            ...message,
            timestamp: stamped,
            status: "complete",
          };
        }
        return message;
      }),
    }));
    setVoiceStreamingMessageId(null);
    const trimmed = finalText.trim();
    if (trimmed && activeSessionId) {
      void persistMessageToBackend(activeSessionId, "assistant", trimmed, authToken)
        .then(syncSessionFromRemote)
        .catch((error) => loggerWarn("persist-voice-assistant", error));
    }
  }, [authToken, voiceStreamingMessageId, updateActiveSession, activeSessionId, syncSessionFromRemote]);

  const clearVoiceSilenceTimer = useCallback(() => {
    if (voiceSilenceTimerRef.current) {
      window.clearTimeout(voiceSilenceTimerRef.current);
      voiceSilenceTimerRef.current = null;
    }
  }, []);

  const stopVoiceSession = useCallback(async () => {
    clearVoiceSilenceTimer();
    voiceGreetingSentRef.current = false;
    setIsVoiceMuted(false);
    const session = voiceSessionRef.current;
    if (session) {
      try {
        await session.stop();
      } catch (error) {
        loggerWarn("voice-stop", error);
      }
      voiceSessionRef.current = null;
    }
    setIsVoiceActive(false);
    setVoiceSessionState("idle");
    finalizeVoiceMessage();
  }, [clearVoiceSilenceTimer, finalizeVoiceMessage]);

  const scheduleVoiceSilenceTimeout = useCallback(() => {
    clearVoiceSilenceTimer();
    voiceSilenceTimerRef.current = window.setTimeout(() => {
      void stopVoiceSession();
    }, 2 * 60 * 1000);
  }, [clearVoiceSilenceTimer, stopVoiceSession]);

  const appendVoiceUserTranscriptRealtime = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !activeSessionId) return;
      scheduleVoiceSilenceTimeout();
      addMessage({
        role: "user",
        text: trimmed,
        timestamp: formatTimestamp(new Date()),
        status: "complete",
      });
      void persistMessageToBackend(activeSessionId, "user", trimmed, authToken)
        .then(syncSessionFromRemote)
        .catch((error) => loggerWarn("persist-voice-user", error));
    },
    [activeSessionId, addMessage, authToken, scheduleVoiceSilenceTimeout, syncSessionFromRemote]
  );

  const handleVoiceSessionError = useCallback(
    (message: string) => {
      loggerWarn("voice-session", message);
      addMessage({
        role: "assistant",
        text: message || "Voice channel hit a snag. Try enabling voice again in a moment.",
        timestamp: formatTimestamp(new Date()),
        status: "complete",
      });
    },
    [addMessage]
  );

  const startVoiceSession = useCallback(async () => {
    if (!canUseApi) {
      void signIn("azure-ad");
      return;
    }
    if (isVoiceActive) {
      return;
    }

    const session = new RealtimeVoiceSession({
      backendBase,
      authToken,
      callbacks: {
        onStateChange: setVoiceSessionState,
        onAssistantDelta: (delta) => applyVoiceDelta(delta),
        onAssistantComplete: () => finalizeVoiceMessage(),
        onUserTranscript: (text) => appendVoiceUserTranscriptRealtime(text),
        onError: (message) => {
          handleVoiceSessionError(message);
          void stopVoiceSession();
        },
      },
    });

    voiceSessionRef.current = session;
    setVoiceSessionState("connecting");
    setIsVoiceMuted(false);

    try {
      await session.start({ name: voiceParticipantName });
      setIsVoiceActive(true);
      scheduleVoiceSilenceTimeout();
      if (!voiceGreetingSentRef.current) {
        session.sendGreeting(buildVoiceGreeting(welcomeName));
        voiceGreetingSentRef.current = true;
      }
    } catch (error) {
      handleVoiceSessionError(
        error instanceof Error
          ? error.message
          : "Realtime voice failed to start. Please try again shortly."
      );
      await stopVoiceSession();
    }
  }, [
    appendVoiceUserTranscriptRealtime,
    applyVoiceDelta,
    authToken,
    canUseApi,
    finalizeVoiceMessage,
    handleVoiceSessionError,
    isVoiceActive,
    scheduleVoiceSilenceTimeout,
    stopVoiceSession,
    voiceParticipantName,
    welcomeName,
  ]);

  const toggleVoiceMute = useCallback(() => {
    const session = voiceSessionRef.current;
    if (!session) return;
    const nextMuted = !isVoiceMuted;
    session.setMuted(nextMuted);
    setIsVoiceMuted(nextMuted);
    if (!nextMuted) {
      scheduleVoiceSilenceTimeout();
    }
  }, [isVoiceMuted, scheduleVoiceSilenceTimeout]);

  const handleVoiceSessionToggle = useCallback(async () => {
    userTouchedSessionsRef.current = true;
    if (isVoiceActive) {
      toggleVoiceMute();
      return;
    }
    await startVoiceSession();
  }, [isVoiceActive, startVoiceSession, toggleVoiceMute]);

  const handleVoiceSessionStop = useCallback(async () => {
    userTouchedSessionsRef.current = true;
    await stopVoiceSession();
  }, [stopVoiceSession]);

  useEffect(() => {
    if (voiceAutoStartRef.current || isVoiceActive) {
      return;
    }
    if (!canUseApi || !systemStatus.realtime) {
      return;
    }
    voiceAutoStartRef.current = true;
    void startVoiceSession();
  }, [canUseApi, isVoiceActive, startVoiceSession, systemStatus.realtime]);

  const stopTypingAnimation = useCallback(() => {
    typingTimers.current.forEach((timer) => window.clearTimeout(timer));
    typingTimers.current = [];
  }, []);

  const typeMessage = useCallback(
    (id: string, fullText: string) => {
      stopTypingAnimation();
      updateActiveSession((session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === id
            ? {
                ...message,
                text: "",
                status: "streaming",
              }
            : message
        ),
      }));

      const characters = Array.from(fullText);
      let index = 0;

      const schedule = (callback: () => void, delay: number) => {
        const handle = window.setTimeout(callback, delay);
        typingTimers.current.push(handle);
      };

      const tick = () => {
        const step = Math.max(1, Math.round(characters.length / 90));
        index = Math.min(characters.length, index + step);
        const nextText = characters.slice(0, index).join("");

        updateActiveSession((session) => ({
          ...session,
          messages: session.messages.map((message) =>
            message.id === id
              ? {
                  ...message,
                  text: nextText,
                  status: "streaming",
                }
              : message
          ),
        }));

        if (index < characters.length) {
          const lastChar = characters[index - 1];
          const pause =
            lastChar === "." || lastChar === "?" || lastChar === "!"
              ? 140
              : lastChar === "," || lastChar === ";"
                ? 90
                : 26;
          schedule(tick, pause);
        } else {
          const stamped = formatTimestamp(new Date());
          updateActiveSession((session) => ({
            ...session,
            messages: session.messages.map((message) =>
              message.id === id
                ? {
                    ...message,
                    text: fullText,
                    timestamp: stamped,
                    status: "complete",
                  }
                : message
            ),
          }));
        }
      };

      schedule(tick, 160);
    },
    [stopTypingAnimation, updateActiveSession]
  );

  const setMessageText = useCallback(
    (id: string, text: string, status: "streaming" | "complete") => {
      updateActiveSession((session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === id
            ? {
                ...message,
                text,
                status,
              }
            : message
        ),
      }));
    },
    [updateActiveSession]
  );

  useEffect(() => {
    return () => {
      stopTypingAnimation();
    };
  }, [stopTypingAnimation]);
  const handleSubmit = useCallback(
    async (value: string) => {
      userTouchedSessionsRef.current = true;
      if (!activeSession) return;
      if (!canUseApi) {
        void signIn("azure-ad");
        return;
      }
      const trimmed = value.trim();
      const attachmentsToUpload = [...pendingAttachments];
      const hasAttachments = attachmentsToUpload.length > 0;
      if (!trimmed && !hasAttachments) return;

      const modelPrompt =
        trimmed ||
        (hasAttachments
          ? "Summarise the uploaded file(s) and highlight key points, action items, and any important dates."
          : "");
      const userPromptForTimeline = trimmed || `Uploaded: ${attachmentsToUpload.map((item) => item.name).join(", ")}`;
      const sessionId = activeSession.id;
      setIsSending(true);
      const timestamp = formatTimestamp(new Date());

      const userMessage: ConversationMessage = {
        id: crypto.randomUUID(),
        role: "user",
        text: userPromptForTimeline,
        timestamp,
        status: "complete",
      };
      const historyForModel: ConversationMessage[] = [...messages, { ...userMessage, text: modelPrompt }];

      addMessage(userMessage);
      void persistMessageToBackend(sessionId, "user", userPromptForTimeline, authToken)
        .then(syncSessionFromRemote)
        .catch((error) => loggerWarn("persist-user", error));
      setInput("");

      const fallbackSuggestions = buildFallbackSuggestions(modelPrompt);
      updateActiveSession((session) => ({
        ...session,
        suggestions: fallbackSuggestions,
      }));

      let uploadContext: string | null = null;
      const readyUploads = (activeSession.uploads ?? []).filter((upload) => upload.status === "ready");
      const citationUploadIds = new Set<string>(readyUploads.map((upload) => upload.id));
      if (readyUploads.length > 0) {
        uploadContext = buildUploadContext(readyUploads);
      }
      const placeholderId = crypto.randomUUID();
      addMessage({
        id: placeholderId,
        role: "assistant",
        text: hasAttachments ? "Uploading and processing your file(s)…" : "",
        timestamp: formatTimestamp(new Date()),
        status: "streaming",
      });
      setWebSources([]);

      try {
        let uploadedIds: string[] = [];
        if (hasAttachments) {
          // Revoke previews now that the files have been queued.
          for (const attachment of attachmentsToUpload) {
            if (attachment.previewUrl) {
              URL.revokeObjectURL(attachment.previewUrl);
            }
          }
          setPendingAttachments([]);
          const uploadResult = await processPendingUploads(sessionId, attachmentsToUpload);
          uploadedIds = (uploadResult?.uploads ?? []).map((upload) => upload.id);
        }

        if (hasAttachments && uploadedIds.length === 0) {
          setMessageText(
            placeholderId,
            "I couldn't upload your file(s). Please try again in a moment.",
            "complete"
          );
          return;
        }

        const fallbackReply = generateAssistantReply(modelPrompt, isVoiceActive, uploadCount);
        if (systemStatus.respond) {
          try {
            stopTypingAnimation();
            let streamedText = "";
            let streamedSources: ResponseSource[] = [];

            // If this message includes fresh uploads, wait briefly for OCR to finish so the reply can cite them.
            let sessionAfterUploads: Session | null = null;
            if (hasAttachments && uploadedIds.length) {
              const timeoutMs = 60_000;
              const start = Date.now();
              while (Date.now() - start < timeoutMs) {
                const remote = await fetchSessionDetailFromBackend(sessionId, authToken);
                if (remote) {
                  sessionAfterUploads = remote;
                  const uploaded = uploadedIds.length
                    ? remote.uploads.filter((upload) => uploadedIds.includes(upload.id))
                    : [];
                  if (uploaded.length > 0 && uploaded.every((upload) => upload.status === "ready" || upload.status === "error")) {
                    break;
                  }
                }
                await new Promise((resolve) => setTimeout(resolve, 2000));
              }
            }

            const effectiveSession = sessionAfterUploads ?? activeSession;
            const readyForSession = (effectiveSession?.uploads ?? []).filter((upload) => upload.status === "ready");
            const scopedReady =
              hasAttachments && uploadedIds.length ? readyForSession.filter((upload) => uploadedIds.includes(upload.id)) : readyForSession;
            const effectiveUploads =
              hasAttachments && !trimmed ? scopedReady : scopedReady.length ? scopedReady : readyForSession;
            const effectiveUploadContext = effectiveUploads.length > 0 ? buildUploadContext(effectiveUploads) : null;
            const effectiveUploadIds = effectiveUploads.map((upload) => upload.id);

            if (hasAttachments && effectiveUploads.length === 0 && !trimmed) {
              setMessageText(
                placeholderId,
                "I’ve received your file(s) and started processing them. This can take a minute or two — once they’re ready you’ll see summaries in the upload cards and you can ask questions with citations.",
                "complete"
              );
              return;
            }

            const replyPayload = await requestAssistantReplyStream(
              modelPrompt,
              historyForModel,
              effectiveUploadContext ?? uploadContext,
              effectiveUploadIds.length ? effectiveUploadIds : Array.from(citationUploadIds),
              useWebSources,
              authToken,
              (chunk, fullText) => {
                streamedText = fullText;
                setMessageText(placeholderId, fullText, "streaming");
              },
              (sources) => {
                streamedSources = sources;
                setWebSources(sources);
              }
            );
            if (!replyPayload.ok) {
              if (replyPayload.status === 429) {
                const limitMessage = replyPayload.message || "Token limit reached. Start a new session or contact an admin.";
                setQuotaNotice(limitMessage);
                setWebSources([]);
                setMessageText(placeholderId, limitMessage, "complete");
                return;
              }
              throw new Error(replyPayload.message);
            }
            setQuotaNotice(null);
            const finalText = (streamedText || replyPayload.reply || fallbackReply).trim();
            if (!streamedSources.length) {
              setWebSources(replyPayload.sources);
            }
            setMessageText(placeholderId, finalText, "complete");
            void persistMessageToBackend(sessionId, "assistant", finalText, authToken)
              .then(syncSessionFromRemote)
              .catch((error) => loggerWarn("persist-assistant", error));
          } catch (error) {
            loggerWarn("respond", error);
            setWebSources([]);
            typeMessage(placeholderId, fallbackReply);
            void persistMessageToBackend(sessionId, "assistant", fallbackReply, authToken)
              .then(syncSessionFromRemote)
              .catch((persistError) => loggerWarn("persist-assistant", persistError));
          }
        } else {
          setWebSources([]);
          typeMessage(placeholderId, fallbackReply);
          void persistMessageToBackend(sessionId, "assistant", fallbackReply, authToken)
            .then(syncSessionFromRemote)
            .catch((error) => loggerWarn("persist-assistant", error));
        }

        if (systemStatus.suggestions) {
          void (async () => {
            setIsLoadingSuggestions(true);
            try {
              const remote = await requestSuggestionsFromBackend(modelPrompt, authToken);
              if (remote && remote.length > 0) {
                updateActiveSession((session) => ({
                  ...session,
                  suggestions: remote,
                }));
              }
            } finally {
              setIsLoadingSuggestions(false);
            }
          })();
        }
      } finally {
        setIsSending(false);
      }
    },
    [
      activeSession,
      addMessage,
      authToken,
      canUseApi,
      isVoiceActive,
      messages,
      pendingAttachments,
      processPendingUploads,
      systemStatus.respond,
      systemStatus.suggestions,
      stopTypingAnimation,
      setMessageText,
      typeMessage,
      useWebSources,
      updateActiveSession,
      uploadCount,
      syncSessionFromRemote,
    ]
  );

  const handleSessionSelect = useCallback(
    (sessionId: string) => {
      if (sessionId === activeSessionId) return;
      if (!canUseApi) {
        void signIn("azure-ad");
        return;
      }
      stopTypingAnimation();
      setWebSources([]);
      setActiveSessionId(sessionId);
      setInput("");
      void (async () => {
        const remote = await fetchSessionDetailFromBackend(sessionId, authToken);
        if (!remote) return;
        setSessions((prev) => {
          const exists = prev.some((session) => session.id === remote.id);
          if (!exists) {
            return [...prev, remote];
          }
          return prev.map((session) => (session.id === remote.id ? remote : session));
        });
      })();
    },
    [activeSessionId, authToken, canUseApi, stopTypingAnimation]
  );

  const handleSessionRename = useCallback((sessionId: string, title: string) => {
    userTouchedSessionsRef.current = true;
    if (!canUseApi) {
      void signIn("azure-ad");
      return;
    }
    const trimmed = title.trim();
    if (!trimmed) return;

    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              title: trimmed,
            }
          : session
      )
    );

    void (async () => {
      const remote = await renameSessionOnBackend(sessionId, trimmed, authToken);
      syncSessionFromRemote(remote);
    })();
  }, [authToken, canUseApi, syncSessionFromRemote]);

  const refreshActiveSession = useCallback(async () => {
    if (!activeSessionId) return;
    if (!canUseApi) return;
    const remote = await fetchSessionDetailFromBackend(activeSessionId, authToken);
    if (remote) {
      syncSessionFromRemote(remote);
    }
  }, [activeSessionId, authToken, canUseApi, syncSessionFromRemote]);

  useEffect(() => {
    if (!activeSessionId || !hasProcessingUploads) return;
    let cancelled = false;
    let attempts = 0;
    let intervalHandle: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      attempts += 1;
      await refreshActiveSession();
      if (attempts >= 30 && intervalHandle) {
        window.clearInterval(intervalHandle);
        intervalHandle = null;
      }
    };

    void tick();
    intervalHandle = window.setInterval(() => {
      void tick();
    }, 2000);

    return () => {
      cancelled = true;
      if (intervalHandle) {
        window.clearInterval(intervalHandle);
      }
    };
  }, [activeSessionId, hasProcessingUploads, refreshActiveSession]);

  const handleNewSession = useCallback(() => {
    userTouchedSessionsRef.current = true;
    if (!canUseApi) {
      void signIn("azure-ad");
      return;
    }
    stopTypingAnimation();
    setQuotaNotice(null);
    setInput("");
    const now = new Date();
    const optimisticId = crypto.randomUUID();
    const optimisticTitle = buildDefaultSessionTitle(now.toISOString());
    const welcomeMessage: ConversationMessage = {
      id: `assistant-welcome-${optimisticId}`,
      role: "assistant",
      text: defaultWelcomeMessage,
      timestamp: formatTimestamp(now),
      status: "complete",
    };

    setIsCreatingSession(true);
    setSessions((prev) => [
      ...prev,
      {
        id: optimisticId,
        title: optimisticTitle,
        createdAt: now.toISOString(),
        messages: [welcomeMessage],
        suggestions: starterSuggestions,
        uploads: [],
      },
    ]);
    setActiveSessionId(optimisticId);

    void (async () => {
      try {
        const remote = await createSessionWithWelcome(authToken, undefined, defaultWelcomeMessage);
        if (!remote) return;
        setWebSources([]);
        setSessions((prev) =>
          prev.map((session) => (session.id === optimisticId ? remote : session))
        );
        setActiveSessionId((current) => (current === optimisticId ? remote.id : current));
      } catch (error) {
        loggerWarn("session-create", error);
      } finally {
        setIsCreatingSession(false);
      }
    })();
  }, [authToken, canUseApi, defaultWelcomeMessage, stopTypingAnimation]);

  const handleDictationToggle = useCallback(() => {
    userTouchedSessionsRef.current = true;
    const existing = recognitionRef.current;
    if (isDictating && existing) {
      dictationShouldResumeRef.current = false;
      existing.stop();
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      addMessage({
        role: "assistant",
        text: "Voice dictation isn’t supported in this browser yet. Try the latest Chrome on desktop.",
        timestamp: formatTimestamp(new Date()),
      });
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    dictationShouldResumeRef.current = true;
    const seed = input.trim();
    let committedTranscript = seed ? `${seed} ` : "";
    recognition.onstart = () => setIsDictating(true);
    recognition.onerror = (event: any) => {
      loggerWarn("voice-dictation", event?.error ?? "unknown error");
      dictationShouldResumeRef.current = false;
      setIsDictating(false);
      recognition.stop();
    };
    recognition.onresult = (event: any) => {
      type TranscriptEntry = { 0?: { transcript?: string }; isFinal?: boolean };
      const results = Array.from((event?.results ?? []) as ArrayLike<TranscriptEntry>);
      let interim = "";
      let finalized = "";
      for (let i = event.resultIndex; i < results.length; i++) {
        const result = results[i];
        const snippet = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalized += `${snippet} `;
        } else {
          interim += `${snippet} `;
        }
      }
      if (finalized.trim()) {
        committedTranscript = `${committedTranscript}${finalized}`.replace(/\s+/g, " ").trim();
        if (committedTranscript.length > 0) {
          committedTranscript = `${committedTranscript} `;
        }
      }
      const nextValue = `${committedTranscript}${interim}`.replace(/\s+/g, " ").trim();
      setInput(nextValue);
    };
    recognition.onend = () => {
      if (dictationShouldResumeRef.current) {
        window.setTimeout(() => {
          try {
            recognition.start();
          } catch (error) {
            dictationShouldResumeRef.current = false;
            loggerWarn("voice-dictation-restart", error);
            setIsDictating(false);
          }
        }, 320);
        return;
      }
      setIsDictating(false);
      recognitionRef.current = null;
    };
    recognition.start();
    recognitionRef.current = recognition;
  }, [isDictating, addMessage, input]);

  const handleFileUpload = useCallback(
    (files: File[]) => {
      if (files.length === 0 || !activeSession) return;
      userTouchedSessionsRef.current = true;

      const staged = files.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      }));

      setPendingAttachments((prev) => [...prev, ...staged]);
    },
    [activeSession]
  );

  const handleRemoveAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((attachment) => attachment.id === attachmentId);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((attachment) => attachment.id !== attachmentId);
    });
  }, []);

  const handleDownloadSession = useCallback(async () => {
    if (!activeSession) return;
    try {
      const response = await fetch(`${backendBase}/sessions/${activeSession.id}/export`, {
        cache: "no-store",
        headers: authHeaders,
      });
      if (!response.ok) {
        throw new Error(`Export failed (${response.status})`);
      }
      const payload = await response.json();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const safeTitle = slugify(activeSession.title || "session");
      anchor.download = `${safeTitle}-${activeSession.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      loggerWarn("session-export", error);
    }
  }, [activeSession, authHeaders]);

  const handleExport = useCallback(
    async (format: "md" | "pdf") => {
      if (!activeSession) return;
      setIsExporting(true);
      try {
        const summary = deriveSummary(messages);
        const actionItems = deriveActionItems(messages);
        const references = buildExportReferences(activeSession.uploads ?? []);
        const response = await fetch(`${backendBase}/nexa/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            session_id: activeSession.id,
            title: activeSession.title || "NexaQuill Export",
            summary,
            action_items: actionItems,
            format,
            references,
          }),
        });
        if (!response.ok) {
          throw new Error(`Export failed (${response.status})`);
        }
        const payload = (await response.json()) as { url?: string };
        if (payload?.url) {
          window.open(payload.url, "_blank", "noopener,noreferrer");
        }
      } catch (error) {
        loggerWarn("export", error);
      } finally {
        setIsExporting(false);
      }
    },
    [activeSession, authHeaders, messages]
  );

  const handleShareSession = useCallback(async () => {
    if (!activeSession) return;
    const shareUrl = `${window.location.origin}/share/${activeSession.id}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareLabel("Link copied");
    } catch {
      window.prompt("Copy this share link:", shareUrl);
      setShareLabel("Share link");
      return;
    }
    window.setTimeout(() => setShareLabel("Share link"), 1600);
  }, [activeSession]);

  const handleRetryUpload = useCallback(
    async (uploadId: string) => {
      try {
        const response = await fetch(`${backendBase}/uploads/${uploadId}/reprocess`, {
          method: "POST",
          headers: authHeaders,
        });
        if (!response.ok) {
          throw new Error(`Reprocess failed (${response.status})`);
        }
        await refreshActiveSession();
      } catch (error) {
        loggerWarn("upload-retry", error);
      }
    },
    [authHeaders, refreshActiveSession]
  );

  const handleDeleteUpload = useCallback(
    async (uploadId: string) => {
      try {
        const response = await fetch(`${backendBase}/uploads/${uploadId}`, { method: "DELETE", headers: authHeaders });
        if (!response.ok) {
          throw new Error(`Delete failed (${response.status})`);
        }
        setDownloadUrls((prev) => {
          const next = { ...prev };
          delete next[uploadId];
          return next;
        });
        updateActiveSession((session) => ({
          ...session,
          uploads: (session.uploads ?? []).filter((upload) => upload.id !== uploadId),
        }));
      } catch (error) {
        loggerWarn("upload-delete", error);
      }
    },
    [authHeaders, updateActiveSession]
  );

  const handleCancelUpload = useCallback(
    async (clientId: string) => {
      const controller = uploadControllersRef.current.get(clientId);
      if (controller) {
        controller.abort();
      }
      const uploadId = uploadIdByClientIdRef.current.get(clientId);
      if (uploadId) {
        try {
          await fetch(`${backendBase}/uploads/${uploadId}`, { method: "DELETE", headers: authHeaders });
        } catch {
          // ignore cleanup failures
        }
      }
      uploadControllersRef.current.delete(clientId);
      uploadIdByClientIdRef.current.delete(clientId);
      setUploadStatuses((prev) => prev.filter((item) => item.id !== clientId));
    },
    [authHeaders]
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        const response = await fetch(`${backendBase}/sessions/${sessionId}`, { method: "DELETE", headers: authHeaders });
        if (!response.ok) {
          throw new Error(`Delete session failed (${response.status})`);
        }
        const deletedUploads = sessions.find((session) => session.id === sessionId)?.uploads ?? [];
        if (deletedUploads.length > 0) {
          setDownloadUrls((prev) => {
            const next = { ...prev };
            for (const upload of deletedUploads) {
              delete next[upload.id];
            }
            return next;
          });
        }
        let remaining: Session[] = [];
        setSessions((prev) => {
          remaining = prev.filter((session) => session.id !== sessionId);
          return remaining;
        });
        if (activeSessionId === sessionId) {
          stopTypingAnimation();
          setWebSources([]);
          setInput("");
          const nextId = remaining[0]?.id ?? "";
          if (nextId) {
            setActiveSessionId(nextId);
          } else {
            handleNewSession();
          }
        }
      } catch (error) {
        loggerWarn("session-delete", error);
      }
    },
    [activeSessionId, authHeaders, handleNewSession, sessions, stopTypingAnimation]
  );

  useEffect(() => {
    return () => {
      dictationShouldResumeRef.current = false;
      recognitionRef.current?.stop();
      void stopVoiceSession();
    };
  }, [stopVoiceSession]);

  const activeWindow = messages.slice(-6);
  const tokenEstimate = activeWindow.reduce((total, message) => total + Math.ceil(message.text.length / 4), 0);
  const sidebarSessions = useMemo(
    () =>
      sessions.map((session) => {
        const createdAt = new Date(session.createdAt);
        const createdAtLabel = createdAt.toLocaleString([], {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        const lastSnippet =
          [...session.messages].reverse().find((message) => message.role === "user")?.text ?? null;
        return {
          id: session.id,
          title: session.title,
          createdAtLabel,
          lastSnippet: lastSnippet ? truncateSnippet(lastSnippet) : null,
        };
      }),
    [sessions]
  );
  const showAuthGate = authRequired && (!hasAuthToken || authStatus !== "authenticated");
  const showAuthControls = AUTH_MODE !== "disabled";

  const handleEmailSignIn = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const result = await signIn("credentials", {
        redirect: false,
        email: signInEmail.trim(),
        password: signInPassword,
      });
      if (result?.error) {
        setAuthError("Invalid email or password.");
      }
    } catch (error) {
      loggerWarn("auth-email-signin", error);
      setAuthError("Sign-in failed. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  }, [signInEmail, signInPassword]);

  const handleEmailRegister = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: signUpEmail.trim(),
          password: signUpPassword,
          display_name: signUpDisplayName.trim() || undefined,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as any;
        const detail = typeof payload?.detail === "string" ? payload.detail : "Registration failed.";
        setAuthError(detail);
        return;
      }
      const result = await signIn("credentials", {
        redirect: false,
        email: signUpEmail.trim(),
        password: signUpPassword,
      });
      if (result?.error) {
        setAuthError("Account created, but sign-in failed. Try signing in.");
        setAuthMode("signin");
      }
    } catch (error) {
      loggerWarn("auth-email-register", error);
      setAuthError("Registration failed. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  }, [signUpDisplayName, signUpEmail, signUpPassword]);

  const handleForgotPassword = useCallback(async () => {
    const email = signInEmail.trim();
    if (!email) {
      setAuthError("Enter your email before requesting a reset link.");
      return;
    }
    setPasswordResetBusy(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as any;
        const detail = typeof payload?.detail === "string" ? payload.detail : "Reset request failed.";
        setAuthError(detail);
        return;
      }
      setAuthNotice("Check your inbox for reset instructions.");
    } catch (error) {
      loggerWarn("auth-forgot-password", error);
      setAuthError("Could not send the reset email. Please try again.");
    } finally {
      setPasswordResetBusy(false);
    }
  }, [signInEmail]);

  return (
    <div className="nexa-app">
      <div className="nexa-shell">
        <HeroSection
          showAuthControls={showAuthControls}
          authenticated={authStatus === "authenticated"}
          userName={authSession?.user?.name ?? authSession?.user?.email ?? null}
          onSignIn={() => void signIn("azure-ad")}
          onSignOut={() => void signOut({ callbackUrl: "/" })}
        />

        <section className="nexa-grid">
          {showAuthGate ? (
            <div className="auth-gate">
              <div className="auth-gate__card">
                <h2>Sign in to start</h2>
                <p>
                  Choose a sign-in method to create your account and access chats. You can use Microsoft, Google, or an
                  email + password.
                </p>
                {authStatus === "authenticated" && !hasAuthToken && (
                  <div className="auth-gate__error">
                    Your login session is missing a token. Please sign in again.
                  </div>
                )}
                {authStatus === "authenticated" && (
                  <button
                    type="button"
                    className="btn btn--ghost auth-gate__signout"
                    onClick={() => void signOut({ callbackUrl: "/" })}
                  >
                    Sign out
                  </button>
                )}

                <div className="auth-gate__tabs" role="tablist">
                  <button
                    type="button"
                    className={`auth-gate__tab ${authMode === "signin" ? "auth-gate__tab--active" : ""}`}
                    onClick={() => {
                      setAuthMode("signin");
                      setAuthError(null);
                      setAuthNotice(null);
                      setPasswordResetBusy(false);
                    }}
                    role="tab"
                    aria-selected={authMode === "signin"}
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    className={`auth-gate__tab ${authMode === "signup" ? "auth-gate__tab--active" : ""}`}
                    onClick={() => {
                      setAuthMode("signup");
                      setAuthError(null);
                      setAuthNotice(null);
                      setPasswordResetBusy(false);
                    }}
                    role="tab"
                    aria-selected={authMode === "signup"}
                  >
                    Create account
                  </button>
                </div>
                <form
                  className="auth-gate__form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (authBusy) return;
                    if (authMode === "signup") {
                      void handleEmailRegister();
                      return;
                    }
                    void handleEmailSignIn();
                  }}
                >
                  {authMode === "signup" && (
                    <label className="auth-gate__field">
                      <span>Name (optional)</span>
                      <input
                        type="text"
                        value={signUpDisplayName}
                        onChange={(event) => setSignUpDisplayName(event.target.value)}
                        placeholder="Your name"
                        autoComplete="name"
                        disabled={authBusy}
                      />
                    </label>
                  )}
                  <label className="auth-gate__field">
                    <span>Email</span>
                    <input
                      type="email"
                      value={authMode === "signup" ? signUpEmail : signInEmail}
                      onChange={(event) => {
                        const { value } = event.target;
                        if (authMode === "signup") {
                          setSignUpEmail(value);
                        } else {
                          setSignInEmail(value);
                        }
                      }}
                      placeholder="you@example.com"
                      autoComplete="email"
                      disabled={authBusy}
                      required
                    />
                  </label>
                  <label className="auth-gate__field">
                    <span>Password</span>
                    <input
                      type="password"
                      value={authMode === "signup" ? signUpPassword : signInPassword}
                      onChange={(event) => {
                        const { value } = event.target;
                        if (authMode === "signup") {
                          setSignUpPassword(value);
                        } else {
                          setSignInPassword(value);
                        }
                      }}
                      placeholder="••••••••"
                      autoComplete={authMode === "signup" ? "new-password" : "current-password"}
                      disabled={authBusy}
                      required
                    />
                  </label>
                  {authMode === "signin" && (
                    <button
                      type="button"
                      className="auth-gate__link"
                      onClick={() => {
                        if (!passwordResetBusy) {
                          void handleForgotPassword();
                        }
                      }}
                      disabled={authBusy || passwordResetBusy}
                    >
                      {passwordResetBusy ? "Sending reset link…" : "Forgot password?"}
                    </button>
                  )}
                  {authError && <div className="auth-gate__error">{authError}</div>}
                  {authNotice && <div className="auth-gate__notice">{authNotice}</div>}
                  <button type="submit" className="btn btn--primary auth-gate__submit" disabled={authBusy}>
                    {authBusy ? "Please wait…" : authMode === "signup" ? "Create account" : "Sign in"}
                  </button>
                  <p className="auth-gate__hint">
                    Passwords are stored securely (hashed) in your database. You can always switch to Microsoft/Google
                    later.
                  </p>
                </form>
                <div className="auth-gate__divider" role="separator">
                  <span>or</span>
                </div>
                <div className="auth-gate__actions auth-gate__providers">
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
          ) : (
            <>
              {quotaNotice && (
                <div className="quota-banner" role="status">
                  <div>
                    <strong>Session limit</strong>
                    <p>{quotaNotice}</p>
                  </div>
                  <div className="quota-banner__actions">
                    <button
                      type="button"
                      className="quota-banner__button quota-banner__button--primary"
                      onClick={() => {
                        setQuotaNotice(null);
                        handleNewSession();
                      }}
                    >
                      Start new chat
                    </button>
                    <button
                      type="button"
                      className="quota-banner__button"
                      onClick={() => setQuotaNotice(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
              <ConversationPanel
                input={input}
                onInputChange={setInput}
                onSubmit={handleSubmit}
                canSend={canSend}
                isDictating={isDictating}
                onDictate={handleDictationToggle}
                attachments={pendingAttachments}
                onAttachmentRemove={handleRemoveAttachment}
                uploadStatuses={uploadStatuses}
                messages={messages}
                onFileUpload={handleFileUpload}
                isSending={isSending}
                onNewSession={handleNewSession}
                activeSessionTitle={activeSession?.title ?? "Untitled session"}
                onDownloadSession={handleDownloadSession}
                voiceIndicatorOverride={voiceIndicatorOverride}
                inlineSuggestions={inlineSuggestions}
                inlineSuggestionsBusy={inlineSuggestionsBusy}
                onInlineSuggestionSelect={handleInlineSuggestionSelect}
                onExport={handleExport}
                onShareSession={handleShareSession}
                shareLabel={shareLabel}
                exportBusy={isExporting}
                newSessionBusy={isCreatingSession}
                responseSources={webSources}
                uploadSources={uploadSources}
                uploads={uploadCards}
                onRetryUpload={handleRetryUpload}
                onDeleteUpload={handleDeleteUpload}
                onCancelUpload={handleCancelUpload}
                useWebSources={useWebSources}
                onToggleWebSources={setUseWebSources}
                isLoading={isHydratingSessions}
              />

              <ControlSidebar
                sessions={sidebarSessions}
                activeSessionId={activeSessionId}
                onSessionSelect={handleSessionSelect}
                onRenameSession={handleSessionRename}
                onDeleteSession={handleDeleteSession}
                sessionTurns={messages.length}
                tokenEstimate={tokenEstimate}
                isVoiceActive={isVoiceActive}
                isVoiceMuted={isVoiceMuted}
                onToggleVoice={handleVoiceSessionToggle}
                onStopVoice={handleVoiceSessionStop}
                isLoading={isHydratingSessions}
              />
            </>
          )}
        </section>
      </div>
      {showGuidedTour && currentGuidedTourStep && (
        <GuidedTour
          step={currentGuidedTourStep}
          stepIndex={guidedTourStepIndex}
          totalSteps={guidedTourTotal}
          onNext={handleGuidedTourNext}
          onBack={handleGuidedTourBack}
          onSkip={handleGuidedTourSkip}
          isLast={guidedTourStepIndex >= guidedTourTotal - 1}
        />
      )}
    </div>
  );
}

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function buildDefaultSessionTitle(sourceDate?: string): string {
  const date = sourceDate ? new Date(sourceDate) : new Date();
  const label = date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Notes - ${label}`;
}

function buildVoiceGreeting(name: string, date = new Date()): string {
  const hour = date.getHours();
  const part =
    hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night";
  const timeLabel = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Good ${part}, ${name}. Welcome to NexaQuill at ${timeLabel}. Happy to help you.`;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "session"
  );
}

function buildFallbackSuggestions(prefix: string): string[] {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return [
      "Hello! How would you like NexaQuill to help today?",
      "Need a summary, plan, or quick answer?",
      "Try uploading a PDF so I can synthesise it.",
    ];
  }

  const lead = trimmed.split(" ").slice(0, 6).join(" ");
  return [
    `Want to expand on “${lead}”?`,
    "Should I capture this as a quick summary?",
    "Would a checklist or reminder help here?",
  ];
}

async function requestSuggestionsFromBackend(prefix: string, authToken?: string | null): Promise<string[] | null> {
  if (!prefix.trim()) {
    return null;
  }

  try {
    const response = await fetch(`${backendBase}/nexa/autocomplete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...bearerHeaders(authToken),
      },
      body: JSON.stringify({ prefix }),
    });

    if (!response.ok) {
      throw new Error(`Suggestion request failed (${response.status})`);
    }

    const data = (await response.json()) as { suggestions?: unknown };
    if (Array.isArray(data?.suggestions)) {
      const cleaned = data.suggestions
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      return cleaned.length ? cleaned.slice(0, 3) : null;
    }
  } catch (error) {
    loggerWarn("suggestions", error);
  }

  return null;
}

type ExportReference = { type: string; label?: string | null; link?: string | null };

function deriveSummary(messages: ConversationMessage[]): string {
  const lastAssistant = [...messages].reverse().find((msg) => msg.role === "assistant" && msg.text.trim());
  if (lastAssistant?.text) {
    return lastAssistant.text.trim();
  }
  const lastUser = [...messages].reverse().find((msg) => msg.role === "user" && msg.text.trim());
  return lastUser?.text?.trim() ?? "Session summary not captured yet.";
}

function deriveActionItems(messages: ConversationMessage[]): string[] {
  const source = [...messages].reverse().find((msg) => msg.role === "assistant" && msg.text);
  if (!source?.text) return [];
  const lines = source.text.split("\n");
  const items: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed)) {
      items.push(trimmed.replace(/^[-*]\s+/, "").trim());
    } else if (/^\d+[.)]\s+/.test(trimmed)) {
      items.push(trimmed.replace(/^\d+[.)]\s+/, "").trim());
    }
    if (items.length >= 6) break;
  }
  return items;
}

function buildExportReferences(uploads: UploadRecord[]): ExportReference[] {
  return uploads
    .filter((upload) => upload.status === "ready")
    .map((upload) => ({
      type: "upload",
      label: upload.filename,
      link: upload.blobPath || undefined,
    }));
}

function loggerWarn(context: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[nexaquill:${context}]`, error);
}

function normalizeSources(raw: unknown): ResponseSource[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      label: typeof item.label === "string" ? item.label : "Source",
      url: typeof item.url === "string" ? item.url : "",
    }))
    .filter((entry) => Boolean(entry.url));
}

function parseQuota(raw: unknown): QuotaInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const payload = raw as Record<string, unknown>;
  const limit = typeof payload.limit === "number" ? payload.limit : undefined;
  const used = typeof payload.used === "number" ? payload.used : undefined;
  if (limit === undefined && used === undefined) {
    return undefined;
  }
  return { limit, used };
}

async function requestAssistantReply(
  prompt: string,
  history: ConversationMessage[],
  authToken?: string | null,
  uploadContext?: string | null,
  uploadIds?: string[],
  useWeb?: boolean
): Promise<RespondResult> {
  try {
    const body: {
      prompt: string;
      context: { role: string; text: string }[];
      uploads_context?: string;
      upload_ids?: string[];
      use_web?: boolean;
    } = {
      prompt,
      context: history.slice(-6).map((message) => ({
        role: message.role,
        text: message.text,
      })),
    };
    if (uploadContext) {
      body.uploads_context = uploadContext;
    }
    if (uploadIds && uploadIds.length) {
      body.upload_ids = uploadIds;
    }
    if (useWeb) {
      body.use_web = true;
    }
    const response = await fetch(`${backendBase}/nexa/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...bearerHeaders(authToken),
      },
      body: JSON.stringify(body),
    });
    const parseMessage = async (): Promise<string> => {
      try {
        const payload = (await response.json()) as { detail?: unknown; message?: unknown; quota?: unknown; reply?: unknown; sources?: unknown };
        const quota = parseQuota(payload?.quota);
        const detail = typeof payload?.detail === "string" ? payload.detail : typeof payload?.message === "string" ? payload.message : "";
        if (response.ok) {
          const reply = typeof payload?.reply === "string" ? payload.reply.trim() : "";
          const sources = normalizeSources(payload?.sources);
          if (reply) {
            return JSON.stringify({ reply, sources, quota });
          }
          return JSON.stringify({ message: "Empty reply", quota });
        }
        return JSON.stringify({ message: detail || `Respond request failed (${response.status})`, quota });
      } catch (error) {
        return JSON.stringify({ message: error instanceof Error ? error.message : "Unexpected response" });
      }
    };

    if (!response.ok) {
      const parsed = await parseMessage();
      try {
        const payload = JSON.parse(parsed) as { message?: string; quota?: QuotaInfo };  
        return {
          ok: false,
          status: response.status,
          message: payload.message ?? `Respond request failed (${response.status})`,
          quota: payload.quota,
        };
      } catch {
        return { ok: false, status: response.status, message: `Respond request failed (${response.status})` };
      }
    }

    const parsed = await parseMessage();
    try {
      const payload = JSON.parse(parsed) as { reply?: string; sources?: ResponseSource[]; quota?: QuotaInfo; message?: string };
      const reply = typeof payload.reply === "string" ? payload.reply.trim() : "";
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      if (reply) {
        return { ok: true, reply, sources, quota: payload.quota };
      }
      return {
        ok: false,
        status: 204,
        message: payload.message ?? "Assistant did not respond.",
        quota: payload.quota,
      };
    } catch (error) {
      return {
        ok: false,
        status: 500,
        message: error instanceof Error ? error.message : "Failed to parse response",
      };
    }
  } catch (error) {
    loggerWarn("respond", error);
  }

  return { ok: false, status: 500, message: "Assistant unavailable" };
}

type StreamEvent = {
  event: string;
  data: string;
};

function parseSseEvent(raw: string): StreamEvent | null {
  const lines = raw.split("\n");
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/\r$/, "");
    if (cleaned.startsWith("event:")) {
      event = cleaned.slice(6).trim();
      continue;
    }
    if (cleaned.startsWith("data:")) {
      const payload = cleaned.slice(5);
      dataLines.push(payload);
    }
  }
  const data = dataLines.join("\n");
  if (!data && data !== "") return null;
  return { event, data };
}

async function requestAssistantReplyStream(
  prompt: string,
  history: ConversationMessage[],
  uploadContext: string | null | undefined,
  uploadIds: string[] | undefined,
  useWeb: boolean | undefined,
  authToken: string | null | undefined,
  onToken: (chunk: string, fullText: string) => void,
  onSources: (sources: ResponseSource[]) => void
): Promise<RespondResult> {
  const body: {
    prompt: string;
    context: { role: string; text: string }[];
    uploads_context?: string;
    upload_ids?: string[];
    use_web?: boolean;
  } = {
    prompt,
    context: history.slice(-6).map((message) => ({
      role: message.role,
      text: message.text,
    })),
  };
  if (uploadContext) {
    body.uploads_context = uploadContext;
  }
  if (uploadIds && uploadIds.length) {
    body.upload_ids = uploadIds;
  }
  if (useWeb) {
    body.use_web = true;
  }

  const response = await fetch(`${backendBase}/nexa/respond/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...bearerHeaders(authToken),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      loggerWarn("respond-stream", error);
    }
    const quota = parseQuota(payload?.quota);
    const detail = typeof payload?.detail === "string" ? payload.detail : typeof payload?.message === "string" ? payload.message : "";
    return {
      ok: false,
      status: response.status,
      message: detail || `Stream request failed (${response.status})`,
      quota,
    };
  }

  if (!response.body) {
    return { ok: false, status: 500, message: "Stream body missing" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let sources: ResponseSource[] = [];
  let quota: QuotaInfo | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      if (!rawEvent.trim()) continue;
      const parsed = parseSseEvent(rawEvent);
      if (!parsed) continue;
      if (parsed.data.trim() === "[DONE]") {
        await reader.cancel();
        return { ok: true, reply: reply.trim(), sources, quota };
      }
      if (parsed.event === "sources") {
        try {
          const payload = JSON.parse(parsed.data);
          sources = normalizeSources(payload);
          onSources(sources);
        } catch (error) {
          loggerWarn("respond-sources", error);
        }
        continue;
      }
      if (parsed.event === "quota") {
        try {
          const payload = JSON.parse(parsed.data);
          quota = parseQuota(payload);
        } catch (error) {
          loggerWarn("respond-quota", error);
        }
        continue;
      }
      reply += parsed.data;
      onToken(parsed.data, reply);
    }
  }

  const finalReply = reply.trim();
  if (finalReply) {
    return { ok: true, reply: finalReply, sources, quota };
  }
  return { ok: false, status: 204, message: "Assistant did not respond.", quota };
}

function generateAssistantReply(
  userInput: string,
  voiceActive: boolean,
  uploadCount: number
): string {
  const stem = userInput.slice(0, 120);
  const base = `Noted: “${stem}${stem.length === userInput.length ? "" : "…"}”.`;
  const voiceHint = voiceActive
    ? " I’ll keep listening in case you want to add anything verbally."
    : " You can enable voice mode anytime to keep the conversation flowing hands-free.";
  const uploadHint = uploadCount > 0
    ? ` I’ve also queued ${uploadCount} document${uploadCount > 1 ? "s" : ""} for later analysis.`
    : "";
  return `${base} I’ll convert this into actionable bullets shortly.${voiceHint}${uploadHint}`;
}

function truncateSnippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 68) {
    return trimmed || "…";
  }
  return `${trimmed.slice(0, 65)}…`;
}

function buildUploadContext(uploads: UploadRecord[]): string | null {
  const ready = uploads.filter(
    (upload) => upload.status === "ready" && typeof upload.summary === "string" && upload.summary.trim()
  );
  if (!ready.length) {
    return null;
  }
  return ready
    .map((upload, index) => `${index + 1}. ${upload.filename}: ${upload.summary?.trim() ?? ""}`)
    .join("\n\n");
}

type ApiSessionResponse = {
  id: string;
  title?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  messages?: ApiMessageResponse[];
  uploads?: ApiUploadResponse[];
  suggestions?: string[] | null;
};

type ApiMessageResponse = {
  id?: string;
  role?: string;
  text?: string;
  created_at?: string | null;
};

type ApiUploadResponse = {
  id: string;
  session_id: string;
  filename: string;
  mime_type?: string | null;
  file_size: number;
  status: "pending" | "processing" | "ready" | "error" | string;
  summary?: string | null;
  blob_path: string;
  created_at?: string | null;
  updated_at?: string | null;
};

function normalizeUploadStatus(value?: string | null): UploadRecord["status"] {
  switch (value) {
    case "ready":
      return "ready";
    case "pending":
    case "processing":
      return "processing";
    case "error":
      return "error";
    default:
      return "processing";
  }
}

function toLocalSession(session: ApiSessionResponse): Session {
  const createdAt = session.created_at ?? new Date().toISOString();
  const messages: ConversationMessage[] = Array.isArray(session.messages)
    ? session.messages
        .filter((message): message is ApiMessageResponse => Boolean(message?.role && message?.text))
        .map((message) => {
          const timestampSource = message.created_at ?? createdAt;
          const timestampDate = new Date(timestampSource);
          return {
            id: message.id ?? crypto.randomUUID(),
            role: message.role === "assistant" ? "assistant" : "user",
            text: message.text ?? "",
            timestamp: Number.isNaN(timestampDate.getTime())
              ? formatTimestamp(new Date())
              : formatTimestamp(timestampDate),
            status: "complete",
          };
        })
    : [];
  const uploads = Array.isArray(session.uploads) ? session.uploads.map(toLocalUpload) : [];
  const title = session.title?.trim() || buildDefaultSessionTitle(createdAt ?? undefined);
  return {
    id: session.id,
    title,
    createdAt,
    messages,
    suggestions: session.suggestions && session.suggestions.length ? session.suggestions : [],
    uploads,
  };
}

function toLocalUpload(upload: ApiUploadResponse): UploadRecord {
  return {
    id: upload.id,
    sessionId: upload.session_id,
    filename: upload.filename,
    mimeType: upload.mime_type ?? null,
    fileSize: upload.file_size,
    status: normalizeUploadStatus(upload.status),
    summary: upload.summary ?? null,
    blobPath: upload.blob_path,
    createdAt: upload.created_at ?? undefined,
    updatedAt: upload.updated_at ?? undefined,
  };
}

async function fetchSessionsFromBackend(authToken?: string | null): Promise<Session[]> {
  try {
    const response = await fetch(`${backendBase}/sessions`, { cache: "no-store", headers: bearerHeaders(authToken) });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as ApiSessionResponse[];
    return data.map(toLocalSession);
  } catch (error) {
    loggerWarn("sessions-fetch", error);
    return [];
  }
}

async function fetchSessionDetailFromBackend(sessionId: string, authToken?: string | null): Promise<Session | null> {
  try {
    const response = await fetch(`${backendBase}/sessions/${sessionId}`, {
      cache: "no-store",
      headers: bearerHeaders(authToken),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as ApiSessionResponse;
    return toLocalSession(data);
  } catch (error) {
    loggerWarn("session-detail", error);
    return null;
  }
}

async function createSessionOnBackend(authToken?: string | null, title?: string): Promise<Session | null> {
  try {
    const response = await fetch(`${backendBase}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearerHeaders(authToken) },
      body: JSON.stringify(title ? { title } : {}),
    });
    if (!response.ok) {
      throw new Error(`Create session failed (${response.status})`);
    }
    const data = (await response.json()) as ApiSessionResponse;
    return toLocalSession(data);
  } catch (error) {
    loggerWarn("session-create", error);
    return null;
  }
}

async function renameSessionOnBackend(sessionId: string, title: string, authToken?: string | null): Promise<Session | null> {
  try {
    const response = await fetch(`${backendBase}/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...bearerHeaders(authToken) },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      throw new Error(`Rename session failed (${response.status})`);
    }
    const data = (await response.json()) as ApiSessionResponse;
    return toLocalSession(data);
  } catch (error) {
    loggerWarn("session-rename", error);
    return null;
  }
}

async function appendMessageToBackend(
  sessionId: string,
  role: "assistant" | "user",
  text: string,
  authToken?: string | null
): Promise<Session | null> {
  try {
    const response = await fetch(`${backendBase}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearerHeaders(authToken) },
      body: JSON.stringify({ role, text }),
    });
    if (!response.ok) {
      throw new Error(`Append message failed (${response.status})`);
    }
    const data = (await response.json()) as ApiSessionResponse;
    return toLocalSession(data);
  } catch (error) {
    loggerWarn("session-append", error);
    return null;
  }
}

function persistMessageToBackend(
  sessionId: string,
  role: "assistant" | "user",
  text: string,
  authToken?: string | null
): Promise<Session | null> {
  return appendMessageToBackend(sessionId, role, text, authToken);
}

async function createSessionWithWelcome(
  authToken: string | null | undefined,
  title: string | undefined,
  welcomeMessage: string | undefined
): Promise<Session | null> {
  const session = await createSessionOnBackend(authToken, title);
  if (!session) {
    return null;
  }
  if (!welcomeMessage || !welcomeMessage.trim()) {
    return session;
  }
  const updated = await appendMessageToBackend(session.id, "assistant", welcomeMessage, authToken);
  return updated ?? session;
}
