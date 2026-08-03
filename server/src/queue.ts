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

/**
 * Mechanical proposal: enough rounds to fill the runway at the default
 * pace, round-robin across confirmed specs, capped so a far-off date does
 * not produce a wall of items.
 */
export function proposeQueue(target: Target, now: number): Queue {
  const days = daysLeft(target.interview_date, now);
  const weeks = days === null ? 2 : Math.max(1, days / 7);
  const count = Math.min(MAX_ITEMS, Math.max(2, Math.round(weeks * DEFAULT_PER_WEEK)));
  const items: QueueItem[] = [];
  for (let i = 0; i < count && target.specs.length > 0; i++) {
    const spec = target.specs[i % target.specs.length]!;
    items.push({
      id: `item-${i + 1}`,
      label: `${spec.label} — round ${Math.floor(i / target.specs.length) + 1}`,
      spec_id: spec.id,
      status: 'pending',
    });
  }
  return {
    target_id: target.id,
    items,
    pace: { per_week: DEFAULT_PER_WEEK },
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
  const remaining = next.items.filter(
    (i) => i.status === 'pending' || i.status === 'generating' || i.status === 'ready' || i.status === 'failed',
  ).length;
  const days = daysLeft(target.interview_date, now);
  if (days !== null && remaining > 0) {
    // Weeks stays fractional on purpose: 3 items with one day left is an
    // honest 7/week (clamped), not a leisurely 3.
    next.pace.per_week = Math.min(7, Math.max(1, Math.ceil(remaining / (days / 7))));
  }
  const focus = view?.focus ?? null;
  const upNext = next.items.find((i) => i.status === 'pending' || i.status === 'ready');
  for (const i of next.items) delete i.note; // notes describe NOW, not history
  if (focus && upNext) upNext.note = `focus: ${focus}`;
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
  | { kind: 'interview'; date: string };

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
    if (target.interview_date) rows.push({ kind: 'interview', date: target.interview_date });
    return rows;
  }

  rows.push({ kind: 'day', date: target.interview_date ? today : null, today: true, past: false, items: todayItem ? [todayItem] : [] });

  // ---- future: spread remaining items evenly over remaining days ----
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
  // D4: a run of ≥2 empty future days reads as blank scroll, not a plan —
  // compress each run to one quiet row. Days with items keep their dates,
  // and a lone empty day stays a dated row.
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

  const hidden = [...schedule.keys()].filter((o) => o > shownThrough);
  if (hidden.length > 0) {
    rows.push({ kind: 'collapsed', count: hidden.length, span_days: futureDays - shownThrough });
  }

  rows.push({ kind: 'interview', date: target.interview_date! });
  return rows;
}
