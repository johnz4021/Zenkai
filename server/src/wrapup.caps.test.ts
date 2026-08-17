/**
 * Wrap-up on rounds that cannot run — the ending exists everywhere now.
 *
 * QA 2026-08-14: detectWrapSignal required a completed test_run before a
 * done-phrase counted, and a no-run round (one_shot / can_run_tests:false)
 * cannot produce one during the session — so the wrap-up, the evaluation
 * questions and the closing were unreachable even when the candidate said
 * "I'm done". The exact round-just-stops failure this module was built to
 * kill (sess-1786220758002), guaranteed by construction on two round kinds.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { detectWrapSignal, selectWrapTopic } from './wrapup.js';
import type { AgendaStatus } from './agenda.js';
import type { DimensionKey } from '@interview-prep/shared';

const T0 = 1_700_000_000_000;
const ev = (type: TraceEvent['type'], atMs: number, payload: unknown = {}): TraceEvent =>
  ({ session_id: 's', user_id: 'u1', source: 'chrome', seq: 0, ts: T0 + atMs, type, payload }) as TraceEvent;

describe('detectWrapSignal on a no-run round', () => {
  it('a done-phrase after the first edit starts the wrap-up', () => {
    const events = [
      ev('session_start', 0),
      ev('edit', 60_000, { path: 'REVIEW.md' }),
      ev('utterance', 300_000, { text: "I'm done — that's everything I found." }),
    ];
    expect(detectWrapSignal(events, T0 + 301_000)).not.toBeNull();
  });

  it('a done-phrase before any work is still a mic check, not a surrender', () => {
    const events = [
      ev('session_start', 0),
      ev('utterance', 30_000, { text: "we're good, right?" }),
    ];
    expect(detectWrapSignal(events, T0 + 31_000)).toBeNull();
  });

  it('a runnable round with zero runs still wraps on a done-phrase — edits anchor it (sess-1786985531151)', () => {
    // The old runnable-rounds-need-a-run anchor made the wrap-up
    // structurally unreachable on a round where the candidate edited for
    // 8 minutes and never ran the suite.
    const events = [
      ev('session_start', 0),
      ev('edit', 60_000, { path: 'a.py' }),
      ev('utterance', 300_000, { text: "I'm done." }),
    ];
    expect(detectWrapSignal(events, T0 + 301_000)).not.toBeNull();
  });
});

describe('selectWrapTopic — per-kind wording', () => {
  const allOpen = (): Record<DimensionKey, AgendaStatus> =>
    ({ clarify: 'none', approach: 'none', communicate: 'none', implement: 'none', verify: 'none', reflect: 'none' }) as Record<
      DimensionKey,
      AgendaStatus
    >;

  it('a review round asks about flagged concerns, never "the fix"', () => {
    const topic = selectWrapTopic(allOpen(), 0, 'diff_present');
    expect(topic).toContain('flagged concerns');
    expect(topic).not.toContain('the fix');
  });

  it('a build round asks why the implementation is correct', () => {
    expect(selectWrapTopic(allOpen(), 0, 'all_failing')).toContain('implementation is CORRECT');
  });

  it('the debugging wording is unchanged, and unknown kinds fall back to it', () => {
    const debug = selectWrapTopic(allOpen(), 0, 'one_failing_test');
    expect(debug).toContain('ask WHY it works');
    expect(selectWrapTopic(allOpen(), 0, 'something_new')).toBe(debug);
    expect(selectWrapTopic(allOpen(), 0)).toBe(debug);
  });
});
