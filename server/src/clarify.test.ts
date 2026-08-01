/**
 * The clarify gate stands between one reasoning call and the intake flow's
 * question UI — a broken question set or an out-of-vocabulary draft must
 * die here, falling back to plain inference, never rendering. No model
 * calls (repo convention); model behavior itself is checked by the live
 * smoke in the phase checkpoint.
 */
import { describe, expect, it } from 'vitest';
import { gateClarify } from './clarify.js';

const round = (over: Record<string, unknown> = {}) => ({
  id: 'palantir-oa',
  label: 'Palantir OA',
  interviewer: false,
  can_run_tests: true,
  time_limit_minutes: 90,
  starts_from: 'blank',
  submit: 'one_shot',
  check_kind: 'all_failing',
  emphasis: '',
  rationale: 'Autograded HackerRank per the findings.',
  unsupported: '',
  ...over,
});

const question = (over: Record<string, unknown> = {}) => ({
  id: 'which-round',
  question: 'Sources describe two different Palantir rounds — which are you sitting?',
  options: [
    { label: 'The OA', detail: 'coding + SQL + API, autograded' },
    { label: 'The live LLD round', detail: 'CodePair, with an interviewer' },
    { label: 'Both' },
  ],
  recommended: 'Both',
  why: 'Each shape generates a completely different practice plan.',
  ...over,
});

describe('gateClarify', () => {
  it('zero questions + one draft is the common case and passes untouched', () => {
    const out = gateClarify({ questions: [], rounds: [round()] });
    expect(out.questions).toEqual([]);
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]!.spec.capabilities.time_limit_ms).toBe(90 * 60_000);
  });

  it('multi-round: one description may become several specs', () => {
    const out = gateClarify({
      questions: [question()],
      rounds: [round(), round({ id: 'palantir-live-lld', label: 'Palantir re-engineering', interviewer: true, time_limit_minutes: null, starts_from: 'repo', submit: 'iterate', check_kind: 'one_failing_test' })],
    });
    expect(out.drafts.map((d) => d.spec.id)).toEqual(['palantir-oa', 'palantir-live-lld']);
    expect(out.questions[0]!.recommended).toBe('Both');
  });

  it('caps questions at 3 — interrogation is not intake', () => {
    expect(() =>
      gateClarify({ questions: [question({ id: 'a' }), question({ id: 'b' }), question({ id: 'c' }), question({ id: 'd' })], rounds: [round()] }),
    ).toThrow(/max 3/);
  });

  it('a question without stakes (why) or with degenerate options dies', () => {
    expect(() => gateClarify({ questions: [question({ why: '' })], rounds: [round()] })).toThrow(/why/);
    expect(() => gateClarify({ questions: [question({ options: [{ label: 'Only one' }] })], rounds: [round()] })).toThrow(/2-4/);
  });

  it('best-guess drafts are mandatory even while asking', () => {
    expect(() => gateClarify({ questions: [question()], rounds: [] })).toThrow(/mandatory/);
  });

  it('every draft passes the same vocabulary gate as single-spec inference', () => {
    expect(() =>
      gateClarify({ questions: [], rounds: [round({ can_run_tests: false })] }),
    ).toThrow(/incoherent/);
  });

  it('duplicate round ids die — round-robin keys on spec id', () => {
    expect(() => gateClarify({ questions: [], rounds: [round(), round()] })).toThrow(/duplicate/);
  });

  it('normalizes stringified nested arrays (the judge lesson)', () => {
    const out = gateClarify({
      questions: JSON.stringify([question()]),
      rounds: JSON.stringify([round()]),
    });
    expect(out.questions).toHaveLength(1);
    expect(out.drafts).toHaveLength(1);
  });
});
