/**
 * The vocabulary gate is what stands between LLM spec inference and a wrong
 * 45-minute session — every failure mode here is one a draft spec actually
 * has available to it.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEBUGGING_SPEC, validateRoundSpec, type RoundSpec } from './round-spec.js';
import { resolveRoundSpec } from './rubric.js';

const good = (): RoundSpec => JSON.parse(JSON.stringify(DEFAULT_DEBUGGING_SPEC)) as RoundSpec;

describe('validateRoundSpec', () => {
  it('accepts the default debugging spec (the back-compat anchor)', () => {
    expect(validateRoundSpec(DEFAULT_DEBUGGING_SPEC)).toEqual([]);
  });

  it('accepts a coherent OA spec', () => {
    const oa: RoundSpec = {
      id: 'node-oa',
      label: 'Node.js HackerRank-style task',
      capabilities: {
        interviewer: false,
        can_run_tests: true,
        time_limit_ms: 90 * 60_000,
        starts_from: 'blank',
        submit: 'one_shot',
      },
      check: { kind: 'all_failing', min_tests: 6 },
      memory_tags: ['from_scratch', 'time_boxed', 'autograded'],
    };
    expect(validateRoundSpec(oa)).toEqual([]);
  });

  it('rejects out-of-vocabulary values instead of letting them reach a session', () => {
    const s = good();
    (s.capabilities as { starts_from: string }).starts_from = 'whiteboard';
    (s.check as { kind: string }).kind = 'vibes';
    (s.memory_tags as string[]).push('spicy');
    const failures = validateRoundSpec(s);
    expect(failures.join('\n')).toMatch(/starts_from out of vocabulary/);
    expect(failures.join('\n')).toMatch(/check\.kind out of vocabulary/);
    expect(failures.join('\n')).toMatch(/memory_tag out of vocabulary/);
  });

  it('rejects a test-based check on a round that cannot run tests', () => {
    const s = good();
    s.capabilities.can_run_tests = false;
    expect(validateRoundSpec(s).join('\n')).toMatch(/incoherent/);
  });

  it('requires files_changed for diff_present', () => {
    const s = good();
    s.capabilities.can_run_tests = false;
    s.check = { kind: 'diff_present' };
    expect(validateRoundSpec(s).join('\n')).toMatch(/files_changed/);
  });

  it('rejects non-objects and empty shells loudly', () => {
    expect(validateRoundSpec(null)).toHaveLength(1);
    expect(validateRoundSpec({}).length).toBeGreaterThanOrEqual(4);
  });
});

describe('resolveRoundSpec', () => {
  it('pre-spec manifests resolve to the default debugging spec', () => {
    expect(resolveRoundSpec({})).toEqual(DEFAULT_DEBUGGING_SPEC);
  });

  it('a manifest-carried spec wins', () => {
    const oa = good();
    oa.id = 'custom';
    expect(resolveRoundSpec({ round_spec: oa }).id).toBe('custom');
  });
});
