/**
 * Practice reps — target-less single rounds ("the second door").
 *
 *   paste ──► clarify ──► shape confirm ──► rep record + mkdir lock
 *                                              │ .generating {child pid}
 *                                              ▼
 *                        cli rep-build: draft blueprint ──► generate
 *                                              │                │
 *                                    .failed "draft: …"   .validated / .failed
 *
 * Why it exists (CEO review 2026-08-08): the only path to a session was a
 * season plan — target, intake, queue, pace — a season-sized commitment for
 * "I want a round like the info I gathered." A rep is that round with the
 * plan machinery removed. Everything downstream of generation was ALREADY
 * target-optional (session.ts targetId?, cards served by session id, rejudge
 * scans both universes); only the pre-session windows had no home. This
 * module is that home.
 *
 * REUSES the Queue/QueueItem types and reconcileWithDisk verbatim — a reps
 * file is a Queue with a sentinel target_id, NOT the queue machinery: no
 * pace, no round-robin, no auto-kick. Statuses derive from the same disk
 * markers, so an app restart forgets nothing. 'drafting'/'draft_failed'
 * exist only as a DERIVED phase (blueprint.md presence / a "draft: "-prefixed
 * .failed) so the five status-driven queue loops never meet a status they
 * don't know — the twice-burned lesson pinned in the repo learnings.
 *
 * Endpoint failure paths live HERE as pure gates (app.test.ts never runs the
 * HTTP server — the sweepVerdict precedent): the routes stay thin wiring.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RoundSpec } from '@interview-prep/shared';
import type { Queue, QueueItem } from './queue.js';
import { localDate, reconcileWithDisk } from './queue.js';
import { pristineArchivePath, readRuns, restorability, type RunEntry } from './artifact.js';
import {
  generationProgress,
  readGeneratingMarker,
  sweepVerdict,
  clearGeneratingMarker,
  type GeneratingMarker,
} from './generation-state.js';

/** Sentinel target_id — reps.json is Queue-SHAPED so reconcileWithDisk works
 *  on it verbatim, but no targets/<id>/ dir ever exists for it, so the
 *  status-driven queue loops can never load it. */
export const REPS_TARGET_ID = '__reps__';

/**
 * One practice rep. Structurally a QueueItem — stored statuses stay inside
 * the existing six-value union — plus what a target would have carried: the
 * confirmed spec and the candidate's pasted material (the blueprint drafter
 * re-reads both at build time).
 */
export interface Rep extends QueueItem {
  spec: RoundSpec;
  description: string;
  context?: string;
  /** The clarifier's task hypothesis (blueprint.ts ROUND_TASKS), confirmed
   *  or corrected on the confirm rail. RECIPE-SIDE: routes skeleton choice
   *  in rep-build and nothing else — deliberately not in RoundSpec (the
   *  two-artifact rule). Absent = pre-taxonomy rep = capability fallback. */
  task?: string;
  created: string;
  /** Beta (WU5): who created this rep. Absent = pre-beta = the local user
   *  ('u1') — the founder's. Descriptions hold pasted recruiter emails, so
   *  visibility is scoped to the owner (admins see all). */
  user_id?: string;
}

/** Ownership rule shared by every rep route: absent user_id = legacy = the
 *  local user's. Pure so the verdict matrix is unit-testable. */
export function repOwnedBy(rep: Pick<Rep, 'user_id'>, userId: string, legacyOwnerId: string): boolean {
  return (rep.user_id ?? legacyOwnerId) === userId;
}

export function repsVisibleTo<T extends Pick<Rep, 'user_id'>>(
  reps: T[],
  user: { id: string; admin: boolean },
  legacyOwnerId: string,
): T[] {
  return user.admin ? reps : reps.filter((r) => repOwnedBy(r, user.id, legacyOwnerId));
}

export interface RepsFile extends Queue {
  items: Rep[];
}

/** DERIVED display phase — never stored. 'drafting' = generating with no
 *  blueprint.md yet; 'draft_failed' = failed whose .failed starts "draft:". */
export type RepPhase = QueueItem['status'] | 'drafting' | 'draft_failed';

// ---- paths ----

export function repsDir(root: string): string {
  return path.join(root, 'reps');
}
export function repDir(root: string, id: string): string {
  return path.join(repsDir(root), id);
}
export function repProblemDir(root: string, id: string): string {
  return path.join(repDir(root, id), 'problem');
}
/** The rep-side answer to blueprintPath — OUTSIDE problem/ so the recipe
 *  never enters the candidate's session workspace or the progress file count. */
