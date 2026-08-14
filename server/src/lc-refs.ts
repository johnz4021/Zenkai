/**
 * Problem-reference resolution — how a HUMAN'S words become a dataset slug.
 *
 *   "two sum" / "LC 146" / "#1" / "lru-cache"
 *        │  resolveProblemRef (pure ladder over the index)
 *        ▼
 *   LcIndexEntry | null ──► source binding (practice door, planner door,
 *                            /api/item/source) — null degrades to prose
 *
 * Why it exists: intake extraction and the plan-view control both need to
 * turn free text into a binding MECHANICALLY — a model may notice that a
 * problem was named, but the model never decides which dataset entry that
 * is (no model output reaches state ungated). This realizes TODOS #21
 * against the real 2,869-slug index instead of a curated list.
 *
 * titleSpoilsProblem is the same index turned defensive: plan-topics
 * titles are a COMMITMENT fed to generation and shown pre-round, so a
 * title that names a real problem both spoils the round and contradicts
 * the blueprint's difficulty (the 2026-08-13 "Two sum — hash table
 * lookup" vs "LeetCode-medium" collision, sess-1786643587196).
 *
 * Everything here is pure over (string, index) — no fs, no model.
 */

import type { LcIndexEntry } from './lc-source.js';

/** Lowercase, strip everything but letters/digits/spaces, collapse runs. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** "LC 146" / "leetcode #146" / "#146" / "146" → 146; null otherwise. */
function numberRef(raw: string): number | null {
  const m = raw
    .trim()
    .match(/^(?:lc|leetcode)?\s*#?\s*(\d{1,5})$/i);
  return m ? Number(m[1]) : null;
}

/**
 * The resolution ladder, most-specific first:
 *   1. exact slug            ("lru-cache")
 *   2. LC number             ("146", "LC 146", "#146", "leetcode 146")
 *   3. normalized title, exact  ("two sum" → Two Sum)
 *   4. containment, UNIQUE only ("the two sum problem" ⊇ "two sum";
 *      "merge interv" is NOT matched — containment is whole-title, not prefix)
 * Ambiguous or unresolved → null; the caller keeps the words as prose.
 */
export function resolveProblemRef(raw: string, index: LcIndexEntry[]): LcIndexEntry | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  if (/^[a-z0-9-]+$/.test(trimmed)) {
    const bySlug = index.find((e) => e.slug === trimmed);
    if (bySlug) return bySlug;
  }

  const num = numberRef(trimmed);
  if (num !== null) {
    return index.find((e) => e.id === num) ?? null;
  }

  const q = normalize(trimmed);
  if (!q) return null;

  const exact = index.filter((e) => normalize(e.title) === q);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null; // duplicate titles upstream — refuse to guess

  // Whole-title containment with word boundaries, unique hit only. Padded
  // spaces make " two sum " match inside " the two sum problem " but keep
  // "sum" from matching inside "two sum" backwards.
  const padded = ` ${q} `;
  const hits = index.filter((e) => {
    const t = normalize(e.title);
    return t.length > 0 && (padded.includes(` ${t} `) || ` ${t} `.includes(padded));
  });
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * Does a proposed plan-topics title name a real problem? Word-boundary
 * containment of any LC title with >= 2 words ("Two sum — hash table
 * lookup" hits via "Two Sum"). One-word titles ("Candy", "Triangle") are
 * excluded — common nouns would riddle honest scenario titles with false
 * positives, and a one-word echo spoils little anyway.
 */
export function titleSpoilsProblem(title: string, index: LcIndexEntry[]): boolean {
  const padded = ` ${normalize(title)} `;
  if (padded.trim() === '') return false;
  for (const e of index) {
    const t = normalize(e.title);
    if (!t.includes(' ')) continue; // one-word titles excluded
    if (padded.includes(` ${t} `)) return true;
  }
  return false;
}
