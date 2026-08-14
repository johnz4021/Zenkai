/**
 * The timeline is a DERIVED artifact (ordering, filtering, attribution all
 * encode assumptions) and gets tested like one. The one thing it must never
 * do: render a verdict.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { TOKEN_CEILING, eventAtOffset, renderTimeline, sensorDownIntervals } from './timeline.js';

let n = 0;
const T0 = 1_000_000;
const ev = (type: TraceEvent['type'], dtSec: number, payload: unknown = {}, source: TraceEvent['source'] = 'extension'): TraceEvent => ({
  session_id: 's', user_id: 'u', source, seq: n++, ts: T0 + dtSec * 1000, type, payload,
});

describe('renderTimeline', () => {
  it('renders offsets, attribution, and ordering by ts', () => {
    const out = renderTimeline([
      ev('utterance', 70, { text: 'is the deadline from now?' }, 'chrome'),
      ev('session_start', 0),
      ev('test_run', 6, { exit_code: 1 }),
      ev('interviewer', 80, { text: 'From now.', kind: 'answer', nudge: false }, 'chrome'),
    ]);
    const idx = (s: string) => out.indexOf(s);
    expect(idx('+0s  session started')).toBeGreaterThan(-1);
    expect(idx('+6s  ran tests — tests FAILED')).toBeGreaterThan(idx('session started'));
    expect(out).toContain('+70s  candidate: "is the deadline from now?"');
    expect(out).toContain('+80s  interviewer: "From now."');
  });

  it('untranscribed speech during an STT outage renders as speech, never as silence', () => {
    const out = renderTimeline([
      ev('session_start', 0),
      ev('sensor', 20, { sensor: 'stt', state: 'down', reason: 'socket' }, 'chrome'),
      ev('utterance', 30, { text: '', via: 'voice', untranscribed: true }, 'chrome'),
      ev('sensor', 40, { sensor: 'stt', state: 'up', reason: 'reconnected' }, 'chrome'),
    ]);
    expect(out).toContain('[spoke — transcription unavailable]');
  });

  it('empty utterances while STT is healthy are gate noise and never reach the judge', () => {
    // The v1 renderer turned every empty-text utterance into a "spoke" line.
    // Live data: 28% of all gate activations across the first 17 sessions
    // returned no words with STT up the whole time — background noise, which
    // the judge then cited as "long stretches transcription-unavailable" in
    // real communicate verdicts. STT up + no words = the recognizer ran and
    // heard nothing; that is not speech and must not render as it.
    const out = renderTimeline([
      ev('session_start', 0),
      ev('sensor', 1, { sensor: 'stt', state: 'up', reason: 'connected' }, 'chrome'),
      ev('utterance', 30, { text: '', via: 'voice', untranscribed: true }, 'chrome'),
      ev('utterance', 60, { text: 'the real narration', via: 'voice' }, 'chrome'),
    ]);
    expect(out).not.toContain('transcription unavailable');
    expect(out).toContain('"the real narration"');
  });

  it('a segment that STRADDLES the outage start is kept — membership is by overlap', () => {
    // Watchdog flushes: speech begins, the socket dies mid-segment, the down
    // marker lands, THEN the empty utterance is flushed with speech_start_ts
    // pointing back before the outage. The event ts alone would also pass
    // here, but speech_start_ts is the timestamp that carries the segment's
    // true extent — this pins the overlap rule so a flush-path reorder can't
    // silently start dropping genuine losses.
    const out = renderTimeline([
      ev('session_start', 0),
      ev('sensor', 50, { sensor: 'stt', state: 'down', reason: 'unresponsive' }, 'chrome'),
      ev('utterance', 55, { text: '', via: 'voice', untranscribed: true, speech_start_ts: T0 + 45_000 }, 'chrome'),
      ev('sensor', 60, { sensor: 'stt', state: 'up', reason: 'reconnected' }, 'chrome'),
    ]);
    expect(out).toContain('[spoke — transcription unavailable]');
  });

  it('marks nudges inline so the judge knows what was prompted', () => {
    const out = renderTimeline([
      ev('session_start', 0),
      ev('interviewer', 10, { text: 'look at the index again', nudge: true }, 'chrome'),
      ev('interviewer', 20, { text: '12 minutes left.', nudge: false }, 'chrome'),
    ]);
    expect(out).toContain('look at the index again" [NUDGE');
    expect(out).not.toContain('12 minutes left." [NUDGE');
  });

  it('acks never reach the judge — content-free lines are dropped like sensors', () => {
    // An ack carries zero signal by construction; rendering it would add an
    // uncompressible line AND flush low-signal compression runs.
    const out = renderTimeline([
      ev('session_start', 0),
      ev('interviewer', 10, { text: 'Mm-hm.', kind: 'ack', nudge: false }, 'chrome'),
      ev('interviewer', 20, { text: 'What is your theory?', kind: 'probe', nudge: false }, 'chrome'),
    ]);
    expect(out).not.toContain('Mm-hm');
    expect(out).toContain('What is your theory?');
  });

  it('annotates sensor-down intervals with the two-sensor semantics', () => {
    const out = renderTimeline([
      ev('session_start', 0),
      ev('sensor', 1, { sensor: 'presence', state: 'up', reason: 'mic granted' }, 'chrome'),
      ev('sensor', 60, { sensor: 'stt', state: 'down', reason: 'socket' }, 'chrome'),
      ev('sensor', 180, { sensor: 'stt', state: 'up', reason: 'reconnected' }, 'chrome'),
      ev('session_end', 300, {}, 'chrome'),
    ]);
    expect(out).toContain('EVIDENCE GAP +60s–+180s');
    expect(out).toContain('never WHAT they said');
  });

  it('an open-ended sensor outage annotates to end of session', () => {
    const out = renderTimeline([
      ev('session_start', 0),
      ev('sensor', 30, { sensor: 'presence', state: 'down', reason: 'mic denied' }, 'chrome'),
      ev('session_end', 90, {}, 'chrome'),
    ]);
    expect(out).toContain('end of session');
    expect(out).toContain('Silence in this stretch proves nothing');
  });

  it('skips legacy pause verdicts and raw sensor lines', () => {
    const out = renderTimeline([
      ev('session_start', 0),
      ev('pause', 20, { silence_ms: 20000 }),
      ev('sensor', 25, { sensor: 'stt', state: 'up', reason: 'connected' }, 'chrome'),
    ]);
    expect(out).not.toContain('pause');
    expect(out).not.toContain('connected');
  });

  it('never renders a verdict word about the candidate', () => {
    // The renderer states what happened; judgment belongs to the judge.
    const out = renderTimeline([
      ev('session_start', 0),
      ev('test_run', 5, { exit_code: 1 }),
      ev('edit', 8, { path: '/p/src/a.ts' }),
      ev('session_end', 400, {}, 'chrome'),
    ]);
    for (const verdict of ['went silent', 'inactivity', 'immediate', 'before thinking', 'weak', 'failed to']) {
      expect(out.toLowerCase()).not.toContain(verdict);
    }
  });

  it('handles the empty session', () => {
    expect(renderTimeline([])).toContain('empty session');
  });

  it('compresses low-signal runs above the token ceiling, keeping speech intact', () => {
    const events: TraceEvent[] = [ev('session_start', 0)];
    for (let i = 1; i < 4000; i++) events.push(ev('edit', i, { path: `/p/src/file${i % 7}.ts` }));
    events.push(ev('utterance', 4001, { text: 'the important sentence' }, 'chrome'));
    const out = renderTimeline(events);
    expect(out.length / 4).toBeLessThan(TOKEN_CEILING * 1.2);
    expect(out).toContain('compressed');
    expect(out).toContain('the important sentence');
  });
});

describe('eventAtOffset (citation resolution)', () => {
  const events = [
    ev('session_start', 0),
    ev('utterance', 50, { text: 'hm' }, 'chrome'),
    ev('edit', 120, { path: 'a.ts' }),
  ];

  it('resolves an exact citation', () => {
    expect(eventAtOffset(events, 50)?.type).toBe('utterance');
  });

  it('tolerates ±2s, no more — sloppy citations must not adopt neighbors', () => {
    expect(eventAtOffset(events, 51)?.type).toBe('utterance');
    expect(eventAtOffset(events, 80)).toBeNull();
  });
});

describe('editor-down reliability annotation', () => {
  // Regression: a session whose extension never connected recorded 67
  // utterances and zero editor events. That reads identically to a candidate
  // who never opened a file, and the judge would write weak implement/verify
  // gaps into the memory layer on the strength of an instrument failure.
  it('announces instrument failure when the extension contributed nothing', () => {
    const out = renderTimeline([
      ev('session_start', 0, {}, 'chrome'),
      ev('utterance', 10, { text: 'let me look at the ledger' }, 'chrome'),
      ev('utterance', 40, { text: 'still reading' }, 'chrome'),
      ev('session_end', 60, {}, 'chrome'),
    ]);
    expect(out).toContain('RELIABILITY: the editor sent NO events');
    expect(out).toContain('unassessable');
  });

  it('stays silent when the editor produced even one event', () => {
    const out = renderTimeline([
      ev('session_start', 0, {}, 'chrome'),
      ev('utterance', 10, { text: 'running it' }, 'chrome'),
      ev('test_run', 12, { exit_code: 1 }),
    ]);
    expect(out).not.toContain('RELIABILITY: the editor sent NO events');
  });

  it('does not count speech or interviewer turns as editor activity', () => {
    const out = renderTimeline([
      ev('session_start', 0, {}, 'chrome'),
      ev('interviewer', 20, { text: 'What are you seeing?', kind: 'probe', nudge: true }, 'chrome'),
      ev('utterance', 25, { text: 'an assertion error' }, 'chrome'),
    ]);
    expect(out).toContain('RELIABILITY: the editor sent NO events');
  });
});

describe('real traces render sanely (no ground-truth claim — render check only)', () => {
  const tracesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'traces');
  it('every stored trace renders without throwing and attributes speakers', () => {
    // traces/ is gitignored local session data: absent in a fresh clone, a
    // git worktree, or CI. Assert over whatever is here, and skip cleanly
    // when there is nothing — a corpus check must not fail for lack of a
    // corpus.
    if (!existsSync(tracesDir)) return;
    const files = readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) return;
    for (const f of files) {
      const events = readFileSync(path.join(tracesDir, f), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as TraceEvent);
      const out = renderTimeline(events);
      expect(out).toContain('SESSION TIMELINE');
    }
  });
});

describe('test_run pass counts (renderer v3)', () => {
  it('renders X/Y when the payload carries counts, per via verb', () => {
    const events: TraceEvent[] = [
      ev('session_start', 0),
      ev('test_run', 10, { exit_code: 1, via: 'panes', passed: 5, total: 8 }),
      ev('test_run', 20, { exit_code: 1, via: 'submit', passed: 14, total: 16 }),
    ];
    const out = renderTimeline(events);
    expect(out).toContain('ran tests — 5/8 tests passed');
    expect(out).toContain('submitted — 14/16 tests passed');
  });

  it('falls back to the binary line for old traces without counts', () => {
    const out = renderTimeline([ev('session_start', 0), ev('test_run', 5, { exit_code: 1 })]);
    expect(out).toContain('ran tests — tests FAILED');
  });
});