export function repBlueprintPath(root: string, id: string): string {
  return path.join(repDir(root, id), 'blueprint.md');
}

const REPS_FILE = 'reps.json';

export function loadReps(root: string): RepsFile {
  const file = path.join(root, REPS_FILE);
  if (!existsSync(file)) {
    return { target_id: REPS_TARGET_ID, items: [], pace: { per_week: 0 }, created: '' };
  }
  return JSON.parse(readFileSync(file, 'utf8')) as RepsFile;
}

export function saveReps(root: string, file: RepsFile): void {
  writeFileSync(path.join(root, REPS_FILE), JSON.stringify(file, null, 2));
}

// ---- input gates (pure) ----

/** Client-generated ('rep-' + Date.now().toString(36)) so a double-click
 *  carries the SAME id and the mkdir lock actually bites. Validated here
 *  before any path join. */
export const REP_ID_RE = /^rep-[\w-]+$/;

export function assertRepId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !REP_ID_RE.test(id)) {
    throw new Error('bad rep id');
  }
}

// Precedents: /api/plan/turn caps its message at 32KB; /api/adapt caps
// material at 256KB. Same ceilings, same reasoning — the server cap is the
// real gate (client-side chip/truncation limits are UX, not security).
export const MAX_REP_DESCRIPTION = 32 * 1024;
export const MAX_REP_CONTEXT = 256 * 1024;

export function gateRepInput(input: { description?: unknown; context?: unknown }): {
  description: string;
  context: string;
} {
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const context = typeof input.context === 'string' ? input.context : '';
  if (!description) throw new Error('describe the round in a sentence or two first');
  if (description.length > MAX_REP_DESCRIPTION) {
    throw new Error('description too long — trim it to the relevant part');
  }
  if (context.length > MAX_REP_CONTEXT) {
    throw new Error('pasted material too large — trim it to the relevant part');
  }
  return { description, context };
}

// ---- lifecycle ----

export function createRepRecord(input: {
  id: string;
  spec: RoundSpec;
  description: string;
  context?: string;
  task?: string;
  /** Server-proved real-set binding (accept-spec discipline: the route
   *  re-resolves and re-verdicts whatever the client sent). rep-build
   *  reads it from the record — no flag plumbing. */
  source?: Rep['source'];
  now?: number;
  userId?: string;
}): Rep {
  return {
    id: input.id,
    label: input.spec.label,
    spec_id: input.spec.id,
    // Created directly in 'generating': the .generating marker lands at
    // request time and covers the drafting phase, so there is no stored
    // 'requested' state a crash could strand.
    status: 'generating',
    problem_dir: path.join('reps', input.id, 'problem'),
    planned_title: input.spec.label,
    spec: input.spec,
    description: input.description,
    ...(input.context ? { context: input.context } : {}),
    ...(input.task ? { task: input.task } : {}),
    ...(input.source ? { source: input.source } : {}),
    created: new Date(input.now ?? Date.now()).toISOString(),
    ...(input.userId ? { user_id: input.userId } : {}),
  };
}

/**
 * The double-click / two-tabs guard: mkdirSync without recursive throws
 * EEXIST when the rep dir is already there. Both clicks carry the same
 * client-generated id, so exactly one wins the mkdir race — a check-then-
 * write on reps.json could not promise that.
 */
export function acquireRepLock(root: string, id: string): void {
  mkdirSync(repsDir(root), { recursive: true });
  try {
    mkdirSync(repDir(root, id), { recursive: false });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('already building that one — give it a moment');
    }
    throw e;
  }
}

/** Drafter failures write .failed prefixed "draft: " — that prefix is the
 *  whole encoding, so stored statuses never leave the QueueItem union. */
export const DRAFT_FAILURE_PREFIX = 'draft: ';

export function derivePhase(
  rep: Rep,
  disk: { hasBlueprint: boolean; failedText: string | null },
): RepPhase {
  if (rep.status === 'generating' && !disk.hasBlueprint) return 'drafting';
  if (rep.status === 'failed' && disk.failedText?.startsWith(DRAFT_FAILURE_PREFIX)) {
    return 'draft_failed';
  }
  return rep.status;
}

// ---- endpoint verdicts (pure) ----

