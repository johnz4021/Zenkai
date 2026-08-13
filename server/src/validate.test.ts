import { describe, expect, it } from 'vitest';
import {
  checkExpectations,
  checkManifest,
  checkSuiteAgainstKind,
  countSourceFiles,
  normalizeTestName,
  parseUnittestOutput,
  parseVitestJson,
} from './validate.js';
import type { GeneratedProblem, RoundSpec } from '@interview-prep/shared';
import { DEFAULT_DEBUGGING_SPEC } from '@interview-prep/shared';

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

describe('parseUnittestOutput', () => {
  // Both formats exist in the wild: 3.10 prints `test_x (mod.Class)`,
  // 3.11+ prints `test_x (mod.Class.test_x)`. The container ships 3.10;
  // the host may run either.
  it('parses the 3.10 line shape', () => {
    const out = [
      'test_deposits_accumulate (test_ledger.TestDeposits) ... ok',
      'test_fast_path_agrees (test_ledger.TestSnapshots) ... FAIL',
      '',
      'Ran 2 tests in 0.001s',
      'FAILED (failures=1)',
    ].join('\n');
    const { failed, total } = parseUnittestOutput(out);
    expect(total).toBe(2);
    expect(failed).toEqual(['test_ledger > TestSnapshots > test_fast_path_agrees']);
  });

  it('parses the 3.11+ line shape without doubling the test name', () => {
    const out = [
      'test_fast_path_agrees (test_ledger.TestSnapshots.test_fast_path_agrees) ... FAIL',
      'Ran 1 test in 0.000s',
    ].join('\n');
    expect(parseUnittestOutput(out).failed).toEqual([
      'test_ledger > TestSnapshots > test_fast_path_agrees',
    ]);
  });

  it('counts ERROR as failed and skipped as not-failed', () => {
    const out = [
      'test_a (m.C) ... ERROR',
      'test_b (m.C) ... skipped "reason"',
      'test_c (m.C) ... ok',
      'Ran 3 tests in 0.001s',
    ].join('\n');
    const { failed, total } = parseUnittestOutput(out);
    expect(total).toBe(3);
    expect(failed).toEqual(['m > C > test_a']);
  });

  it('the manifest naming convention matches the parsed name via normalize', () => {
    // python-debugging-001's manifest names "TestSnapshotAcceleratedReads >
    // test_the_fast_read_path..." while the parser emits the module too.
    const observed = normalizeTestName('test_ledger > TestSnapshots > test_fast_path_agrees');
    const claimed = normalizeTestName('TestSnapshots > test_fast_path_agrees');
    expect(observed.includes(claimed)).toBe(true);
  });
});

describe('checkSuiteAgainstKind', () => {
  const withSpec = (kind: RoundSpec['check']['kind'], min?: number): GeneratedProblem =>
    ({
      round_type: 'debugging',
      repo_path: '.',
      model_paths: [],
      spec: 'x'.repeat(120),
      mutations: [],
      rubric: { round_type: 'debugging' },
      round_spec: {
        id: 't',
        label: 'T',
        capabilities: {
          interviewer: false,
          can_run_tests: kind !== 'diff_present',
          time_limit_ms: null,
          starts_from: 'blank',
          submit: 'one_shot',
        },
        check: { kind, min_tests: min, ...(kind === 'diff_present' ? { files_changed: ['a.ts'] } : {}) },
        memory_tags: [],
      },
    }) as GeneratedProblem;

  it('all_failing passes only when every test fails', () => {
    const p = withSpec('all_failing', 3);
    expect(checkSuiteAgainstKind(p, ['a', 'b', 'c'], 3)).toEqual([]);
    expect(checkSuiteAgainstKind(p, ['a', 'b'], 3).join()).toMatch(/1 of 3 pass/);
    expect(checkSuiteAgainstKind(p, ['a'], 1).join()).toMatch(/only 1 tests/);
  });

  it('all_passing passes only on a green suite of sufficient size', () => {
    const p = withSpec('all_passing', 4);
    expect(checkSuiteAgainstKind(p, [], 6)).toEqual([]);
    expect(checkSuiteAgainstKind(p, ['x'], 6).join()).toMatch(/green suite/);
  });

  it('legacy manifests (no round_spec) still enforce one_failing_test', () => {
    const legacy = { ...withSpec('all_failing'), round_spec: undefined } as GeneratedProblem;
    expect(checkSuiteAgainstKind(legacy, ['a', 'b'], 10).join()).toMatch(/exactly 1 failing/);
    expect(checkSuiteAgainstKind(legacy, ['a'], 4).join()).toMatch(/requires >= 8/);
  });

  it('diff_present asserts nothing about the suite', () => {
    expect(checkSuiteAgainstKind(withSpec('diff_present'), ['a', 'b'], 2)).toEqual([]);
  });

  it('one_failing_test honors min_tests instead of hardcoding 8 (doc limitation #6)', () => {
    const relaxed = withSpec('one_failing_test', 4);
    expect(checkSuiteAgainstKind(relaxed, ['a'], 5)).toEqual([]);
    expect(checkSuiteAgainstKind(relaxed, ['a'], 3).join()).toMatch(/requires >= 4/);
  });
});

