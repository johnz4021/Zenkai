/**
 * Gap graph (eng review T11, design review D1/D3).
 *
 *   session classification ──► recordSession ──► gaps.json (per user)
 *                                                   │
 *              buildGraphView (weights, focus, closed) ──► feedback / UI
 *
 * Rules locked in review:
 *   - NEGATIVE labels (immediate_edit, inactivity) create gap instances;
 *     positive labels are observations, not gaps.
 *   - Recency weight: 0.5^(sessionsAgo / 5) — half-life of 5 sessions.
 *   - REMEDIATION (T11): a gap closes only after 3 consecutive sessions where
 *     the trigger condition OCCURRED and the gap did not fire. Sessions where
 *     the trigger never occurred prove nothing and must not count — that
 *     false positive corrupts persisted state.
 *   - D3: remediation is an EVENT (surfaced once) and then a record in a
 *     `closed` list. A closed gap that fires again reopens.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Verdict } from '@interview-prep/shared';
import { DIMENSION_DEFS, isDimensionKey } from '@interview-prep/shared';
import type { Assessment } from './judge.js';

export const GAP_LABELS: readonly string[] = ['immediate_edit', 'inactivity'];
export const GAP_DESCRIPTIONS: Record<string, string> = {
  immediate_edit: 'Starts editing before reading the failure or asking about it.',
  inactivity: 'Goes quiet when something breaks instead of narrating or probing.',
};

/** Card/focus description for any gap key — dimension-aware, label fallback. */
export function gapDescription(key: string): string {
  if (isDimensionKey(key)) return DIMENSION_DEFS[key].weak;
  return GAP_DESCRIPTIONS[key] ?? key;
}

export interface GapInstance {
  session_id: string;
  ts: number;
  evidence: { source: string; seq: number; ts: number; note: string }[];
  /**
   * Judge-era texture (tension 1, CEO review): the judge's sentence about
   * THIS session. Without it, "approach weak 4/5" is a mush bucket; with it,
   * the memory expands into four specific descriptions of how — which is
   * where the disposition patterns become visible before they are ever
   * formally named. Absent on label-era instances.
   */
  analysis?: string;
  verdict?: Verdict;
  round_type_at?: string;
  /**
   * Closed-vocabulary round tags (MEMORY_TAGS) — what counting is allowed
   * to group by. Free-form round labels would fragment a thin history into
   * buckets of one; tags keep "is my verify gap specific to timed rounds?"
   * a countable question. Absent on pre-spec instances.
   */
  memory_tags?: string[];
}

export interface SessionRecord {
  session_id: string;
  ts: number;
  round_type: string;
  trigger_occurred: boolean;
  /** Keys (labels or dimensions) that FIRED as gaps this session. */
  labels_fired: string[];
  /**
   * Keys for which this session was UNINFORMATIVE — label-era: fired only
   * after a nudge; dimension-era: verdict unassessable, or a weak verdict
   * whose every citation was stripped (a claim without a receipt must not
   * write history). Uninformative keys neither advance nor reset a
   * remediation streak.
   */
  contaminated_labels?: string[];
  /**
   * The plan this session's round belonged to (additive, forward-only —
   * absent on pool problems, reps, and pre-stamp history). Storage stays
   * GLOBAL: six dimensions score every session, and splitting them per plan
   * would starve the remediation streak by construction. This stamp exists
   * so a future "how is this prep going" view can be a FILTER over the one
   * store, never a second store.
   */
  target_id?: string;
}

export interface GapStore {
  user_id: string;
  sessions: SessionRecord[];
  gaps: Record<string, { instances: GapInstance[]; closed_at?: number; closed_after?: string }>;
}

export interface GapView {
  key: string;
  description: string;
  fired_count: number;
  last_fired_ts: number | null;
  weight: number;
  state: 'rising' | 'stable' | 'fading';
  closed: boolean;
}

export interface GraphView {
  session_count: number;
  /** D1: below this, present findings as observations, not patterns. */
  sessions_until_patterns: number;
  active: GapView[];
  closed: GapView[];
  focus: string | null;
  /** D3: gaps that closed as a result of the MOST RECENT session — the event. */
  newly_closed: string[];
}

/**
 * THE memory boundary: may this session id deposit into (or be read back
 * from) the user's memory stores — the gap graph, the topic ledgers, the
 * verdict history?
 *
 * Every real session is minted `sess-${Date.now()}` (app.ts launch paths,
 * cli.ts session default) — `sess-` + digits, nothing else. Anything with a
 * non-digit id segment came in through the IP_SESSION_ID override, which is
 * the QA harness's door. History of this arms race, so it is not re-fought:
 * qa-lc runs polluted the store first (2026-08-13, prefix guard added);
 * the next harness pass minted sess-qa813 and sess-qa814 ids that PASSED
 * the bare sess- prefix guard and deposited 10 more sessions plus an
 * all-QA topic ledger (found at merge, 2026-08-14). Shape-of-mint is the
 * boundary a harness cannot drift past without also colliding with real
 * session semantics.
 */
