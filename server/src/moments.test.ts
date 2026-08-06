/**
 * Moments drive unprompted probes, so restraint is the property under test:
 * each fires ONCE, only on its check kind, only when the trace actually
 * shows the moment. An over-eager moment system is the over-speaking
 * failure (Koala, IUI 2025) wearing a new hat.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { FIRST_READ_MS, detectMoment } from './moments.js';

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
