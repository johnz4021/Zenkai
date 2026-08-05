/**
 * Presence detection + endpointing. PURE — no browser APIs, no clocks.
 *
 *   samples ──► frameEnergy ──► isSpeechFrame ─┐
 *                                              ▼
 *   state ──────────────────────────────► presenceStep ──► { state', event }
 *
 * Runs in the BROWSER (imported by voice.js as an ES module) but is scoring
 * logic: it decides whether the candidate was speaking, which decides
 * whether `inactivity` fires, which feeds the gap graph. So it lives here
 * as pure functions and is unit-tested in node with synthetic audio — the
 * same seam as UtteranceJudge and pendingAfter() (eng review issue 3).
 *
 * Why this and not a plain amplitude gate wired straight to the mic: the
 * candidate is TYPING all session. A mechanical keyboard clack is a loud
 * ~50ms transient; real speech sustains for hundreds of ms. The min-duration
 * requirement is what keeps keystroke noise from streaming to a paid STT
 * endpoint and being scored as narration. (Silero VAD stays deferred until
 * the activations-vs-transcripts metric says the cheap gate is not enough —
 * see TODOS.md #3.)
 *
 * State machine:
 *
 *   idle ──energy──► maybe ──sustained ≥ minSpeechMs──► speaking
 *     ▲               │ energy gone before minSpeechMs        │
 *     └── transient ──┘                    silence ≥ endpointMs│
 *     ▲                                                       │
 *     └────────────────── speech_end ─────────────────────────┘
 */

export const DEFAULT_PRESENCE_CFG = {
  /** RMS energy above this counts as a live frame — the QUIET-ROOM floor.
   *  In a noisy room the adaptive noise floor below takes over. */
  energyThreshold: 0.015,
  /** Sustained energy shorter than this is a transient (keystroke), not speech. */
  minSpeechMs: 300,
  /** This much silence after speech closes the turn. */
  endpointMs: 1000,
  /** Speech must clear the learned noise floor by this multiple. */
  noiseFloorFactor: 2.5,
  /** Per-frame EMA rate at which the floor leaks UP toward sustained sound.
   *  ~0.02 at ~85ms frames ≈ a few seconds to learn a constant hum. */
  noiseFloorRise: 0.02,
  /** The floor never learns past this — a room so loud it masks speech is
   *  not something a gate can fix, and an uncapped floor could gate a
   *  LOUD speaker out mid-monologue. */
  noiseFloorMax: 0.05,
};

/**
 * Minimum-statistics noise-floor estimate (live failure, sess-1785962737985:
 * a noisy room + the fixed 0.015 threshold produced 38 empty transcripts out
 * of 93 segments — ambient noise flickering over the constant threshold was
 * streamed to STT as "speech", transcribed to nothing, and rendered as
 * "transcription unavailable"; the candidate asked "can you hear me?" four
 * times at a working microphone).
 *
 * The estimator: snap DOWN to any quieter frame instantly, leak UP slowly
 * toward sustained sound. Real speech is full of sub-floor dips (inter-word
 * gaps, breaths) that keep re-anchoring the floor low; a constant hum has
 * none, so the floor climbs to it within seconds and the gate stops
 * mistaking it for a voice. Pure — call once per frame.
 */
export function nextNoiseFloor(floor, energy, cfg = DEFAULT_PRESENCE_CFG) {
  if (energy < floor) return energy;
  return Math.min(cfg.noiseFloorMax, floor + (energy - floor) * cfg.noiseFloorRise);
}

/** The effective gate: the quiet-room constant, or the learned floor times
 *  the clearance factor — whichever is higher. */
export function speechThreshold(floor, cfg = DEFAULT_PRESENCE_CFG) {
  return Math.max(cfg.energyThreshold, floor * cfg.noiseFloorFactor);
}

/** Root-mean-square energy of a sample frame (Float32Array or number[]). */
export function frameEnergy(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Fixed-threshold classification — quiet-room path, kept for callers
 *  without a noise-floor estimate. The voice client uses the adaptive
 *  threshold via frameEnergy + speechThreshold instead. */
export function isSpeechFrame(samples, cfg = DEFAULT_PRESENCE_CFG) {
  return frameEnergy(samples) > cfg.energyThreshold;
}

export function initialPresence() {
  return { phase: 'idle', burstStartMs: 0, lastSpeechMs: 0 };
}

/**
 * Advance the state machine by one frame.
 * Returns { state, event } where event is one of:
 *   null
 *   { type: 'speech_start', ts }            ts = when the BURST began, not
 *                                           when it crossed minSpeechMs —
 *                                           this is the speech_start_ts that
 *                                           stamps the utterance event.
 *   { type: 'speech_end', start, end }
 *   { type: 'transient', ts }               counted, never streamed.
 */
export function presenceStep(state, speechFrame, nowMs, cfg = DEFAULT_PRESENCE_CFG) {
  switch (state.phase) {
    case 'idle':
      if (speechFrame) {
        return { state: { phase: 'maybe', burstStartMs: nowMs, lastSpeechMs: nowMs }, event: null };
      }
      return { state, event: null };

    case 'maybe':
      if (speechFrame) {
        const sustained = nowMs - state.burstStartMs;
        if (sustained >= cfg.minSpeechMs) {
          return {
            state: { phase: 'speaking', burstStartMs: state.burstStartMs, lastSpeechMs: nowMs },
            event: { type: 'speech_start', ts: state.burstStartMs },
          };
        }
        return { state: { ...state, lastSpeechMs: nowMs }, event: null };
      }
      // Energy died before minSpeechMs: a clack, not a word.
      if (nowMs - state.lastSpeechMs >= cfg.endpointMs) {
        return {
          state: { phase: 'idle', burstStartMs: 0, lastSpeechMs: 0 },
          event: { type: 'transient', ts: state.burstStartMs },
        };
      }
      return { state, event: null };

    case 'speaking':
      if (speechFrame) {
        return { state: { ...state, lastSpeechMs: nowMs }, event: null };
      }
      if (nowMs - state.lastSpeechMs >= cfg.endpointMs) {
        return {
          state: { phase: 'idle', burstStartMs: 0, lastSpeechMs: 0 },
          event: { type: 'speech_end', start: state.burstStartMs, end: state.lastSpeechMs },
        };
      }
      return { state, event: null };

    default:
      return { state: initialPresence(), event: null };
  }
}
