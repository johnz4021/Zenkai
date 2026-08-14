/**
 * Per-target queue — a queue with a PACE, not a calendar (CEO decision 5).
 *
 * No due dates, no overdue state, no red. The interview date sets how much
 * per week; the queue says what's next; slippage re-paces silently. A missed
 * week changes the pace number, never the item list.
 *
 * Statuses are DERIVED FROM DISK wherever possible (.validated marker,
 * .used marker, assessments/<sid>.json) so the app process can die and
 * restart without corrupting anything — the queue file only records what
 * disk cannot: the item list, order, and intent (skipped).
 *
 * Proposal is MECHANICAL (count from pace arithmetic, round-robin across
 * the target's confirmed specs). An LLM proposer was considered and
 * rejected for v1: with one or two specs per target there is nothing for a
 * model to decide, and a generated plan cannot be validated the way a
 * generated problem can. The queue is legible, editable data — not a
 * pedagogy claim.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RoundSpec } from '@interview-prep/shared';
import type { Target } from './intake.js';
import { targetDir } from './intake.js';
import type { GraphView } from './gap-graph.js';

export interface QueueItem {
  id: string;
  label: string;
  spec_id: string;
  /** `failed` is derived from a .failed marker (generation exited non-zero
   *  or was orphaned by an app restart) — retryable, never terminal. */
  status: 'pending' | 'generating' | 'ready' | 'done' | 'skipped' | 'failed';
  problem_dir?: string;
  session_id?: string;
  /** Display-only note set by re-pacing ("focus: verify"). Generation-time
   *  emphasis travels through the target note, not this field. */
  note?: string;
  /** Named at plan build (one LLM call for the whole queue) so the future
   *  reads as a plan, not scaffolding. Fed into this item's generation
   *  brief so the problem built matches the promise. */
  planned_title?: string;
  /** ISO date stamped when the item flipped to done — pins the item to a
   *  calendar day in the past band. Derived from the assessment file's
   *  mtime, so it survives an app restart like everything else. */
  done_at?: string;
  /** Set by an applied adaptation on a READY item whose spec was
   *  superseded: the built problem no longer matches the plan's shape.
   *  Advisory — the item stays launchable; the timeline offers a rebuild
   *  and the candidate decides. Cleared by /api/rebuild. */
  stale?: boolean;
  /** Dataset-sourced items: which real problem(s) this build converts.
   *  `picked_by: 'user'` = the candidate named it (a commitment, like
   *  planned_title). Top-level slug/title/difficulty are always PART 1
   *  (the primary) so single-problem readers stay correct; `parts` exists
   *  ONLY when the round is a set of >=2 (multi-part OA — the
   *  oa-hackerrank-classic "same count of parts" contract). Survives
   *  reconcileWithDisk's JSON round-trip like every other field. */
  source?: {
    kind: 'leetcode';
    slug: string;
    title: string;
    difficulty: 'easy' | 'medium' | 'hard';
    picked_by: 'user' | 'auto';
    reasons?: string[];
    parts?: {
      slug: string;
      title: string;
      difficulty: 'easy' | 'medium' | 'hard';
      picked_by: 'user' | 'auto';
    }[];
  };
}

export interface Queue {
  target_id: string;
  items: QueueItem[];
  pace: { per_week: number };
  created: string;
}

const DEFAULT_PER_WEEK = 3;
const MAX_ITEMS = 12;

