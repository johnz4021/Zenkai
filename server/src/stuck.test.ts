/**
 * The stuck detector decides when the interviewer is allowed to step in, so
 * its false positives are the expensive kind: interrupting someone mid-thought
 * is the one failure this codebase treats as worse than any latency. These
 * tests pin the SILENCE cases as hard as the firing case. Pure — no model
 * calls, frozen clock (repo convention).
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { STUCK_FLOOR_MS, describeStuck, detectStuck } from './stuck.js';

const T0 = 1_700_000_000_000;
const A = '/p/src/sweep.ts';
const B = '/p/src/reservationService.ts';
const TEST = '/p/test/expiry.test.ts';

/** Minutes-from-start trace DSL, mirroring eval/personas.ts's TraceBuilder. */
class T {
  private events: TraceEvent[] = [];
  private seq = 0;
  private push(type: TraceEvent['type'], min: number, payload: unknown): this {
    this.events.push({
      session_id: 'fixture', user_id: 'u1', source: 'extension',
      seq: this.seq++, ts: T0 + min * 60_000, type, payload,
    });
    return this;
  }
  open(min: number, path: string) { return this.push('file_open', min, { path }); }
  edit(min: number, path: string) { return this.push('edit', min, { path, changes: 3 }); }
  save(min: number, path: string) { return this.push('file_save', min, { path, is_model_path: false }); }
  fail(min: number, summary = 'Ran 15 tests — FAILED (failures=1)') {
    return this.push('test_run', min, { via: 'task', exit_code: 1, duration_ms: 90, summary });
  }
  pass(min: number) { return this.push('test_run', min, { via: 'task', exit_code: 0, duration_ms: 90 }); }
  crashed(min: number) { return this.push('test_run', min, { via: 'task', exit_code: null, duration_ms: 5 }); }
  say(min: number, text: string) { return this.push('utterance', min, { text }); }
  build() { return [...this.events]; }
}

/** Three swings at the same file, all still failing. */
const thrash = () =>
  new T()
    .open(1, A).open(2, TEST)
    .edit(3, A).fail(4)
    .edit(6, A).fail(7)
    .edit(9, A).fail(10);

const at = (min: number) => T0 + min * 60_000;

describe('detectStuck — fires on grinding, not on working', () => {
  it('three edit-and-run cycles in one file is stuck', () => {
    const s = detectStuck(thrash().build(), at(11), T0);
    expect(s).not.toBeNull();
    expect(s!.cycles).toBe(3);
    expect(s!.files_touched).toBe(1);
    expect(s!.since_ms).toBe(at(3)); // the streak's FIRST edit, not the last
    expect(s!.last_summary).toMatch(/failures=1/);
  });

  it('two cycles is normal iteration, not a pattern', () => {
    const two = new T().open(1, A).edit(3, A).fail(4).edit(6, A).fail(7).build();
    expect(detectStuck(two, at(8), T0)).toBeNull();
  });

  it('stays silent inside the opening floor however fast they grind', () => {
    // Same three cycles, compressed into the first four minutes.
    const fast = new T()
      .open(0, A)
      .edit(1, A).fail(1.5)
      .edit(2, A).fail(2.5)
      .edit(3, A).fail(3.5)
      .build();
    expect(detectStuck(fast, at(4), T0)).toBeNull();
    // ...and the identical streak does fire once the floor has passed.
    expect(detectStuck(fast, T0 + STUCK_FLOOR_MS + 1, T0)).not.toBeNull();
  });
});

describe('detectStuck — the silences that matter', () => {
  it('a long read never fires: no runs, no cycles', () => {
    const reading = new T()
      .open(1, TEST).open(3, A).open(6, B).open(9, TEST).say(11, 'still reading')
      .build();
    expect(detectStuck(reading, at(12), T0)).toBeNull();
  });

  it('edits with no test runs are not cycles', () => {
    const edits = new T().open(1, A).edit(3, A).edit(5, A).edit(7, A).edit(9, A).build();
    expect(detectStuck(edits, at(10), T0)).toBeNull();
  });

  it('a passing run resets everything — green is progress', () => {
    const recovered = new T()
      .open(1, A)
      .edit(3, A).fail(4)
      .edit(6, A).fail(7)
      .pass(8)
      .edit(9, A).fail(10)
      .build();
    expect(detectStuck(recovered, at(11), T0)).toBeNull();
  });

  it('opening a new file mid-streak is exploration, not grinding', () => {
    const explored = new T()
      .open(1, A)
      .edit(3, A).fail(4)
      .edit(6, A).fail(7)
      .open(8, B) // went looking somewhere new
      .edit(9, A).fail(10)
      .build();
    expect(detectStuck(explored, at(11), T0)).toBeNull();
  });

  it('editing a DIFFERENT file is a new hypothesis and restarts the count', () => {
    const moved = new T()
      .open(1, A).open(2, B)
      .edit(3, A).fail(4)
      .edit(6, A).fail(7)
      .edit(9, B).fail(10) // same territory? no — different file
      .build();
    expect(detectStuck(moved, at(11), T0)).toBeNull();
  });

  it('re-running without editing anything does not manufacture cycles', () => {
    const spam = new T()
      .open(1, A).edit(3, A)
      .fail(4).fail(5).fail(6).fail(7).fail(8)
      .build();
    expect(detectStuck(spam, at(9), T0)).toBeNull();
  });

  it('a run that never completed proves nothing either way', () => {
    const crashy = new T()
      .open(1, A)
      .edit(3, A).fail(4)
      .edit(6, A).crashed(7)
      .edit(9, A).fail(10)
      .build();
    // Two real cycles; the crashed run neither counts nor resets.
    expect(detectStuck(crashy, at(11), T0)).toBeNull();
  });

  it('re-opening a file they already know is not exploration', () => {
    const reread = new T()
      .open(1, A).open(2, TEST)
      .edit(3, A).fail(4)
      .edit(6, A).fail(7)
      .open(8, TEST) // re-reading the failing test they already opened
      .edit(9, A).fail(10)
      .build();
    expect(detectStuck(reread, at(11), T0)).not.toBeNull();
  });

  it('no session start yet means no clock and no hint', () => {
    expect(detectStuck(thrash().build(), at(11), null)).toBeNull();
  });
});

describe('describeStuck — identity, never names', () => {
  it('describes the shape of the streak without any path', () => {
    const s = detectStuck(thrash().build(), at(11), T0)!;
    const text = describeStuck(s, at(11));
    expect(text).toContain('3 edit-and-run cycles');
    expect(text).toContain('the same file');
    // The buggy filename leaking through an activity feed is a bug this repo
    // has already shipped once — never again through this path.
    expect(text).not.toContain('sweep');
    expect(text).not.toContain('.ts');
    expect(text).not.toContain('/p/');
  });
});
