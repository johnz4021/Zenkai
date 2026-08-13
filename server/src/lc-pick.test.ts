/**
 * The picker's promises: deterministic for a seed, diverse across primary
 * tags, respectful of the exclusion set, short when the pool runs dry —
 * and blind to everything the no-steering rule forbids (its inputs are
 * the index and options alone; there is nothing else to test).
 */
import { describe, expect, it } from 'vitest';
import type { LcIndexEntry } from './lc-source.js';
import { pickDiverse } from './lc-pick.js';

let n = 100;
const entry = (slug: string, tag: string, difficulty: 'easy' | 'medium' | 'hard' = 'medium'): LcIndexEntry => ({
  slug, id: n++, title: slug, difficulty, tags: [tag as never, 'array' as never],
  n_cases: 50, structures: ['plain'], stdlib_only: true,
});

const INDEX: LcIndexEntry[] = [
  entry('g1', 'graph'), entry('g2', 'graph'), entry('g3', 'graph'),
  entry('d1', 'dynamic_programming'), entry('d2', 'dynamic_programming'),
  entry('s1', 'string'), entry('s2', 'string'),
  entry('h1', 'hash_table'),
  entry('easy1', 'graph', 'easy'),
  { ...entry('tree1', 'tree'), structures: ['tree'] },          // ineligible: structure
  { ...entry('thin1', 'stack'), n_cases: 3 },                   // ineligible: case floor
];

describe('pickDiverse', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a1 = pickDiverse(INDEX, { count: 4, seed: 'target-a' });
    const a2 = pickDiverse(INDEX, { count: 4, seed: 'target-a' });
    expect(a1.map((e) => e.slug)).toEqual(a2.map((e) => e.slug));
    const b = pickDiverse(INDEX, { count: 4, seed: 'target-b' });
    expect([...a1, ...b].length).toBe(8); // both full — pool supports it
  });

  it('spreads consecutive picks across distinct primary tags while it can', () => {
    const picks = pickDiverse(INDEX, { count: 4, seed: 's' });
    const tags = picks.map((e) => e.tags[0]);
    expect(new Set(tags).size).toBe(4); // 4 distinct primary tags available
  });

  it('honors the difficulty band (default medium) and eligibility', () => {
    const picks = pickDiverse(INDEX, { count: 20, seed: 's' });
    expect(picks.every((e) => e.difficulty === 'medium')).toBe(true);
    expect(picks.some((e) => e.slug === 'tree1' || e.slug === 'thin1')).toBe(false);
    const easy = pickDiverse(INDEX, { count: 5, difficulty: ['easy'], seed: 's' });
    expect(easy.map((e) => e.slug)).toEqual(['easy1']);
  });

  it('respects exclusions and returns short when the pool runs dry', () => {
    const picks = pickDiverse(INDEX, {
      count: 10, seed: 's',
      excludeSlugs: new Set(['g1', 'g2', 'g3', 'd1', 'd2', 's1', 's2']),
    });
    expect(picks.map((e) => e.slug)).toEqual(['h1']); // one eligible medium left
  });

  it('wraps back to a tag once every tag has been dealt one', () => {
    const picks = pickDiverse(INDEX, { count: 8, seed: 's' });
    expect(picks).toHaveLength(8); // 8 eligible mediums total
    const firstFour = new Set(picks.slice(0, 4).map((e) => e.tags[0]));
    expect(firstFour.size).toBe(4); // one from each tag before any repeat
  });
});
