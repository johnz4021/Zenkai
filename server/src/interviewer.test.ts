import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REDACTED_REPLY,
  bugContext,
  guard,
  leaksBugLocation,
  parseTurn,
  render,
  renderActivity,
} from './interviewer.js';
import type { GeneratedProblem, TraceEvent } from '@interview-prep/shared';

const BUG_FILE = 'src/reservationService.ts';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('leak guard — the never-reveal rule, mechanically', () => {
  it('catches the full path', () => {
    expect(leaksBugLocation('Have a look at src/reservationService.ts.', BUG_FILE)).toBe(true);
  });

  it('catches the bare filename', () => {
    expect(leaksBugLocation('reservationService.ts is where I would start', BUG_FILE)).toBe(true);
  });

  it('catches the stem however the model cased it', () => {
    expect(leaksBugLocation('the ReservationService is worth re-reading', BUG_FILE)).toBe(true);
  });

  it('does NOT block domain vocabulary the spec itself uses', () => {
    // debugging-001's bug is about extend() and the expiry index. Both words
    // are in the spec, so a legitimate spec answer must survive the guard.
    const answer =
      'Extending a hold moves the deadline forward from the current time, not from the original deadline.';
    expect(leaksBugLocation(answer, BUG_FILE)).toBe(false);
  });

  it('does not fire on a substring inside a longer word', () => {
    expect(leaksBugLocation('that behavior is not serviceable here', 'src/service.ts')).toBe(false);
  });

  it('replaces a leaking reply instead of sending it', () => {
    const leaked = { say: 'Check reservationService.ts line 66', kind: 'answer' as const, nudge: true };
    const out = guard(leaked, BUG_FILE);
    expect(out.say).toBe(REDACTED_REPLY);
    expect(out.redacted).toBe(true);
    expect(out.nudge).toBe(false);
  });

  it('passes a clean reply through untouched', () => {
    const clean = { say: 'What makes you suspect that?', kind: 'probe' as const, nudge: false };
    expect(guard(clean, BUG_FILE)).toEqual(clean);
  });

  it('redacts an UNPROMPTED leak to silence, not to a decline', () => {
    // A decline answers a question. Volunteering one out of nowhere is both a
    // non-sequitur and a tell that the agent nearly named a location.
    const leaked = { say: 'You have been in reservationService.ts a while', kind: 'pressure' as const, nudge: true };
    const out = guard(leaked, BUG_FILE, false);
    expect(out.say).toBe('');
    expect(out.kind).toBe('silent');
    expect(out.redacted).toBe(true);
  });
});

describe('parseTurn', () => {
  it('reads the JSON contract', () => {
    const t = parseTurn('{"say":"12 minutes left. Leading theory?","kind":"pressure","nudge":false}');
    expect(t).toEqual({ say: '12 minutes left. Leading theory?', kind: 'pressure', nudge: false });
  });

  it('tolerates prose around the JSON', () => {
    expect(parseTurn('Sure:\n```json\n{"say":"ok","kind":"answer","nudge":false}\n```').say).toBe('ok');
  });

  it('treats an empty say as silence, which is a valid turn', () => {
    expect(parseTurn('{"say":"","kind":"silent","nudge":false}').kind).toBe('silent');
  });

  it('falls back to silence rather than inventing a turn', () => {
    expect(parseTurn('I refuse to answer in JSON').say).toBe('');
  });

  it('defaults a missing nudge flag to true', () => {
    // Fail toward "contaminated": an uncounted honest label beats a counted
    // one that we prompted.
    expect(parseTurn('{"say":"look again","kind":"answer"}').nudge).toBe(true);
  });
});

describe('renderActivity', () => {
  const now = 1_000_000;
  const ev = (type: string, dtSec: number, payload: unknown = {}): TraceEvent =>
    ({ session_id: 's', user_id: 'u', source: 'extension', seq: 0, ts: now - dtSec * 1000, type, payload }) as TraceEvent;

  it('summarizes editor activity with relative times', () => {
    const out = renderActivity([ev('test_run', 90, { exit_code: 1 }), ev('edit', 10, { path: 'a.ts' })], now);
    expect(out).toContain('-90s  test run FAILED');
    expect(out).toContain('-10s  edit file A');
  });

  it('never puts a real path in the prompt — the agent parroted one back', () => {
    const out = renderActivity(
      [
        ev('file_open', 60, { path: 'src/reservationService.ts' }),
        ev('edit', 30, { path: 'src/reservationService.ts' }),
        ev('edit', 10, { path: 'src/expiryIndex.ts' }),
      ],
      now,
    );
    expect(out).not.toContain('reservationService');
    expect(out).not.toContain('expiryIndex');
    // Identity survives: same file keeps the same alias, a new file gets a new one.
    expect(out).toContain('file_open file A');
    expect(out).toContain('edit file A');
    expect(out).toContain('edit file B');
  });

  it('excludes chat so the transcript is not duplicated into the prompt', () => {
    expect(renderActivity([ev('utterance', 5, { text: 'hi' })], now)).toBe('(no editor activity yet)');
  });
});

describe('render (prompt templating)', () => {
  const ctx = {
    spec: 'THE SPEC',
    bug: 'THE BUG',
    bugFile: BUG_FILE,
    elapsedMs: 60_000,
    remainingMs: 44 * 60_000,
    recentActivity: 'ACTIVITY',
    transcript: [],
    candidateMessage: 'hello',
  };

  it('leaves no unfilled slots — a literal {{VAR}} is a silently broken prompt', () => {
    const out = render(readFileSync(path.join(REPO, 'prompts/interviewer.md'), 'utf8'), ctx);
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('substitutes EVERY occurrence, not just the first', () => {
    // The live failure: a variable mentioned earlier in the file ate the value
    // and the real slot stayed literal, so the agent read the wrong clock.
    const out = render('list: {{REMAINING_MIN}}\n---\nRemaining: {{REMAINING_MIN}} min.', ctx);
    expect(out).toBe('list: 44\n---\nRemaining: 44 min.');
  });

  it('marks an unprompted turn as unprompted rather than faking a message', () => {
    const out = render('{{CANDIDATE_MESSAGE}}', { ...ctx, candidateMessage: null });
    expect(out).toContain('unprompted turn');
  });

  it('leaves unknown tokens alone instead of blanking them', () => {
    expect(render('{{NOT_A_VAR}}', ctx)).toBe('{{NOT_A_VAR}}');
  });
});

describe('bugContext', () => {
  it('hands the agent ground truth plus the file for the guard', () => {
    const problem = {
      planted_bug: { file: BUG_FILE, line: 66, description: 'stale index entry', failing_test: 'x > y' },
    } as GeneratedProblem;
    const ctx = bugContext(problem);
    expect(ctx.bugFile).toBe(BUG_FILE);
    expect(ctx.bug).toContain('stale index entry');
  });

  it('degrades safely for round types with no planted bug', () => {
    expect(bugContext({} as GeneratedProblem).bugFile).toBe('');
  });
});
