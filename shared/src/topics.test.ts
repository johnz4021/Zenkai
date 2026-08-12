import { describe, expect, it } from 'vitest';
import { TOPIC_TAGS, isTopicTag, normalizeTopicTag, normalizeTopicTags } from './topics.js';

/**
 * Every raw tag spelling observed in the vendored LeetCodeDataset at the
 * pinned revision (full-corpus audit, 2026-08-12). The vocabulary contract:
 * all of these normalize, none drop. If `lc fetch` ever reports a drop, the
 * dataset revision changed — extend TOPIC_TAGS deliberately and add the new
 * raw spelling here.
 */
const RAW_DATASET_TAGS = [
  'Array', 'String', 'Hash Table', 'Dynamic Programming', 'Math', 'Sorting',
  'Greedy', 'Binary Search', 'Depth-First Search', 'Matrix', 'Bit Manipulation',
  'Breadth-First Search', 'Two Pointers', 'Tree', 'Prefix Sum',
  'Heap (Priority Queue)', 'Simulation', 'Graph', 'Counting', 'Binary Tree',
  'Sliding Window', 'Stack', 'Enumeration', 'Backtracking', 'Union Find',
  'Number Theory', 'Monotonic Stack', 'Linked List', 'Bitmask', 'Segment Tree',
  'Trie', 'Combinatorics', 'Divide and Conquer', 'Recursion', 'Ordered Set',
  'Memoization', 'Geometry', 'String Matching', 'Hash Function',
  'Topological Sort', 'Binary Indexed Tree', 'Shortest Path', 'Queue',
  'Binary Search Tree', 'Rolling Hash', 'Game Theory', 'Monotonic Queue',
  'Brainteaser', 'Merge Sort', 'Counting Sort', 'Quickselect', 'Suffix Array',
  'Bucket Sort', 'Line Sweep', 'Probability and Statistics',
  'Minimum Spanning Tree', 'Radix Sort', 'Eulerian Circuit',
  'Strongly Connected Component', 'Interactive', 'Biconnected Component',
  'Concurrency', 'Randomized',
];

describe('topic vocabulary', () => {
  it('covers every raw dataset spelling with zero drops', () => {
    const { tags, dropped } = normalizeTopicTags(RAW_DATASET_TAGS);
    expect(dropped).toEqual([]);
    expect(tags.length).toBe(RAW_DATASET_TAGS.length);
  });

  it('vocabulary and dataset fixture are the same size — no orphan tags either way', () => {
    // An entry in TOPIC_TAGS that no dataset spelling produces would be an
    // unreachable bucket; keep the two lists in lockstep.
    expect(TOPIC_TAGS.length).toBe(RAW_DATASET_TAGS.length);
    const normalized = new Set(RAW_DATASET_TAGS.map((r) => normalizeTopicTag(r)));
    for (const t of TOPIC_TAGS) expect(normalized.has(t)).toBe(true);
  });

  it('normalization is mechanical: case, hyphens, parens, padding', () => {
    expect(normalizeTopicTag('Heap (Priority Queue)')).toBe('heap_priority_queue');
    expect(normalizeTopicTag('Depth-First Search')).toBe('depth_first_search');
    expect(normalizeTopicTag('  divide AND conquer  ')).toBe('divide_and_conquer');
  });

  it('out-of-vocabulary returns null, never throws', () => {
    expect(normalizeTopicTag('Database')).toBeNull();
    expect(normalizeTopicTag('')).toBeNull();
    expect(normalizeTopicTag('   ')).toBeNull();
  });

  it('normalizeTopicTags dedupes, preserves order, reports drops verbatim', () => {
    const { tags, dropped } = normalizeTopicTags(['Graph', 'graph', 'Shell', 'Array']);
    expect(tags).toEqual(['graph', 'array']);
    expect(dropped).toEqual(['Shell']);
  });

  it('isTopicTag guards the exact vocabulary', () => {
    expect(isTopicTag('union_find')).toBe(true);
    expect(isTopicTag('Union Find')).toBe(false);
  });
});
