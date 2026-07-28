import { describe, expect, it } from 'vitest';
import { SPEC_CHANGE_LABELS, isSpecChangeLabel } from './labels.js';
import {
  CROSS_SOURCE_AMBIGUITY_MS,
  compareEvents,
  type TraceEvent,
} from './trace.js';

function ev(partial: Partial<TraceEvent>): TraceEvent {
  return {
    session_id: 's1',
    user_id: 'u1',
    source: 'extension',
    seq: 0,
    ts: 0,
    type: 'edit',
    payload: null,
    ...partial,
  };
}

describe('labels', () => {
  it('has no duplicates (single source of truth would hide a drift)', () => {
    expect(new Set(SPEC_CHANGE_LABELS).size).toBe(SPEC_CHANGE_LABELS.length);
  });

  it('guards unknown strings', () => {
    expect(isSpecChangeLabel('clarifying_question')).toBe(true);
    expect(isSpecChangeLabel('vibes')).toBe(false);
  });
});

describe('compareEvents', () => {
  it('same-source pairs use exact seq, ignoring timestamps', () => {
    // Deliberately contradictory ts: seq must win within a source.
    const a = ev({ seq: 1, ts: 5_000 });
    const b = ev({ seq: 2, ts: 1_000 });
    expect(compareEvents(a, b)).toBe('before');
    expect(compareEvents(b, a)).toBe('after');
  });

  it('cross-source pairs inside the ambiguity band are ambiguous, not guessed', () => {
    const a = ev({ source: 'extension', ts: 10_000 });
    const b = ev({ source: 'chrome', ts: 10_000 + CROSS_SOURCE_AMBIGUITY_MS - 1 });
    expect(compareEvents(a, b)).toBe('ambiguous');
    expect(compareEvents(b, a)).toBe('ambiguous');
  });

  it('cross-source pairs outside the band order by ts', () => {
    const a = ev({ source: 'extension', ts: 10_000 });
    const b = ev({ source: 'chrome', ts: 20_000 });
    expect(compareEvents(a, b)).toBe('before');
    expect(compareEvents(b, a)).toBe('after');
  });

  it('classifier-window scale: a 3m34s gap is unambiguous cross-source', () => {
    // The canonical evidence citation: schema commit at T, question at T+3m34s.
    const save = ev({ source: 'extension', type: 'file_save', ts: 0 });
    const ask = ev({ source: 'chrome', type: 'utterance', ts: 214_000 });
    expect(compareEvents(save, ask)).toBe('before');
  });
});
