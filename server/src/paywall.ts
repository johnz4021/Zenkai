/**
 * Paywall gate — the willingness-to-pay experiment.
 *
 *   reps[].runs + queue items ──► countRoundsRun ──┐
 *   targets ──────────────────► countPlans ────────┤
 *   paywall.jsonl ────────────► hasGrant ──────────┼──► gateVerdict ──► GateView | null
 *   IP_PAYWALL_GATE / _FREE_* ► cfg.pub.paywall ───┘          │
 *                                                       402 at 4 routes
 *   POST /api/paywall/probe ──► probeAction ──► logPaywall ──► paywall.jsonl
 *
 * Why it exists: docs/beta-runbook.md §6 counts "≥1 unprompted follow-up (can
 * I do another)" as signal and upvotes as zero. That is the qualitative demand
 * question. This is the next rung — would anyone BUY another — and the only
 * honest way to ask is to actually stop someone and see what they do.
 *
 * THIS GATE REALLY DENIES. An earlier draft (the "probe", same day) showed a
 * price and launched the round regardless; that measures cheap talk, since the
 * click cost nothing and changed nothing. Someone who picks "Maybe later" here
 * does not get that round. They can return and press Subscribe at any time,
 * and admins are exempt, and IP_PAYWALL_GATE turns the whole thing off without
 * a deploy — but the denial is real, deliberately.
 *
 * NO CARD FIELDS, EVER. Nothing in this flow collects payment details. A form
 * that collects payment credentials under false pretenses is deceptive
 * regardless of intent, and it costs no signal to omit: the measurement is the
 * CLICK, not the form. Pressing "Subscribe — $39/mo" while believing it starts
 * checkout has already answered the question; everything after that click
 * affects trust, not information.
 *
 * Pure over pre-loaded input (detector convention — stuck.ts lineage): no I/O,
 * no clock reads. The caller owns file reading.
 *
 * Two layers keep the founder out, and it is worth being precise about which
 * does the work where, because they do NOT both cover both environments:
 *
 *   LOCAL DEV is protected by the config layer ONLY. IP_PAYWALL_GATE is unset
 *   in .env, so `enabled` is false and gateVerdict returns null first. The
 *   admin layer does NOT help here: the dev .env sets IP_AUTH_ADMIN_EMAILS to
 *   the you@example.com placeholder while Supabase IS configured, so signing
 *   in locally yields admin:false (auth.ts:244-249) — the founder is a
 *   stranger on their own machine, by configuration. Verified 2026-08-14; do
 *   not drop the enabled check on the theory that admin covers it.
 *
 *   PRODUCTION is protected by the admin layer, since ops/env.launch.template
 *   arms the gate deliberately and sets the founder's real address there.
 */

import type { RunEntry } from './artifact.js';

/** What the client needs to paint the gate. null = not gated. */
export interface GateView {
  /** Integer dollars. NOT a display string: esc() (client/app.js:22) escapes
   *  only '<', so an env-supplied string would be an innerHTML injection
   *  surface. The client composes '$' + n + '/mo' from fixed copy. */
  price_usd: number;
  /** Which limit was hit — drives the headline copy. */
  reason: 'rounds' | 'plans';
  used: number;
  free: number;
}

/**
 * The closed vocabulary of recordable actions.
 *
 * `would_pay` is the intent signal AND the grant trigger. `would_pay_confirmed`
 * is the honest one: agreeing to be emailed about paying is a second
 * deliberate act that costs something real, and it is where people who merely
 * wanted their round fall away. Reading them as a pair measures the size of
 * the cheap-talk problem instead of assuming it.
 */
export const PROBE_ACTIONS = [
  'gated',
  'would_pay',
  'not_yet',
  'would_pay_confirmed',
  'notify_declined',
] as const;
export type ProbeAction = (typeof PROBE_ACTIONS)[number] | 'unknown';

/** Actions that put a user through for the rest of the beta. */
const GRANTING: readonly string[] = ['would_pay', 'would_pay_confirmed'];

/** Free-text answers arrive on a route whose body reader has no size cap
 *  (readBody, app.ts:86) — bounded here, beside the vocabulary it belongs to. */
export const EXPECTED_MAX = 200;

/** Minimal shapes this module reads — structural, so RepView, QueueItem and
 *  Target satisfy them without importing any of those types. */
export interface CountableRep {
  session_id?: string;
  status?: string;
  runs?: RunEntry[];
}
export interface CountableItem {
  session_id?: string;
  status?: string;
}
export interface CountableTarget {
  user_id?: string;
}
/** One parsed line of paywall.jsonl. */
export interface PaywallRow {
  user_id?: string;
  action?: string;
}

/**
 * Rounds this user has actually STARTED.
 *
 * Started, not completed, and deliberately not `status === 'done'` — that
 * field has two defects for this purpose, both in queue.ts:
 *
 *   - done requires assessments/<sid>.json to exist and parse with
 *     status !== 'unassessed' (queue.ts:248-268), so a judge failure erases a
 *     fully-played 45-minute round. The person with the MOST product
 *     experience would be the one who never hits the limit.
 *   - "practice again" demotes done -> ready and clears done_at
 *     (queue.ts:235-245), so the counter can go DOWN — someone could drop back
 *     under the limit by repeating a round, which would make the gate leak.
 *
 * artifact.ts's append-only `.runs.jsonl` has neither problem: a repeat is a
 * new row, a judge failure is irrelevant, and SLIM_KEEP (retention.ts:44)
 * preserves it. Pre-ledger reps fall back to their single `session_id`.
 */
