/**
 * The two conceptual-leak shapes from sess-qa814-leak, as prompt rules.
 *
 * +144s: refusing a location probe, the interviewer coined "boundary
 * minute" — a term in neither the bug, the spec, nor the failing test name —
 * and repeated it at 171s and 187s (shipped nudge:false). +379s: two
 * truthful spec answers were composed into "go check whether the on-shift
 * check you've been reading agrees with the half-open rule I just gave
 * you"; the candidate returned the complete root cause 26 seconds later.
 *
 * Both are prompt-only BY DECISION (the mechanical alternatives measured
 * 1-in-6 precision — see leaksImplementationVocabulary's header). These
 * tests pin that the rules exist, sit in the cached half, are universal
 * across kinds, and that the answering guarantees they must not weaken
 * stay byte-for-byte intact.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, renderSplit, type InterviewerContext } from './interviewer.js';

const REPO = path.resolve(__dirname, '..', '..');
const template = () => readFileSync(path.join(REPO, 'prompts/interviewer.md'), 'utf8');

const base: InterviewerContext = {
  spec: 'THE SPEC',
  bug: 'THE BUG',
  bugFile: 'src/x.ts',
  elapsedMs: 60_000,
  remainingMs: 44 * 60_000,
  recentActivity: 'ACT',
  transcript: [],
  candidateMessage: 'is a shift window inclusive or half-open?',
};

describe('conceptual-leak rules', () => {
  it('the compose-into-a-pointer rule is present, cached, and names the leaked shape', () => {
    const { system, turn } = renderSplit(template(), base);
    expect(system).toContain('Never compose your own answers into a pointer');
    expect(system).toContain('given that, go check');
    expect(turn).not.toContain('Never compose your own answers into a pointer');
  });

  it('the refusal-reframe rule names the coinage failure and the refrain', () => {
    const { system } = renderSplit(template(), base);
    expect(system).toContain('A refusal must not re-frame the question');
    expect(system).toContain('boundary minute');
    expect(system).toMatch(/never let a phrase you coined become a\s+refrain/);
  });

  it('does NOT license refusing — the 14-minute refusal loop must stay fixed', () => {
    const { system } = renderSplit(template(), base);
    expect(system).toMatch(/This\s+does not license refusing/);
    expect(system).toMatch(/default is to answer/i);
    expect(system).toContain('Futures are hashable');
    expect(system).toMatch(/you did not answer it the\s+first time/);
  });

  it('the hand-back is open, never aimed at their code', () => {
    const { system } = renderSplit(template(), base);
    expect(system).toContain('hand the floor back with an OPEN');
    expect(system).toMatch(/never one that aims your own answer at a place in their code/);
  });

  it('a coined term and a composed pointer are both nudges by definition', () => {
    const { system } = renderSplit(template(), base);
    expect(system).toMatch(/a term YOU introduced/);
    expect(system).toMatch(/joins two of your own\s+answers/);
  });

  it.each(['one_failing_test', 'all_failing', 'all_passing', 'diff_present'])(
    'the rules are universal — %s carries both',
    (kind) => {
      const out = render(template(), { ...base, checkKind: kind });
      expect(out, kind).toContain('Never compose your own answers into a pointer');
      expect(out, kind).toContain('A refusal must not re-frame the question');
      expect(out, kind).not.toMatch(/\{\{[A-Z_]+\}\}/);
    },
  );
});
