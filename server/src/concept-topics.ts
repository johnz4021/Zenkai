/**
 * Per-plan concept topics — the mechanical half of the topics harness.
 *
 *   planner propose_rounds (topics: string[]) ──► gateConceptTopics ──► Target.topics
 *                                                        (frozen at accept-spec)
 *   generator manifest (topics_exercised) ──► filterExercised ──► problem.json
 *                                                        (subset of the frozen list)
 *
 * Why authored-per-plan instead of a global taxonomy (user decision,
 * 2026-08-13): the concept space of interview rounds is far larger than the
 * LC tag set (debugging a Python service, LLD, a Node build — none
 * representable), and authoring a global vocabulary up front means guessing.
 * The planner that read the candidate's own material names 4-12 topics for
 * THIS season; a frozen per-plan list is still a closed vocabulary — it just
 * has plan scope, which is exactly where "what do I drill" lives. Cross-plan
 * aggregation is deliberately given up (nothing asks it at this scale); after
 * ~20 plans the accumulated slugs are the DATA a real global taxonomy gets
 * derived from.
 *
 * Why this makes recording legal: topic-graph.ts refuses non-LC topical
 * identity because "it exists only as model prose, and recording that would
 * put ungated model output into state." This module is the gate that removes
 * the objection — authored once, mechanically gated, candidate-confirmed at
 * the same surface that confirms specs, append-only after. The LC dataset
 * ledger keeps its own mechanical guarantee; the two vocabularies never mix
 * into one number.
 *
 * Module shape per the plan-topics.ts convention: a pure gate that THROWS
 * with the reason; callers degrade (a plan without topics is a plan, never a
 * failure). filterExercised never throws — an out-of-list declaration is
 * dropped and reported, because the generator must not be able to invent
 * vocabulary into state.
 */

export interface ConceptTopic {
  /** lowercase_snake_case, the countable key. */
  id: string;
  /** Human label, derived from the id unless authored. */
  label: string;
}

export const MIN_TOPICS = 4;
export const MAX_TOPICS = 12;

const SLUG = /^[a-z][a-z0-9_]{2,40}$/;

// Filler is banned as a WHOLE-SLUG pattern: a topic that names everything
// names nothing, and "misc" is where a lazy author hides. Vocabulary inside
// a real slug ("dynamic_programming_basics") survives.
const BANNED = new Set([
  'general', 'misc', 'other', 'basics', 'fundamentals', 'coding',
  'programming', 'algorithms', 'data_structures', 'problem_solving',
]);

const labelOf = (id: string): string => id.replace(/_/g, ' ');

/**
 * Gate the planner's authored topic slugs. Accepts an array of strings (the
 * tool-schema shape) and returns normalized {id, label} pairs. Throws with
 * the reason on any violation — the caller degrades to a topic-less plan.
 */
export function gateConceptTopics(raw: unknown): ConceptTopic[] {
  if (!Array.isArray(raw)) throw new Error('topics: not an array');
  const ids = raw.map((t) => String(t).trim().toLowerCase());
  if (ids.length < MIN_TOPICS || ids.length > MAX_TOPICS) {
    throw new Error(`topics: got ${ids.length}, need ${MIN_TOPICS}-${MAX_TOPICS}`);
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (!SLUG.test(id)) throw new Error(`topics: "${id}" is not a lowercase_snake_case slug`);
    if (BANNED.has(id)) throw new Error(`topics: "${id}" is filler — name the concept, not the category`);
    if (seen.has(id)) throw new Error(`topics: duplicate "${id}"`);
    seen.add(id);
  }
  return ids.map((id) => ({ id, label: labelOf(id) }));
}

/**
 * Filter a generator's declared topics against the plan's frozen list.
 * Mechanical subset — kept ⊆ allowed by id; everything else is dropped and
 * reported so the build log shows what the model tried to invent. Never
 * throws: topics are annotation, not a build gate.
 */
export function filterExercised(
  declared: unknown,
  allowed: ConceptTopic[],
): { kept: string[]; dropped: string[] } {
  if (!Array.isArray(declared)) return { kept: [], dropped: [] };
  const allowedIds = new Set(allowed.map((t) => t.id));
  const kept: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const t of declared) {
    const id = String(t).trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    (allowedIds.has(id) ? kept : dropped).push(id);
  }
  return { kept, dropped };
}
