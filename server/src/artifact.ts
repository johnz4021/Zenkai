/**
 * Problem-artifact durability: pristine archives and the per-run ledger.
 *
 *   validation writes .validated ──► makePristineArchive ──► <dir>.pristine.tar.gz
 *                                                                 │
 *   session onReady ──► markUsed (latest run) + appendRun ──► <dir>/.runs.jsonl
 *                                                                 │
 *   "practice again" ──► preserveRunTree ──► <dir>.runs/<sid>.tar.gz
 *                    ──► restorePristine / restoreFromSnapshot ──► fresh workspace
 *
 * Why it exists (TODOS #48): the session bind-mounts the problem dir into
 * docker and the candidate edits it in place, generation is nondeterministic,
 * and `.used` was a single-session slot — so a re-run replayed the previous
 * candidate's dirty workspace and orphaned the earlier session's provenance
 * (2026-08-14 QA: four sessions consumed rep-set67388; only the last was
 * recoverable). The archive is taken at validation time, before any session
 * can mutate the tree; the ledger is append-only so rejudge can resolve EVERY
 * session that ever ran in a dir, not just the latest.
 *
 * Paths are uniform siblings of the problem dir (the <dir>.build.log
 * convention): outside the bind mount (never candidate-visible), outside
 * retention's slim pass (which only writes inside problem/), and picked up by
 * the nightly backup with the rest of reps/.
 *
 * Recorded limitations, deliberate for phase 1:
 *  - Rejudging an OLD session of a review-shaped round reads the CURRENT
 *    working tree (judge.ts deliverableText); the run-tree tarball preserves
 *    the bytes but rejudge does not read tarballs (TODOS entry).
 *  - A repeat's memorized re-solve inflates topic-ledger strength like a
 *    first-sight solve; TopicAttempt.origin is a closed union and stays
 *    closed (TODOS entry).
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

/** Marker files that survive a restore: they are the run history, not the
 *  problem. Everything else inside the dir is replaced by the archive. */
export const PRISTINE_MARKERS = ['.used', '.validated', '.failed', '.runs.jsonl'] as const;

/** Excluded from the pristine tar: the markers above plus caches and
 *  session leftovers. problem.json is INCLUDED on purpose — the IDE surface
 *  exposes it in the mount, so a restore also repairs any tampering. */
const PRISTINE_EXCLUDES = [
  ...PRISTINE_MARKERS,
  '.generating',
  '.session-snapshot',
  '.linux-deps-ok',
  '.vitest-report.json',
  'node_modules',
  '__pycache__',
  '*.pyc',
];

/** What restoreFromSnapshot keeps from the working tree: the markers plus
 *  the two files the snapshot machinery never captures (panes.ts excludes
 *  problem.json and all dotfiles from listWorkspaceFiles). */
const SNAPSHOT_KEEP = [...PRISTINE_MARKERS, 'problem.json', '.session-snapshot'];

const SNAPSHOT_DIR = '.session-snapshot';

export function pristineArchivePath(problemDir: string): string {
  return `${problemDir}.pristine.tar.gz`;
}

export function runsDirPath(problemDir: string): string {
  return `${problemDir}.runs`;
}

function runsLedgerPath(problemDir: string): string {
  return path.join(problemDir, '.runs.jsonl');
}

function tar(args: string[]): { ok: boolean; err: string } {
  const r = spawnSync('tar', args, { encoding: 'utf8', timeout: 5 * 60_000 });
  return { ok: r.status === 0, err: (r.stderr ?? '').slice(0, 300) };
}

/**
 * Archive the pristine tree beside the dir. Refuses when `.used` exists (a
 * consumed tree is not pristine — `cli.ts validate` can be pointed at one)
 * or when the archive already exists (idempotent re-validation). `force` is
 * for the snapshot self-heal path only, where the tree is known-pristine.
 * Never throws: a failed archive must not fail a build that already spent
 * real money — callers warn on !ok.
 */
export function makePristineArchive(
  problemDir: string,
  opts?: { force?: boolean },
): { ok: boolean; skipped?: string } {
  const dest = pristineArchivePath(problemDir);
  if (!opts?.force) {
    if (existsSync(path.join(problemDir, '.used'))) return { ok: false, skipped: 'dir is consumed (.used exists)' };
    if (existsSync(dest)) return { ok: false, skipped: 'archive already exists' };
  }
  try {
    const tmp = `${dest}.tmp`;
    const r = tar([
      '-czf', tmp,
      ...PRISTINE_EXCLUDES.flatMap((e) => ['--exclude', e]),
      '-C', problemDir, '.',
    ]);
    if (!r.ok) {
      rmSync(tmp, { force: true });
      return { ok: false, skipped: `tar failed: ${r.err}` };
    }
    renameSync(tmp, dest); // atomic: a torn archive is never trusted
    return { ok: true };
  } catch (e) {
    return { ok: false, skipped: String(e).slice(0, 200) };
  }
}

/**
 * Reset the dir to the archived pristine state, preserving the markers.
 * Throws on a missing archive or tar failure — the repeat endpoint must
 * fail loudly rather than launch a session on a half-wiped workspace.
 */
export function restorePristine(problemDir: string): void {
  const archive = pristineArchivePath(problemDir);
  if (!existsSync(archive)) throw new Error(`no pristine archive at ${archive}`);
  wipeExcept(problemDir, PRISTINE_MARKERS as readonly string[]);
  const r = tar(['-xzf', archive, '-C', problemDir]);
  if (!r.ok) throw new Error(`pristine extract failed: ${r.err}`);
}

