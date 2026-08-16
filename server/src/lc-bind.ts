/**
 * LC auto-binding — the ONE decision both intake doors make.
 *
 *   task hypothesis + round shape ──► autoSourceEligible ──► bind at all?
 *   named refs ──► resolveNamedRefs ──► entries (lenient tier)
 *   stated part count + named count + spec ──► sourceSetSize ──► N
 *   named + N + exclusions + seed ──► composeSourceBinding ──► binding | null
 *
 * Why it exists (zenkai.run incident, 2026-08-15): this decision lived as
 * two near-identical ~70-line blocks inside app.ts request handlers — the
 * practice door's clarify and the planner's accept-spec — and they drifted:
 * accept-spec lost the task-hypothesis gate, so the capability fallback's
 * documented blind spot (blank + all_failing + panes cannot distinguish an
 * algorithmic set from a practical build — blueprint.ts) bound real
 * LeetCode problems onto a TypeScript live-design round and an LLD OA. One
 * build agent, handed two contradictory "authoritative" briefs, spent its
 * whole turn budget investigating the contradiction and wrote nothing.
 * Same cure round-rules.ts applied to the interviewer prompt: ONE copy,
 * callers fill slots. app.test.ts pins that both doors call this module
 * and that no inline task-gate comparison survives anywhere in app.ts.
 *
 * The pieces are separate exports because the doors compose them with
 * different cardinalities: the practice door decides once per draft;
 * accept-spec resolves names and sizes ONCE per spec, then deals a set per
 * queue item (named refs land in item 1's set; later items are all-auto at
 * the same size, deduped via the caller's `bound` accumulator). All pure —
 * index and blocklist passed in, no fs, no clock — so the eligibility
 * matrix is finally unit-testable.
 *
 * What stays per-door, on purpose: the practice door's answered-row
 * strictness and "invent" opt-out, its stable-confirm-screen seed vs the
 * queue's per-item seeds, persistence, and logging. Bind-time ref checks
 * stay blocklist + eligibleForSourcing — the hard sourceBindingVerdict
 * remains at commit/build time (/api/practice, cli.ts
 * resolveSourceBinding), where a failure must be loud rather than dropped.
 */

import type { RoundSpec } from '@interview-prep/shared';
import { deriveTaskFromSpec } from './blueprint.js';
import { buildSourceSet } from './lc-pick.js';
import { resolveProblemRef } from './lc-refs.js';
import { eligibleForSourcing, type LcIndexEntry } from './lc-source.js';
import type { QueueItem } from './queue.js';

/** The stored binding shape — queue items and reps share it. */
export type SourceBinding = NonNullable<QueueItem['source']>;

/**
 * Does this round get a real problem bound at all? The task HYPOTHESIS —
 * made by the model that actually READ the material (clarifier or planner)
 * — outranks the capability fallback; the fallback covers hypothesis-less
 * legacy drafts only. Sourcing any other task shape hands the generator
 * two contradictory authoritative briefs.
 */
export function autoSourceEligible(taskHypothesis: string | undefined, spec: RoundSpec): boolean {
  return (taskHypothesis ?? deriveTaskFromSpec(spec)) === 'algorithmic_set';
}

/**
 * Resolve caller-ordered refs to index entries — the LENIENT tier: refs
 * that miss, are blocklisted, are excluded, or fail eligibility just drop.
 * Door-level strictness (the practice door's answered-row-fails ⇒
 * whole-draft-unbinds rule) stays at the door, checked before this. The
 * recency window deliberately never applies here — re-doing a problem you
 * asked for is fine — so `excludeSlugs` carries only hard exclusions
 * (accept-spec's cross-queue `bound` accumulator), never recency.
 */
export function resolveNamedRefs(
  refs: string[],
  opts: { index: LcIndexEntry[]; blocked: Set<string>; excludeSlugs?: Set<string> },
): LcIndexEntry[] {
  const named: LcIndexEntry[] = [];
  for (const ref of refs) {
    const hit = resolveProblemRef(ref, opts.index);
    if (
      hit &&
      !opts.blocked.has(hit.slug) &&
      !opts.excludeSlugs?.has(hit.slug) &&
      eligibleForSourcing(hit)
    ) {
      named.push(hit);
    }
  }
  return named;
}

/**
 * Set size: the stated part count, never below what was named, capped by
 * the enforceable size knob and 4. No >=2 pre-filter on the stated count —
 * the floor makes a stated 1 identical to undefined for every named count
 * (the old accept-spec filter was drift, verified moot). Computed ONCE per
 * spec on the queue door so every item of a 3-part spec deals a 3-part set.
 */
export function sourceSetSize(
  statedPartCount: number | undefined,
  namedCount: number,
  spec: RoundSpec,
): number {
  return Math.min(
    Math.max(statedPartCount ?? namedCount, namedCount, 1),
    spec.check.max_source_files ?? 4,
    4,
  );
}

/** Assemble one binding: named lead, diverse picks fill to `count`,
 *  escalation order, the stored shape. `binding: null` when the pool is
 *  dry; `boundSlugs` feeds the caller's dedup accumulator. */
export function composeSourceBinding(opts: {
  index: LcIndexEntry[];
  named: LcIndexEntry[];
  count: number;
  /** Exclusions for AUTO picks: recency window + blocklist + any caller
   *  accumulator. Named entries are excluded from picks automatically. */
  excludeSlugs: Set<string>;
  /** Caller-owned: `${user}:${spec}` on the confirm screen (stable across
   *  re-clarify), `${target}:${spec}:${item}` on the queue (per-item
   *  variety). */
  seed: string;
}): { binding: SourceBinding | null; boundSlugs: string[] } {
  const set = buildSourceSet({
    index: opts.index,
    named: opts.named,
    count: opts.count,
    excludeSlugs: opts.excludeSlugs,
    seed: opts.seed,
  });
  if (set.length === 0) return { binding: null, boundSlugs: [] };
  const toPart = (x: (typeof set)[number]) => ({
    slug: x.entry.slug,
    title: x.entry.title,
    difficulty: x.entry.difficulty,
    picked_by: x.picked_by,
  });
  return {
    binding: {
      kind: 'leetcode',
      ...toPart(set[0]!),
      ...(set.length > 1 ? { parts: set.map(toPart) } : {}),
    },
    boundSlugs: set.map((x) => x.entry.slug),
  };
}
