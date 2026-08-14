import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { buildAssessmentCard } from './feedback.js';
import { buildGraphView, emptyStore } from './gap-graph.js';
import type { Assessment, Unassessed } from './judge.js';

let n = 0;
const T0 = 1_000_000;
const ev = (type: TraceEvent['type'], dtSec: number, payload: unknown = {}, source: TraceEvent['source'] = 'extension'): TraceEvent => ({
  session_id: 's', user_id: 'u', source, seq: n++, ts: T0 + dtSec * 1000, type, payload,
});

const EVENTS = [
  ev('session_start', 0),
  ev('utterance', 50, { text: 'the sweep releases the full count' }, 'chrome'),
  // Inside a genuine STT outage — renderer v2 only honors an empty-text
  // utterance as lost speech when transcription was actually down.
  ev('sensor', 65, { sensor: 'stt', state: 'down', reason: 'socket' }, 'chrome'),
  ev('utterance', 70, { text: '', via: 'voice', untranscribed: true }, 'chrome'),
  ev('sensor', 75, { sensor: 'stt', state: 'up', reason: 'reconnected' }, 'chrome'),
  ev('edit', 90, { path: '/p/src/sweep.ts' }),
];

const view = buildGraphView(emptyStore('u1'));

const assessed: Assessment = {
  session_id: 's1', status: 'assessed', judged_at: 1, model: 'fake', prompt_hash: 'x',
  schema_version: 1, renderer_version: 1,
  expectations_used: {} as Assessment['expectations_used'],
  solved: false, summary: 'shape of the session',
  dimensions: [
    { dimension: 'approach', verdict: 'weak', analysis: 'named a location, not a mechanism', evidence: [50, 90] },
    { dimension: 'communicate', verdict: 'adequate', analysis: 'spoke while working', evidence: [70] },
    { dimension: 'verify', verdict: 'weak', analysis: 'claim without receipt', evidence: [], evidence_stripped: true },
  ],
};

describe('buildAssessmentCard', () => {
  it('pulls verbatim quotes FROM THE TRACE — the judge never wrote them', () => {
    const card = buildAssessmentCard(assessed, view, EVENTS);
    const approach = card.rows!.find((r) => r.dimension === 'approach')!;
    expect(approach.quotes).toEqual([
      { clock: '+0:50', text: '"the sweep releases the full count"' },
      { clock: '+1:30', text: 'edited src/sweep.ts' },
    ]);
  });

  it('renders untranscribed citations honestly, never inventing words', () => {
    const card = buildAssessmentCard(assessed, view, EVENTS);
    const comm = card.rows!.find((r) => r.dimension === 'communicate')!;
    expect(comm.quotes[0]!.text).toBe('[spoke — transcription unavailable]');
  });

  it('a gate-noise phantom cannot photobomb the receipt for real words', () => {
    // The receipt-side half of the phantom fix: the judge cites the real
    // utterance it saw, but a noise empty 0.2s nearer would win nearest-match
    // resolution and render "[spoke — transcription unavailable]" as the
    // quote for words that were actually said — a fabricated receipt on a
    // card whose whole design is receipts.
    const events = [
      ev('session_start', 0),
      ev('sensor', 1, { sensor: 'stt', state: 'up', reason: 'connected' }, 'chrome'),
      ev('utterance', 50.2, { text: '', via: 'voice', untranscribed: true }, 'chrome'),
      ev('utterance', 50.8, { text: 'I think the retry maps by position', via: 'voice' }, 'chrome'),
    ];
    const a: Assessment = {
      ...assessed,
      dimensions: [
        { dimension: 'communicate', verdict: 'adequate', analysis: 'narrated the mechanism', evidence: [50] },
      ],
    };
    const card = buildAssessmentCard(a, view, events);
    const comm = card.rows!.find((r) => r.dimension === 'communicate')!;
    expect(comm.quotes[0]!.text).toBe('"I think the retry maps by position"');
  });

  it('flags unreceipted rows so a stripped verdict never passes as evidenced', () => {
    const card = buildAssessmentCard(assessed, view, EVENTS);
    expect(card.rows!.find((r) => r.dimension === 'verify')!.unreceipted).toBe(true);
  });

  it('withholds nothing structurally: bug rides the card, client gates on solved', () => {
    const card = buildAssessmentCard(assessed, view, EVENTS, 'sweep releases original count');
    expect(card.solved).toBe(false);
    expect(card.bug?.description).toContain('sweep');
  });

  it('unassessed is its own state whose copy promises only what a user can do', () => {
    const un: Unassessed = { session_id: 's1', status: 'unassessed', judged_at: 1, reason: 'judge timed out twice' };
    const card = buildAssessmentCard(un, view, EVENTS);
    expect(card.state).toBe('unassessed');
    // The work is kept and the failure is ours, not theirs. "Rejudge" is a
    // CLI only the founder can run — it must never be the user's next step.
    expect(card.reason).toContain('saved');
    expect(card.reason).not.toContain('rejudge');
    expect(card.rows).toBeUndefined();
  });
});
