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
import { reconcileWithDisk } from './queue.js';
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

// ---- views ----

export interface RepView extends Rep {
  phase: RepPhase;
  title: string;
  generating?: { since: string | null; files: number; phase: 'building' | 'finalizing' };
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
      const view: RepView = { ...rep, phase, title: resolveRepTitle(root, rep) };
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
