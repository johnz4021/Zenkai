import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CAP_USD,
  STT_USD_PER_MIN,
  VoiceBudget,
  VoiceRuntime,
  type UpstreamSocket,
  type VoiceHooks,
} from './voice.js';

function fakeUpstream(): UpstreamSocket & {
  sent: string[];
  fire: (ev: string, arg?: unknown) => void;
} {
  const handlers = new Map<string, ((arg?: unknown) => void)[]>();
  return {
    sent: [],
    send(d: string) {
      this.sent.push(d);
    },
    close() {},
    on(ev, fn) {
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
    },
    fire(ev: string, arg?: unknown) {
      for (const fn of handlers.get(ev) ?? []) fn(arg);
    },
  };
}

function hooks(): VoiceHooks & { sensors: unknown[]; utterances: { text: string; ts: number }[] } {
  const h = {
    sensors: [] as unknown[],
    utterances: [] as { text: string; ts: number }[],
    emitSensor(sensor: string, state: string, reason: string) {
      h.sensors.push({ sensor, state, reason });
    },
    emitUtterance(text: string, ts: number) {
      h.utterances.push({ text, ts });
    },
  };
  return h as ReturnType<typeof hooks>;
}

function runtime(h = hooks(), capUsd?: number) {
  const up = fakeUpstream();
  const rt = new VoiceRuntime(
    { apiKey: 'test', capUsd, upstreamFactory: () => up },
    h,
  );
  return { rt, up, h };
}

describe('utterance stamping', () => {
  it('stamps at SPEECH START, never at transcript arrival', () => {
    const { rt, up, h } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1_000 });
    up.fire('open');
    rt.handleClientMessage({ type: 'audio', audio_base_64: 'AAAA', duration_ms: 2_500 });
    rt.handleClientMessage({ type: 'speech_end', ts: 3_500 });
    // Transcript arrives "seconds later" — the stamp must not move.
    rt.handleUpstreamMessage(
      JSON.stringify({ message_type: 'committed_transcript', text: 'the sweep releases everything' }),
    );
    expect(h.utterances).toEqual([{ text: 'the sweep releases everything', ts: 1_000 }]);
  });

  it('an empty committed transcript still lands as an UNTRANSCRIBED utterance', () => {
    // Presence proved sound; STT heard no words. The segment must still
    // count as activity or a transcription failure fabricates silence.
    const { rt, up, h } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1_000 });
    up.fire('open');
    rt.handleUpstreamMessage(JSON.stringify({ message_type: 'committed_transcript', text: '' }));
    expect(h.utterances).toEqual([{ text: '', ts: 1_000 }]);
    expect(rt.health.empty_transcripts).toBe(1);
  });

  it('speech while STT is dead is flushed untranscribed at speech_end', () => {
    const h = hooks();
    const rt = new VoiceRuntime({ apiKey: 'k' /* no upstreamFactory */ }, h);
    rt.handleClientMessage({ type: 'speech_start', ts: 5_000 });
    rt.handleClientMessage({ type: 'speech_end', ts: 8_000 });
    expect(h.utterances).toEqual([{ text: '', ts: 5_000 }]);
  });

  it('a hung segment is flushed when the next one starts', () => {
    const { rt, up, h } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1_000 });
    up.fire('open');
    // no transcript ever arrives; candidate starts talking again
    rt.handleClientMessage({ type: 'speech_start', ts: 30_000 });
    expect(h.utterances).toEqual([{ text: '', ts: 1_000 }]);
  });

  it('falls back to the last partial when the commit arrives textless', () => {
    const { rt, up, h } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 500 });
    up.fire('open');
    rt.handleUpstreamMessage(JSON.stringify({ message_type: 'partial_transcript', text: 'hold on' }));
    rt.handleUpstreamMessage(JSON.stringify({ message_type: 'committed_transcript' }));
    expect(h.utterances).toEqual([{ text: 'hold on', ts: 500 }]);
  });
});

