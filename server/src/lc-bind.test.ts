/**
 * The binding decision's promises, finally pinned (the 2026-08-15 incident
 * shipped its one-line fix with no test because the decision lived inside
 * two request handlers). Eligibility: the task hypothesis outranks the
 * capability fallback — a practical build stays unsourced even when its
 * shape sits in the fallback's documented blind spot. Composition: named
 * lead, picks fill, clamps hold, dedup accumulates. All pure — the index
 * and blocklist are inputs.
 */
import { describe, expect, it } from 'vitest';
import type { RoundSpec } from '@interview-prep/shared';
import type { LcIndexEntry } from './lc-source.js';
import {
  autoSourceEligible,
  composeSourceBinding,
  resolveNamedRefs,
  sourceSetSize,
} from './lc-bind.js';

let n = 500;
const entry = (slug: string, tag: string, difficulty: 'easy' | 'medium' | 'hard' = 'medium'): LcIndexEntry => ({
  slug, id: n++, title: slug, difficulty, tags: [tag as never, 'array' as never],
  n_cases: 50, structures: ['plain'], stdlib_only: true,
});

const INDEX: LcIndexEntry[] = [
  entry('g1', 'graph'), entry('g2', 'graph'),
  entry('d1', 'dynamic_programming'), entry('d2', 'dynamic_programming'),
  entry('s1', 'string'), entry('s2', 'string'),
  entry('easy1', 'hash_table', 'easy'),
  { ...entry('tree1', 'tree'), structures: ['tree'] }, // ineligible for sourcing
];

const spec = (over: Partial<RoundSpec['capabilities']> = {}, check: Partial<RoundSpec['check']> = {}): RoundSpec =>
  ({
    id: 's1',
    label: 'S1',
    capabilities: {
      interviewer: false, can_run_tests: true, time_limit_ms: 3_600_000,
      starts_from: 'blank', submit: 'iterate', surface: 'panes', ...over,
    },
    check: { kind: 'all_failing', ...check },
    memory_tags: ['from_scratch'],
  }) as RoundSpec;

describe('autoSourceEligible — the 2026-08-15 gate', () => {
  it('the incident pin: a practical_build hypothesis is never sourced, even in the fallback blind spot', () => {
    // blank + all_failing + panes is exactly the shape deriveTaskFromSpec
    // cannot tell apart from an algorithmic set — the fallback alone says
    // bind. The hypothesis (made by the model that read the material) wins.
    expect(autoSourceEligible('practical_build', spec())).toBe(false);
  });

  it('only an algorithmic_set hypothesis binds; every other task never does', () => {
    expect(autoSourceEligible('algorithmic_set', spec())).toBe(true);
    for (const task of ['debug', 'practical_build', 'comprehend', 'extend_keep_green', 'review_diff']) {
      expect(autoSourceEligible(task, spec()), task).toBe(false);
    }
  });

  it('no hypothesis → the capability fallback, exactly as documented', () => {
    expect(autoSourceEligible(undefined, spec())).toBe(true); // blank+all_failing+panes
    expect(autoSourceEligible(undefined, spec({ starts_from: 'repo', surface: 'ide' }))).toBe(false); // practical_build side
    expect(autoSourceEligible(undefined, spec({}, { kind: 'one_failing_test' }))).toBe(false);
    expect(autoSourceEligible(undefined, spec({}, { kind: 'all_passing' }))).toBe(false);
    expect(autoSourceEligible(undefined, spec({ starts_from: 'diff' }, { kind: 'diff_present' }))).toBe(false);
  });
});

describe('resolveNamedRefs — the lenient tier', () => {
  it('resolves in order; unknown, blocked, excluded, and ineligible refs drop', () => {
    const named = resolveNamedRefs(['g1', 'nope', 'd1', 's1', 'tree1'], {
      index: INDEX,
      blocked: new Set(['d1']),
      excludeSlugs: new Set(['s1']),
    });
    expect(named.map((e) => e.slug)).toEqual(['g1']);
  });
});

describe('sourceSetSize — the clamp', () => {
  it('stated count, never below named, capped by max_source_files and 4', () => {
    expect(sourceSetSize(3, 0, spec())).toBe(3);
    expect(sourceSetSize(2, 3, spec())).toBe(3); // never below named
    expect(sourceSetSize(undefined, 2, spec())).toBe(2);
    expect(sourceSetSize(undefined, 0, spec())).toBe(1); // floor
    expect(sourceSetSize(9, 0, spec())).toBe(4); // hard cap
    expect(sourceSetSize(3, 0, spec({}, { kind: 'all_failing', max_source_files: 2 }))).toBe(2);
  });

  it('a stated 1 is identical to undefined for every named count (the old >=2 filter was moot)', () => {
    for (const namedCount of [0, 1, 2, 3]) {
      expect(sourceSetSize(1, namedCount, spec())).toBe(sourceSetSize(undefined, namedCount, spec()));
    }
  });
});

describe('composeSourceBinding', () => {
  it('a single pick has no parts; a set carries parts in escalation order', () => {
    const single = composeSourceBinding({ index: INDEX, named: [], count: 1, excludeSlugs: new Set(), seed: 'a' });
    expect(single.binding).not.toBeNull();
    expect(single.binding!.kind).toBe('leetcode');
    expect(single.binding!.parts).toBeUndefined();
    expect(single.boundSlugs).toHaveLength(1);

    const set = composeSourceBinding({
      index: INDEX, named: [INDEX.find((e) => e.slug === 'easy1')!], count: 3, excludeSlugs: new Set(), seed: 'a',
    });
    expect(set.binding!.parts).toHaveLength(3);
    expect(set.binding!.parts![0]!.difficulty).toBe('easy'); // escalation: easiest leads
    expect(set.binding!.slug).toBe(set.binding!.parts![0]!.slug); // top-level = part 1
    expect(set.boundSlugs).toEqual(set.binding!.parts!.map((p) => p.slug));
  });

  it('a dry pool yields null, and exclusions are respected', () => {
    const all = new Set(INDEX.map((e) => e.slug));
    expect(composeSourceBinding({ index: INDEX, named: [], count: 2, excludeSlugs: all, seed: 'a' }).binding).toBeNull();
  });

  it('is deterministic per seed', () => {
    const a = composeSourceBinding({ index: INDEX, named: [], count: 2, excludeSlugs: new Set(), seed: 'x' });
    const b = composeSourceBinding({ index: INDEX, named: [], count: 2, excludeSlugs: new Set(), seed: 'x' });
    expect(a.boundSlugs).toEqual(b.boundSlugs);
  });
});

describe('the accept-spec fan-out contract (pure simulation)', () => {
  it('per-item sets never repeat a slug; named refs land only in item 1', () => {
    const bound = new Set<string>();
    const named = resolveNamedRefs(['g1'], { index: INDEX, blocked: new Set(), excludeSlugs: bound });
    const count = sourceSetSize(2, named.length, spec());
    const sets: string[][] = [];
    for (const item of ['item-1', 'item-2', 'item-3']) {
      const { binding, boundSlugs } = composeSourceBinding({
        index: INDEX,
        named: item === 'item-1' ? named : [],
        count,
        excludeSlugs: new Set([...bound]),
        seed: `t:s1:${item}`,
      });
      if (!binding) continue;
      for (const s of boundSlugs) bound.add(s);
      sets.push(boundSlugs);
    }
    const flat = sets.flat();
    expect(new Set(flat).size).toBe(flat.length); // cross-item dedup holds
    expect(sets[0]).toContain('g1'); // named leads item 1
    expect(sets.slice(1).flat()).not.toContain('g1'); // and only item 1
  });
});
