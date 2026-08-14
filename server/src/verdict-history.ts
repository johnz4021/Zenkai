/**
 * Verdict history — the read side the memory layer never had.
 *
 *   assessments/*.json (loaded by the CALLER) ──► buildVerdictHistory ──► /api/memory
 *   feedback/*.json  ─ ownership ──┘                                        │
 *   gaps/archive/*   ─ exclusions ─┘                              the Gaps band (history)
 *
 * Why it exists (memory audit, 2026-08-13): the gap store is negative-only BY
 * DESIGN — it records weak instances and nothing else, so no surface built on
 * it can ever show improvement. The full record (every verdict, every session)
 * already sits in assessments/*.json, where a real trend was measured and had
 * never been rendered: not-weak verdicts 7% → 24% between the first and last
 * five eligible sessions, three solved rounds all in the recent half. This
 * module is the pure reader over that record; the gap store keeps its job
 * (remediation streaks, focus) and is deliberately NOT the membership source —
 * it is a derived, failures-only file that was already missing two legitimate
 * sessions when this was designed.
 *
 * Pure over pre-loaded input (detector convention — stuck.ts lineage): no I/O,
 * no clock reads, `nowMs` injected. Callers own file reading and the skipped
 * count for unreadable files; this module owns membership, ownership,
 * ordering, and arithmetic.
 *
 * Rules locked during design review (each was a live bug or near-miss):
 *   - Membership: status === 'assessed' only. UNASSESSED never becomes history.
 *   - Ownership splits two cases the first draft conflated: a feedback file
 *     WITHOUT user_id is the founder's (WU5 pre-accounts rule, the same
 *     `fb.user_id ?? legacyOwnerId` the DB mirror ships in db.ts); a feedback
 *     file that is ABSENT means ownership is unknowable — excluded and counted,
 *     never guessed. The strict-everywhere rule would have rendered exactly
 *     one session (3 of 20 feedback files carry user_id).
 *   - Order by SESSION START (the sid timestamp), never judged_at: a batch
 *     rejudge (2026-08-12) re-scored 9 of 10 sessions in one minute, so
 *     judged_at records when a session was SCORED, not practiced — sorting by
 *     it put the newest session first.
 *   - Sessions listed in gaps/archive/* are deliberately re-baselined eras and
 *     never re-enter history.
 *   - prompt_hash boundaries are emitted so the renderer can mark where the
 *     judge changed — the trend must never silently mix rulers.
 *   - Every state string is derived arithmetic. Nothing here is model-written
 *     (house invariant: no ungated model output on a user surface).
 */

import type { DimensionKey, Verdict } from '@interview-prep/shared';
import { DIMENSIONS } from '@interview-prep/shared';
import type { JudgeResult } from './judge.js';

export interface VerdictHistoryInput {
  /** Parsed assessment files, any order — the caller read the directory. */
  assessments: JudgeResult[];
  /** sid → feedback user_id. A key present with `undefined` means the file
   *  exists but carries no user_id (pre-accounts record → founder's). */
  owners: Record<string, string | undefined>;
  /** sids that have a feedback file at all. Absent → unattributable. */
  presentFeedback: Set<string>;
  /** Union of session ids across gaps/archive/* — excluded eras. */
  archivedIds: Set<string>;
  /** The requesting user. */
  userId: string;
  /** cfg.userId — who an ownerless (pre-accounts) record belongs to. */
  legacyOwnerId: string;
  isAdmin: boolean;
  nowMs: number;
}

export interface VerdictRow {
  dimension: DimensionKey;
  verdict: Verdict;
  /** Weak verdict whose every citation was stripped — rendered as a claim
   *  without a receipt, and UNINFORMATIVE to state/trend arithmetic (the
   *  recordAssessment gate, mirrored). */
  unreceipted?: boolean;
  analysis?: string;
}

export interface SessionVerdicts {
  sid: string;
  /** The sid timestamp (sess-<ms>); falls back to judged_at when unparseable. */
  started_at: number;
  solved: boolean | null;
  prompt_hash: string;
  rows: VerdictRow[];
}

export type DimensionState =
  | 'still firing'
  | 'improving'
  | 'quiet lately'
  | 'mixed'
  | 'no signal';

export interface DimensionSummary {
  state: DimensionState;
  /** Analysis sentence from the most recent INFORMATIVE occurrence — the
   *  receipt the Gaps row shows. */
  latest_analysis?: string;
  weak_count: number;
  informative_count: number;
  /** Over the last 5 informative verdicts — the client composes copy like
   *  "3 of last 5 adequate" from these, arithmetic only. */
  recent_not_weak: number;
  recent_informative: number;
}

export interface TrendCounts {
  not_weak: number;
  informative: number;
}

export interface VerdictHistory {
  /** Chronological by session start. */
  sessions: SessionVerdicts[];
  states: Record<DimensionKey, DimensionSummary>;
  /** First-half / second-half not-weak counts across all dimensions, or null
   *  below 2 sessions (no halves to compare). */
  trend: { first: TrendCounts; second: TrendCounts } | null;
  /** Indices i where sessions[i].prompt_hash !== sessions[i-1].prompt_hash —
   *  the renderer draws a ruler-change divider before sessions[i]. */
  comparability_boundaries: number[];
  solved_count: number;
  /** Assessed sessions excluded because no feedback file could attribute
   *  them. Surfaced, never silent. */
  unattributable: number;
}