describe('sensor health into the trace', () => {
  it('upstream lifecycle emits stt up/down sensor events', () => {
    const { rt, up, h } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1 });
    up.fire('open');
    up.fire('close');
    expect(h.sensors).toEqual([
      { sensor: 'stt', state: 'up', reason: 'connected' },
      { sensor: 'stt', state: 'down', reason: 'socket closed' },
    ]);
  });

  it('presence messages (including mute) pass through as sensor events', () => {
    const { rt, h } = runtime();
    rt.handleClientMessage({ type: 'presence', state: 'up', reason: 'mic granted' });
    rt.handleClientMessage({ type: 'presence', state: 'down', reason: 'muted by user' });
    expect(h.sensors.map((s) => (s as { state: string }).state)).toEqual(['up', 'down']);
  });

  it('tracks the gate-quality ratio inputs: starts, transients, transcripts', () => {
    const { rt, up } = runtime();
    rt.handleClientMessage({ type: 'transient' });
    rt.handleClientMessage({ type: 'transient' });
    rt.handleClientMessage({ type: 'speech_start', ts: 1 });
    up.fire('open');
    rt.handleUpstreamMessage(JSON.stringify({ message_type: 'committed_transcript', text: 'hi' }));
    expect(rt.health.transients).toBe(2);
    expect(rt.health.speech_starts).toBe(1);
    expect(rt.health.transcripts).toBe(1);
  });
});

describe('budget', () => {
  it('meters streamed audio and warns at 80%', () => {
    const b = new VoiceBudget(0.01); // 1 cent cap for the test
    // 0.8 cents of STT: 0.008 / 0.0065 per min ≈ 73.8s
    b.addSttMs((0.008 / STT_USD_PER_MIN) * 60_000);
    expect(b.state().warned).toBe(true);
    expect(b.state().exhausted).toBe(false);
  });

  it('at 100% the runtime stops streaming audio — degraded, not silently muted', () => {
    const h = hooks();
    const { rt, up } = runtime(h, 0.0001); // ~0.9s of STT exhausts it
    rt.handleClientMessage({ type: 'speech_start', ts: 1 });
    up.fire('open');
    rt.handleClientMessage({ type: 'audio', audio_base_64: 'x', duration_ms: 60_000 }); // metered, sent, cap blown
    rt.handleClientMessage({ type: 'audio', audio_base_64: 'x', duration_ms: 1_000 }); // dropped
    rt.handleClientMessage({ type: 'speech_start', ts: 2 }); // new segments refused too
    expect(up.sent).toHaveLength(1);
    expect(rt.budget.state().exhausted).toBe(true);
  });

  it('tts refuses when exhausted with a reason the header can show', async () => {
    const { rt } = runtime(hooks(), 0.000001);
    rt.budget.addTtsChars(1_000_000);
    const res = await rt.tts('hello');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('degraded to text');
  });

  it('default cap is a hard ceiling well above a normal session', () => {
    // ~45 min gated session ≈ $0.20; the cap must not clip normal use.
    expect(DEFAULT_CAP_USD).toBeGreaterThanOrEqual(0.5);
  });
});

describe('tts', () => {
  it('meters characters and streams the body through', async () => {
    const body = new ReadableStream<Uint8Array>();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body })) as unknown as typeof fetch;
    const rt = new VoiceRuntime({ apiKey: 'k', fetchImpl }, hooks());
    const res = await rt.tts('twelve chars');
    expect(res.ok).toBe(true);
    expect(rt.budget.spentUsd()).toBeCloseTo(12 * (50 / 1e6), 10);
  });

  it('a vendor 429 comes back as an error, counted in health', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, body: null })) as unknown as typeof fetch;
    const rt = new VoiceRuntime({ apiKey: 'k', fetchImpl }, hooks());
    const res = await rt.tts('x');
    expect(res.ok).toBe(false);
    expect(rt.health.tts_failures).toBe(1);
  });
});
