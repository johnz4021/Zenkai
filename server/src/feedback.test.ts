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
  ev('utterance', 70, { text: '', via: 'voice', untranscribed: true }, 'chrome'),
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

  it('flags unreceipted rows so a stripped verdict never passes as evidenced', () => {
    const card = buildAssessmentCard(assessed, view, EVENTS);
    expect(card.rows!.find((r) => r.dimension === 'verify')!.unreceipted).toBe(true);
  });

  it('withholds nothing structurally: bug rides the card, client gates on solved', () => {
    const card = buildAssessmentCard(assessed, view, EVENTS, 'sweep releases original count');
    expect(card.solved).toBe(false);
    expect(card.bug?.description).toContain('sweep');
  });

  it('unassessed is its own state with the rejudge promise, never an empty success', () => {
    const un: Unassessed = { session_id: 's1', status: 'unassessed', judged_at: 1, reason: 'judge timed out twice' };
    const card = buildAssessmentCard(un, view, EVENTS);
    expect(card.state).toBe('unassessed');
    expect(card.reason).toContain('rejudge');
    expect(card.rows).toBeUndefined();
  });
});
