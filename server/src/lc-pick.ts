/**
 * Memory-blind diverse auto-pick — which real problems an UNNAMED
 * algorithmic round gets.
 *
 *   eligible index ──► filter (difficulty band, exclusions) ──► group by
 *   primary tag ──► seeded rotation across tags ──► LcIndexEntry[]
 *
 * Why it exists: "source by default" (user decision 2026-08-13) needs a
 * chooser, but weakness-driven selection is explicitly deferred — the
 * topic graph steers nothing. So this picker is DELIBERATELY blind: no
 * gap graph, no topic strengths, no difficulty adaptation. Its whole job
 * is coverage — spread one plan's items across distinct algorithmic
 * domains the way a real OA bank would, deterministically (seeded hash,
 * never Math.random — replay rule) so the same plan re-proposed picks the
 * same problems.
 *
 * The ONE memory touch lives in the caller's exclusion set:
 * recentlyAttemptedSlugs (topic-graph.ts) reads the ledger as a
 * slug+timestamp seen-list so a problem done in the last SPACING_DAYS is
 * not re-dealt, and an OLDER one may return as spaced revision. That is
 * dedup-with-a-window, not steering — the product call: get students
 * ready without over-practicing, while leaving room for revision.
 */

import type { LcIndexEntry } from './lc-source.js';
import { eligibleForSourcing } from './lc-source.js';

export interface PickOptions {
  count: number;
  /** Band, default ['medium'] — the skeletons' "LeetCode-medium" bar. */
  difficulty?: ('easy' | 'medium' | 'hard')[];
  /** Same-queue bindings + blocklist + the recency window, caller-built. */
  excludeSlugs?: Set<string>;
  /** Stable per-plan seed (target id / rep id) — determinism, not fairness. */
  seed: string;
}

/** FNV-1a — tiny, deterministic, good enough to de-bias slug ordering. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const DIFFICULTY_RANK = { easy: 0, medium: 1, hard: 2 } as const;

/**
 * A full problem SET for one round: named problems first (the candidate's
 * commitments, deduped), diverse picks fill to `count`, and the result is
 * sorted easy→hard — the oa-hackerrank-classic escalation contract. Named
 * entries are trusted as pre-verified by the caller (they went through
 * resolution + the binding verdict); picks exclude them automatically.
 * Short output when the pool runs dry — callers bind what they got.
 */
export function buildSourceSet(opts: {
  index: LcIndexEntry[];
  named: LcIndexEntry[];
  count: number;
  difficulty?: PickOptions['difficulty'];
  excludeSlugs?: Set<string>;
  seed: string;
}): { entry: LcIndexEntry; picked_by: 'user' | 'auto' }[] {
  const seen = new Set<string>();
  const set: { entry: LcIndexEntry; picked_by: 'user' | 'auto' }[] = [];
  for (const e of opts.named) {
    if (seen.has(e.slug) || set.length >= opts.count) continue;
    seen.add(e.slug);
    set.push({ entry: e, picked_by: 'user' });
  }
  if (set.length < opts.count) {
    const exclude = new Set([...(opts.excludeSlugs ?? []), ...seen]);
    const picks = pickDiverse(opts.index, {
      count: opts.count - set.length,
      ...(opts.difficulty ? { difficulty: opts.difficulty } : {}),
      excludeSlugs: exclude,
      seed: opts.seed,
    });
    for (const e of picks) set.push({ entry: e, picked_by: 'auto' });
  }
  // Escalation: easiest part first, stable within a band by slug.
  return set.sort(
    (a, b) =>
      DIFFICULTY_RANK[a.entry.difficulty] - DIFFICULTY_RANK[b.entry.difficulty] ||
      (a.entry.slug < b.entry.slug ? -1 : 1),
  );
}

/**
 * Up to `count` eligible problems, no two consecutive picks sharing a
 * primary tag while other tags still have candidates. Short output when
 * the pool runs dry — callers invent for the remainder.
 */
export function pickDiverse(index: LcIndexEntry[], opts: PickOptions): LcIndexEntry[] {
  const band = new Set(opts.difficulty ?? ['medium']);
  const exclude = opts.excludeSlugs ?? new Set<string>();
  const pool = index.filter(
    (e) => eligibleForSourcing(e) && band.has(e.difficulty) && !exclude.has(e.slug) && e.tags.length > 0,
  );

  // Group by primary tag; order inside each group and the group order
  // itself by seeded hash so two plans with different seeds deal
  // different hands, while one seed always deals the same one.
  const byTag = new Map<string, LcIndexEntry[]>();
  for (const e of pool) {
    const tag = e.tags[0]!;
    const list = byTag.get(tag) ?? [];
    list.push(e);
    byTag.set(tag, list);
  }
  for (const list of byTag.values()) {
    list.sort((a, b) => hash(`${opts.seed}:${a.slug}`) - hash(`${opts.seed}:${b.slug}`) || (a.slug < b.slug ? -1 : 1));
  }
  const tags = [...byTag.keys()].sort(
    (a, b) => hash(`${opts.seed}:${a}`) - hash(`${opts.seed}:${b}`) || (a < b ? -1 : 1),
  );

  const out: LcIndexEntry[] = [];
  let cursor = 0;
  while (out.length < opts.count && tags.length > 0) {
    const tag = tags[cursor % tags.length]!;
    const list = byTag.get(tag)!;
    const next = list.shift();
    if (next) out.push(next);
    if (!list.length) {
      byTag.delete(tag);
      tags.splice(cursor % tags.length, 1);
      // cursor stays — the next tag slides into this position.
    } else {
      cursor += 1;
    }
  }
  return out;
}