/**
 * Fallback for reps consumed before archives existed: the session-start
 * snapshot IS the pristine workspace for a once-used rep. Keeps problem.json
 * from the working tree (the snapshot never contains it; tampering is NOT
 * repaired on this path), copies the snapshot over a wiped tree, drops the
 * snapshot, then self-heals the missing archive so the next repeat takes the
 * fast path.
 */
export function restoreFromSnapshot(problemDir: string): void {
  const snap = path.join(problemDir, SNAPSHOT_DIR);
  if (!existsSync(snap)) throw new Error(`no ${SNAPSHOT_DIR} in ${problemDir}`);
  wipeExcept(problemDir, SNAPSHOT_KEEP);
  cpSync(snap, problemDir, { recursive: true });
  rmSync(snap, { recursive: true, force: true });
  makePristineArchive(problemDir, { force: true });
}

function wipeExcept(dir: string, keep: readonly string[]): void {
  for (const entry of readdirSync(dir)) {
    if (keep.includes(entry)) continue;
    rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

/** How a dir can be reset, if at all. Pure over injected facts. */
export function restorability(facts: {
  hasPristine: boolean;
  hasSnapshot: boolean;
}): 'pristine' | 'snapshot' | null {
  if (facts.hasPristine) return 'pristine';
  if (facts.hasSnapshot) return 'snapshot';
  return null;
}

export interface RunEntry {
  session_id: string;
  user_id: string;
  at: string;
}

/** One JSON line per run. `.used` stays overwrite-latest (every existing
 *  reader keeps working, and its mtime stays retention's age clock); this
 *  ledger is the history. */
export function appendRun(problemDir: string, entry: RunEntry): void {
  appendFileSync(runsLedgerPath(problemDir), `${JSON.stringify(entry)}\n`);
}

/**
 * Capture the session `.used` currently names, if the ledger never saw it.
 *
 * Every problem dir consumed before this module existed carries its ONLY
 * session→dir binding in `.used`, and the next run overwrites it — so the
 * first repeat of a pre-ledger rep orphaned the original session's
 * provenance, which is precisely the loss TODOS #48 set out to end (QA
 * 2026-08-14 reproduced it live: repeating rep-e2e52324 left
 * `rejudge sess-qa813-lc1` reporting "no problem found").
 *
 * Called immediately before markUsed on every launch path, so the outgoing
 * sid is banked no matter which door ran it. `user_id` is 'unknown' rather
 * than a guess: the marker never recorded who ran it, and inventing an owner
 * would put a fabricated attribution in the one file that is supposed to be
 * the provenance record.
 */
export function backfillRunFromUsed(problemDir: string): void {
  const usedFile = path.join(problemDir, '.used');
  let sid: string;
  let stamp: string;
  try {
    const [first, second] = readFileSync(usedFile, 'utf8').split('\n');
    sid = (first ?? '').trim();
    stamp = (second ?? '').trim();
  } catch {
    return; // never consumed — nothing to bank
  }
  // Session ids only: `cli.ts lc verify` writes an `lc-verify` sentinel here.
  if (!/^sess-[\w-]+$/.test(sid)) return;
  if (readRuns(problemDir).some((r) => r.session_id === sid)) return;
  let at = stamp;
  if (!at) {
    try {
      at = new Date(statSync(usedFile).mtimeMs).toISOString();
    } catch {
      at = new Date(0).toISOString();
    }
  }
  appendRun(problemDir, { session_id: sid, user_id: 'unknown', at });
}

export function readRuns(problemDir: string): RunEntry[] {
  let raw: string;
  try {
    raw = readFileSync(runsLedgerPath(problemDir), 'utf8');
  } catch {
    return [];
  }
  const out: RunEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as RunEntry;
      if (typeof e.session_id === 'string') out.push(e);
    } catch {
      /* torn last line from a crash mid-append proves nothing — skip it */
    }
  }
  return out;
}

/**
 * Did sessionId ever run in this dir? Rejudge's question. Matches the
 * `.used` first line (covers pre-ledger history and the lc-verify sentinel's
 * non-session first line harmlessly) OR any ledger row.
 */
export function dirRanSession(problemDir: string, sessionId: string): boolean {
  try {
    const first = readFileSync(path.join(problemDir, '.used'), 'utf8').split('\n')[0];
    if (first === sessionId) return true;
  } catch {
    /* no .used — ledger may still know */
  }
  return readRuns(problemDir).some((r) => r.session_id === sessionId);
}

/**
 * Insurance before a restore: tar the current working tree (minus caches)
 * to <dir>.runs/<sid>.tar.gz. Non-fatal — the trace is the primary record
 * of candidate work; this preserves the bytes for manual recovery.
 */
export function preserveRunTree(problemDir: string, sessionId: string): { ok: boolean } {
  try {
    const safe = sessionId.replace(/[^\w-]/g, '_');
    const dir = runsDirPath(problemDir);
    mkdirSync(dir, { recursive: true });
    const r = tar([
      '-czf', path.join(dir, `${safe}.tar.gz`),
      '--exclude', 'node_modules',
      '--exclude', '__pycache__',
      '--exclude', '*.pyc',
      '--exclude', '.session-snapshot',
      '--exclude', '.vitest-report.json',
      '-C', problemDir, '.',
    ]);
    return { ok: r.ok };
  } catch {
    return { ok: false };
  }
}
