import { describe, expect, it } from 'vitest';
import { checkExpectations, checkManifest, normalizeTestName, parseVitestJson } from './validate.js';
import type { GeneratedProblem } from '@interview-prep/shared';

const report = (failures: { status: string; fullName: string }[][]) =>
  JSON.stringify({
    numTotalTests: failures.flat().length,
    testResults: failures.map((assertionResults) => ({ assertionResults })),
  });

describe('parseVitestJson', () => {
  it('finds the single failed test by full name', () => {
    const json = report([
      [
        { status: 'passed', fullName: 'reserve > rejects overdraw' },
        { status: 'failed', fullName: 'reserve > releases expired holds' },
      ],
      [{ status: 'passed', fullName: 'ship > decrements stock' }],
    ]);
    const { failed, total } = parseVitestJson(json);
    expect(total).toBe(3);
    expect(failed).toEqual(['reserve > releases expired holds']);
  });

  it('reports zero failures on a green run', () => {
    const json = report([[{ status: 'passed', fullName: 'a' }]]);
    expect(parseVitestJson(json).failed).toEqual([]);
  });
});

describe('normalizeTestName', () => {
  // REGRESSION: debugging-001 was rejected because vitest's fullName joins
  // describe+test with a space while the manifest used " > ". Same test,
  // different notation — a correct problem must not fail over punctuation.
  it('treats " > " separators and plain spaces as the same name', () => {
    const fromVitest = 'hold expiry keeps the units of an extended hold reserved past its original deadline';
    const fromManifest = 'hold expiry > keeps the units of an extended hold reserved past its original deadline';
    expect(normalizeTestName(fromVitest)).toBe(normalizeTestName(fromManifest));
  });

  it('still distinguishes genuinely different tests', () => {
    expect(normalizeTestName('reserve > rejects overdraw')).not.toBe(
      normalizeTestName('reserve > releases expired holds'),
    );
  });
});

describe('checkManifest', () => {
  const base: GeneratedProblem = {
    round_type: 'debugging',
    repo_path: '.',
    model_paths: ['src/model.ts'],
    planted_bug: {
      file: 'src/holds.ts',
      line: 42,
      description: 'expiry comparison excludes the boundary instant',
      failing_test: 'reserve > releases expired holds',
    },
    spec:
      'The inventory module places time-limited holds on stock units; every hold carries an expiry deadline, and an hourly sweep releases expired holds back to available stock. One behavior is broken: find and fix it.',
    mutations: [],
    rubric: {
      round_type: 'debugging',
      dimensions: {
        clarify: 'Reads the failing expiry test body and asks whether the deadline boundary is inclusive before editing.',
        approach: 'Names the mechanism: the sweep comparison excludes the boundary instant, so holds expiring exactly on the deadline are never released.',
        communicate: 'Narrates which hold states are being inspected while tracing the sweep.',
        implement: 'Changes only the sweep comparison to test the stated boundary hypothesis.',
        verify: 'Re-runs the suite and confirms the expired-holds test passes with stock restored.',
        reflect: 'Explains why the boundary instant was excluded and what the fix changes.',
      },
    },
  };

  it('accepts a manifest with concrete, spec-tied expectations', () => {
    expect(checkExpectations(base)).toEqual([]);
  });

  it('rejects a manifest with no dimensions at all — a generation failure', () => {
    const bad = { ...base, rubric: { round_type: 'debugging' } } as GeneratedProblem;
    expect(checkExpectations(bad).some((f) => f.includes('dimensions missing'))).toBe(true);
  });

  it('rejects vague stems — "understands the problem" is not an observable behavior', () => {
    const bad = {
      ...base,
      rubric: {
        ...base.rubric,
        dimensions: { ...base.rubric.dimensions, clarify: 'Understands the problem and the expiry deadline sweep behavior well' },
      },
    } as GeneratedProblem;
    expect(checkExpectations(bad).some((f) => f.includes('vague stem'))).toBe(true);
  });

  it('rejects thin expectations (under 8 words)', () => {
    const bad = {
      ...base,
      rubric: { ...base.rubric, dimensions: { ...base.rubric.dimensions, verify: 'Runs the expiry tests again' } },
    } as GeneratedProblem;
    expect(checkExpectations(bad).some((f) => f.includes('too thin'))).toBe(true);
  });

  it('rejects generic expectations that share no vocabulary with the spec', () => {
    const bad = {
      ...base,
      rubric: {
        ...base.rubric,
        dimensions: {
          ...base.rubric.dimensions,
          approach: 'States a general plan of attack before writing any code changes at all',
        },
      },
    } as GeneratedProblem;
    expect(checkExpectations(bad).some((f) => f.includes('no vocabulary'))).toBe(true);
  });
});
