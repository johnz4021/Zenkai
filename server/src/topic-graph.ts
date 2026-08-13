/**
 * Topic ledger — the second memory graph, keyed on LC topic tags.
 *
 *   session finalize / rejudge --record
 *        │  (only when problem.source.kind === 'leetcode' and assessed)
 *        ▼
 *   attemptFromSession ──► upsertAttempt ──► topics/<userId>.json
 *                                               │
 *                              buildTopicView (derived, never stored)
 *
 * Why it exists: the gap graph is deliberately topic-blind — six behavioral
 * dimensions, nothing about WHAT was practiced. LC-sourced rounds carry a
 * mechanical topical identity (dataset tags, never model output), so the
 * system can finally count "how do graph problems actually go for this
 * user". DELIBERATELY NOT gap-graph-shaped: ~63 tags × 6 dimensions is a
 * sparse key space where fire/streak/close semantics starve (most cells
 * never see 3 observations) — this is an exposure/outcome LEDGER with
 * derived recency-decayed scores instead. Recording is the whole v1 scope:
 * nothing reads the view to shape future rounds yet (user decision
 * 2026-08-12 — build the graph, hold the steering).
 *
 * Three defects of the sibling store are fixed here BY CONSTRUCTION:
 *   #34 rejudge double-count → upsertAttempt replaces by session_id
 *   #17 torn writes          → save = tmp + fsync + rename
 *   #18 loaders cast blindly → loadTopicStore validates; corrupt THROWS
 *                              (returning empty would shadow-wipe history
 *                              on the next save), callers degrade per site
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DimensionKey, GeneratedProblem, RoundSpec, TopicTag, TraceEvent, Verdict } from '@interview-prep/shared';
import { DIMENSIONS, isTopicTag, isVerdict, normalizeTopicTags } from '@interview-prep/shared';
import type { Assessment } from './judge.js';

export const TOPIC_SCHEMA_VERSION = 1;

/** Wall-clock decay half-life. Wall-clock, NOT sessions-ago: the gap
 *  graph's session clock works because every session touches every
 *  dimension; topic attempts are sparse and bursty, so forgetting is a
 *  function of elapsed time. */
export const TOPIC_HALF_LIFE_DAYS = 21;
/** Below this recency-weighted exposure, strength is a lead, not a
 *  pattern (the D1 rule transplanted). */
export const TOPIC_CONFIDENCE_MIN = 1.0;
/** A strong topic untouched this long counts as stale/due. */
export const SPACING_DAYS = 14;

export type Difficulty = 'easy' | 'medium' | 'hard';

/** One judged session against an LC-sourced problem. The ledger row. */
export interface TopicAttempt {
  /** THE idempotency key — one row per session, ever. Rejudge replaces. */
  session_id: string;
  /** assessment.judged_at. */
  ts: number;
  slug: string;
  title?: string;
  difficulty: Difficulty;
  tags: TopicTag[];
  solved: boolean;
  /** Submit-run counts when the emitter parsed them (renderer v3). */
  tests?: { passed: number; total: number };
  /** Evidence DETAIL only — never aggregated into the topic score
   *  (behavior is the gap graph's job; folding it in double-counts). */
  verdicts?: Partial<Record<DimensionKey, Verdict>>;
  duration_ms?: number;
  time_limit_ms?: number | null;
  round_label?: string;
  memory_tags?: string[];
  origin: 'session' | 'rejudge';
}

export interface TopicStore {
  schema_version: typeof TOPIC_SCHEMA_VERSION;
  user_id: string;
  /** Ordered by ts ascending. */
  attempts: TopicAttempt[];
}

export function emptyTopicStore(userId: string): TopicStore {
  return { schema_version: TOPIC_SCHEMA_VERSION, user_id: userId, attempts: [] };
}

// ── recording ──────────────────────────────────────────────────────────────

