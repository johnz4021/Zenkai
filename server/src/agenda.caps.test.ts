/**
 * The agenda learns the round's capabilities.
 *
 * QA 2026-08-14: on a one-shot round, `verify` went 'none' the moment the
 * candidate edited and stayed there forever — every turn's agenda printed
 * "they have edited but not run the suite since" about a Run button that
 * does not exist, and the prompt told the interviewer to aim probes at it.
 * `approach` keyed on the first FAILING run, which cannot exist on a no-run
 * round, switching off the state-a-theory dimension exactly where thinking
 * aloud is the only signal.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { assessAgenda, renderAgenda } from './agenda.js';

const T0 = 1_700_000_000_000;
const ev = (type: TraceEvent['type'], atMs: number, payload: unknown = {}): TraceEvent =>
  ({ session_id: 's', user_id: 'u1', source: 'chrome', seq: 0, ts: T0 + atMs, type, payload }) as TraceEvent;

const THEORY =
  'I think the rollup misses the second page because the cache key ignores the window offset entirely';

describe('assessAgenda on a no-run round (one_shot / can_run_tests:false)', () => {
  it('verify and reflect are not-applicable, never open gaps', () => {
    const events = [ev('session_start', 0), ev('edit', 60_000, { path: 'solution.py' })];
    const status = assessAgenda(events, T0 + 120_000, { runnable: false });
    expect(status.verify).toBe('na');
    expect(status.reflect).toBe('na');
    expect(renderAgenda(status)).not.toContain('not run the suite');
  });

  it('approach opens from the session start — no failing run is ever coming', () => {
    const events = [
      ev('session_start', 0),
      ev('utterance', 30_000, { text: THEORY }),
      ev('edit', 60_000, { path: 'solution.py' }),
    ];
    expect(assessAgenda(events, T0 + 120_000, { runnable: false }).approach).toBe('some');
  });

  it('editing silently on a no-run round still shows the approach gap', () => {
    const events = [ev('session_start', 0), ev('edit', 60_000, { path: 'solution.py' })];
    expect(assessAgenda(events, T0 + 120_000, { runnable: false }).approach).toBe('none');
  });
});

describe('assessAgenda on a runnable round — unchanged', () => {
  it('verify opens after an edit and closes on a run, exactly as before', () => {
    const edited = [ev('session_start', 0), ev('test_run', 5_000, { exit_code: 1 }), ev('edit', 60_000, {})];
    expect(assessAgenda(edited, T0 + 120_000).verify).toBe('none');
    const ran = [...edited, ev('test_run', 90_000, { exit_code: 1 })];
    expect(assessAgenda(ran, T0 + 120_000).verify).toBe('some');
  });

  it('approach still keys on the first failure', () => {
    const noFail = [ev('session_start', 0), ev('utterance', 30_000, { text: THEORY })];
    expect(assessAgenda(noFail, T0 + 60_000).approach).toBe('na');
    const failed = [
      ev('session_start', 0),
      ev('test_run', 10_000, { exit_code: 1 }),
      ev('utterance', 30_000, { text: THEORY }),
    ];
    expect(assessAgenda(failed, T0 + 60_000).approach).toBe('some');
  });
});
