/**
 * Stuck detection — when has the candidate tried things that don't work?
 *
 *   trace ──► detectStuck ──► StuckState | null ──► the unprompted turn
 *                                                    becomes ONE step toward
 *                                                    the cause, not pressure
 *
 * Why cycles and not a clock. Unprompted turns used to fire every 4 minutes
 * regardless of what was happening, so a candidate who was cruising got nagged
 * and a candidate who was grinding got the same treatment. A wall clock also
 * measures the wrong thing entirely: a stuck candidate is usually BUSY. A real
 * trace in this repo holds five consecutive identical failing runs — an idle
 * timer would have seen nothing at all.
 *
 * A cycle is: edit(s) → run the suite → it still fails. Three consecutive
 * cycles that bring nothing new into the attempt means three ideas tried and
 * none worked. That is paced by the candidate's REASONING, not by the clock:
 * a fast candidate reaches three cycles in four minutes, a careful one in
 * eighteen, and both get help at the same point in their thinking.
 *
 * What must never trip it (design rules, not accidents):
 *   - Reading. No runs, no cycles, no hint. The gap vocabulary rewards
 *     reading the failure before editing; interrupting a long read would
 *     punish exactly the behavior the product wants.
 *   - Exploring. Opening a file for the first time, or editing outside the
 *     streak's file, restarts it — a new hypothesis IS progress even while
 *     the suite is still red.
 *   - The opening minutes. A floor protects early struggle, which is where
 *     productive-failure research puts the learning.
 *
 * Single FORWARD pass: "first time seen" is only cheap in trace order, and a
 * backward walk made the streak's start ambiguous. Pure — no I/O, no clock
 * reads; `nowMs` and `sessionStartedAt` are injected, as in queue.ts.
 */

import type { EditPayload, FileOpenPayload, TraceEvent } from '@interview-prep/shared';
import { isFailingRun } from '@interview-prep/shared';

/** Consecutive failed attempt-cycles before the interviewer may step in. */
export const STUCK_CYCLES = 3;
/** No hint before this much elapsed session, however fast they grind. */
export const STUCK_FLOOR_MS = 6 * 60_000;

export interface StuckState {
  /** Consecutive edit→failing-run cycles bringing nothing new. */
  cycles: number;
  /** When the streak began (ms epoch) — the "for how long" of the hint. */
  since_ms: number;
  /** Distinct files edited during the streak. Aliased before it reaches a
   *  prompt; raw paths are how a filename once leaked into a pressure beat. */
  files_touched: number;
  /** The last failing run's summary line, when the runner emitted one. */
  last_summary: string | null;
}

const PATH_TYPES = new Set(['edit', 'file_open', 'file_save']);

function pathOf(e: TraceEvent): string | null {
  if (!PATH_TYPES.has(e.type)) return null;
  const p = e.payload as Partial<EditPayload & FileOpenPayload> | null;
  return typeof p?.path === 'string' && p.path ? p.path : null;
}

function isPassingRun(e: TraceEvent): boolean {
  return e.type === 'test_run' && (e.payload as { exit_code?: number | null })?.exit_code === 0;
}

/** The streak ending at the newest event, or null if they are not stuck. */
export function detectStuck(
  events: TraceEvent[],
  nowMs: number,
  sessionStartedAt: number | null,
  opts: { cycles?: number; floorMs?: number } = {},
): StuckState | null {
  const needed = opts.cycles ?? STUCK_CYCLES;
  const floorMs = opts.floorMs ?? STUCK_FLOOR_MS;
  if (sessionStartedAt === null || nowMs - sessionStartedAt < floorMs) return null;

  const seen = new Set<string>(); // every path touched so far this session
  let streakFiles = new Set<string>();
  let pendingEdits = new Set<string>();
  let pendingFirstTs: number | null = null;
  let cycles = 0;
  let sinceTs = 0;
  let lastSummary: string | null = null;

  const reset = () => {
    cycles = 0;
    streakFiles = new Set();
    pendingEdits = new Set();
    pendingFirstTs = null;
    lastSummary = null;
  };

  for (const e of events) {
    const p = pathOf(e);

    if (p !== null) {
      const firstTime = !seen.has(p);
      seen.add(p);
      if (e.type === 'edit') {
        // Editing outside the streak's territory is a NEW hypothesis, not
        // another swing at the old one. Start a fresh streak here.
        if (cycles > 0 && !streakFiles.has(p)) {
          reset();
          pendingEdits.add(p);
          pendingFirstTs = e.ts;
          continue;
        }
        if (pendingEdits.size === 0) pendingFirstTs = e.ts;
        pendingEdits.add(p);
        continue;
      }
      // Opening a file for the first time mid-streak is exploration —
      // they went looking somewhere new, which is progress.
      if (e.type === 'file_open' && firstTime && cycles > 0) reset();
      continue;
    }

    if (e.type !== 'test_run') continue;
    if (isPassingRun(e)) {
      reset(); // green is unambiguous progress
      continue;
    }
    if (!isFailingRun(e)) continue; // never completed — proves nothing either way
    if (pendingEdits.size === 0) continue; // re-running without changing anything
    if (cycles === 0) sinceTs = pendingFirstTs ?? e.ts;
    cycles++;
    for (const f of pendingEdits) streakFiles.add(f);
    const s = (e.payload as { summary?: unknown })?.summary;
    lastSummary = typeof s === 'string' && s ? s : null;
    pendingEdits = new Set();
    pendingFirstTs = null;
  }

  if (cycles < needed) return null;
  return {
    cycles,
    since_ms: sinceTs,
    files_touched: streakFiles.size,
    last_summary: lastSummary,
  };
}

/**
 * The observation handed to the prompt. Aliased on purpose: renderActivity
 * learned the hard way that raw paths get parroted back, so this speaks in
 * identity ("the same file") and never in names.
 */
export function describeStuck(s: StuckState, nowMs: number): string {
  const mins = Math.max(1, Math.round((nowMs - s.since_ms) / 60_000));
  const where = s.files_touched <= 1 ? 'the same file' : `the same ${s.files_touched} files`;
  return (
    `${s.cycles} edit-and-run cycles over the last ${mins} minute${mins === 1 ? '' : 's'}, ` +
    `all in ${where}, nothing opened that they had not already been in, and the suite ` +
    `still fails the same way.`
  );
}
