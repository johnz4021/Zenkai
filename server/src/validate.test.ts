import { describe, expect, it } from 'vitest';
import { checkManifest, parseVitestJson } from './validate.js';
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
    spec: 'x'.repeat(150),
    mutations: [],
    rubric: {
      round_type: 'debugging',
      trigger: { event: 'test_run', predicate: 'first_failure' },
      window: { duration_ms: 90_000 },
      labels: ['clarifying_question', 'immediate_edit', 'test_run'],
      expectation: 'reads the failure output before editing',
    },
  };

  it('rejects labels outside the single source of truth', () => {
    const bad = {
      ...base,
      rubric: { ...base.rubric, labels: ['clarifying_question', 'vibes'] },
    } as unknown as GeneratedProblem;
    const failures = checkManifest(bad, '/nonexistent');
    expect(failures.some((f) => f.includes('vibes'))).toBe(true);
  });

  it('requires a test_run trigger for debugging rounds', () => {
    const bad = {
      ...base,
      rubric: { ...base.rubric, trigger: { event: 'spec_mutation' } },
    } as unknown as GeneratedProblem;
    const failures = checkManifest(bad, '/nonexistent');
    expect(failures.some((f) => f.includes('test_run'))).toBe(true);
  });
});