/**
 * Pure replace-by-session_id upsert. There is no append path keyed on
 * anything else, which is what makes rejudge corrective instead of
 * inflationary (the #34 class, killed structurally).
 */
export function upsertAttempt(store: TopicStore, attempt: TopicAttempt): TopicStore {
  const next = JSON.parse(JSON.stringify(store)) as TopicStore;
  next.attempts = next.attempts.filter((a) => a.session_id !== attempt.session_id);
  next.attempts.push(JSON.parse(JSON.stringify(attempt)) as TopicAttempt);
  next.attempts.sort((a, b) => a.ts - b.ts);
  return next;
}

export interface AttemptInputs {
  assessment: Assessment;
  problem: GeneratedProblem;
  spec: RoundSpec;
  events: TraceEvent[];
  origin: 'session' | 'rejudge';
}

/**
 * The whole extraction — every input is already-persisted mechanical data,
 * so recording is zero-model-call by construction. Returns null when the
 * problem carries no leetcode source (non-LC rounds record NOTHING: their
 * topical identity exists only as model prose, and recording that would
 * put ungated model output into state).
 */
export function attemptFromSession(inp: AttemptInputs): TopicAttempt | null {
  const src = inp.problem.source;
  if (src?.kind !== 'leetcode') return null;
  const { tags, dropped } = normalizeTopicTags(src.tags ?? []);
  if (dropped.length) console.warn(`[topics] dropped out-of-vocabulary tags: ${dropped.join(', ')}`);

  const verdicts: Partial<Record<DimensionKey, Verdict>> = {};
  for (const d of inp.assessment.dimensions) {
    if ((DIMENSIONS as readonly string[]).includes(d.dimension) && isVerdict(d.verdict)) {
      verdicts[d.dimension as DimensionKey] = d.verdict;
    }
  }

  const submit = [...inp.events].reverse().find(
    (e) => e.type === 'test_run' && (e.payload as { via?: string })?.via === 'submit',
  );
  const sp = (submit?.payload ?? {}) as { passed?: unknown; total?: unknown };
  const tests =
    typeof sp.passed === 'number' && typeof sp.total === 'number' && sp.total > 0
      ? { passed: sp.passed, total: sp.total }
      : undefined;

  const first = inp.events[0];
  const last = inp.events.at(-1);

  return {
    session_id: inp.assessment.session_id,
    ts: inp.assessment.judged_at,
    slug: src.slug,
    ...(src.title ? { title: src.title } : {}),
    difficulty: src.difficulty,
    tags,
    solved: inp.assessment.solved,
    ...(tests ? { tests } : {}),
    verdicts,
    ...(first && last && last.ts > first.ts ? { duration_ms: last.ts - first.ts } : {}),
    time_limit_ms: inp.spec.capabilities.time_limit_ms,
    round_label: inp.spec.label,
    memory_tags: inp.spec.memory_tags,
    origin: inp.origin,
  };
}

// ── persistence (the #17/#18 fixes, locally) ──────────────────────────────

export function topicsDir(repoRoot: string): string {
  return path.join(repoRoot, 'topics');
}

/** Mechanical shape gate; returns human-readable failures, empty = valid. */
export function validateTopicStore(raw: unknown): string[] {
  const failures: string[] = [];
  const s = raw as Partial<TopicStore> | null;
  if (!s || typeof s !== 'object') return ['store is not an object'];
  if (s.schema_version !== TOPIC_SCHEMA_VERSION) {
    failures.push(`schema_version ${String(s.schema_version)} — this build reads v${TOPIC_SCHEMA_VERSION}; migrate before writing`);
  }
  if (typeof s.user_id !== 'string' || !s.user_id) failures.push('user_id missing');
  if (!Array.isArray(s.attempts)) {
    failures.push('attempts missing');
    return failures;
  }
  for (const a of s.attempts) {
    if (typeof a?.session_id !== 'string' || !a.session_id) failures.push('attempt without session_id');
    if (typeof a?.ts !== 'number') failures.push(`attempt ${String(a?.session_id)}: ts missing`);
    if (a?.difficulty !== 'easy' && a?.difficulty !== 'medium' && a?.difficulty !== 'hard') {
      failures.push(`attempt ${String(a?.session_id)}: difficulty out of vocabulary`);
    }
    if (typeof a?.solved !== 'boolean') failures.push(`attempt ${String(a?.session_id)}: solved missing`);
    if (!Array.isArray(a?.tags)) failures.push(`attempt ${String(a?.session_id)}: tags missing`);
  }
  return failures;
}

