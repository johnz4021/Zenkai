import { describe, expect, it } from 'vitest';
import {
  assertLcRecord, detectStdlibOnly, detectStructures, eligibleForSourcing,
  indexEntryOf, normalizeRecord, titleFromSlug,
} from './lc-source.js';

/** Fabricated record in the audited upstream encoding — never real dataset
 *  bytes (the corpus is licensed but statements stay out of git). */
const RAW = {
  task_id: 'sum-of-widget-batches-ii',
  question_id: 4242,
  difficulty: 'Medium',
  tags: ['Array', 'Hash Table', 'Heap (Priority Queue)'],
  problem_description:
    'You are given an integer array batches. Return the sum of all batch sizes that appear exactly twice.\n \nExample 1:\n\nInput: batches = [1,2,2,3]\nOutput: 4\n\nConstraints:\n\n1 <= batches.length <= 100',
  starter_code: 'class Solution:\n    def sumOfBatches(self, batches: List[int]) -> int:\n        ',
  completion:
    'class Solution:\n    def sumOfBatches(self, batches: List[int]) -> int:\n        c = Counter(batches)\n        return sum(v * 2 for v, n in c.items() if n == 2)\n',
  entry_point: 'Solution().sumOfBatches',
  test: 'def check(candidate):\n    assert candidate(batches = [1,2,2,3]) == 4\n',
  input_output: [
    { input: 'batches = [1,2,2,3]', output: '4' },
    { input: 'batches = [5]', output: '0' },
  ],
  estimated_date: '2024-05-01',
};

describe('lc-source normalization', () => {
  it('normalizes the audited record shape end to end', () => {
    const p = normalizeRecord(RAW);
    expect(p.slug).toBe('sum-of-widget-batches-ii');
    expect(p.id).toBe(4242);
    expect(p.title).toBe('Sum Of Widget Batches II');
    expect(p.difficulty).toBe('medium');
    expect(p.tags).toEqual(['array', 'hash_table', 'heap_priority_queue']);
    expect(p.method).toBe('sumOfBatches');
    expect(p.structures).toEqual(['plain']);
    expect(p.stdlib_only).toBe(true);
    expect(p.cases).toHaveLength(2);
  });

  it('rejects out-of-vocabulary tags loudly instead of dropping them', () => {
    expect(() => normalizeRecord({ ...RAW, tags: ['Array', 'Shell'] })).toThrow(/out of vocabulary: Shell/);
  });

  it('assertLcRecord names the slug and the drifted field', () => {
    expect(() => assertLcRecord({ ...RAW, entry_point: 'solve' })).toThrow(/sum-of-widget-batches-ii.*entry_point/);
    expect(() => assertLcRecord({ ...RAW, input_output: [] })).toThrow(/input_output/);
    expect(() => assertLcRecord({ ...RAW, input_output: [{ input: 'x = 1', output: 2 }] })).toThrow(/input_output entry/);
    expect(() => assertLcRecord({ ...RAW, difficulty: 'Impossible' })).toThrow(/difficulty/);
  });

  it('null-output cases pass the gate but are dropped at normalization', () => {
    const p = normalizeRecord({
      ...RAW,
      input_output: [...RAW.input_output, { input: 'batches = [9]', output: null }],
    });
    expect(p.cases).toHaveLength(2); // the null-output case is gone
  });

  it('titleFromSlug handles roman numerals and hyphens', () => {
    expect(titleFromSlug('two-sum')).toBe('Two Sum');
    expect(titleFromSlug('lru-cache')).toBe('Lru Cache');
    expect(titleFromSlug('best-time-to-buy-and-sell-stock-iv')).toBe('Best Time To Buy And Sell Stock IV');
  });

  it('detects tree and linked-list structures from the dataset harness', () => {
    expect(detectStructures({ test: 'assert is_same_tree(candidate(root = tree_node([1,2])), ...)' })).toEqual(['tree']);
    expect(detectStructures({ starter_code: 'class Solution:\n    def merge(self, l1: Optional[ListNode]) -> ...' })).toEqual(['linked_list']);
    expect(detectStructures({ test: 'assert candidate(n = 3) == 2' })).toEqual(['plain']);
  });

  it('flags third-party imports as not stdlib-only', () => {
    expect(detectStdlibOnly({ completion: 'from sortedcontainers import SortedList\nclass Solution: ...' })).toBe(false);
    expect(detectStdlibOnly({ completion: 'import heapq\nclass Solution: ...' })).toBe(true);
    // "sortedcontainers" inside a comment/prose must not false-positive on word fragments.
    expect(detectStdlibOnly({ completion: 'class Solution:\n    # no imports\n    pass' })).toBe(true);
  });

  it('catches BARE sortedcontainers usage with no import line (upstream env auto-imports)', () => {
    expect(detectStdlibOnly({ completion: 'class Solution:\n    def f(self):\n        sl = SortedList()\n' })).toBe(false);
  });

  it('eligibility bar: plain + stdlib + case floor', () => {
    const e = indexEntryOf(normalizeRecord(RAW));
    expect(eligibleForSourcing(e)).toBe(false); // only 2 cases
    expect(eligibleForSourcing({ ...e, n_cases: 12 })).toBe(true);
    expect(eligibleForSourcing({ ...e, n_cases: 50, structures: ['tree'] })).toBe(false);
    expect(eligibleForSourcing({ ...e, n_cases: 50, stdlib_only: false })).toBe(false);
  });
});

describe('sourceBindingVerdict — the one ladder (integration over the real dataset when fetched)', () => {
  // Pure-shape checks only when the dataset is absent; the e2e sweep covers
  // the fetched path. Here: the reason strings surface verbatim as UI copy.
  it('names the missing dataset instead of throwing', async () => {
    const { sourceBindingVerdict } = await import('./lc-source.js');
    const v = sourceBindingVerdict('/nonexistent-root', 'two-sum');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('lc fetch');
  });
});