export function launchVerdict(
  rep: Rep,
  state: { usedExists: boolean; sessionLive: boolean },
): 'ok' | 'not-ready' | 'already-used' | 'session-live' {
  if (rep.status !== 'ready') return 'not-ready';
  // .used is written by the session at boot; its presence means a launch
  // already consumed this problem — reconcile will carry the session id.
  if (state.usedExists) return 'already-used';
  if (state.sessionLive) return 'session-live';
  return 'ok';
}

/**
 * "Practice again" on a finished rep (artifact.ts / TODOS #48). Separate
 * from launchVerdict on purpose: launch refuses a consumed dir, repeat
 * REQUIRES one and then destroys the candidate's working tree, so every
 * branch below is a reason not to destroy something.
 *
 *  not-done        a ready+.used rep is a crashed or unassessed run whose
 *                  working tree IS the rejudge evidence — refuse, never
 *                  wipe it. Only 'done' (a real verdict landed) is safe.
 *  not-consumed    nothing has run here yet; there is nothing to repeat and
 *                  the plain launch path is the honest answer.
 *  session-live    a live session has the dir bind-mounted into docker;
 *                  restoring under it would swap the files out from beneath
 *                  the candidate mid-round.
 *  not-repeatable  neither a pristine archive nor a session snapshot exists
 *                  (a pre-archive rep whose snapshot retention slimmed) —
 *                  relaunching would hand back the previous solve.
 */
export function repeatVerdict(
  rep: Pick<Rep, 'status'>,
  state: {
    usedExists: boolean;
    sessionLiveOnDir: boolean;
    restorable: 'pristine' | 'snapshot' | null;
  },
): 'ok' | 'not-done' | 'not-consumed' | 'session-live' | 'not-repeatable' {
  if (rep.status !== 'done') return 'not-done';
  if (!state.usedExists) return 'not-consumed';
  if (state.sessionLiveOnDir) return 'session-live';
  if (state.restorable === null) return 'not-repeatable';
  return 'ok';
}

export function retryVerdict(
  rep: Rep,
  state: { markerAlive: boolean },
): 'ok' | 'not-failed' | 'still-running' {
  if (rep.status !== 'failed') return 'not-failed';
  // The ISSUE-003 double-agent guard: a false 'failed' can coexist with a
  // live detached build for a moment — spawning again would put two agents
  // in one directory.
  if (state.markerAlive) return 'still-running';
  return 'ok';
}

/**
 * Beta admission gate (WU6) — pure verdict, caps injected from PublicConfig.
 * Daily boundary is the LOCAL calendar day (queue.ts's localDate convention):
 * a candidate practicing at 11pm shouldn't find the next morning's budget
 * already spent. Pending = anything not yet consumed or written off
 * (generating | ready | failed) — the cap that bounds disk, since every
 * ready node rep is a ~60MB problem dir until retention slims it.
 *
 * `maxBuildsPerDay` is the GLOBAL ceiling, counted across every user, and it
 * is the one cap that actually bounds spend. The per-user caps above assume a
 * gated identity; signup is deliberately open (decision 2026-08-12), so a new
 * email is free and every per-user limit is one signup away from being reset.
 * Only a global count is not, which is why this check exists and why it is
 * checked LAST: a user who has spent their own budget should be told that,
 * not that the whole product is full.
 */
export function admissionVerdict(
  reps: Pick<Rep, 'user_id' | 'status' | 'created'>[],
  userId: string,
  legacyOwnerId: string,
  nowMs: number,
  caps: { maxRepsPerUserDay: number; maxPendingPerUser: number; maxBuildsPerDay?: number },
): 'ok' | 'daily-cap' | 'pending-cap' | 'global-cap' {
  const mine = reps.filter((r) => repOwnedBy(r, userId, legacyOwnerId));
  const today = localDate(nowMs);
  const createdToday = mine.filter((r) => localDate(Date.parse(r.created)) === today).length;
  if (createdToday >= caps.maxRepsPerUserDay) return 'daily-cap';
  const pending = mine.filter(
    (r) => r.status === 'generating' || r.status === 'ready' || r.status === 'failed',
  ).length;
  if (pending >= caps.maxPendingPerUser) return 'pending-cap';
  // Absent = Infinity, so local dev and any caller that has not been taught
  // this cap behaves exactly as before.
  const globalCap = caps.maxBuildsPerDay ?? Infinity;
  const builtToday = reps.filter((r) => localDate(Date.parse(r.created)) === today).length;
  if (builtToday >= globalCap) return 'global-cap';
  return 'ok';
}