/**
 * Missing file → empty store (a new user, not an error). Corrupt or
 * out-of-version file → THROW. Record paths catch-warn-skip (finalize
 * must never crash on memory bookkeeping); read paths degrade to cold
 * start at their own call sites.
 */
export function loadTopicStore(dir: string, userId: string): TopicStore {
  const file = path.join(dir, `${userId}.json`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return emptyTopicStore(userId);
  }
  const raw = JSON.parse(text) as unknown; // a parse error propagates — deliberately
  const failures = validateTopicStore(raw);
  if (failures.length) {
    throw new Error(`topics/${userId}.json failed validation: ${failures.slice(0, 3).join('; ')}`);
  }
  const store = raw as TopicStore;
  // Vocabulary drift tolerance: a tag removed from shared/topics.ts must
  // not brick an old store — unknown tags drop at READ time, file intact.
  for (const a of store.attempts) a.tags = a.tags.filter((t) => isTopicTag(t));
  return store;
}

/** Atomic publish: tmp + fsync + rename. A crash mid-save leaves the old
 *  file whole, never a torn JSON (the exact #17 prescription). */
export function saveTopicStore(dir: string, store: TopicStore): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${store.user_id}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, JSON.stringify(store, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** The one call the two record sites make. Load-or-cold-start, upsert,
 *  atomic save. Throws only on a corrupt existing store — callers catch. */
export function recordTopicAttempt(repoRoot: string, userId: string, attempt: TopicAttempt): void {
  const dir = topicsDir(repoRoot);
  const store = loadTopicStore(dir, userId);
  saveTopicStore(dir, upsertAttempt(store, attempt));
}

/**
 * Slugs attempted inside the spacing window — the auto-picker's dedup
 * set. THE one sanctioned read of this ledger by selection (user product
 * call, 2026-08-13): a window rather than a blocklist, so a problem done
 * recently is not re-dealt but an older one may return as spaced
 * revision. Slug + timestamp only — difficulty/tags/verdicts stay
 * write-only to selection (the no-steering line). Missing or corrupt
 * ledger degrades to the empty set: dedup is a nicety, never a blocker.
 */
export function recentlyAttemptedSlugs(repoRoot: string, userId: string, nowMs: number): Set<string> {
  try {
    const store = loadTopicStore(topicsDir(repoRoot), userId);
    const cutoff = nowMs - SPACING_DAYS * 86_400_000;
    return new Set(store.attempts.filter((a) => a.ts >= cutoff).map((a) => a.slug));
  } catch {
    return new Set();
  }
}

// ── derived view (read-only; nothing steers on it in v1) ──────────────────

export type TopicState = 'unseen' | 'weak' | 'developing' | 'strong' | 'stale';

export interface TopicView {
  tag: TopicTag;
  attempts: number;
  solved: number;
  /** Recency-weighted, difficulty-adjusted mastery in [0,1]; null unseen. */
  strength: number | null;
  /** Recency-weighted exposure (Σ decay weights). */
  confidence: number;
  last_attempt_ts: number | null;
  staleness_days: number | null;
  state: TopicState;
  /** Per-dimension weak counts across this topic's attempts — evidence
   *  texture ("verify was weak on 3 of 4 graph attempts"), never score. */
  weak_dimensions?: Partial<Record<DimensionKey, number>>;
}

export interface TopicGraphView {
  attempt_count: number;
  /** For a future picker's exclusion set — derived here for free. */
  attempted_slugs: string[];
  /** Every attempted tag, plus nothing — unseen tags are not enumerated
   *  (63 mostly-empty rows is noise; unseen = absent). */
  topics: TopicView[];
}

/** Solved/unsolved base scores by difficulty. Adjusted at the SCORE level,
 *  not the weight level: failing a hard problem is weak evidence of
 *  weakness; failing an easy one is strong evidence. */
const SCORE = {
  solved: { easy: 0.6, medium: 0.8, hard: 1.0 },
  unsolved: { easy: 0.0, medium: 0.15, hard: 0.3 },
} as const;

/** One attempt's mastery evidence in [0,1] (exported for tests). Partial
 *  credit interpolates on the pass ratio when submit counts exist; going
 *  over a time cap halves the solved margin (finished-late ≠ clean). */
export function attemptScore(a: Pick<TopicAttempt, 'difficulty' | 'solved' | 'tests' | 'duration_ms' | 'time_limit_ms'>): number {
  const lo = SCORE.unsolved[a.difficulty];
  const hi = SCORE.solved[a.difficulty];
  let s: number;
  if (a.solved) s = hi;
  else if (a.tests && a.tests.total > 0) s = lo + (a.tests.passed / a.tests.total) * (hi - lo);
  else s = lo;
  const overTime =
    typeof a.time_limit_ms === 'number' && a.time_limit_ms > 0 &&
    typeof a.duration_ms === 'number' && a.duration_ms > a.time_limit_ms;
  return overTime ? Math.min(s, lo + (hi - lo) / 2) : s;
}

export function buildTopicView(store: TopicStore, nowMs: number): TopicGraphView {
  const perTag = new Map<TopicTag, TopicAttempt[]>();
  for (const a of store.attempts) {
    for (const t of a.tags) {
      const list = perTag.get(t) ?? [];
      list.push(a);
      perTag.set(t, list);
    }
  }

  const topics: TopicView[] = [];
  for (const [tag, list] of perTag) {
    let wSum = 0;
    let wsSum = 0;
    let lastTs = 0;
    const weakDims: Partial<Record<DimensionKey, number>> = {};
    for (const a of list) {
      const days = Math.max(0, (nowMs - a.ts) / 86_400_000);
      const w = Math.pow(0.5, days / TOPIC_HALF_LIFE_DAYS);
      wSum += w;
      wsSum += w * attemptScore(a);
      lastTs = Math.max(lastTs, a.ts);
      for (const [k, v] of Object.entries(a.verdicts ?? {})) {
        if (v === 'weak') weakDims[k as DimensionKey] = (weakDims[k as DimensionKey] ?? 0) + 1;
      }
    }
    const strength = wSum > 0 ? wsSum / wSum : null;
    const stalenessDays = (nowMs - lastTs) / 86_400_000;
    let state: TopicState = 'developing';
    if (wSum >= TOPIC_CONFIDENCE_MIN && strength !== null) {
      if (strength < 0.4) state = 'weak';
      else if (strength >= 0.7) state = stalenessDays >= SPACING_DAYS ? 'stale' : 'strong';
      else state = stalenessDays >= SPACING_DAYS ? 'stale' : 'developing';
    }
    topics.push({
      tag,
      attempts: list.length,
      solved: list.filter((a) => a.solved).length,
      strength,
      confidence: wSum,
      last_attempt_ts: lastTs,
      staleness_days: stalenessDays,
      state,
      ...(Object.keys(weakDims).length ? { weak_dimensions: weakDims } : {}),
    });
  }

  topics.sort((a, b) => (a.strength ?? 1) - (b.strength ?? 1) || a.tag.localeCompare(b.tag));
  return {
    attempt_count: store.attempts.length,
    attempted_slugs: [...new Set(store.attempts.map((a) => a.slug))],
    topics,
  };
}
