import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REDACTED_REPLY,
  TurnQueue,
  renderSplit,
  bugContext,
  guard,
  leaksBugLocation,
  leaksImplementationVocabulary,
  stuckVocabOf,
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

describe('TurnQueue (addressed turns only; narration never enters)', () => {
  it('answers two stacked questions as one turn, oldest first', async () => {
    const { TurnQueue } = await import('./interviewer.js');
    const q = new TurnQueue(2);
    q.push('is the deadline from now?');
    q.push('and does extend re-register the hold?');
    expect(q.drain()).toBe('is the deadline from now?\nand does extend re-register the hold?');
    expect(q.drain()).toBeNull();
  });

  it('caps at 2 by dropping the OLDEST — the newest is what they wait on', async () => {
    const { TurnQueue } = await import('./interviewer.js');
    const q = new TurnQueue(2);
    q.push('q1');
    q.push('q2');
    q.push('q3');
    expect(q.drain()).toBe('q2\nq3');
  });
});

describe('gap-note never-mention guard (T15)', () => {
  it('redacts meta-talk about the candidate history', () => {
    for (const leak of [
      'Last time you went quiet when the test failed.',
      "I've noticed your pattern of editing before reading the failure.",
      'You tend to go silent under pressure.',
      'Your progress is being measured, so narrate.',
    ]) {
      const out = guard({ say: leak, kind: 'probe', nudge: false }, BUG_FILE, true, true);
      expect(out.redacted, leak).toBe(true);
    }
  });

  it('lets ordinary probing through — the note shapes pressure, it does not mute it', () => {
    for (const fine of [
      'Talk me through what you have ruled out so far.',
      'What did the failure output actually say?',
      "Twelve minutes left. What's your leading theory?",
      'Walk me through your last change.',
    ]) {
      const out = guard({ say: fine, kind: 'probe', nudge: false }, BUG_FILE, true, true);
      expect(out.redacted, fine).toBeUndefined();
    }
  });

  it('is DISARMED when no target note was injected', () => {
    const out = guard(
      { say: 'You tend to be careful — good.', kind: 'probe', nudge: false },
      BUG_FILE,
      true,
      false,
    );
    expect(out.redacted).toBeUndefined();
  });

  it('an unprompted gap leak redacts to silence, like the bug guard', () => {
    const out = guard(
      { say: 'Last session you went quiet here.', kind: 'pressure', nudge: false },
      BUG_FILE,
      false,
      true,
    );
    expect(out.say).toBe('');
    expect(out.kind).toBe('silent');
  });
});

describe('renderSplit (prompt caching seam)', () => {
  const ctx = {
    spec: 'THE SPEC', bug: 'THE BUG', bugFile: BUG_FILE, targetNote: 'TARGETING NOTE: gap X',
    elapsedMs: 60_000, remainingMs: 44 * 60_000, recentActivity: 'ACT', transcript: [],
    candidateMessage: 'hello',
  };

  it('the stable half contains spec, bug, and note; the turn half the clock', () => {
    const template = readFileSync(path.join(REPO, 'prompts/interviewer.md'), 'utf8');
    const { system, turn } = renderSplit(template, ctx);
    expect(system).toContain('THE SPEC');
    expect(system).toContain('THE BUG');
    expect(system).toContain('TARGETING NOTE: gap X');
    expect(system).not.toContain('Elapsed: 1 min');
    expect(turn).toContain('Elapsed: 1 min');
    expect(turn).toContain('hello');
  });

  it('is IDENTICAL across turns when only per-turn state changes — or caching dies', () => {
    const template = readFileSync(path.join(REPO, 'prompts/interviewer.md'), 'utf8');
    const a = renderSplit(template, ctx).system;
    const b = renderSplit(template, {
      ...ctx, elapsedMs: 20 * 60_000, remainingMs: 25 * 60_000,
      recentActivity: 'DIFFERENT', candidateMessage: 'another question',
      transcript: [{ who: 'candidate' as const, text: 'earlier' }],
    }).system;
    expect(a).toBe(b);
  });
});