// ---- views ----

export interface RepView extends Rep {
  phase: RepPhase;
  title: string;
  generating?: { since: string | null; files: number; phase: 'building' | 'finalizing' };
  /** Can this finished round be run again on a reset workspace? Drives the
   *  history row's "practice again" action — no extra endpoint, and the
   *  button never appears where /api/practice/repeat would 409. */
  repeatable: boolean;
  /** Every session that ever ran in this dir (artifact.ts's append-only
   *  ledger). Length > 1 = a repeat happened, and history renders the
   *  prior attempts' cards — without it a repeat LOOKS like erasure. */
  runs: RunEntry[];
}

/**
 * Reconciled, display-ready reps, newest first. reconcileWithDisk is the
 * queue's own reconciler reused literally — it only reads problem_dir-
 * relative markers, so a Queue-shaped reps file is a valid input.
 */
export function repStateView(root: string, file: RepsFile): RepView[] {
  const reconciled = reconcileWithDisk(root, file) as RepsFile;
  return reconciled.items
    .map((rep) => {
      const dir = repProblemDir(root, rep.id);
      const failedFile = path.join(dir, '.failed');
      const failedText = existsSync(failedFile) ? readFileSync(failedFile, 'utf8') : null;
      const phase = derivePhase(rep, {
        hasBlueprint: existsSync(repBlueprintPath(root, rep.id)),
        failedText,
      });
      const view: RepView = {
        ...rep,
        phase,
        title: resolveRepTitle(root, rep),
        // Restorability is a disk fact, same discipline as every other
        // status here: a pristine archive beside the dir, or the pre-archive
        // session snapshot inside it.
        repeatable:
          rep.status === 'done' &&
          restorability({
            hasPristine: existsSync(pristineArchivePath(dir)),
            hasSnapshot: existsSync(path.join(dir, '.session-snapshot')),
          }) !== null,
        runs: readRuns(dir),
      };
      if (rep.status === 'generating') view.generating = generationProgress(dir);
      return view;
    })
    .reverse();
}

/** The generated problem's own name wins; the spec label is the promise
 *  until then (resolveTitle's logic, rep-shaped). */
function resolveRepTitle(root: string, rep: Rep): string {
  const manifest = path.join(repProblemDir(root, rep.id), 'problem.json');
  if (existsSync(manifest)) {
    try {
      const p = JSON.parse(readFileSync(manifest, 'utf8')) as { title?: string };
      if (p.title) return p.title;
    } catch {
      /* half-written manifest mid-generation */
    }
  }
  return rep.label;
}

// ---- the orphan sweep, reps half ----

/**
 * App restart while a rep build was mid-flight: probe the marker's pid
 * before judging, exactly like the targets sweep (ISSUE-003). Writes only
 * disk markers — the stored file is never mutated; reconcileWithDisk derives
 * the failed status on the next state read, same as the queue sweep.
 * Returns log strings instead of printing so tests never capture console.
 */
export function sweepReps(
  root: string,
  file: RepsFile,
  isAlive: (pid: number) => boolean,
  skipDirs: Set<string> = new Set(),
): string[] {
  const log: string[] = [];
  for (const rep of file.items) {
    if (rep.status !== 'generating' || !rep.problem_dir) continue;
    const dir = path.isAbsolute(rep.problem_dir) ? rep.problem_dir : path.join(root, rep.problem_dir);
    if (skipDirs.has(dir)) continue; // this process owns a live child for it
    const marker: GeneratingMarker | null = readGeneratingMarker(dir);
    const verdict = sweepVerdict({
      marker,
      alive: marker ? isAlive(marker.pid) : false,
      hasTerminalMarker:
        existsSync(path.join(dir, '.validated')) || existsSync(path.join(dir, '.failed')),
    });
    if (verdict === 'clear-marker') {
      clearGeneratingMarker(dir);
    } else if (verdict === 'fail') {
      clearGeneratingMarker(dir);
      writeFileSync(path.join(dir, '.failed'), `orphaned by app restart at ${new Date().toISOString()}\n`);
      log.push(`[app] rep ${rep.id} orphaned by restart — marked failed (retryable)`);
    } else {
      log.push(`[app] rep ${rep.id} still building (pid ${marker!.pid} alive) — left alone`);
    }
  }
  return log;
}
