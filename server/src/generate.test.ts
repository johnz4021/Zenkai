/**
 * The requirement blocks are the words the generator obeys hardest — the
 * template calls them non-advisory. The pinned regression: "4 to 8 source
 * files" beat a candidate's explicit "one page of Python" (Palantir
 * size-loss case, docs/problem-generation.md), while the validator never
 * counted files at all. Size claims live here ONLY when the validator
 * proves them.
 */
import { describe, expect, it } from 'vitest';
import type { RoundSpec } from '@interview-prep/shared';
import { checkRequirements } from './generate.js';

type Check = RoundSpec['check'];

describe('checkRequirements', () => {
  it('one_failing_test makes no unproven size claim — the old constant is dead', () => {
    const block = checkRequirements({ kind: 'one_failing_test' });
    expect(block).not.toContain('4 to 8');
    expect(block).not.toMatch(/\d+ to \d+ source files/);
    // Shape defers to the round description, which the template says wins.
    expect(block).toContain('sized per the round');
  });

  it('test floors interpolate min_tests instead of hardcoding', () => {
    expect(checkRequirements({ kind: 'one_failing_test' })).toContain('at least 8 tests');
    expect(checkRequirements({ kind: 'one_failing_test', min_tests: 12 })).toContain('at least 12 tests');
    expect(checkRequirements({ kind: 'all_failing' })).toContain('At least 5 tests');
    expect(checkRequirements({ kind: 'all_failing', min_tests: 9 })).toContain('At least 9 tests');
    expect(checkRequirements({ kind: 'all_passing', min_tests: 6 })).toContain('at least 6 tests');
  });

  it('the max-files sentence appears exactly when the spec sets the knob', () => {
    const capped: Check = { kind: 'one_failing_test', max_source_files: 1 };
    expect(checkRequirements(capped)).toContain('At most 1 source file (tests excluded)');
    expect(checkRequirements(capped)).toContain('the validator counts them');
    expect(checkRequirements({ kind: 'one_failing_test' })).not.toContain('At most');
    // And it is the plural form when > 1.
    expect(checkRequirements({ kind: 'all_failing', max_source_files: 3 })).toContain('At most 3 source files');
  });

  it('the planted-bug machinery and self-verification survive the slimming', () => {
    const block = checkRequirements({ kind: 'one_failing_test' });
    expect(block).toContain('EXACTLY ONE subtle bug');
    expect(block).toContain('"planted_bug"');
    expect(block).toContain('Self-verification');
    expect(block).toContain('RESTORE the bug exactly');
  });

  it('every check kind still produces a block', () => {
    for (const kind of ['one_failing_test', 'all_failing', 'all_passing', 'diff_present'] as const) {
      expect(checkRequirements({ kind }).length).toBeGreaterThan(100);
    }
  });
});
