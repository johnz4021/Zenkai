/**
 * The ladder's order and its refusals are the contract: a wrong binding
 * builds the wrong problem under a user-visible commitment, so ambiguity
 * must resolve to null, never to a guess.
 */
import { describe, expect, it } from 'vitest';
import type { LcIndexEntry } from './lc-source.js';
import { resolveProblemRef, titleSpoilsProblem } from './lc-refs.js';

const entry = (slug: string, id: number, title: string): LcIndexEntry => ({
  slug, id, title, difficulty: 'medium', tags: ['array'], n_cases: 50,
  structures: ['plain'], stdlib_only: true,
});

const INDEX: LcIndexEntry[] = [
  entry('two-sum', 1, 'Two Sum'),
  entry('two-sum-ii-input-array-is-sorted', 167, 'Two Sum II Input Array Is Sorted'),
  entry('lru-cache', 146, 'Lru Cache'),
  entry('merge-intervals', 56, 'Merge Intervals'),
  entry('candy', 135, 'Candy'),
  entry('reorder-list', 143, 'Reorder List'),
];

describe('resolveProblemRef — the ladder', () => {
  it('exact slug wins first', () => {
    expect(resolveProblemRef('lru-cache', INDEX)?.id).toBe(146);
    expect(resolveProblemRef('two-sum', INDEX)?.id).toBe(1);
  });

  it('LC-number forms all resolve', () => {
    for (const form of ['146', 'LC 146', 'lc146', '#146', 'leetcode 146', 'LeetCode #146']) {
      expect(resolveProblemRef(form, INDEX)?.slug).toBe('lru-cache');
    }
    expect(resolveProblemRef('LC 9999', INDEX)).toBeNull();
  });

  it('normalized exact title match, case- and punctuation-blind', () => {
    expect(resolveProblemRef('Two Sum', INDEX)?.slug).toBe('two-sum');
    expect(resolveProblemRef('merge intervals!', INDEX)?.slug).toBe('merge-intervals');
    expect(resolveProblemRef('LRU cache', INDEX)?.slug).toBe('lru-cache');
  });

  it('containment resolves only when the hit is UNIQUE', () => {
    // "the two sum problem" contains BOTH "Two Sum" and nothing else whole;
    // Two Sum II's full title is not contained, so this is a unique hit.
    expect(resolveProblemRef('the two sum problem', INDEX)?.slug).toBe('two-sum');
    // Bare "two sum" exact-matches Two Sum before containment can see II.
    expect(resolveProblemRef('two sum', INDEX)?.slug).toBe('two-sum');
    // A query contained by MULTIPLE titles refuses: "sum" is one word — no
    // whole-title relation; craft a real ambiguity instead:
    const amb = [...INDEX, entry('two-sum-iii', 1000, 'Two Sum Iii')];
    expect(resolveProblemRef('some two sum iii and two sum together', amb)).toBeNull();
  });

  it('unresolvable prose and empties return null, never throw', () => {
    expect(resolveProblemRef('', INDEX)).toBeNull();
    expect(resolveProblemRef('   ', INDEX)).toBeNull();
    expect(resolveProblemRef('a hard graph one probably', INDEX)).toBeNull();
  });
});

describe('titleSpoilsProblem — the plan-topics net', () => {
  it('hits when a multi-word LC title appears whole', () => {
    expect(titleSpoilsProblem('Two sum — hash table lookup', INDEX)).toBe(true);
    expect(titleSpoilsProblem('Warehouse merge intervals audit', INDEX)).toBe(true);
  });

  it('one-word LC titles never trigger (common-noun false positives)', () => {
    expect(titleSpoilsProblem('Candy distribution ledger — batch audit', INDEX)).toBe(false);
  });

  it('honest scenario titles pass', () => {
    expect(titleSpoilsProblem('Warehouse pallet pairing — batch audit', INDEX)).toBe(false);
    expect(titleSpoilsProblem('Delivery window overlap report', INDEX)).toBe(false);
  });
});
