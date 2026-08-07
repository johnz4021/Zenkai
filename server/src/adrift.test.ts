/**
 * Adrift fires a LOCATION signal, so its false positives are the expensive
 * kind — telling someone the region is spent when the answer is sitting in it
 * is worse than saying nothing at all. These tests pin the silence cases and
 * the suppression inversion as hard as the firing case. Pure, frozen clock
 * (repo convention).
 *
 * The load-bearing fixture is `sess-1786072934316`: the real session where a
 * candidate read `hydrate`'s executor block for fourteen minutes while the
 * fault sat in `_hydrate_one`, said "I quit", and never once tripped
 * detectStuck. Thresholds here are tuned against it, not guessed.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import {
  ADRIFT_FLOOR_MS,
  describeAdrift,
  describeWarm,
  detectAdrift,
  regionContainsAnswer,
} from './adrift.js';

const T0 = 1_700_000_000_000;
const A = '/home/workspace/p-s/hydrator.py';
const B = '/home/workspace/p-s/test_hydrator.py';

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
  focus(min: number, path: string) { return this.push('file_open', min, { path, via: 'focus' }); }
  view(min: number, path: string, start: number, end: number) {
    return this.push('view_range', min, { path, start, end });
  }
  edit(min: number, path: string) { return this.push('edit', min, { path, changes: 3 }); }
  fail(min: number, summary = 'Ran 15 tests — FAILED (failures=1)') {
    return this.push('test_run', min, { via: 'task', exit_code: 1, duration_ms: 90, summary });
  }
  pass(min: number) { return this.push('test_run', min, { via: 'task', exit_code: 0, duration_ms: 9 }); }
  say(min: number, text: string) { return this.push('utterance', min, { text }); }
  build() { return [...this.events]; }
}

const at = (min: number) => T0 + min * 60_000;

/** The shape of the real session: settled in one file, narrating, no edits. */
const circling = () =>
  new T()
    .open(1, A).view(2, A, 235, 262).fail(2)
    .view(6, A, 273, 300)
    .say(7, 'so we submit all the specs into the thread pool')
    .say(8, 'and then as completed, we accept the exception')
    .say(9, 'somehow it seems like we are failing on every single turn');

describe('detectAdrift — fires on circling, stays quiet on working', () => {
  it('one file, no edits, narrating, suite unmoved: adrift', () => {
    const s = detectAdrift(circling().build(), at(10), T0);
    expect(s).not.toBeNull();
    expect(s!.file).toBe(A);
    expect(s!.lineLow).toBe(273);
    expect(s!.lineHigh).toBe(300);
    expect(s!.utterances).toBe(3);
  });

  it('stays silent inside the opening floor however long they read', () => {
    expect(detectAdrift(circling().build(), T0 + ADRIFT_FLOOR_MS - 1_000, T0)).toBeNull();
  });

  it('an edit in the window hands the case to the stuck detector', () => {
    expect(detectAdrift(circling().edit(9.5, A).build(), at(10), T0)).toBeNull();
  });

  it('cross-referencing two files is not circling', () => {
    expect(detectAdrift(circling().open(9.2, B).view(9.3, B, 200, 230).build(), at(10), T0)).toBeNull();
  });

  it('a passing run ends it — green is unambiguous progress', () => {
    expect(detectAdrift(circling().pass(9.5).build(), at(10), T0)).toBeNull();
  });

  it('silence is not adrift: reading hard and being away look identical', () => {
    const quiet = new T()
      .open(1, A).view(2, A, 235, 262).fail(2).view(6, A, 273, 300)
      .say(7, 'hmm');
    expect(detectAdrift(quiet.build(), at(10), T0)).toBeNull();
  });

  it('a changed failure summary means something moved under them', () => {
    // Both runs must land INSIDE the 6-minute window (min 4 onward) — a
    // failure older than the window says nothing about the current stretch.
    const moved = circling()
      .fail(5, 'Ran 15 tests — FAILED (failures=1)')
      .fail(9.4, 'Ran 15 tests — FAILED (failures=3)');
    expect(detectAdrift(moved.build(), at(10), T0)).toBeNull();
  });

  it('the SAME failure repeated inside the window is still circling', () => {
    const same = circling().fail(5).fail(9.4);
    expect(detectAdrift(same.build(), at(10), T0)).not.toBeNull();
  });

  it('opening a second file for the first time inside the window is exploring', () => {
    const exploring = new T()
      .open(1, A).fail(2)
      .view(6, A, 273, 300)
      .say(7, 'let me look at the test').say(8, 'ok').say(9, 'hmm')
      .open(9.5, B);
    expect(detectAdrift(exploring.build(), at(10), T0)).toBeNull();
  });

  it('re-focusing a file they already knew is not exploring', () => {
    const s = detectAdrift(circling().focus(9.5, A).build(), at(10), T0);
    expect(s).not.toBeNull();
  });
});

describe('regionContainsAnswer — the suppression that makes this shippable', () => {
  const state = { file: A, lineLow: 273, lineHigh: 300, since_ms: at(6), utterances: 3 };

  it('the real case: fault at 310, viewport 273-300 — never on screen, so redirect', () => {
    // Pinned deliberately. Any pad >= 10 flips this to warm and the
    // interviewer would ENDORSE the region that cost fourteen minutes.
    expect(regionContainsAnswer(state, 'hydrator.py', 310)).toBe(false);
  });

  it('fault inside the span: they are close, suppress the redirect', () => {
    expect(regionContainsAnswer(state, 'hydrator.py', 288)).toBe(true);
  });

  it('a different file entirely is always safe to close', () => {
    expect(regionContainsAnswer(state, 'executor.py', 288)).toBe(false);
  });

  it('blind (no scroll sensor) assumes close — knowing nothing must not become a confident redirect', () => {
    expect(
      regionContainsAnswer({ ...state, lineLow: null, lineHigh: null }, 'hydrator.py', 310),
    ).toBe(true);
  });

  it('no bug line to compare assumes close', () => {
    expect(regionContainsAnswer(state, 'hydrator.py', null)).toBe(true);
  });

  it('no planted bug at all: nothing to suppress', () => {
    expect(regionContainsAnswer(state, '', 310)).toBe(false);
  });
});

describe('the observations handed to the prompt', () => {
  const state = { file: A, lineLow: 273, lineHigh: 300, since_ms: at(4), utterances: 3 };

  it('describeAdrift names no file and no line — describeStuck\'s rule', () => {
    const out = describeAdrift(state, at(10));
    expect(out).not.toMatch(/hydrator|\.py|273|300/);
    expect(out).toContain('6 minutes');
    expect(out).toContain('not where the answer is');
  });

  it('describeWarm encourages without pointing, and says so explicitly', () => {
    const out = describeWarm(state, at(10));
    expect(out).not.toMatch(/hydrator|\.py|273|300/);
    expect(out).toMatch(/do not point at it/i);
    expect(out).toMatch(/right neighbourhood/i);
  });
});