export function loadQueue(root: string, targetId: string): Queue | null {
  const file = path.join(targetDir(root, targetId), 'queue.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as Queue;
}

export function saveQueue(root: string, queue: Queue): void {
  const dir = targetDir(root, queue.target_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(queue, null, 2));
}

/** Days until the interview, floored at 1; null when undated. */
export function daysLeft(interviewDate: string | undefined, now: number): number | null {
  if (!interviewDate) return null;
  const d = Date.parse(`${interviewDate}T23:59:59`);
  if (Number.isNaN(d)) return null;
  return Math.max(1, Math.ceil((d - now) / 86_400_000));
}

// ---- per-round dates ----
// One loop, several rounds, different days. Each spec's practice paces
// against ITS OWN deadline; the target date is the fallback for specs
// without one. Everything below degrades to the single-date behavior when
// no spec carries a date — the entire pre-dates test surface is the
// compat contract.

/** The date THIS spec's practice must land before. */
export function specDeadline(spec: RoundSpec, target: Target): string | undefined {
  return spec.date ?? target.interview_date;
}

/** The loop's last known date (max across spec dates and the target date). */
export function loopEnd(target: Target): string | undefined {
  let end = target.interview_date;
  for (const s of target.specs) {
    if (s.date && (!end || s.date > end)) end = s.date;
  }
  return end;
}

function hasSpecDates(target: Target): boolean {
  return target.specs.some((s) => Boolean(s.date));
}

/**
 * Mechanical proposal: enough rounds to fill the runway at the default
 * pace, round-robin across confirmed specs, capped so a far-off date does
 * not produce a wall of items.
 */
export function proposeQueue(target: Target, now: number, perWeek: number = DEFAULT_PER_WEEK): Queue {
  // perWeek comes from the planning CONVERSATION when the candidate answered
  // the time-budget question ("about an hour a day" → 4/week); the constant
  // is only the silence default. It sizes the queue; repace keeps adjusting
  // pace against the runway afterwards.
  const items: QueueItem[] = [];
  if (target.specs.length > 0 && !hasSpecDates(target)) {
    // Single-deadline loop: the original behavior, byte-identical.
    const days = daysLeft(target.interview_date, now);
    const weeks = days === null ? 2 : Math.max(1, days / 7);
    const count = Math.min(MAX_ITEMS, Math.max(2, Math.round(weeks * perWeek)));
    for (let i = 0; i < count; i++) {
      const spec = target.specs[i % target.specs.length]!;
      items.push({
        id: `item-${i + 1}`,
        label: `${spec.label} — round ${Math.floor(i / target.specs.length) + 1}`,
        spec_id: spec.id,
        status: 'pending',
      });
    }
  } else if (target.specs.length > 0) {
    // Per-round deadlines: the TOTAL budget is unchanged (sized against the
    // loop end), but distribution follows each round's own runway — a near
    // OA gets a small tight block, a far onsite the fuller one — and item
    // ORDER follows imminence, nearest round's practice first. Undated
    // specs get 2 flat and sort last (confirmed but unscheduled).
    const endDays = daysLeft(loopEnd(target), now);
    const weeks = endDays === null ? 2 : Math.max(1, endDays / 7);
    const total = Math.min(MAX_ITEMS, Math.max(2, Math.round(weeks * perWeek)));
    const dated = target.specs.filter((s) => specDeadline(s, target));
    const undated = target.specs.filter((s) => !specDeadline(s, target));
    const daysOf = new Map(dated.map((s) => [s.id, daysLeft(specDeadline(s, target), now) ?? 1]));
    const sum = [...daysOf.values()].reduce((a, b) => a + b, 0) || 1;
    const share = new Map(dated.map((s) => [s.id, Math.max(1, Math.round((total * (daysOf.get(s.id) ?? 1)) / sum))]));
    // Deadline groups, nearest first; round-robin WITHIN a group so
    // same-day rounds keep the old interleaving.
    const groups = new Map<string, RoundSpec[]>();
    for (const s of [...dated].sort((a, b) => (specDeadline(a, target)! < specDeadline(b, target)! ? -1 : 1))) {
      const key = specDeadline(s, target)!;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    const perSpecCount = new Map<string, number>();
    const push = (spec: RoundSpec) => {
      const k = (perSpecCount.get(spec.id) ?? 0) + 1;
      perSpecCount.set(spec.id, k);
      items.push({
        id: `item-${items.length + 1}`,
        label: `${spec.label} — round ${k}`,
        spec_id: spec.id,
        status: 'pending',
      });
    };
    for (const specs of groups.values()) {
      const want = specs.map((s) => share.get(s.id) ?? 1);
      for (let round = 0; round < Math.max(...want); round++) {
        for (let j = 0; j < specs.length; j++) {
          if (round < want[j]! && items.length < MAX_ITEMS) push(specs[j]!);
        }
      }
    }
    for (const s of undated) {
      for (let k = 0; k < 2 && items.length < MAX_ITEMS; k++) push(s);
    }
  }
  return {
    target_id: target.id,
    items,
    pace: { per_week: perWeek },
    created: new Date(now).toISOString(),
  };
}

/**
 * Reconcile queue statuses with what disk says actually happened. The app
 * calls this on every scan; it is idempotent and safe after a restart.
 *
 *   problem_dir/.validated exists      generating → ready
 *   problem_dir/.failed (no .validated) generating → failed (retryable)
 *   problem_dir/.used exists           its session started → session_id
 *   assessments/<session>.json exists  → done (+ done_at from file mtime)
 */
export function reconcileWithDisk(root: string, queue: Queue): Queue {
  const next: Queue = JSON.parse(JSON.stringify(queue)) as Queue;
  for (const item of next.items) {
    if (!item.problem_dir) continue;
    const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(root, item.problem_dir);
    if (item.status === 'generating' || item.status === 'failed') {
      if (existsSync(path.join(dir, '.validated'))) {
        item.status = 'ready';
      } else if (existsSync(path.join(dir, '.failed'))) {
        item.status = 'failed';
      }
    }
    const usedFile = path.join(dir, '.used');
    if ((item.status === 'ready' || item.status === 'generating') && existsSync(usedFile)) {
      item.session_id = readFileSync(usedFile, 'utf8').split('\n')[0];
    }
    if (item.session_id && item.status !== 'done') {
      const assessment = path.join(root, 'assessments', `${item.session_id}.json`);
      if (existsSync(assessment)) {
        item.status = 'done';
        item.done_at = localDate(statSync(assessment).mtimeMs);
      }
    }
  }
  return next;
}

/**
 * Re-pace after something changed: pace follows the remaining runway, and
 * the next pending item gets a display note naming the current focus gap.
 * Arithmetic + the existing graph view — never an LLM call.
 */
export function repace(queue: Queue, target: Target, view: GraphView | null, now: number): Queue {
  const next: Queue = JSON.parse(JSON.stringify(queue)) as Queue;
  const live = (i: QueueItem) =>
    i.status === 'pending' || i.status === 'generating' || i.status === 'ready' || i.status === 'failed';
  const remaining = next.items.filter(live).length;
  const days = daysLeft(loopEnd(target), now);
  if (days !== null && remaining > 0) {
    // Weeks stays fractional on purpose: 3 items with one day left is an
    // honest 7/week (clamped), not a leisurely 3.
    next.pace.per_week = Math.min(7, Math.max(1, Math.ceil(remaining / (days / 7))));
  }
  const focus = view?.focus ?? null;
  const upNext = next.items.find((i) => i.status === 'pending' || i.status === 'ready');
  for (const i of next.items) delete i.note; // notes describe NOW, not history
  if (focus && upNext) upNext.note = `focus: ${focus}`;
  // Per-round over-commitment is SURFACED, never silently redistributed: a
  // segment can be tight while the loop has weeks of slack (six debugging
  // items, four days to the debugging round). The note lands on that
  // round's first live item and outranks the focus note there.
  const today = localDate(now);
  for (const s of target.specs) {
    if (!s.date || s.date < today) continue; // undated/passed → loop-end pace above
    const segDays = daysLeft(s.date, now);
    if (segDays === null) continue;
    const seg = next.items.filter((i) => i.spec_id === s.id && live(i));
    if (seg.length > 0 && seg.length / (segDays / 7) > 7) {
      seg[0]!.note = `tight: ${seg.length} round${seg.length === 1 ? '' : 's'}, ${segDays} day${segDays === 1 ? '' : 's'} to ${s.label}`;
    }
  }
  return next;
}

/** The single item the candidate should do next. */
export function nextUp(queue: Queue): QueueItem | null {
  return queue.items.find((i) => i.status === 'ready') ?? queue.items.find((i) => i.status === 'pending') ?? null;
}

// ---- day bucketing (the timeline's spine) ----

/** Calendar date in the USER'S timezone. UTC slicing flips "today" at 5pm
 *  on the US west coast, which is exactly when students practice. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type DayRow =
  | { kind: 'day'; date: string | null; today: boolean; past: boolean; items: QueueItem[] }
  /** Rounds finished TODAY, pinned directly above the TODAY row (QA
   *  ISSUE-002: the past band starts at yesterday and TODAY shows only
   *  remaining work, so today's completions were invisible — finishing a
   *  season rendered as an empty timeline). */
  | { kind: 'done-today'; items: QueueItem[] }
  /** Every item done/skipped — the season's terminal state. Replaces an
   *  empty TODAY row so completion never reads as "nothing scheduled". */
  | { kind: 'complete'; done_count: number }
  /** A run of ≥2 empty future days compressed to one quiet row (D4). */
  | { kind: 'quiet'; count: number }
  | { kind: 'collapsed'; count: number; span_days: number }
  /** Confirmed rounds with no date yet — parked after the runway, honestly
   *  unscheduled rather than guessed onto a day. Followed by their items
   *  as undated day rows. */
  | { kind: 'unscheduled'; count: number }
  /** `label` names the round(s) happening that day; absent on the
   *  single-date compat path (the client keeps its legacy copy there). */
  | { kind: 'interview'; date: string; label?: string };

const PAST_DAYS_SHOWN = 4;
const FUTURE_DAYS_SHOWN = 8;

/**
 * The dated, forward-only runway (design decision D2). Past days show what
 * happened — done items pinned to their done_at date, empty days as neutral
 * rows, never a debt. TODAY holds the single next item. Remaining items
 * spread evenly across the remaining days; a season longer than the visible
 * budget collapses its far stretch into one row. Pure; no clock reads.
 */
export function bucketIntoDays(queue: Queue, target: Target, now: number): DayRow[] {
  const today = localDate(now);
  const remaining = queue.items.filter(
    (i) => i.status === 'ready' || i.status === 'generating' || i.status === 'failed' || i.status === 'pending',
  );
  // The item that belongs on TODAY: startable beats in-flight beats queued.
  const todayItem =
    remaining.find((i) => i.status === 'ready') ??
    remaining.find((i) => i.status === 'generating') ??
    remaining.find((i) => i.status === 'failed') ??
    remaining[0] ??
    null;
  const future = remaining.filter((i) => i !== todayItem);

  const rows: DayRow[] = [];

  // ---- past band: the last few calendar days, done items pinned ----
  const done = queue.items.filter((i) => i.status === 'done');
  for (let back = PAST_DAYS_SHOWN; back >= 1; back--) {
    const date = localDate(now - back * 86_400_000);
    const items = done.filter((i) => i.done_at === date);
    // A past day with nothing is neutral history — rendered, not hidden,
    // and never red (D2: the failure mode was debt, not dates).
    rows.push({ kind: 'day', date: target.interview_date ? date : null, today: false, past: true, items });
  }
  // Done work older than the band still counts — the season progress bar
  // carries it; these rows would just be scroll.

  // ---- today's completions, pinned above TODAY (QA ISSUE-002) ----
  const doneToday = done.filter((i) => i.done_at === today);
  if (doneToday.length > 0) rows.push({ kind: 'done-today', items: doneToday });

  // ---- season complete: nothing left anywhere ----
  if (remaining.length === 0) {
    rows.push({ kind: 'complete', done_count: done.length });
    if (!hasSpecDates(target)) {
      if (target.interview_date) rows.push({ kind: 'interview', date: target.interview_date });
    } else {
      for (const row of upcomingInterviewRows(target, now)) rows.push(row);
    }
    return rows;
  }

  const anyDate = Boolean(target.interview_date) || hasSpecDates(target);
  rows.push({ kind: 'day', date: anyDate ? today : null, today: true, past: false, items: todayItem ? [todayItem] : [] });

  if (!hasSpecDates(target)) {
    // ---- single-deadline compat path: the original behavior, verbatim ----
    const days = daysLeft(target.interview_date, now);
    if (days === null) {
      // Undated target: no calendar to spread over — a flat ordered list.
      for (const item of future) {
        rows.push({ kind: 'day', date: null, today: false, past: false, items: [item] });
      }
      return rows;
    }

    const futureDays = Math.max(1, days - 1); // tomorrow .. day before the interview
    const interval = future.length > 0 ? Math.max(1, Math.floor(futureDays / (future.length + 1))) : 1;
    const schedule = new Map<number, QueueItem>(); // day offset from today -> item
    future.forEach((item, idx) => {
      schedule.set(Math.min(futureDays, (idx + 1) * interval), item);
    });

    let shownThrough = 0;
    const futureRows: Extract<DayRow, { kind: 'day' }>[] = [];
    for (let offset = 1; offset <= futureDays && shownThrough < FUTURE_DAYS_SHOWN; offset++) {
      const item = schedule.get(offset);
      futureRows.push({
        kind: 'day',
        date: localDate(now + offset * 86_400_000),
        today: false,
        past: false,
        items: item ? [item] : [],
      });
      shownThrough = offset;
    }
    pushWithQuietRuns(rows, futureRows);
    const hidden = [...schedule.keys()].filter((o) => o > shownThrough);
    if (hidden.length > 0) {
      rows.push({ kind: 'collapsed', count: hidden.length, span_days: futureDays - shownThrough });
    }
    rows.push({ kind: 'interview', date: target.interview_date! });
    return rows;
  }

  // ---- per-round path: each round's practice lands BEFORE its own date ----
  const specOf = new Map(target.specs.map((s) => [s.id, s]));
  const deadlineOf = (i: QueueItem): string | undefined => {
    const s = specOf.get(i.spec_id);
    return s ? specDeadline(s, target) : loopEnd(target);
  };
  const unscheduled = future.filter((i) => !deadlineOf(i));
  const datedFuture = future.filter((i) => Boolean(deadlineOf(i)));

  // Upcoming deadlines, nearest first. A PASSED round's leftover items are
  // never overdue (D2): they merge into the nearest upcoming window; the
  // header handles the round's own debrief.
  const upcoming = [...new Set(
    target.specs.map((s) => specDeadline(s, target)).filter((d): d is string => Boolean(d) && d! >= today),
  )].sort();
  const interviewLabel = (d: string) =>
    target.specs.filter((s) => specDeadline(s, target) === d).map((s) => s.label).join(' · ');

  const schedule = new Map<number, QueueItem>();
  const interviewAt = new Map<number, Extract<DayRow, { kind: 'interview' }>>();
  const claim = (want: number, endOffset: number, item: QueueItem) => {
    // Forward-walk on collision so a tight segment does not silently drop
    // items from the display.
    for (let o = Math.min(want, endOffset); o <= endOffset; o++) {
      if (!schedule.has(o) && !interviewAt.has(o)) { schedule.set(o, item); return; }
    }
  };
  let cursor = 1;
  let carry: QueueItem[] = datedFuture.filter((i) => {
    const d = deadlineOf(i);
    return d !== undefined && d < today; // passed round → nearest window
  });
  for (const dl of upcoming) {
    const dlOffset = daysLeft(dl, now)!;
    interviewAt.set(dlOffset, { kind: 'interview', date: dl, label: interviewLabel(dl) });
    const seg = [...carry, ...datedFuture.filter((i) => deadlineOf(i) === dl)];
    carry = [];
    const endOffset = Math.max(cursor, dlOffset - 1);
    const win = endOffset - cursor + 1;
    const interval = seg.length > 0 ? Math.max(1, Math.floor(win / (seg.length + 1))) : 1;
    seg.forEach((item, idx) => claim(cursor - 1 + (idx + 1) * interval, endOffset, item));
    cursor = dlOffset + 1;
  }
  // Everything (incl. all-deadlines-passed): whatever never found a window
  // spreads over the loop tail.
  if (carry.length > 0 || upcoming.length === 0) {
    const leftovers = upcoming.length === 0 ? datedFuture : carry;
    const endDays = daysLeft(loopEnd(target), now) ?? 1;
    const endOffset = Math.max(cursor, endDays);
    leftovers.forEach((item, idx) => claim(cursor + idx, endOffset, item));
    cursor = endOffset + 1;
  }

  const maxOffset = Math.max(...[...schedule.keys(), ...interviewAt.keys(), 1]);
  let shown = 0;
  const buffer: Extract<DayRow, { kind: 'day' }>[] = [];
  let lastEmitted = 0;
  for (let offset = 1; offset <= maxOffset; offset++) {
    if (interviewAt.has(offset)) {
      pushWithQuietRuns(rows, buffer.splice(0));
      rows.push(interviewAt.get(offset)!);
      lastEmitted = offset;
      continue;
    }
    if (shown >= FUTURE_DAYS_SHOWN) continue;
    buffer.push({ kind: 'day', date: localDate(now + offset * 86_400_000), today: false, past: false, items: schedule.has(offset) ? [schedule.get(offset)!] : [] });
    shown++;
    lastEmitted = offset;
  }
  pushWithQuietRuns(rows, buffer.splice(0));
  const hidden = [...schedule.keys()].filter((o) => o > lastEmitted);
  if (hidden.length > 0) {
    rows.push({ kind: 'collapsed', count: hidden.length, span_days: maxOffset - lastEmitted });
  }

  if (unscheduled.length > 0) {
    rows.push({ kind: 'unscheduled', count: unscheduled.length });
    for (const item of unscheduled) {
      rows.push({ kind: 'day', date: null, today: false, past: false, items: [item] });
    }
  }
  return rows;
}

/** D4: a run of ≥2 empty future days reads as blank scroll, not a plan —
 *  compress each run to one quiet row. Days with items keep their dates,
 *  and a lone empty day stays a dated row. */
function pushWithQuietRuns(rows: DayRow[], futureRows: Extract<DayRow, { kind: 'day' }>[]): void {
  let run: Extract<DayRow, { kind: 'day' }>[] = [];
  const flushRun = () => {
    if (run.length >= 2) rows.push({ kind: 'quiet', count: run.length });
    else rows.push(...run);
    run = [];
  };
  for (const r of futureRows) {
    if (r.items.length === 0) {
      run.push(r);
      continue;
    }
    flushRun();
    rows.push(r);
  }
  flushRun();
}

/** Interview rows for every upcoming dated round, labeled, nearest first. */
function upcomingInterviewRows(target: Target, now: number): Extract<DayRow, { kind: 'interview' }>[] {
  const today = localDate(now);
  const dates = [...new Set(
    target.specs.map((s) => specDeadline(s, target)).filter((d): d is string => Boolean(d) && d! >= today),
  )].sort();
  return dates.map((d) => ({
    kind: 'interview',
    date: d,
    label: target.specs.filter((s) => specDeadline(s, target) === d).map((s) => s.label).join(' · '),
  }));
}
