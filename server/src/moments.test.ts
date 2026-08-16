/**
 * Moments drive unprompted probes, so restraint is the property under test:
 * each fires ONCE, only on its check kind, only when the trace actually
 * shows the moment. An over-eager moment system is the over-speaking
 * failure (Koala, IUI 2025) wearing a new hat.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { FIRST_READ_MS, detectMoment, detectUrgentMoment } from './moments.js';

const T0 = 1_700_000_000_000;
const ev = (type: TraceEvent['type'], atSec: number, payload: unknown = {}): TraceEvent => ({
  session_id: 's', user_id: 'u1', source: 'extension', seq: 0, ts: T0 + atSec * 1000, type, payload,
});
const fail = (atSec: number) => ev('test_run', atSec, { via: 'task', exit_code: 1 });
const pass = (atSec: number) => ev('test_run', atSec, { via: 'task', exit_code: 0 });
const edit = (atSec: number) => ev('edit', atSec, { path: 'engine.py' });
const open = (atSec: number) => ev('file_open', atSec, { path: 'test_engine.py' });
const none = new Set<string>();
const at = (sec: number) => T0 + sec * 1000;

describe('one_failing_test moments', () => {
  it('first_failure_read: fires after sustained reading of the first failure', () => {
    const events = [fail(10), open(20), open(40)];
    const m = detectMoment(events, 'one_failing_test', none, at(10) + FIRST_READ_MS + 1000)!;
    expect(m.kind).toBe('first_failure_read');
  });

  it('first_failure_read: an edit means they moved past reading — no probe', () => {
    const events = [fail(10), open(20), edit(30)];
    const m = detectMoment(events, 'one_failing_test', none, at(10) + FIRST_READ_MS + 1000);
    expect(m?.kind).not.toBe('first_failure_read');
  });

  it('first_failure_read: too early to call it reading', () => {
    expect(detectMoment([fail(10)], 'one_failing_test', none, at(20))).toBeNull();
  });

  it('first_fix_ran: the first run after an edit, pass or fail', () => {
    const failedAttempt = [fail(10), edit(60), fail(90)];
    expect(detectMoment(failedAttempt, 'one_failing_test', none, at(91))!.kind).toBe('first_fix_ran');
    expect(detectMoment(failedAttempt, 'one_failing_test', none, at(91))!.observation).toContain('still fails');
    const passedAttempt = [fail(10), edit(60), pass(90)];
    expect(detectMoment(passedAttempt, 'one_failing_test', none, at(91))!.observation).toContain('PASSED');
  });

  it('pass_after_struggle needs at least two failures first', () => {
    // first_fix_ran/first_failure_read already fired (in the set) — a pass
    // after ONE failure is a clean solve, not a struggle.
    const fired = new Set(['first_fix_ran', 'first_failure_read']);
    expect(detectMoment([fail(10), edit(20), pass(50)], 'one_failing_test', fired, at(60))).toBeNull();
    const m = detectMoment([fail(10), fail(30), edit(40), pass(50)], 'one_failing_test', fired, at(60))!;
    expect(m.kind).toBe('pass_after_struggle');
    expect(m.observation).toContain('2 failing runs');
  });

  it('each moment fires once — the fired set suppresses re-detection', () => {
    const events = [fail(10), open(20)];
    const fired = new Set(['first_failure_read']);
    expect(detectMoment(events, 'one_failing_test', fired, at(10) + FIRST_READ_MS + 1000)).toBeNull();
  });

  it('edit_without_theory: first edit with no stated mechanism, before its run', () => {
    const silent = [fail(10), edit(60)];
    const m = detectMoment(silent, 'one_failing_test', none, at(70))!;
    expect(m.kind).toBe('edit_without_theory');
    expect(m.observation).toContain('without having said');
  });

  it('edit_without_theory: a stated theory before the edit disarms it', () => {
    const theory = ev('utterance', 40, {
      text: 'I think the retry loop drops the record because the index never resets there',
    });
    expect(detectMoment([fail(10), theory, edit(60)], 'one_failing_test', none, at(70))).toBeNull();
  });

  it('edit_without_theory: once the run completed, first_fix_ran owns the beat', () => {
    const m = detectMoment([fail(10), edit(60), fail(90)], 'one_failing_test', none, at(95))!;
    expect(m.kind).toBe('first_fix_ran');
  });

  it('reran_without_change: same suite twice with nothing edited between', () => {
    // Run #2 right after the kickoff is exempt (looking at output again);
    // run #3 with nothing changed since #2 is re-running and hoping.
    const rerunAfterKickoff = [fail(10), fail(40)];
    const fired = new Set(['first_failure_read']);
    expect(detectMoment(rerunAfterKickoff, 'one_failing_test', fired, at(50))).toBeNull();
    const hoping = [fail(10), fail(40), fail(70)];
    const m = detectMoment(hoping, 'one_failing_test', fired, at(75))!;
    expect(m.kind).toBe('reran_without_change');
  });

  it('reran_without_change: an edit or save between runs is a real attempt', () => {
    const fired = new Set(['first_failure_read', 'edit_without_theory', 'first_fix_ran']);
    const attempted = [fail(10), fail(40), edit(50), fail(70)];
    expect(detectMoment(attempted, 'one_failing_test', fired, at(75))).toBeNull();
  });
});

describe('all_failing moments', () => {
  it('first_run fires on the first completed run; first_pass on green after red', () => {
    expect(detectMoment([fail(10)], 'all_failing', none, at(20))!.kind).toBe('first_run');
    const fired = new Set(['first_run']);
    expect(detectMoment([fail(10), pass(60)], 'all_failing', fired, at(70))!.kind).toBe('first_pass');
    // A pass with no failure before it is not a "first_pass" story.
    expect(detectMoment([pass(10)], 'all_failing', fired, at(20))).toBeNull();
  });
});

describe('kinds with no mechanical moments', () => {
  it('all_passing and diff_present return null in v1', () => {
    const events = [fail(10), pass(20)];
    expect(detectMoment(events, 'all_passing', none, at(30))).toBeNull();
    expect(detectMoment(events, 'diff_present', none, at(30))).toBeNull();
  });
});

describe('urgent — a green suite is the climax and bypasses cadence (session.ts)', () => {
  it('first_fix_ran is urgent only when it PASSED', () => {
    const passed = detectMoment([fail(10), edit(60), pass(90)], 'one_failing_test', none, at(95))!;
    expect(passed.kind).toBe('first_fix_ran');
    expect(passed.urgent).toBe(true);
    const failed = detectMoment([fail(10), edit(60), fail(90)], 'one_failing_test', none, at(95))!;
    expect(failed.kind).toBe('first_fix_ran');
    expect(failed.urgent).toBeUndefined();
  });

  it('pass_after_struggle is urgent', () => {
    const fired = new Set(['first_failure_read', 'edit_without_theory', 'first_fix_ran']);
    const m = detectMoment(
      [fail(10), edit(20), fail(30), edit(40), pass(50)],
      'one_failing_test', fired, at(55),
    )!;
    expect(m.kind).toBe('pass_after_struggle');
    expect(m.urgent).toBe(true);
  });

  it('first_pass (all_failing) is urgent', () => {
    const m = detectMoment([fail(10), pass(60)], 'all_failing', new Set(['first_run']), at(65))!;
    expect(m.kind).toBe('first_pass');
    expect(m.urgent).toBe(true);
  });

  it('first_run (all_failing) is not urgent — nothing went green', () => {
    const m = detectMoment([fail(10)], 'all_failing', none, at(15))!;
    expect(m.kind).toBe('first_run');
    expect(m.urgent).toBeUndefined();
  });
});

describe('detectUrgentMoment — a stale unfired moment must not mask the pass', () => {
  it('returns the green moment even while first_failure_read is still pending', () => {
    // No edits ever traced (a real live-probe shape): first_failure_read
    // stays pending forever and detectMoment returns it — but the suite
    // just went green after two failures, and THAT is the moment.
    const events = [fail(10), fail(60), pass(120)];
    expect(detectMoment(events, 'one_failing_test', none, at(125))!.kind).toBe('first_failure_read');
    const urgent = detectUrgentMoment(events, 'one_failing_test', none)!;
    expect(urgent.kind).toBe('pass_after_struggle');
    expect(urgent.urgent).toBe(true);
  });

  it('a first fix that still FAILS is not urgent and does not mask a later pass', () => {
    const events = [fail(10), edit(20), fail(30), fail(60), pass(90)];
    const urgent = detectUrgentMoment(events, 'one_failing_test', none)!;
    expect(urgent.kind).toBe('pass_after_struggle');
  });

  it('nothing green yet → null', () => {
    expect(detectUrgentMoment([fail(10), edit(20), fail(30)], 'one_failing_test', none)).toBeNull();
  });

  it('respects the fired set like every moment', () => {
    const events = [fail(10), fail(60), pass(120)];
    expect(detectUrgentMoment(events, 'one_failing_test', new Set(['pass_after_struggle']))).toBeNull();
  });
});
