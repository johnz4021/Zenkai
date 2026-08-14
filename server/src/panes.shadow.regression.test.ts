/**
 * Regression: QA 2026-08-14 fix-verification — the one-shot read-only block
 * covered tests/ and cases*.json, but the graded run is
 * `cd <workspace> && <test_command>` and Python puts the CWD on sys.path
 * for `-m`, so a root-level unittest.py IS the module the runner imports.
 * A candidate could force a green graded suite without ever touching
 * tests/ (demonstrated end to end against a live one-shot round).
 * Report: .gstack/qa-reports/qa-report-interview-prep-2026-08-14.md
 */
import { describe, expect, it } from 'vitest';
import { shadowsTestRunner } from './panes.js';

describe('shadowsTestRunner — the graded-run hijack guard', () => {
  it('catches the demonstrated exploit: a root-level unittest.py', () => {
    expect(shadowsTestRunner('unittest.py')).toBe(true);
  });

  it('catches the other CWD-imported runner hooks', () => {
    for (const f of [
      'pytest.py',
      'conftest.py',
      'sitecustomize.py',
      'usercustomize.py',
      'vitest.config.ts',
      'vitest.config.js',
      'vitest.config.mjs',
    ]) {
      expect(shadowsTestRunner(f), f).toBe(true);
    }
  });

  it('is case-insensitive (macOS/Windows hosts resolve UnitTest.py the same)', () => {
    expect(shadowsTestRunner('UnitTest.py')).toBe(true);
  });

  // Only the CWD copy is the one the runner imports. Blocking nested paths
  // would take away ordinary work: a round may legitimately ship its own
  // package with any of these names inside it.
  it('leaves nested copies alone — they never shadow', () => {
    expect(shadowsTestRunner('pkg/unittest.py')).toBe(false);
    expect(shadowsTestRunner('src/deep/conftest.py')).toBe(false);
  });

  it('leaves the candidate\'s actual work alone', () => {
    for (const f of ['solution.py', 'solution_part1.py', 'REVIEW.md', 'api.py', 'notes.txt']) {
      expect(shadowsTestRunner(f), f).toBe(false);
    }
  });
});
