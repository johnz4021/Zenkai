/**
 * Voice runtime: ElevenLabs STT relay + TTS proxy + budget + sensor health.
 *
 *   browser ──ws /voice──► VoiceRuntime ──ws──► ElevenLabs Scribe v2 Realtime
 *     │  speech_start/audio/speech_end │              (xi-api-key, server-side)
 *     │  presence up/down              ▼
 *     │                        committed transcript
 *     │                                │
 *     │                     utterance{via:'voice', ts: SPEECH START}
 *     │                                │
 *     ◄──http /voice/tts/:seq── Flash v2.5 stream (mp3, progressive)
 *
 * Key custody: the ElevenLabs key never reaches the browser — the client
 * speaks only to :3200 and this module holds the vendor connection.
 *
 * Timestamps: an utterance is stamped at speech_start (browser presence
 * detector's burst start), never at transcript arrival. A transcript lands
 * seconds after the words; arrival stamps would shift every utterance by the
 * STT round trip and corrupt gap arithmetic (20s threshold).
 *
 * Sensor health: two independent sensors (presence = browser energy gate,
 * stt = this relay's upstream). State changes are emitted into the TRACE as
 * `sensor` events, so contamination is derived from the same record as
 * everything else. See shared/trace.ts SensorPayload for why two sensors.
 *
 * Budget: hard per-session cap. Published rates: Scribe v2 Realtime
 * $0.0065/min streamed, Flash v2.5 $50/M chars. Warn at 80%; at 100% voice
 * degrades to TEXT with the header saying so — never a silent mute, which
 * produces the exact "is this thing broken?" reaction session one taught us.
 *
 * Everything vendor-shaped is injectable; tests never open a socket.
 */

import { EventEmitter } from 'node:events';

// ---- rates & budget ----

export const STT_USD_PER_MIN = 0.0065;
export const TTS_USD_PER_CHAR = 50 / 1_000_000;
export const DEFAULT_CAP_USD = 1.0;
export const WARN_FRACTION = 0.8;

export interface BudgetState {
  spent_usd: number;
  cap_usd: number;
  warned: boolean;
  exhausted: boolean;
}

export class VoiceBudget {
  private sttMs = 0;
  private ttsChars = 0;
  constructor(readonly capUsd: number = DEFAULT_CAP_USD) {}

  addSttMs(ms: number): void {
    this.sttMs += Math.max(0, ms);
  }
  addTtsChars(chars: number): void {
    this.ttsChars += Math.max(0, chars);
  }
  spentUsd(): number {
    return (this.sttMs / 60_000) * STT_USD_PER_MIN + this.ttsChars * TTS_USD_PER_CHAR;
  }
  state(): BudgetState {
    const spent = this.spentUsd();
    return {
      spent_usd: Number(spent.toFixed(4)),
      cap_usd: this.capUsd,
      warned: spent >= this.capUsd * WARN_FRACTION,
      exhausted: spent >= this.capUsd,
    };
  }
}

// ---- messages from the browser voice client ----

export type ClientVoiceMessage =
  | { type: 'speech_start'; ts: number }
  | { type: 'audio'; audio_base_64: string; duration_ms: number }
  | { type: 'speech_end'; ts: number }
  | { type: 'presence'; state: 'up' | 'down'; reason: string }
  | { type: 'transient' }; // counted for the gate-quality metric, never streamed

// ---- injectable upstream socket (ws-compatible surface) ----

export interface UpstreamSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'close' | 'error', fn: (arg?: unknown) => void): void;
}

export type UpstreamFactory = (url: string, headers: Record<string, string>) => UpstreamSocket;

export interface VoiceHooks {
  /** Write a sensor state change into the trace. */
  emitSensor(sensor: 'presence' | 'stt', state: 'up' | 'down', reason: string): void;
  /**
   * Write a finished spoken utterance into the trace, stamped at speech
   * start. `text === ''` means UNTRANSCRIBED: presence proved sound, STT
   * produced no words. It still enters the trace — it counts as candidate
   * activity (silence is disproven) while contributing nothing to content
   * labels. This is the mechanism behind the two-sensor contamination split.
   */
  emitUtterance(text: string, speechStartTs: number): void;
}