export function isMemorableSessionId(sid: string): boolean {
  return /^sess-\d{10,}$/.test(sid);
}

export const PATTERN_MIN_SESSIONS = 3;
const HALF_LIFE_SESSIONS = 5;
const REMEDIATION_STREAK = 3;

export function emptyStore(userId: string): GapStore {
  return { user_id: userId, sessions: [], gaps: {} };
}

export function recordSession(
  store: GapStore,
  record: SessionRecord,
  evidenceByLabel: Record<string, GapInstance['evidence']>,
  /** Judge-era texture merged into each fired instance (analysis, verdict, round). */
  metaByKey?: Record<string, Pick<GapInstance, 'analysis' | 'verdict' | 'round_type_at' | 'memory_tags'>>,
): GapStore {
  const next: GapStore = JSON.parse(JSON.stringify(store)) as GapStore;
  next.sessions.push(record);

  for (const label of record.labels_fired) {
    // Label-era keys are restricted to the negative set; dimension keys are
    // all gap-capable (a weak verdict on any dimension is a gap).
    if (!isDimensionKey(label) && !(GAP_LABELS as readonly string[]).includes(label)) continue;
    const gap = (next.gaps[label] ??= { instances: [] });
    gap.instances.push({
      session_id: record.session_id,
      ts: record.ts,
      evidence: evidenceByLabel[label] ?? [],
      ...(metaByKey?.[label] ?? {}),
    });
    // Reopen on fire (D3): a closed gap that fires again is active history intact.
    delete gap.closed_at;
    delete gap.closed_after;
  }

  // Remediation check (T11). Only sessions where the trigger occurred count
  // toward the streak; trigger-less sessions are ignored entirely — they
  // neither advance nor reset it.
  const triggered = next.sessions.filter((s) => s.trigger_occurred);
  const recent = triggered.slice(-REMEDIATION_STREAK);
  for (const [key, gap] of Object.entries(next.gaps)) {
    if (gap.closed_at || gap.instances.length === 0) continue;
    if (recent.length < REMEDIATION_STREAK) continue;
    const streakClean = recent.every((s) => !s.labels_fired.includes(key));
    // A session where this gap fired only after a nudge is UNINFORMATIVE, not
    // clean. Counting it would hand out remediation credit for behavior we
    // prompted — exactly the false positive T11 exists to prevent.
    const streakContaminated = recent.some((s) =>
      (s.contaminated_labels ?? []).includes(key),
    );
    if (streakContaminated) continue;
    // The gap must have existed BEFORE the streak began, or "3 clean sessions"
    // is just "we never saw it" wearing a suit.
    const firstOfStreak = recent[0];
    const existedBefore = gap.instances.some((i) => i.ts < (firstOfStreak?.ts ?? 0));
    if (streakClean && existedBefore) {
      gap.closed_at = record.ts;
      gap.closed_after = record.session_id;
    }
  }
  return next;
}

/**
 * Judge-era entry point: fold an Assessment into the graph.
 *
 *   weak                          → gap fires (instance with the analysis)
 *   weak + all citations stripped → UNINFORMATIVE (a claim without a receipt
 *                                   must not write history)
 *   unassessable                  → UNINFORMATIVE (nothing was observable)
 *   adequate / strong             → counts toward the remediation streak
 *
 * trigger_occurred generalizes to "the session was assessable at all":
 * a session where every dimension was unassessable proves nothing and must
 * not advance any streak — same rule T11 established for trigger-less
 * sessions, one level up.
 */
export function recordAssessment(
  store: GapStore,
  assessment: Assessment,
  roundType: string,
  /** Closed-vocabulary tags from the round's spec (MEMORY_TAGS). */
  memoryTags?: string[],
  /** The owning plan, when the round came from one (SessionRecord.target_id). */
  targetId?: string,
): GapStore {
  const fired: string[] = [];
  const uninformative: string[] = [];
  const evidenceByKey: Record<string, GapInstance['evidence']> = {};
  const metaByKey: Record<string, Pick<GapInstance, 'analysis' | 'verdict' | 'round_type_at' | 'memory_tags'>> = {};

  for (const d of assessment.dimensions) {
    if (d.verdict === 'unassessable' || (d.verdict === 'weak' && d.evidence_stripped)) {
      uninformative.push(d.dimension);
      continue;
    }
    if (d.verdict === 'weak') {
      fired.push(d.dimension);
      evidenceByKey[d.dimension] = d.evidence.map((offset) => ({
        source: 'judge',
        seq: -1,
        ts: offset, // seconds from session start; renderer resolves via trace
        note: d.analysis,
      }));
      metaByKey[d.dimension] = {
        analysis: d.analysis,
        verdict: d.verdict,
        round_type_at: roundType,
        ...(memoryTags && memoryTags.length > 0 ? { memory_tags: memoryTags } : {}),
      };
    }
    // adequate/strong: not a gap; contributes to the streak by absence.
  }

  const anyAssessable = assessment.dimensions.some((d) => d.verdict !== 'unassessable');

  return recordSession(
    store,
    {
      session_id: assessment.session_id,
      ts: assessment.judged_at,
      round_type: roundType,
      trigger_occurred: anyAssessable,
      labels_fired: fired,
      contaminated_labels: uninformative,
      ...(targetId ? { target_id: targetId } : {}),
    },
    evidenceByKey,
    metaByKey,
  );
}

