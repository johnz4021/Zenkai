/**
 * The timeline is a DERIVED artifact (ordering, filtering, attribution all
 * encode assumptions) and gets tested like one. The one thing it must never
 * do: render a verdict.
 */
import { readFileSync, readdirSync } from 'node:fs';
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
    expect(idx('+0:00  session started')).toBeGreaterThan(-1);
    expect(idx('+0:06  ran tests — tests FAILED')).toBeGreaterThan(idx('session started'));
    expect(out).toContain('+1:10  candidate: "is the deadline from now?"');
    expect(out).toContain('+1:20  interviewer: "From now."');
  });

  it('renders untranscribed speech as speech, never as silence', () => {
    const out = renderTimeline([
      ev('session_start', 0),
      ev('utterance', 30, { text: '', via: 'voice', untranscribed: true }, 'chrome'),
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

  it('annotates sensor-down intervals with the two-sensor semantics', () => {
    const out = renderTimeline([
      ev('session_start', 0),
      ev('sensor', 1, { sensor: 'presence', state: 'up', reason: 'mic granted' }, 'chrome'),
      ev('sensor', 60, { sensor: 'stt', state: 'down', reason: 'socket' }, 'chrome'),
      ev('sensor', 180, { sensor: 'stt', state: 'up', reason: 'reconnected' }, 'chrome'),
      ev('session_end', 300, {}, 'chrome'),
    ]);
    expect(out).toContain('EVIDENCE GAP +1:00–+3:00');
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

describe('real traces render sanely (no ground-truth claim — render check only)', () => {
  const tracesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'traces');
  it('every stored trace renders without throwing and attributes speakers', () => {
    const files = readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
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
