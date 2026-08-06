/**
 * Browser voice client — the untested SHELL around tested logic.
 *
 *   mic ──► ScriptProcessor frames ──► presence.js (pure, unit-tested)
 *                    │                        │ speech_start / end / transient
 *                    │ 16k PCM16 chunks       ▼
 *                    └──────────────► ws /voice ──► server relay ──► STT
 *
 *   /api/messages poll (session.js) ──► new turn ──► <audio src=/voice/tts/N>
 *
 * Division of labor is deliberate (eng review issue 3): everything that
 * SCORES — was that speech? did the turn end? — lives in presence.js as pure
 * functions with node tests. This file only owns browser plumbing:
 * getUserMedia, sample transport, playback, and the mute/state UI.
 *
 * No push-to-talk button, by decision: a physical addressing gesture does
 * not exist in a real interview and changes the behavior being measured.
 * The only control is MUTE (press to silence). Muting reports presence DOWN:
 * silence while muted is unobservable, so it must never score as a clean
 * "stayed quiet" — the server contaminates accordingly.
 *
 * Echo: echoCancellation only. Headphones still recommended in the UI copy.
 * There is deliberately NO barge-in (candidate speech never pauses agent
 * audio): interrupting the interviewer is a habit this product should not
 * rehearse, and the old pause had no resume path — one noise blip over the
 * gate permanently amputated the rest of a turn. The inverse courtesy IS
 * kept: a turn arriving mid-candidate-sentence holds until their speech_end.
 *
 * Mic denied / no device is a RUNTIME fallback, not a flag: the session
 * continues text-only with the state chip saying so.
 */

/* global document, window, navigator, fetch, WebSocket, AudioContext */

import {
  DEFAULT_PRESENCE_CFG,
  frameEnergy,
  initialPresence,
  nextNoiseFloor,
  presenceStep,
  speechThreshold,
} from '/client/presence.js';

const TARGET_RATE = 16_000;

