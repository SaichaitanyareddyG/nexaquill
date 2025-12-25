export type VoiceSessionState = "idle" | "connecting" | "listening" | "speaking";

type VoiceSessionCallbacks = {
  onStateChange?: (state: VoiceSessionState) => void;
  onAssistantDelta?: (text: string) => void;
  onAssistantComplete?: () => void;
  onUserTranscript?: (text: string) => void;
  onError?: (message: string) => void;
};

type StartOptions = {
  name?: string;
  model?: string;
};

type TokenResponse = {
  client_secret?: { value?: string };
  value?: string;
};

export class RealtimeVoiceSession {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteAudioEl: HTMLAudioElement | null = null;
  private callbacks: VoiceSessionCallbacks;
  private backendBase: string;
  private authToken: string | null = null;
  private sessionToken: string | null = null;
  private dataChannel: RTCDataChannel | null = null;

  constructor(options: { backendBase: string; authToken?: string | null; callbacks?: VoiceSessionCallbacks }) {
    this.backendBase = options.backendBase;
    this.authToken = options.authToken ?? null;
    this.callbacks = options.callbacks ?? {};
  }

  async start(options?: StartOptions): Promise<void> {
    if (this.pc) {
      await this.stop();
    }
    this.callbacks.onStateChange?.("connecting");

    const token = await this.fetchToken(options?.name);
    this.sessionToken = token;

    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    this.pc.onconnectionstatechange = () => {
      if (this.pc?.connectionState === "failed" || this.pc?.connectionState === "disconnected") {
        this.callbacks.onError?.("Realtime connection lost. Re-enable voice to reconnect.");
        void this.stop();
      }
    };

    this.pc.ontrack = (event) => {
      if (!this.remoteAudioEl) {
        this.remoteAudioEl = new Audio();
        this.remoteAudioEl.autoplay = true;
        this.remoteAudioEl.setAttribute("playsinline", "true");
      }
      this.remoteAudioEl.srcObject = event.streams[0];
      void this.remoteAudioEl.play().catch(() => {
        this.callbacks.onError?.(
          "Browser blocked autoplay for the agent audio. Tap the canvas and re-enable voice."
        );
      });
    };

    this.pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.onmessage = (evt) => {
        this.handleEvent(evt.data);
      };
      channel.onclose = () => {
        if (this.dataChannel === channel) {
          this.dataChannel = null;
        }
      };
    };

    this.localStream.getTracks().forEach((track) => {
      this.pc?.addTrack(track, this.localStream as MediaStream);
    });

    this.dataChannel = this.pc.createDataChannel("oai-events");
    this.dataChannel.onopen = () => {
      this.sendSessionConfiguration();
    };
    this.dataChannel.onmessage = (event) => {
      this.handleEvent(event.data);
    };
    this.dataChannel.onclose = () => {
      this.dataChannel = null;
    };

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const answer = await this.exchangeSdp(offer.sdp ?? "", options?.model);
    await this.pc.setRemoteDescription({ type: "answer", sdp: answer });

    this.callbacks.onStateChange?.("listening");
  }

  async stop(): Promise<void> {
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.ondatachannel = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onclose = null;
      try {
        this.dataChannel.close();
      } catch {
        // ignore
      }
      this.dataChannel = null;
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    if (this.remoteAudioEl) {
      this.remoteAudioEl.pause();
      this.remoteAudioEl.srcObject = null;
      this.remoteAudioEl.remove();
      this.remoteAudioEl = null;
    }
    this.callbacks.onStateChange?.("idle");
  }

  private async fetchToken(name?: string): Promise<string> {
    const url = new URL("/nexa/token", this.backendBase);
    if (name) {
      url.searchParams.set("name", name);
    }
    const headers: Record<string, string> = {};
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    const resp = await fetch(url.toString(), { cache: "no-store", headers });
    if (!resp.ok) {
      throw new Error(`Failed to fetch realtime token (${resp.status})`);
    }
    const data = (await resp.json()) as TokenResponse;
    const token = data.client_secret?.value || data.value;
    if (!token) {
      throw new Error("Realtime token missing from response");
    }
    return token;
  }

  private async exchangeSdp(offerSdp: string, model?: string): Promise<string> {
    const body = {
      offerSdp,
      token: this.sessionToken,
      model,
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    const resp = await fetch(new URL("/nexa/sdp", this.backendBase), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Realtime SDP exchange failed (${resp.status})`);
    }
    return resp.text();
  }

  private handleEvent(raw: string): void {
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const type: string | undefined = payload.type ?? payload.event;
    if (!type) return;

    if (type.includes("response.output_text.delta")) {
      const delta = payload.delta ?? payload.text ?? this.extractText(payload);
      if (typeof delta === "string" && delta.trim()) {
        this.callbacks.onAssistantDelta?.(delta);
      }
    }

    if (type.includes("response.completed") || type.includes("response.output_text.done")) {
      this.callbacks.onAssistantComplete?.();
      this.callbacks.onStateChange?.("listening");
    }

    if (type.includes("response.output_audio.delta")) {
      this.callbacks.onStateChange?.("speaking");
    }

    if (type.includes("conversation.item.completed")) {
      const role = payload.item?.role;
      const text = this.extractText(payload.item);
      if (role === "user" && text) {
        this.callbacks.onUserTranscript?.(text);
      }
      if (role === "assistant" && text) {
        this.callbacks.onAssistantDelta?.(text);
        this.callbacks.onAssistantComplete?.();
      }
    }
  }

  private extractText(input: any): string | null {
    if (!input) return null;
    if (typeof input === "string") return input;
    if (Array.isArray(input)) {
      for (const entry of input) {
        const value = this.extractText(entry);
        if (value) return value;
      }
      return null;
    }
    if (typeof input === "object") {
      if (typeof input.text === "string") {
        return input.text;
      }
      if (Array.isArray(input.content)) {
        for (const piece of input.content) {
          const value = this.extractText(piece);
          if (value) return value;
        }
      }
      if (typeof input.delta === "string") {
        return input.delta;
      }
    }
    return null;
  }

  private sendSessionConfiguration(): void {
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== "open") {
      return;
    }
    const payload = {
      type: "session.update",
      session: {
        instructions:
          "You are NexaQuill's realtime companion. Respond concisely and warmly while the user speaks.",
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          silence_duration_ms: 350,
          prefix_padding_ms: 200,
          create_response: true,
          interrupt_response: true,
        },
        modalities: ["audio", "text"],
        voice: "verse",
        max_response_output_tokens: 1200,
      },
    };
    channel.send(JSON.stringify(payload));
  }
}