/** sess-<ms> → ms. Non-numeric sids fall back to the provided default. */
export function sessionStartMs(sid: string, fallback: number): number {
  const m = /^[a-z-]*-(\d{10,})/.exec(sid);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** The recordAssessment uninformative gate, mirrored: a claim without a
 *  receipt must not move state. */
function informative(r: VerdictRow): boolean {
  if (r.verdict === 'unassessable') return false;
  if (r.verdict === 'weak' && r.unreceipted) return false;
  return true;
}

const notWeak = (v: Verdict): boolean => v === 'adequate' || v === 'strong';

function dimensionState(inf: Verdict[]): DimensionState {
  if (inf.length === 0) return 'no signal';
  const last = (n: number) => inf.slice(-n);
  if (inf.length >= 3 && last(3).every(notWeak)) return 'quiet lately';
  if (inf.length >= 2 && last(2).every((v) => v === 'weak')) return 'still firing';
  const recent = last(5);
  const prior = inf.slice(-10, -5);
  if (prior.length >= 2) {
    const rate = (vs: Verdict[]) => vs.filter(notWeak).length / vs.length;
    if (rate(recent) > rate(prior)) return 'improving';
  } else if (recent.some(notWeak) && recent[recent.length - 1] !== 'weak') {
    // Thin history: a not-weak latest among mixed results still reads as
    // movement — without this, session 4's first adequate renders as 'mixed'.
    return 'improving';
  }
  return 'mixed';
}

export function buildVerdictHistory(inp: VerdictHistoryInput): VerdictHistory {
  let unattributable = 0;
  const sessions: SessionVerdicts[] = [];

  for (const a of inp.assessments) {
    if (a.status !== 'assessed') continue; // UNASSESSED never becomes history
    const sid = a.session_id;
    if (inp.archivedIds.has(sid)) continue;
    if (!inp.presentFeedback.has(sid)) {
      unattributable += 1;
      continue;
    }
    const owner = inp.owners[sid] ?? inp.legacyOwnerId;
    if (!inp.isAdmin && owner !== inp.userId) continue;

    const byDim = new Map(a.dimensions.map((d) => [d.dimension, d]));
    const rows: VerdictRow[] = [];
    for (const dim of DIMENSIONS) {
      const d = byDim.get(dim);
      if (!d) continue; // defensive — the judge emits all six
      rows.push({
        dimension: dim,
        verdict: d.verdict,
        ...(d.evidence_stripped ? { unreceipted: true } : {}),
        ...(d.analysis ? { analysis: d.analysis } : {}),
      });
    }
    sessions.push({
      sid,
      started_at: sessionStartMs(sid, a.judged_at),
      solved: typeof a.solved === 'boolean' ? a.solved : null,
      prompt_hash: a.prompt_hash,
      rows,
    });
  }

  sessions.sort((x, y) => x.started_at - y.started_at || (x.sid < y.sid ? -1 : 1));

  // Per-dimension chronological verdicts, informative-only for arithmetic.
  const states = {} as Record<DimensionKey, DimensionSummary>;
  for (const dim of DIMENSIONS) {
    const rows = sessions
      .map((s) => s.rows.find((r) => r.dimension === dim))
      .filter((r): r is VerdictRow => r !== undefined);
    const inf = rows.filter(informative);
    const infVerdicts = inf.map((r) => r.verdict);
    const recent = infVerdicts.slice(-5);
    const latest = inf[inf.length - 1];
    states[dim] = {
      state: dimensionState(infVerdicts),
      ...(latest?.analysis ? { latest_analysis: latest.analysis } : {}),
      weak_count: infVerdicts.filter((v) => v === 'weak').length,
      informative_count: inf.length,
      recent_not_weak: recent.filter(notWeak).length,
      recent_informative: recent.length,
    };
  }

  // Whole-history trend: first half vs second half, informative only.
  let trend: VerdictHistory['trend'] = null;
  if (sessions.length >= 2) {
    const half = Math.floor(sessions.length / 2);
    const count = (ss: SessionVerdicts[]): TrendCounts => {
      let nw = 0;
      let n = 0;
      for (const s of ss) {
        for (const r of s.rows) {
          if (!informative(r)) continue;
          n += 1;
          if (notWeak(r.verdict)) nw += 1;
        }
      }
      return { not_weak: nw, informative: n };
    };
    trend = { first: count(sessions.slice(0, half)), second: count(sessions.slice(half)) };
  }

  const comparability_boundaries: number[] = [];
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i]!.prompt_hash !== sessions[i - 1]!.prompt_hash) {
      comparability_boundaries.push(i);
    }
  }

  return {
    sessions,
    states,
    trend,
    comparability_boundaries,
    solved_count: sessions.filter((s) => s.solved === true).length,
    unattributable,
  };
}