describe('countSourceFiles — what check.max_source_files counts', () => {
  // The knob exists because "one page of Python" had no enforceable home;
  // the count must see the candidate's problem, not its scaffolding.
  it('counts source files, not tests or harness config', () => {
    expect(
      countSourceFiles([
        'main.py',
        'lib/helper.py',
        'src/mod.ts',
        'tests/test_main.py', // test dir
        'test/helper.test.ts', // test dir
        'src/mod.test.ts', // test suffix
        'src/util_test.py', // pytest-style suffix
        'vitest.config.ts', // harness
        'README.md', // not source
        'PROBLEM.md',
        'package.json',
      ]),
    ).toBe(3);
  });

  it('an empty listing counts zero', () => {
    expect(countSourceFiles([])).toBe(0);
  });

  it('checkManifest enforces the cap against the real tree', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'cap-'));
    try {
      mkdirSync(path.join(dir, 'tests'));
      writeFileSync(path.join(dir, 'main.py'), 'x');
      writeFileSync(path.join(dir, 'extra.py'), 'x');
      writeFileSync(path.join(dir, 'tests/test_main.py'), 'x');
      const capped = {
        round_type: 'debugging',
        repo_path: '.',
        model_paths: [],
        spec: 'y'.repeat(120),
        mutations: [],
        rubric: { round_type: 'debugging' },
        round_spec: {
          id: 't', label: 'T',
          capabilities: {
            interviewer: false, can_run_tests: true, time_limit_ms: null,
            starts_from: 'blank' as const, submit: 'one_shot' as const,
          },
          check: { kind: 'all_failing' as const, min_tests: 3, max_source_files: 1 },
          memory_tags: [],
        },
      } as unknown as GeneratedProblem;
      const failures = checkManifest(capped, dir);
      expect(failures.join('\n')).toMatch(/2 source files — check\.max_source_files allows 1/);
      capped.round_spec!.check.max_source_files = 2;
      expect(checkManifest(capped, dir).join('\n')).not.toMatch(/max_source_files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkManifest spec dispatch', () => {
  const minimal = (over: Partial<GeneratedProblem>): GeneratedProblem =>
    ({
      round_type: 'debugging',
      repo_path: '.',
      model_paths: [],
      spec:
        'A scheduling service assigns workers to shifts; assignments respect availability windows and maximum weekly hours, and overlapping shifts for one worker are rejected by the planner.',
      mutations: [],
      rubric: {
        round_type: 'debugging',
        dimensions: {
          clarify: 'Asks whether availability windows are inclusive of their boundary instants before designing the planner checks.',
          approach: 'States which invariant the planner enforces first — overlapping shifts rejection — and why ordering matters.',
          communicate: 'Narrates the worker-assignment walkthrough while writing each planner rule.',
          implement: 'Builds the availability and weekly-hours checks as separate planner predicates.',
          verify: 'Dry-runs an overlapping-shifts scenario against the planner before declaring the rules complete.',
          reflect: 'Explains which planner invariant is riskiest and how the shifts model would break without it.',
        },
      },
      ...over,
    }) as GeneratedProblem;

  it('an all_failing manifest needs no planted_bug', () => {
    const p = minimal({
      round_spec: {
        id: 'oa',
        label: 'OA',
        capabilities: { interviewer: false, can_run_tests: true, time_limit_ms: 60_000, starts_from: 'blank', submit: 'one_shot' },
        check: { kind: 'all_failing', min_tests: 5 },
        memory_tags: ['from_scratch', 'autograded'],
      },
    });
    expect(checkManifest(p, '/nonexistent')).toEqual([]);
  });

  it('a diff_present MANIFEST requires non-empty files_changed — the generator names what changed', () => {
    // The inference-side gate no longer requires the list (no problem exists
    // there to name files from — QA 2026-08-13); the proof moved HERE, where
    // the artifact exists. An empty declaration = nothing to review = a
    // generation failure.
    const p = minimal({
      round_spec: {
        id: 'rev',
        label: 'Review',
        capabilities: { interviewer: false, can_run_tests: false, time_limit_ms: 60_000, starts_from: 'diff', submit: 'one_shot' },
        check: { kind: 'diff_present' },
        memory_tags: ['review'],
      },
    });
    expect(checkManifest(p, '/nonexistent').join('\n')).toMatch(/non-empty check\.files_changed/);
  });

  it('a legacy manifest still requires its planted_bug', () => {
    const p = minimal({});
    expect(checkManifest(p, '/nonexistent').join()).toMatch(/planted_bug missing/);
  });

  it('an out-of-vocabulary spec is rejected at the manifest gate', () => {
    const p = minimal({
      round_spec: { id: 'x', label: 'X', capabilities: {}, check: { kind: 'vibes' }, memory_tags: [] } as never,
    });
    expect(checkManifest(p, '/nonexistent').join()).toMatch(/round_spec:/);
  });
});

describe('normalizeTestName — the third notation (live failure)', () => {
  it('python dotted paths match the parser\'s " > " form', () => {
    const claimed = 'tests.test_dashboard.WatchlistTest.test_each_row_carries_the_snapshot_of_its_own_device';
    const observed = 'tests > test_dashboard > WatchlistTest > test_each_row_carries_the_snapshot_of_its_own_device';
    expect(normalizeTestName(claimed)).toBe(normalizeTestName(observed));
  });
});

describe('checkExpectations vocabulary pool keeps identifiers whole (rep-e2e52324)', () => {
  const base = (spec: string, reflect: string) => ({
    round_type: 'debugging' as const,
    repo_path: '.', model_paths: ['solution.py'], mutations: [],
    round_spec: { ...DEFAULT_DEBUGGING_SPEC, check: { kind: 'all_failing' as const } },
    spec,
    rubric: {
      round_type: 'debugging' as const,
      dimensions: {
        clarify: 'Pins down the chime duration bounds before writing any code at all here',
        approach: 'Names the chime table fill mechanism before typing a single line of it',
        communicate: 'Narrates the chime recurrence out loud while building it step by step',
        implement: 'Builds the chime table in one pass without rewriting the whole thing',
        verify: 'Dry-runs the chime examples by hand before submitting the final answer',
        reflect,
      },
    },
  });

  it('a snake_case identifier shared with the spec ties the expectation', () => {
    // The ONLY overlap is `min_ms` — story words (chime) live in the spec,
    // algorithm words (modulus) in the expectation. Pre-fix this false-failed.
    const p = base(
      'A doorbell chime is presentable when its duration lands between `min_ms` and `max_ms` inclusive, and the composer appends pulses one at a time until it does.',
      'Explains why the answer sums across the whole [min_ms, max_ms] range and why the modulus is applied throughout.',
    );
    const failures = checkExpectations(p as never);
    expect(failures.filter((f) => f.includes('reflect'))).toEqual([]);
  });

  it('still rejects an expectation with genuinely no shared vocabulary', () => {
    const p = base(
      'A doorbell chime is presentable when its duration lands between `min_ms` and `max_ms` inclusive.',
      'Explains the tradeoffs of their approach clearly and honestly to the interviewer at the end.',
    );
    expect(checkExpectations(p as never).some((f) => f.includes('reflect'))).toBe(true);
  });
});
