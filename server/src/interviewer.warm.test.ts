/**
 * The warm inversion gets its own voice.
 *
 * QA 2026-08-14 audit: describeWarm() rode the {{ADRIFT}} slot, where the
 * prompt's adrift rules instruct "Say plainly that it looks sound — that
 * region is not where the fault is" — a direct order to push the candidate
 * off the bug in the one case the detector exists to invert. CLAUDE.md's
 * contract ("adrift must NOT fire when the region being read contains the
 * bug") held in the detector and was undone by the render.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, renderSplit, stuckVocabOf, type InterviewerContext } from './interviewer.js';

const REPO = path.resolve(__dirname, '..', '..');
const template = () => readFileSync(path.join(REPO, 'prompts/interviewer.md'), 'utf8');

const base: InterviewerContext = {
  spec: 'THE SPEC',
  bug: 'THE BUG',
  bugFile: 'src/x.ts',
  elapsedMs: 10 * 60_000,
  remainingMs: null,
  recentActivity: 'ACT',
  transcript: [],
  candidateMessage: null,
};

describe('warm renders under its own rules, never the adrift redirect', () => {
  it('a warm observation fills WARM and leaves ADRIFT at no', () => {
    const out = render(template(), { ...base, warmObservation: 'they are in the right neighbourhood' });
    expect(out).toMatch(/Warm: WARM — they are in the right neighbourhood/);
    expect(out).toMatch(/Adrift: no/);
    expect(out).toContain('Follow the warm rules above: encourage, never redirect');
  });

  it('an adrift observation fills ADRIFT and leaves WARM at no', () => {
    const out = render(template(), { ...base, adriftObservation: 'that region is spent' });
    expect(out).toMatch(/Adrift: ADRIFT — that region is spent/);
    expect(out).toMatch(/Warm: no/);
  });

  it('the warm rules live in the cached half and forbid the redirect explicitly', () => {
    const { system } = renderSplit(template(), { ...base, warmObservation: 'right neighbourhood' });
    expect(system).toContain('## If the session state says WARM');
    expect(system).toContain('must never be handled with the adrift rules');
    expect(system).toMatch(/Do NOT redirect/);
    expect(system).toMatch(/Never "you're close"/);
  });

  it('a warm turn arms the vocabulary guard like the other scaffolding lanes', () => {
    expect(stuckVocabOf({ ...base, warmObservation: 'right neighbourhood' })).toBeDefined();
    expect(stuckVocabOf(base)).toBeUndefined();
  });
});
