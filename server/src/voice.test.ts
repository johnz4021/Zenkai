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

describe('buffering until open (the lost-segment fix, spike 5)', () => {
  it('audio sent while the socket is CONNECTING is flushed on open, in order', () => {
    // The live failure: ws.send() on a connecting socket throws, and the
    // whole first utterance after an idle disconnect vanished.
    const { rt, up } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1_000 });
    rt.handleClientMessage({ type: 'audio', audio_base_64: 'AAA1', duration_ms: 100 });
    rt.handleClientMessage({ type: 'audio', audio_base_64: 'AAA2', duration_ms: 100 });
    rt.handleClientMessage({ type: 'speech_end', ts: 2_000 });
    expect(up.sent).toEqual([]); // nothing raw-sent before open
    up.fire('open');
    expect(up.sent.map((s) => JSON.parse(s))).toEqual([
      { message_type: 'input_audio_chunk', audio_base_64: 'AAA1' },
      { message_type: 'input_audio_chunk', audio_base_64: 'AAA2' },
      { message_type: 'input_audio_chunk', audio_base_64: '', commit: true },
    ]);
  });

  it('a whole segment spoken against a dead socket survives the reconnect', () => {
    const { rt, up, h } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1_000 });
    up.fire('open');
    rt.handleUpstreamMessage(JSON.stringify({ message_type: 'committed_transcript', text: 'first' }));
    up.fire('close'); // vendor idle-close (~15s, code 1000)
    // Next utterance starts on a dead socket — the killer loop.
    rt.handleClientMessage({ type: 'speech_start', ts: 30_000 });
    rt.handleClientMessage({ type: 'audio', audio_base_64: 'BBBB', duration_ms: 100 });
    rt.handleClientMessage({ type: 'speech_end', ts: 31_000 });
    up.fire('open'); // reconnect completes
    rt.handleUpstreamMessage(JSON.stringify({ message_type: 'committed_transcript', text: 'second' }));
    expect(h.utterances).toEqual([
      { text: 'first', ts: 1_000 },
      { text: 'second', ts: 30_000 },
    ]);
  });
});

describe('sensor health into the trace', () => {
  it('an idle close between segments is NORMAL, not an outage', () => {
    const { rt, up, h } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1 });
    up.fire('open');
    rt.handleUpstreamMessage(JSON.stringify({ message_type: 'committed_transcript', text: 'done' }));
    up.fire('close'); // idle close AFTER the segment finished
    expect(h.sensors).toEqual([{ sensor: 'stt', state: 'up', reason: 'connected' }]);
  });

  it('a close MID-SEGMENT is a real loss and says so', () => {
    const { rt, up, h } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1 });
    up.fire('open');
    up.fire('close'); // still mid-segment: no transcript arrived
    expect(h.sensors).toEqual([
      { sensor: 'stt', state: 'up', reason: 'connected' },
      { sensor: 'stt', state: 'down', reason: 'socket closed mid-segment' },
    ]);
  });

  it('vendor error messages surface as sensor evidence instead of vanishing', () => {
    const { rt, up, h } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1 });
    up.fire('open');
    rt.handleUpstreamMessage(JSON.stringify({ message_type: 'quota_exceeded', error: 'out of credits' }));
    expect(h.sensors).toContainEqual({
      sensor: 'stt',
      state: 'down',
      reason: 'quota_exceeded: out of credits',
    });
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

describe('lifecycle: nothing after close', () => {
  it('frames from a still-open tab after finalize are ignored entirely', () => {
    // Measured live: 5 phantom untranscribed utterances landed in the trace
    // minutes AFTER the End Session click.
    const { rt, up, h } = runtime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1_000 });
    up.fire('open');
    rt.close();
    rt.handleClientMessage({ type: 'speech_start', ts: 200_000 });
    rt.handleClientMessage({ type: 'audio', audio_base_64: 'x', duration_ms: 1_000 });
    rt.handleClientMessage({ type: 'speech_end', ts: 201_000 });
    expect(h.utterances).toEqual([]);
    expect(rt.budget.spentUsd()).toBe(0);
  });
});

describe('per-segment sessions + mute-session watchdog (the half-death fix)', () => {
  function freshFactoryRuntime(h = hooks()) {
    const sockets: ReturnType<typeof fakeUpstream>[] = [];
    const rt = new VoiceRuntime(
      {
        apiKey: 'test',
        upstreamFactory: () => {
          const s = fakeUpstream();
          sockets.push(s);
          return s;
        },
      },
      h,
    );
    return { rt, sockets, h };
  }

  it('every segment gets a FRESH upstream session', () => {
    const { rt, sockets } = freshFactoryRuntime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1_000 });
    sockets[0]!.fire('open');
    rt.handleUpstreamMessage(JSON.stringify({ message_type: 'committed_transcript', text: 'one' }));
    rt.handleClientMessage({ type: 'speech_start', ts: 30_000 });
    expect(sockets).toHaveLength(2);
  });

  it('a mute session is declared dead by the watchdog, honestly recorded', () => {
    // The live failure, twice over: audio + commit sent, and the vendor
    // session returns NOTHING — no transcript, no error, no close.
    vi.useFakeTimers();
    try {
      const { rt, sockets, h } = freshFactoryRuntime();
      rt.handleClientMessage({ type: 'speech_start', ts: 1_000 });
      sockets[0]!.fire('open');
      rt.handleClientMessage({ type: 'audio', audio_base_64: 'x', duration_ms: 3_000 });
      rt.handleClientMessage({ type: 'speech_end', ts: 4_000 });
      vi.advanceTimersByTime(VoiceRuntime.WATCHDOG_MS + 1);
      expect(h.utterances).toEqual([{ text: '', ts: 1_000 }]); // recorded, not lost
      expect(h.sensors).toContainEqual({
        sensor: 'stt',
        state: 'down',
        reason: 'unresponsive: commit unanswered for 8s',
      });
      // Next segment must NOT stream into the corpse.
      rt.handleClientMessage({ type: 'speech_start', ts: 60_000 });
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a transcript in time disarms the watchdog — no false outage', () => {
    vi.useFakeTimers();
    try {
      const { rt, sockets, h } = freshFactoryRuntime();
      rt.handleClientMessage({ type: 'speech_start', ts: 1_000 });
      sockets[0]!.fire('open');
      rt.handleClientMessage({ type: 'speech_end', ts: 3_000 });
      rt.handleUpstreamMessage(JSON.stringify({ message_type: 'committed_transcript', text: 'made it' }));
      vi.advanceTimersByTime(VoiceRuntime.WATCHDOG_MS * 2);
      expect(h.utterances).toEqual([{ text: 'made it', ts: 1_000 }]);
      expect(h.sensors.filter((s) => (s as { state: string }).state === 'down')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a LATE event from a rotated-away socket cannot touch the fresh one', () => {
    const { rt, sockets } = freshFactoryRuntime();
    rt.handleClientMessage({ type: 'speech_start', ts: 1_000 });
    sockets[0]!.fire('open');
    rt.handleUpstreamMessage(JSON.stringify({ message_type: 'committed_transcript', text: 'one' }));
    rt.handleClientMessage({ type: 'speech_start', ts: 30_000 });
    sockets[1]!.fire('open');
    sockets[0]!.fire('close'); // abandoned socket dies late
    // The fresh socket must still be live and receiving.
    rt.handleClientMessage({ type: 'audio', audio_base_64: 'y', duration_ms: 100 });
    expect(sockets[1]!.sent.length).toBeGreaterThan(0);
  });
});
