/**
 * The opening rides its own slot, not the moment wrapper.
 *
 * QA 2026-08-14 audit: the opening was dispatched through momentObservation,
 * so it rendered "Follow the moment rules above" — kind "probe", nudge true —
 * flatly contradicting the OPENING rule's kind "answer", nudge false. Not
 * cosmetic: agenda.ts keys the `clarify` dimension off a prompted
 * kind:'answer', so a mislabeled opening corrupted the agenda. The same
 * positional weakness let the Amazon round's blueprint-mandated pre-code LP
 * segment lose to the opening instruction: {{ENGAGEMENT}} was a descriptive
 * heading 34 lines away with no imperative force.
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
  elapsedMs: 0,
  remainingMs: null,
  recentActivity: '(no editor activity yet)',
  transcript: [],
  candidateMessage: null,
};

describe('the opening slot', () => {
  it('renders under the OPENING rule with kind answer, and MOMENT stays no', () => {
    const out = render(template(), { ...base, openingObservation: 'The candidate just arrived.' });
    expect(out).toMatch(/Opening: OPENING — The candidate just arrived\./);
    expect(out).toContain('Follow the OPENING rule above: kind "answer", nudge false.');
    expect(out).toMatch(/Moment: no/);
  });

  it('a real moment still gets the moment wrapper, and OPENING stays no', () => {
    const out = render(template(), { ...base, momentObservation: 'first failure read' });
    expect(out).toMatch(/Moment: MOMENT — first failure read/);
    expect(out).toMatch(/Opening: no/);
  });

  it('the OPENING rule defers to a pre-code engagement segment, in the cached half', () => {
    const { system } = renderSplit(template(), base);
    expect(system).toMatch(/EXCEPTION: if this round's engagement style/);
    expect(system).toContain("part of the round's design, not a suggestion");
  });
});