export function startVoice({ onState, onAgentAudioWanted }) {
  const state = {
    chip: 'connecting',
    muted: false,
    ws: null,
    ctx: null,
    stream: null,
    presence: initialPresence(),
    // Learned ambient level — the gate adapts to the room instead of
    // streaming a noisy café to STT as "speech" (sess-1785962737985: 38 of
    // 93 segments transcribed to nothing in a noisy environment).
    noiseFloor: 0,
    // ~500ms rolling pre-roll so the first word is not clipped: chunks are
    // buffered while idle and flushed when speech_start confirms.
    preRoll: [],
    speaking: false,
    audioEl: null,
    // A turn that arrived while the candidate was mid-sentence, waiting for
    // their speech_end (or the hold cap) before playing.
    heldSeq: null,
    holdTimer: null,
  };

  const setChip = (chip) => {
    state.chip = chip;
    onState(chip, state.muted);
  };

  const send = (msg) => {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg));
  };

  // ---- downsample float32 @ ctx rate -> PCM16 @ 16k, base64 ----
  function toPcm16Base64(float32, fromRate) {
    const ratio = fromRate / TARGET_RATE;
    const outLen = Math.floor(float32.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = Math.max(-1, Math.min(1, float32[Math.floor(i * ratio)]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    let bin = '';
    const bytes = new Uint8Array(out.buffer);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return window.btoa(bin);
  }

  async function boot() {
    state.ws = new WebSocket(
      (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/voice',
    );
    state.ws.addEventListener('open', async () => {
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        // Runtime fallback: the session works text-only; the chip says why.
        send({ type: 'presence', state: 'down', reason: 'mic unavailable: ' + (e && e.name) });
        setChip('mic unavailable — text only');
        return;
      }
      send({ type: 'presence', state: 'up', reason: 'mic granted' });
      setChip('listening');

      state.ctx = new AudioContext();
      const srcNode = state.ctx.createMediaStreamSource(state.stream);
      const proc = state.ctx.createScriptProcessor(4096, 1, 1);
      srcNode.connect(proc);
      proc.connect(state.ctx.destination);

      proc.onaudioprocess = (e) => {
        if (state.muted) return;
        const samples = e.inputBuffer.getChannelData(0);
        const now = Date.now();
        const frameMs = (samples.length / state.ctx.sampleRate) * 1000;
        const chunk = {
          type: 'audio',
          audio_base_64: toPcm16Base64(samples, state.ctx.sampleRate),
          duration_ms: Math.round(frameMs),
        };

        // Adaptive gate: classify against the learned room floor, then let
        // the floor learn from this frame. Ordering matters — classifying
        // with the pre-update floor keeps a loud first word from raising
        // the bar against itself.
        const energy = frameEnergy(samples);
        const speechFrame = energy > speechThreshold(state.noiseFloor, DEFAULT_PRESENCE_CFG);
        state.noiseFloor = nextNoiseFloor(state.noiseFloor, energy, DEFAULT_PRESENCE_CFG);
        const r = presenceStep(state.presence, speechFrame, now, DEFAULT_PRESENCE_CFG);
        state.presence = r.state;

        if (r.event && r.event.type === 'speech_start') {
          state.speaking = true;
          send({ type: 'speech_start', ts: r.event.ts });
          for (const c of state.preRoll) send(c); // first word lives here
          state.preRoll = [];
          // NO barge-in, by decision: the interviewer's audio always plays
          // to completion. The old pause-on-speech_start had no resume path,
          // so one noise blip over the gate amputated the rest of the turn
          // permanently (reported live from a noisy room) — and interrupting
          // the interviewer is a habit this product should NOT rehearse.
          setChip('hearing you');
        } else if (r.event && r.event.type === 'speech_end') {
          state.speaking = false;
          send({ type: 'speech_end', ts: now });
          setChip('listening');
          playHeldTurn();
        } else if (r.event && r.event.type === 'transient') {
          send({ type: 'transient' });
        }

        if (state.speaking) {
          send(chunk);
        } else {
          state.preRoll.push(chunk);
          const maxPreRoll = Math.ceil(500 / frameMs);
          while (state.preRoll.length > maxPreRoll) state.preRoll.shift();
        }
      };
    });
    state.ws.addEventListener('close', () => setChip('voice link lost — text only'));
  }

  function toggleMute() {
    state.muted = !state.muted;
    if (state.muted) {
      // Mid-sentence mute: flush the boundary honestly, then go dark.
      if (state.speaking) {
        state.speaking = false;
        send({ type: 'speech_end', ts: Date.now() });
      }
      state.presence = initialPresence();
      state.preRoll = [];
      send({ type: 'presence', state: 'down', reason: 'muted by user' });
      setChip('muted');
    } else {
      send({ type: 'presence', state: 'up', reason: 'unmuted' });
      setChip('listening');
    }
    return state.muted;
  }

  /** Session over: release the mic and tear everything down. The server
   *  also ignores late frames, but holding a live mic open after End
   *  Session is wrong on its own terms. */
  function stop() {
    state.muted = true;
    state.heldSeq = null;
    if (state.holdTimer) { clearTimeout(state.holdTimer); state.holdTimer = null; }
    try { if (state.ctx) state.ctx.close(); } catch {}
    try { if (state.stream) state.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (state.ws) state.ws.close(); } catch {}
    try { if (state.audioEl) state.audioEl.pause(); } catch {}
    setChip('ended');
  }

  /** The inverse courtesy of no-barge-in: the interviewer does not START
   *  talking while the candidate is mid-sentence. A turn that arrives
   *  during a speech segment is held and played at speech_end — capped, so
   *  a noisy never-ending segment cannot delay the answer forever. */
  const HOLD_CAP_MS = 3_000;
  function playHeldTurn() {
    if (state.heldSeq === null) return;
    const seq = state.heldSeq;
    state.heldSeq = null;
    if (state.holdTimer) { clearTimeout(state.holdTimer); state.holdTimer = null; }
    playNow(seq);
  }

  function playNow(seq) {
    const el = state.audioEl || (state.audioEl = document.createElement('audio'));
    el.src = '/voice/tts/' + seq;
    setChip('interviewer speaking');
    el.onended = () => setChip(state.muted ? 'muted' : 'listening');
    el.onerror = () => setChip(state.muted ? 'muted' : 'listening');
    el.play().catch(() => {
      /* autoplay blocked: text already rendered, audio resumes on gesture */
    });
    if (onAgentAudioWanted) onAgentAudioWanted(seq);
  }

  /** Called by session.js when a new interviewer turn arrives. */
  function speak(seq) {
    if (state.chip.indexOf('text only') !== -1) return;
    if (state.speaking) {
      // Hold: they are mid-sentence. Newest turn wins if several stack.
      state.heldSeq = seq;
      if (state.holdTimer) clearTimeout(state.holdTimer);
      state.holdTimer = setTimeout(() => {
        state.holdTimer = null;
        playHeldTurn();
      }, HOLD_CAP_MS);
      return;
    }
    playNow(seq);
  }

  boot();
  return { toggleMute, speak, stop };
}
