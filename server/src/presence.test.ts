/**
 * Presence detector against synthetic audio. These frames are the browser's
 * job to produce; whether they MEAN speech is scoring logic and tested here.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESENCE_CFG,
  frameEnergy,
  initialPresence,
  isSpeechFrame,
  presenceStep,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — plain-JS browser module, typed by use
} from './client/presence.js';

// ---- synthetic frames (each "frame" = 32ms of samples at some rate) ----
const SILENCE = new Float32Array(512); // zeros
const NOISE_FLOOR = Float32Array.from({ length: 512 }, () => (Math.random() - 0.5) * 0.005);
const SPEECH = Float32Array.from({ length: 512 }, (_, i) => 0.25 * Math.sin(i / 3));
const LOUD_CLACK = Float32Array.from({ length: 512 }, (_, i) => (i < 100 ? 0.8 : 0));

const FRAME_MS = 32;

/** Run a schedule of frames through the machine, return emitted events. */
function run(frames: { frame: Float32Array; count: number }[]): { type: string; [k: string]: unknown }[] {
  let state = initialPresence();
  let now = 0;
  const events: { type: string }[] = [];
  for (const { frame, count } of frames) {
    for (let i = 0; i < count; i++) {
      now += FRAME_MS;
      const speech = isSpeechFrame(frame, DEFAULT_PRESENCE_CFG);
      const r = presenceStep(state, speech, now, DEFAULT_PRESENCE_CFG);
      state = r.state;
      if (r.event) events.push(r.event);
    }
  }
  return events;
}

describe('frame energy', () => {
  it('silence and room noise stay under the gate', () => {
    expect(isSpeechFrame(SILENCE)).toBe(false);
    expect(isSpeechFrame(NOISE_FLOOR)).toBe(false);
  });

  it('sustained speech-level signal crosses it', () => {
    expect(frameEnergy(SPEECH)).toBeGreaterThan(DEFAULT_PRESENCE_CFG.energyThreshold);
  });
});

describe('presence state machine', () => {
  it('a 50ms keyboard clack is a transient, never speech', () => {
    const events = run([
      { frame: SILENCE, count: 10 },
      { frame: LOUD_CLACK, count: 2 }, // ~64ms of loud transient
      { frame: SILENCE, count: 40 },
    ]);
    expect(events.map((e) => e.type)).toEqual(['transient']);
  });

  it('a sustained word fires speech_start stamped at the BURST start', () => {
    const events = run([
      { frame: SILENCE, count: 10 },
      { frame: SPEECH, count: 15 }, // 480ms ≥ minSpeechMs
      { frame: SILENCE, count: 40 },
    ]);
    const start = events.find((e) => e.type === 'speech_start') as unknown as { ts: number };
    const end = events.find((e) => e.type === 'speech_end') as unknown as { start: number };
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    // The stamp is when sound BEGAN (frame 11 → ts 352ms), not when it
    // crossed the min-duration bar (~640ms). Stamping at the crossing would
    // shave minSpeechMs off every utterance and shift gap arithmetic.
    expect(start.ts).toBe(11 * FRAME_MS);
    expect(end.start).toBe(start.ts);
  });

  it('a short mid-word dip does not end the turn (endpoint is 1s, not a frame)', () => {
    const events = run([
      { frame: SPEECH, count: 15 },
      { frame: SILENCE, count: 10 }, // 320ms dip < endpointMs
      { frame: SPEECH, count: 15 },
      { frame: SILENCE, count: 40 }, // real endpoint
    ]);
    expect(events.filter((e) => e.type === 'speech_end')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'speech_start')).toHaveLength(1);
  });

  it('two utterances separated by real silence are two turns', () => {
    const events = run([
      { frame: SPEECH, count: 15 },
      { frame: SILENCE, count: 40 },
      { frame: SPEECH, count: 15 },
      { frame: SILENCE, count: 40 },
    ]);
    expect(events.filter((e) => e.type === 'speech_start')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'speech_end')).toHaveLength(2);
  });

  it('pure: same inputs, same outputs, no hidden clock', () => {
    const a = run([{ frame: SPEECH, count: 15 }, { frame: SILENCE, count: 40 }]);
    const b = run([{ frame: SPEECH, count: 15 }, { frame: SILENCE, count: 40 }]);
    expect(a).toEqual(b);
  });
});