export interface VoiceConfig {
  apiKey: string;
  capUsd?: number;
  sttUrl?: string;
  upstreamFactory?: UpstreamFactory;
  fetchImpl?: typeof fetch;
}

// language_code PINNED, not auto-detected. First judge-era live session:
// with language_code null, short fragments and background noise came back
// as Russian ("Смех"), Turkish, and CJK punctuation — per-segment detection
// hallucinates languages on exactly the fragmented speech this product
// records. Override with IP_STT_LANGUAGE for non-English candidates.
const STT_URL = () =>
  `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=${process.env.IP_STT_LANGUAGE ?? 'en'}`;
const TTS_URL = (voiceId: string, modelId: string) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?model_id=${modelId}&output_format=mp3_44100_64`;
/** "George" — a calm default; overridable per env. */
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
const TTS_MODEL = 'eleven_flash_v2_5';

export class VoiceRuntime extends EventEmitter {
  readonly budget: VoiceBudget;
  readonly health = {
    presence_up: false,
    stt_up: false,
    speech_starts: 0,
    transients: 0,
    transcripts: 0,
    empty_transcripts: 0,
    tts_failures: 0,
  };

  private upstream: UpstreamSocket | null = null;
  private upstreamOpen = false;
  /**
   * Outbound buffer until the upstream socket is OPEN. Spike 5 evidence:
   * ElevenLabs idle-closes the socket after ~15s (code 1000), so almost
   * every utterance after a pause begins on a dead or CONNECTING socket —
   * and ws.send() on a connecting socket THROWS, which silently ate whole
   * segments in the first live session ('Can we...' was the surviving tail
   * of one). Everything queues here and flushes on 'open'.
   */
  private pendingOut: string[] = [];
  private currentSpeechStart: number | null = null;
  private partial = '';
  private closed = false;
  private readonly debug = process.env.IP_VOICE_DEBUG === '1';

  constructor(
    private readonly cfg: VoiceConfig,
    private readonly hooks: VoiceHooks,
  ) {
    super();
    this.budget = new VoiceBudget(cfg.capUsd);
  }

  /** Messages from the browser voice client (parsed JSON). */
  handleClientMessage(msg: ClientVoiceMessage): void {
    // After finalize the session record is closed. Frames from a still-open
    // browser tab must not append phantom utterances to an ended trace
    // (measured live: 5 untranscribed segments landed minutes after the
    // End Session click) — and must not stream to a paid endpoint.
    if (this.closed) return;
    switch (msg.type) {
      case 'presence': {
        this.health.presence_up = msg.state === 'up';
        this.hooks.emitSensor('presence', msg.state, msg.reason);
        return;
      }
      case 'transient': {
        this.health.transients += 1;
        return;
      }
      case 'speech_start': {
        if (this.budget.state().exhausted) return; // degraded: no more streaming
        // Previous segment never got a transcript (hung upstream)? It still
        // happened — flush it as untranscribed before starting the next.
        this.flushUntranscribed();
        this.health.speech_starts += 1;
        this.currentSpeechStart = msg.ts;
        this.partial = '';
        // FRESH upstream session per segment. Measured live: a long-lived
        // session went half-dead after its 4th commit — no transcripts, no
        // errors, no close, socket "open" — and 11 segments of narration
        // streamed into it for two minutes. Long-lived vendor sessions buy
        // idle-close races and silent death; a per-segment session costs one
        // ~150ms handshake that the outbound buffer already hides.
        this.rotateUpstream();
        return;
      }
      case 'audio': {
        if (this.budget.state().exhausted || this.currentSpeechStart === null) return;
        this.budget.addSttMs(msg.duration_ms);
        this.sendUpstream(
          JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: msg.audio_base_64 }),
        );
        return;
      }
      case 'speech_end': {
        if (this.currentSpeechStart === null) return;
        if (!this.upstream) {
          // No socket and none coming: presence heard a segment, record it.
          this.flushUntranscribed();
          return;
        }
        // Commit the segment so the upstream finalizes its transcript.
        // (Buffered like everything else if the socket is still connecting.)
        this.sendUpstream(
          JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true }),
        );
        // Watchdog: a commit that draws NO response — no transcript, no
        // error, no close — within the deadline means the session is mute
        // (the half-death failure mode). Record the segment honestly and
        // kill the socket so the next segment starts clean.
        this.armWatchdog();
        return;
      }
    }
  }

  /** Send now if open, buffer if connecting. NEVER raw-send: ws throws on a
   *  CONNECTING socket, and that throw ate whole segments (spike 5). */
  private sendUpstream(data: string): void {
    if (this.upstream && this.upstreamOpen) {
      try {
        this.upstream.send(data);
      } catch (e) {
        if (this.debug) console.warn('[voice] send failed, buffering:', String(e).slice(0, 120));
        this.pendingOut.push(data);
      }
    } else {
      this.pendingOut.push(data);
    }
    // ~60s of audio at 100ms chunks. If the socket has been down that long
    // the segment is already contaminated evidence; stop hoarding memory.
    while (this.pendingOut.length > 600) this.pendingOut.shift();
  }

  /** Upstream transcript message (parsed). Exposed for tests. */
  handleUpstreamMessage(raw: unknown): void {
    if (this.debug) console.log('[voice] <-', String(raw).slice(0, 300));
    let msg: { message_type?: string; type?: string; text?: string; transcript?: string; error?: string };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return;
    }
    const kind = msg.message_type ?? msg.type ?? '';
    const text = (msg.text ?? msg.transcript ?? '').trim();
    // Vendor errors were silently discarded before spike 5. Every one is
    // sensor evidence: it names why words went missing.
    if (kind.includes('error') || kind === 'quota_exceeded' || kind === 'rate_limited' || kind === 'commit_throttled') {
      this.health.stt_up = this.health.stt_up && kind === 'commit_throttled'; // throttle ≠ dead
      this.hooks.emitSensor('stt', kind === 'commit_throttled' ? 'up' : 'down', `${kind}: ${msg.error ?? ''}`.slice(0, 200));
      return;
    }
    if (kind === 'session_started') return; // handshake ack, healthy
    if (kind.includes('partial')) {
      this.partial = text;
      return;
    }
    if (kind.includes('committed') || kind.includes('final')) {
      this.disarmWatchdog();
      const stamp = this.currentSpeechStart;
      this.currentSpeechStart = null;
      let finalText = text || this.partial;
      this.partial = '';
      // A transcript with no letters in any script ('。', '... ？') is
      // punctuation noise from the recognizer, not words — record the
      // segment as untranscribed speech rather than junk content.
      if (finalText && !/\p{L}/u.test(finalText)) finalText = '';
      if (!finalText) {
        // VAD fired, upstream heard nothing intelligible. Tracked (a high
        // starts-to-empties ratio means the gate streams non-speech) AND
        // recorded as untranscribed — presence proved sound, so this must
        // still count as activity.
        this.health.empty_transcripts += 1;
        this.hooks.emitUtterance('', stamp ?? Date.now());
        return;
      }
      this.health.transcripts += 1;
      this.hooks.emitUtterance(finalText, stamp ?? Date.now());
    }
  }

  /** Emit the in-flight segment as untranscribed, if any. */
  private flushUntranscribed(): void {
    this.disarmWatchdog();
    if (this.currentSpeechStart === null) return;
    const stamp = this.currentSpeechStart;
    this.currentSpeechStart = null;
    this.partial = '';
    this.health.empty_transcripts += 1;
    this.hooks.emitUtterance('', stamp);
  }

  // ---- per-segment session rotation + mute-session watchdog ----

  /** Close the current upstream WITHOUT ceremony and open a fresh one. */
  private rotateUpstream(): void {
    if (this.upstream) {
      // Detach before closing: this is deliberate rotation, and the old
      // socket's close event must not be reported as an outage.
      const old = this.upstream;
      this.upstream = null;
      this.upstreamOpen = false;
      try {
        old.close();
      } catch {
        /* already dead — exactly why we rotate */
      }
    }
    this.ensureUpstream();
  }

  static WATCHDOG_MS = 8_000;
  private watchdog: NodeJS.Timeout | null = null;

  private armWatchdog(): void {
    this.disarmWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.currentSpeechStart === null) return; // answered after all
      this.health.stt_up = false;
      this.hooks.emitSensor(
        'stt',
        'down',
        `unresponsive: commit unanswered for ${VoiceRuntime.WATCHDOG_MS / 1000}s`,
      );
      this.flushUntranscribed();
      // Kill the mute socket so the NEXT segment starts on a fresh one
      // instead of streaming into the void again.
      if (this.upstream) {
        const dead = this.upstream;
        this.upstream = null;
        this.upstreamOpen = false;
        try {
          dead.close();
        } catch {
          /* dead is dead */
        }
      }
    }, VoiceRuntime.WATCHDOG_MS);
    this.watchdog.unref?.();
  }

  private disarmWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private ensureUpstream(): void {
    if (this.upstream || this.closed) return;
    const factory = this.cfg.upstreamFactory;
    if (!factory) {
      this.hooks.emitSensor('stt', 'down', 'no upstream factory (voice disabled?)');
      return;
    }
    try {
      const sock = factory(this.cfg.sttUrl ?? STT_URL(), { 'xi-api-key': this.cfg.apiKey });
      this.upstream = sock;
      this.upstreamOpen = false;
      // Every handler guards on identity: after a rotation, a LATE event
      // from the abandoned socket must not mutate the fresh one's state.
      sock.on('open', () => {
        if (this.upstream !== sock) return;
        this.upstreamOpen = true;
        this.health.stt_up = true;
        this.hooks.emitSensor('stt', 'up', 'connected');
        // Flush everything that arrived while connecting — this is the fix
        // for the lost-segment bug: the first utterance after an idle
        // disconnect lands intact instead of being eaten by the handshake.
        const pending = this.pendingOut;
        this.pendingOut = [];
        for (const data of pending) {
          try {
            sock.send(data);
          } catch {
            this.pendingOut.push(data);
          }
        }
      });
      sock.on('message', (data) => {
        if (this.upstream !== sock) return;
        this.handleUpstreamMessage(data);
      });
      sock.on('close', () => {
        if (this.upstream !== sock) return;
        this.upstreamOpen = false;
        this.health.stt_up = false;
        this.upstream = null;
        // Idle close (~15s, code 1000) is NORMAL vendor behavior, not an
        // outage: nothing was being said, so nothing can have been missed.
        // A mid-segment close IS a loss — flag only that.
        if (!this.closed && this.currentSpeechStart !== null) {
          this.hooks.emitSensor('stt', 'down', 'socket closed mid-segment');
        } else if (this.debug) {
          console.log('[voice] upstream idle-closed (normal)');
        }
      });
      sock.on('error', (err) => {
        if (this.upstream !== sock) return;
        this.upstreamOpen = false;
        this.health.stt_up = false;
        this.hooks.emitSensor('stt', 'down', `socket error: ${String(err).slice(0, 200)}`);
      });
    } catch (e) {
      this.hooks.emitSensor('stt', 'down', `connect failed: ${String(e).slice(0, 200)}`);
    }
  }

  /**
   * Synthesize a COMPLETE interviewer turn. Whole-turn on purpose: the leak
   * guard must see the entire text before anything is emitted, so sentence-
   * by-sentence synthesis ahead of the guard would put leaked audio in the
   * air before redaction could happen. Progressive HTTP streaming of the
   * mp3 recovers most of the latency (playback starts on first bytes).
   */
  async tts(text: string): Promise<{ ok: true; body: ReadableStream<Uint8Array> } | { ok: false; error: string }> {
    if (this.budget.state().exhausted) {
      return { ok: false, error: 'budget exhausted — session degraded to text' };
    }
    const f = this.cfg.fetchImpl ?? fetch;
    try {
      const res = await f(TTS_URL(process.env.IP_TTS_VOICE ?? DEFAULT_VOICE_ID, TTS_MODEL), {
        method: 'POST',
        headers: { 'xi-api-key': this.cfg.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok || !res.body) {
        this.health.tts_failures += 1;
        return { ok: false, error: `tts http ${res.status}` };
      }
      this.budget.addTtsChars(text.length);
      return { ok: true, body: res.body };
    } catch (e) {
      this.health.tts_failures += 1;
      return { ok: false, error: String(e).slice(0, 200) };
    }
  }

  close(): void {
    this.closed = true;
    this.disarmWatchdog();
    this.upstream?.close();
    this.upstream = null;
  }
}