describe('stuck vocabulary guard — one step, their words only (validated on debugging-001)', () => {
  // The real spec/bug pair the design was validated against. The spec the
  // candidate reads contains extend/extending/deadline/hold/reserved; only
  // the private bug knowledge contains re-registers/expiry index/stale/
  // cancelling/queued/sweep.
  const SPEC =
    'Every hold carries a deadline. A checkout that needs more time can extend an active ' +
    'hold; extending moves the deadline forward from the current time, and the hold\'s units ' +
    'must stay reserved right up to the new deadline and be released only when that new ' +
    'deadline passes.';
  const BUG =
    'File: src/reservationService.ts (line 66)\n' +
    'extend() re-registers the hold in the expiry index without cancelling its previous ' +
    'entry, so the stale entry for the original deadline is still queued and the next sweep ' +
    'expires the hold at its old time.\n' +
    'It breaks exactly one test: "hold expiry > keeps the units of an extended hold reserved past its original deadline".';
  const FAILING = 'hold expiry > keeps the units of an extended hold reserved past its original deadline';

  const allowed = (utterances = '') => `${SPEC}\n${FAILING}\n${utterances}`;

  it('accepts the validated hint — spec vocabulary plus a trace observation', () => {
    const hint =
      "You've made three changes to the same file and the test fails the same way each time. " +
      'What happens to a hold that gets extended twice?';
    expect(leaksImplementationVocabulary(hint, BUG, allowed())).toBe(false);
  });

  it('rejects the mechanism even when no file is named', () => {
    const mech = 'Think about what happens when the old entry is still queued in the expiry index.';
    expect(leaksImplementationVocabulary(mech, BUG, allowed())).toBe(true);
  });

  it('rejects private vocabulary like "stale" and "sweep"', () => {
    expect(leaksImplementationVocabulary('Could the entry be stale?', BUG, allowed())).toBe(true);
    expect(leaksImplementationVocabulary('Have you looked at the sweep?', BUG, allowed())).toBe(true);
  });

  it('a word becomes safe once the CANDIDATE says it first', () => {
    const hint = "You've come back to the sweep twice out loud — what have you done to test that?";
    expect(leaksImplementationVocabulary(hint, BUG, allowed())).toBe(true);
    expect(leaksImplementationVocabulary(hint, BUG, allowed('I think the bug is in the sweep'))).toBe(false);
  });

  it('failing-test vocabulary is safe — it is on their screen', () => {
    const hint = 'The failing test is about an extended hold reserved past its original deadline. What is it asserting?';
    expect(leaksImplementationVocabulary(hint, BUG, allowed())).toBe(false);
  });

  it('guard arms only on stuck turns and forces nudge true on survivors', () => {
    const turn = { say: 'What happens to a hold that gets extended twice?', kind: 'probe' as const, nudge: false };
    const vocab = { forbidden: BUG, allowed: allowed() };
    expect(guard(turn, 'src/reservationService.ts', false, false, vocab)).toEqual({ ...turn, nudge: true });
    // Same words on a NORMAL turn: untouched, nudge stays as the model set it.
    expect(guard(turn, 'src/reservationService.ts', false, false)).toEqual(turn);
  });

  it('a leaking stuck turn redacts to SILENCE, never the canned decline', () => {
    const leak = { say: 'Look at the expiry index entry.', kind: 'probe' as const, nudge: true };
    const out = guard(leak, 'src/reservationService.ts', false, false, { forbidden: BUG, allowed: allowed() });
    expect(out).toEqual({ say: '', kind: 'silent', nudge: false, redacted: true });
  });

  it('stuckVocabOf composes exactly what the runtime hands the guard', () => {
    const v = stuckVocabOf({
      spec: SPEC, bug: BUG, bugFile: 'src/reservationService.ts',
      elapsedMs: 0, remainingMs: 0, recentActivity: '', candidateMessage: null,
      transcript: [
        { who: 'candidate', text: 'maybe the sweep?' },
        { who: 'interviewer', text: 'never echo me: stale queued entry' },
      ],
      stuckObservation: '3 cycles', allowedExtra: FAILING,
    })!;
    expect(v.forbidden).toContain('re-registers');
    expect(v.allowed).toContain('maybe the sweep?');
    // The interviewer's own past words are NOT allowed vocabulary — only
    // the candidate's. Otherwise one slip whitelists itself forever.
    expect(v.allowed).not.toContain('never echo me');
    expect(stuckVocabOf({ spec: SPEC, bug: BUG, bugFile: '', elapsedMs: 0, remainingMs: 0, recentActivity: '', candidateMessage: null, transcript: [] })).toBeUndefined();
  });
});