export function countRoundsRun(
  reps: CountableRep[],
  items: CountableItem[],
  userId: string,
  legacyOwnerId: string,
): number {
  let n = 0;
  for (const rep of reps) {
    const runs = rep.runs ?? [];
    if (runs.length > 0) {
      for (const r of runs) if ((r.user_id || legacyOwnerId) === userId) n++;
    } else if (rep.session_id) {
      n++;
    }
  }
  for (const it of items) if (it.session_id) n++;
  return n;
}

/**
 * Rounds this user has caused to be BUILT.
 *
 * Counted separately from runs because the money is spent here, not at launch:
 * a build is $0.50 sourced / $3.54 invented (measured, TODOS #57) against a
 * session's ~$0.85. A gate that only counted launches let someone queue builds
 * forever and simply never start them — the expensive half, ungated.
 *
 * "Built" means a build was KICKED, not that it finished: a failed or
 * abandoned build spent the same opus run as a successful one. Anything past
 * `pending` therefore counts, and so does anything that already has a session.
 */
export function countBuilds(
  reps: CountableRep[],
  items: CountableItem[],
  userId: string,
  legacyOwnerId: string,
): number {
  const kicked = (x: { status?: string; session_id?: string }): boolean =>
    Boolean(x.session_id) || (typeof x.status === 'string' && x.status !== 'pending');
  let n = 0;
  for (const rep of reps) if (kicked(rep)) n++;
  for (const it of items) if (kicked(it)) n++;
  return n;
}

/**
 * What the free-round allowance is actually spent against: whichever of runs
 * or builds is larger.
 *
 * max(), not a sum, because a build the user then runs is ONE round, not two —
 * summing would halve the allowance for normal use. Taking the larger bounds
 * both abuses at once: build-and-never-run is caught by the build count, and
 * repeat-forever is caught by the run count (which never decrements, see
 * countRoundsRun).
 */
export function roundsUsed(
  reps: CountableRep[],
  items: CountableItem[],
  userId: string,
  legacyOwnerId: string,
): number {
  return Math.max(
    countRoundsRun(reps, items, userId, legacyOwnerId),
    countBuilds(reps, items, userId, legacyOwnerId),
  );
}

/**
 * Targets this user owns. The plan limit is a GUARDRAIL, not the experiment:
 * a plan costs ~$1 against a round's $1.35-$4.39, and it is the on-ramp, so
 * gating it tightly would stop people before they have seen a round and would
 * punish the multi-target user — who is more invested, not less.
 *
 * Counts targets, including abandoned ones that never reached a planner turn
 * and therefore cost nothing. Deliberate: slightly unfair, and fine, because
 * the round gate fires first in practice and this exists to bound abuse.
 */
export function countPlans(
  targets: CountableTarget[],
  userId: string,
  legacyOwnerId: string,
): number {
  let n = 0;
  for (const t of targets) if ((t.user_id || legacyOwnerId) === userId) n++;
  return n;
}

/**
 * Has this user ever pressed Subscribe? Derived from the event log rather
 * than stored separately — one append-only file, already in BACKUP_PATHS,
 * consistent with the reconcile-from-disk discipline the queue uses.
 *
 * A lost or corrupt paywall.jsonl therefore reads as NO grants, and a
 * previously-granted user is gated again. That is not fail-open; it is
 * recoverable-closed, and the recovery is that they press Subscribe a second
 * time — a duplicate row, which dedup-by-user_id at read time absorbs.
 */
export function hasGrant(rows: PaywallRow[], userId: string): boolean {
  return rows.some((r) => r.user_id === userId && GRANTING.includes(r.action ?? ''));
}

/**
 * Is this action gated? `null` means no, and null rather than `{gated:false}`
 * on purpose: the routes omit the key entirely, so a client bug cannot misread
 * a boolean that was never sent.
 *
 * Order matters — the three exemptions come before the count, so an admin on a
 * probe-off box costs zero disk reads.
 */
export function gateVerdict(input: {
  enabled: boolean;
  admin: boolean;
  granted: boolean;
  reason: 'rounds' | 'plans';
  used: number;
  free: number;
  priceUsd: number;
}): GateView | null {
  if (!input.enabled || input.admin || input.granted) return null;
  if (input.used < input.free) return null;
  return {
    price_usd: input.priceUsd,
    reason: input.reason,
    used: input.used,
    free: input.free,
  };
}

/** Sanitize to the closed enum — logLaunch's origin discipline (app.ts:279):
 *  an unrecognized value is recorded as 'unknown', never passed through. */
export function probeAction(raw: unknown): ProbeAction {
  return (PROBE_ACTIONS as readonly string[]).includes(raw as string)
    ? (raw as ProbeAction)
    : 'unknown';
}

/** True when this action should put the user through. Used by the route to
 *  decide whether to answer `granted: true`, so the client knows the retry
 *  will succeed rather than looping on the gate. */
export function grantsAccess(action: ProbeAction): boolean {
  return GRANTING.includes(action);
}

/** Trim and bound the "what would you expect to pay?" answer. undefined for
 *  anything empty, so the row omits the key rather than carrying ''. */
export function expectedText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().slice(0, EXPECTED_MAX);
  return s.length > 0 ? s : undefined;
}
