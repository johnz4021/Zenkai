/**
 * Per-kind ground truth — the {{BUG}} slot stops contradicting its heading.
 *
 * QA 2026-08-14: on every round without a planted bug, "(no planted bug for
 * this round type)" rendered directly under "## What you know that they do
 * not", followed by answer rules asserting private knowledge. On the one
 * real review round (rep-mst39p35), the FULL grading key — four defects,
 * severities, files, lines — rode into the slot wrapped in a debugging-
 * shaped "It breaks exactly one test:" sentence, and the location guard
 * covered one of the four defect files. The old test suite pinned
 * `bug: 'THE BUG'` everywhere and never rendered the sentinel once.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GeneratedProblem } from '@interview-prep/shared';
import {
  guard,
  interviewerGroundTruth,
  protectionOf,
  render,
  renderSplit,
  stuckVocabOf,
  type InterviewerContext,
} from './interviewer.js';

const REPO = path.resolve(__dirname, '..', '..');
const template = () => readFileSync(path.join(REPO, 'prompts/interviewer.md'), 'utf8');

const PLANTED = {
  file: 'triage/policy.py',
  line: 55,
  description: 'accepts offset <= span, disagreeing with the half-open Shift.covers in models.py',
  failing_test: 'tests.test_triage.ShiftTests.test_evening',
};

const REVIEW_KEY = {
  file: 'api.py',
  line: 77,
  description:
    'Defect 1 (BLOCKER): api.py:77 caches the invoice. Defect 2 (BLOCKER): rollup.py:73 sums the window.',
  failing_test: '(none — a review round: the shipped suite is green as written)',
};

describe('interviewerGroundTruth — per kind', () => {
  it('one_failing_test keeps the original debugging text byte-identical', () => {
    const gt = interviewerGroundTruth({ planted_bug: PLANTED } as GeneratedProblem, 'one_failing_test');
    expect(gt.bug).toBe(
      `File: triage/policy.py (line 55)\n${PLANTED.description}\nIt breaks exactly one test: "${PLANTED.failing_test}".`,
    );
    expect(gt.bugFile).toBe('triage/policy.py');
    expect(gt.hasAnswerKnowledge).toBe(true);
  });

  it('no planted bug → an explicit no-knowledge statement, never the old sentinel', () => {
    for (const kind of ['all_failing', 'all_passing', undefined]) {
      const gt = interviewerGroundTruth({} as GeneratedProblem, kind);
      expect(gt.bug).toContain('NO private answer knowledge');
      expect(gt.bug).toContain('Do not imply you know');
      expect(gt.bug).not.toContain('(no planted bug for this round type)');
      expect(gt.bugFile).toBe('');
      expect(gt.hasAnswerKnowledge).toBe(false);
    }
  });

  it('diff_present frames the key as a grading key, not a bug that breaks one test', () => {
    const gt = interviewerGroundTruth({ planted_bug: REVIEW_KEY } as GeneratedProblem, 'diff_present');
    expect(gt.bug).toContain('grading key');
    expect(gt.bug).toContain(REVIEW_KEY.description);
    expect(gt.bug).not.toContain('It breaks exactly one test');
    expect(gt.hasAnswerKnowledge).toBe(true);
  });
});

const baseCtx = (over: Partial<InterviewerContext>): InterviewerContext => ({
  spec: 'THE SPEC — a triage service routes tickets.',
  bug: 'THE BUG',
  bugFile: 'src/x.ts',
  elapsedMs: 60_000,
  remainingMs: 44 * 60_000,
  recentActivity: 'ACT',
  transcript: [],
  candidateMessage: 'hello',
  ...over,
});

describe('the rendered slot on a no-knowledge round', () => {
  it('says so under the heading, in the cached half, with no sentinel', () => {
    const gt = interviewerGroundTruth({} as GeneratedProblem, 'all_failing');
    const { system } = renderSplit(
      template(),
      baseCtx({ bug: gt.bug, bugFile: gt.bugFile, checkKind: 'all_failing' }),
    );
    expect(system).toContain('NO private answer knowledge');
    expect(system).not.toContain('(no planted bug for this round type)');
  });
});

describe('guard — extra protected locations (multi-defect rounds)', () => {
  const turn = { say: 'Have you looked at rollup.py yet?', kind: 'probe' as const, nudge: false };

  it('naming an unvisited extra defect file is a leak', () => {
    const out = guard(turn, 'api.py', true, false, undefined, false, [
      { file: 'rollup.py', visited: false },
    ]);
    expect(out.redacted).toBe(true);
  });

  it('found territory relaxes per file, exactly like the primary', () => {
    const out = guard(turn, 'api.py', true, false, undefined, false, [
      { file: 'rollup.py', visited: true },
    ]);
    expect(out).toEqual(turn);
  });

  it('the primary file behavior is unchanged when extras are present', () => {
    const leaky = { say: 'Check api.py line 77', kind: 'answer' as const, nudge: false };
    const out = guard(leaky, 'api.py', true, false, undefined, false, [
      { file: 'rollup.py', visited: true },
    ]);
    expect(out.redacted).toBe(true);
  });
});

describe('protectionOf — spec-named extras are public', () => {
  it('a defect file the spec itself names is not a leak to mention', () => {
    const ctx = baseCtx({
      spec: 'Review the change to rollup.py and its callers.',
      protectedExtras: [
        { file: 'rollup.py', visited: false },
        { file: 'ledger.py', visited: false },
      ],
    });
    expect(protectionOf(ctx)).toEqual([
      { file: 'rollup.py', visited: true },
      { file: 'ledger.py', visited: false },
    ]);
  });
});

describe('stuckVocabOf — never armed without answer knowledge', () => {
  it('a no-knowledge round arms nothing, even mid-scaffold', () => {
    const gt = interviewerGroundTruth({} as GeneratedProblem, 'all_failing');
    const ctx = baseCtx({
      bug: gt.bug,
      bugFile: gt.bugFile,
      hasAnswerKnowledge: gt.hasAnswerKnowledge,
      stuckObservation: 'three attempts in the same place',
    });
    expect(stuckVocabOf(ctx)).toBeUndefined();
  });

  it('a debugging round still arms exactly as before', () => {
    const ctx = baseCtx({
      hasAnswerKnowledge: true,
      stuckObservation: 'three attempts in the same place',
    });
    expect(stuckVocabOf(ctx)).toBeDefined();
  });

  it('existing call sites without the field keep arming (default true)', () => {
    const ctx = baseCtx({ stuckObservation: 'three attempts in the same place' });
    expect(stuckVocabOf(ctx)).toBeDefined();
  });
});
