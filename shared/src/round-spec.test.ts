/**
 * The vocabulary gate is what stands between LLM spec inference and a wrong
 * 45-minute session — every failure mode here is one a draft spec actually
 * has available to it.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEBUGGING_SPEC, resolveSurface, validateRoundSpec, type RoundSpec } from './round-spec.js';
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

  it('surface is optional, in-vocabulary when present, rejected otherwise', () => {
    expect(validateRoundSpec(good())).toEqual([]); // absent — every pre-surface spec
    const ide = good();
    ide.capabilities.surface = 'ide';
    expect(validateRoundSpec(ide)).toEqual([]);
    const panes = good();
    panes.capabilities.surface = 'panes';
    expect(validateRoundSpec(panes)).toEqual([]);
    const bad = good();
    (bad.capabilities as { surface: string }).surface = 'terminal';
    expect(validateRoundSpec(bad).join('\n')).toMatch(/surface out of vocabulary/);
  });
});

describe('resolveSurface', () => {
  // The derivation is what routes the two on-disk OA targets (starts_from
  // 'blank', no surface field) to panes with zero regeneration — and keeps
  // every pre-surface debugging spec on the IDE it was built for.
  it('blank rounds without a surface derive panes (the on-disk OA targets)', () => {
    const oa = good().capabilities;
    oa.starts_from = 'blank';
    expect(resolveSurface(oa)).toBe('panes');
  });

  it('repo rounds without a surface derive ide (every pre-surface debugging spec)', () => {
    expect(resolveSurface(DEFAULT_DEBUGGING_SPEC.capabilities)).toBe('ide');
  });

  it('an explicit surface beats the derivation in both directions', () => {
    const repoPanes = good().capabilities;
    repoPanes.surface = 'panes';
    expect(resolveSurface(repoPanes)).toBe('panes');
    const blankIde = good().capabilities;
    blankIde.starts_from = 'blank';
    blankIde.surface = 'ide';
    expect(resolveSurface(blankIde)).toBe('ide');
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