export function buildGraphView(store: GapStore, lastSessionId?: string): GraphView {
  const sessionIndex = new Map(store.sessions.map((s, i) => [s.session_id, i]));
  const latest = store.sessions.length - 1;

  const views: GapView[] = Object.entries(store.gaps).map(([key, gap]) => {
    let weight = 0;
    for (const inst of gap.instances) {
      const idx = sessionIndex.get(inst.session_id) ?? latest;
      weight += Math.pow(0.5, (latest - idx) / HALF_LIFE_SESSIONS);
    }
    const last = gap.instances[gap.instances.length - 1] ?? null;
    const firedRecently = last && sessionIndex.get(last.session_id) === latest;
    const oldWeight = weight - (firedRecently ? 1 : 0);
    const state: GapView['state'] = firedRecently
      ? oldWeight > 0.6
        ? 'rising'
        : 'stable'
      : 'fading';
    return {
      key,
      description: gapDescription(key),
      fired_count: gap.instances.length,
      last_fired_ts: last?.ts ?? null,
      weight: Number(weight.toFixed(3)),
      state,
      closed: Boolean(gap.closed_at),
    };
  });

  const active = views.filter((v) => !v.closed).sort((a, b) => b.weight - a.weight);
  const closed = views.filter((v) => v.closed);
  const newly_closed = lastSessionId
    ? Object.entries(store.gaps)
        .filter(([, g]) => g.closed_after === lastSessionId)
        .map(([k]) => k)
    : [];

  return {
    session_count: store.sessions.length,
    sessions_until_patterns: Math.max(0, PATTERN_MIN_SESSIONS - store.sessions.length),
    active,
    closed,
    focus: active[0]?.key ?? null,
    newly_closed,
  };
}

/**
 * Turn the graph into generator emphasis — this is what closes the memory loop.
 *
 * Without this the gap graph is a gap LOG: written every session, read by
 * nobody, and the next problem is as random as the first. The product's whole
 * claim is that session seven is smarter than session one, and this function
 * is where that claim becomes mechanical.
 *
 * Returns undefined when there is nothing learned yet (session one), so the
 * generator produces a neutral problem instead of chasing noise.
 */
export function buildTargetNote(view: GraphView, store?: GapStore): string | undefined {
  const focus = view.active[0];
  if (!focus) return undefined;
  // One data point is an observation, not a pattern (design decision D1).
  // Target it, but say so, so the generator does not over-fit to a fluke.
  const confidence =
    view.session_count < PATTERN_MIN_SESSIONS
      ? `This is provisional: only ${view.session_count} session(s) so far, so treat it as a lead rather than an established pattern.`
      : `This has fired ${focus.fired_count} times across ${view.session_count} sessions and is currently ${focus.state}.`;

  // Judge-era texture: the analysis SENTENCES, not just the dimension name.
  // "approach: weak" tells the generator almost nothing; "named a location,
  // not a mechanism, and edited before stating what was wrong" tells it
  // exactly what to make costly.
  const recentAnalyses = (store?.gaps[focus.key]?.instances ?? [])
    .filter((i) => i.analysis)
    .slice(-3)
    .map((i) => `  - (${i.round_type_at ?? 'session'}) ${i.analysis}`);

  return [
    "TARGETING NOTE (from this candidate's history):",
    `Their most active gap is: "${focus.description}"`,
    confidence,
    ...(recentAnalyses.length > 0
      ? ['What it looked like in recent sessions:', ...recentAnalyses]
      : []),
    'Design the problem so this specific behavior is both LIKELY TO BE TRIGGERED and CLEARLY OBSERVABLE.',
    'Make the behavior the note describes costly to skip and rewarding to do well.',
    'Do NOT mention this note, the gap, or that anything is being measured anywhere in the spec or the repo.',
  ].join('\n');
}

// ---- persistence (JSON per user; SQLite when multi-user arrives) ----

export function loadStore(dir: string, userId: string): GapStore {
  const file = path.join(dir, `${userId}.json`);
  if (!existsSync(file)) return emptyStore(userId);
  return JSON.parse(readFileSync(file, 'utf8')) as GapStore;
}

export function saveStore(dir: string, store: GapStore): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${store.user_id}.json`), JSON.stringify(store, null, 2));
}
