/**
 * {{ROUND_MECHANICS}} — the axes the prompt never used to carry.
 *
 * QA 2026-08-14: prompt rules assumed iteration on one-shot rounds ("When
 * they make a change, ask what it should fix and how they'll know" — they
 * cannot know), promised "latest test output" that cannot exist, and
 * nothing anywhere in the interviewer path named REVIEW.md as the review
 * round's graded deliverable.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSplit, type InterviewerContext } from './interviewer.js';

const REPO = path.resolve(__dirname, '..', '..');
const template = () => readFileSync(path.join(REPO, 'prompts/interviewer.md'), 'utf8');

const base: InterviewerContext = {
  spec: 'THE SPEC',
  bug: 'THE BUG',
  bugFile: 'src/x.ts',
  elapsedMs: 60_000,
  remainingMs: null,
  recentActivity: 'ACT',
  transcript: [],
  candidateMessage: null,
};

describe('the mechanics slot', () => {
  it('lands in the cached half with the facts-win instruction', () => {
    const { system } = renderSplit(template(), {
      ...base,
      mechanics: 'ONE graded submission, at the end. They CANNOT run tests during the round.',
    });
    expect(system).toContain('## How this round works (mechanics)');
    expect(system).toContain('They CANNOT run tests during the round');
    expect(system).toContain('the facts above win');
  });

  it('absent mechanics render a harmless note, never a literal slot', () => {
    const { system } = renderSplit(template(), base);
    expect(system).toContain('(no mechanics notes for this round)');
    expect(system).not.toContain('{{ROUND_MECHANICS}}');
  });
});
