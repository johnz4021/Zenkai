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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Target } from './intake.js';
import { targetDir } from './intake.js';
import type { GraphView } from './gap-graph.js';

export interface QueueItem {
  id: string;
  label: string;
  spec_id: string;
  status: 'pending' | 'generating' | 'ready' | 'done' | 'skipped';
  problem_dir?: string;
  session_id?: string;
  /** Display-only note set by re-pacing ("focus: verify"). Generation-time
   *  emphasis travels through the target note, not this field. */
  note?: string;
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
 *   problem_dir/.used exists           its session started → session_id
 *   assessments/<session>.json exists  → done
 */
export function reconcileWithDisk(root: string, queue: Queue): Queue {
  const next: Queue = JSON.parse(JSON.stringify(queue)) as Queue;
  for (const item of next.items) {
    if (!item.problem_dir) continue;
    const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(root, item.problem_dir);
    if (item.status === 'generating' && existsSync(path.join(dir, '.validated'))) {
      item.status = 'ready';
    }
    const usedFile = path.join(dir, '.used');
    if ((item.status === 'ready' || item.status === 'generating') && existsSync(usedFile)) {
      item.session_id = readFileSync(usedFile, 'utf8').split('\n')[0];
    }
    if (item.session_id && item.status !== 'done') {
      if (existsSync(path.join(root, 'assessments', `${item.session_id}.json`))) {
        item.status = 'done';
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
  const remaining = next.items.filter((i) => i.status === 'pending' || i.status === 'generating' || i.status === 'ready').length;
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
