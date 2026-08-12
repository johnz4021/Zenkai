/**
 * LeetCode topic-tag vocabulary — single source of truth.
 *
 *   dataset tags ("Heap (Priority Queue)") ──► normalizeTopicTag ──► TopicTag
 *                                                                      │
 *                    topic ledger (topic-graph.ts) counts over ────────┤
 *                    lc ingest (lc-source.ts) asserts zero drops ──────┘
 *
 * Why it exists: the topic graph counts over these keys the way the gap
 * graph counts over dimensions, so the vocabulary must be CLOSED and stable
 * (free-form tags would fragment a thin history into buckets of one —
 * round-spec.ts's memory-tag rule, applied to topics). The list is exactly
 * the 63 tags observed in the vendored LeetCodeDataset at the pinned
 * revision (2026-08-12 audit over all 2,869 records) — not a hand-guessed
 * LC tag list. `cli.ts lc fetch` asserts every dataset tag normalizes into
 * this vocabulary with zero drops; if a future dataset revision introduces
 * a new tag, ingest fails loudly and this file gets a deliberate PR, never
 * a silent bucket.
 *
 * Normalization is purely mechanical (lowercase, non-alphanumeric runs to
 * "_", trim) — audited to cover all 63 observed spellings with no alias
 * table. Keep it that way until a dataset revision proves otherwise.
 */

export const TOPIC_TAGS = [
  'array',
  'string',
  'hash_table',
  'dynamic_programming',
  'math',
  'sorting',
  'greedy',
  'binary_search',
  'depth_first_search',
  'matrix',
  'bit_manipulation',
  'breadth_first_search',
  'two_pointers',
  'tree',
  'prefix_sum',
  'heap_priority_queue',
  'simulation',
  'graph',
  'counting',
  'binary_tree',
  'sliding_window',
  'stack',
  'enumeration',
  'backtracking',
  'union_find',
  'number_theory',
  'monotonic_stack',
  'linked_list',
  'bitmask',
  'segment_tree',
  'trie',
  'combinatorics',
  'divide_and_conquer',
  'recursion',
  'ordered_set',
  'memoization',
  'geometry',
  'string_matching',
  'hash_function',
  'topological_sort',
  'binary_indexed_tree',
  'shortest_path',
  'queue',
  'binary_search_tree',
  'rolling_hash',
  'game_theory',
  'monotonic_queue',
  'brainteaser',
  'merge_sort',
  'counting_sort',
  'quickselect',
  'suffix_array',
  'bucket_sort',
  'line_sweep',
  'probability_and_statistics',
  'minimum_spanning_tree',
  'radix_sort',
  'eulerian_circuit',
  'strongly_connected_component',
  'interactive',
  'biconnected_component',
  'concurrency',
  'randomized',
] as const;

export type TopicTag = (typeof TOPIC_TAGS)[number];

const TAG_SET = new Set<string>(TOPIC_TAGS);

export function isTopicTag(v: string): v is TopicTag {
  return TAG_SET.has(v);
}

/**
 * Mechanical dataset-tag → vocabulary mapping. Returns null for anything
 * out of vocabulary — callers decide whether a drop is a warn (the topic
 * recorder) or a hard failure (lc ingest). Never throws.
 */
export function normalizeTopicTag(raw: string): TopicTag | null {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return isTopicTag(slug) ? slug : null;
}

/**
 * Normalize a raw tag list: deduped, order-preserving, with the raw
 * spellings that failed to resolve reported alongside — the ingest gate's
 * zero-drop assertion is `dropped.length === 0` over the whole corpus.
 */
export function normalizeTopicTags(raw: string[]): { tags: TopicTag[]; dropped: string[] } {
  const tags: TopicTag[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = normalizeTopicTag(String(r));
    if (t === null) {
      dropped.push(String(r));
    } else if (!seen.has(t)) {
      seen.add(t);
      tags.push(t);
    }
  }
  return { tags, dropped };
}
