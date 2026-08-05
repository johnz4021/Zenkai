/**
 * Generation state, derived from disk (QA ISSUE-003 / 007 / 008).
 *
 * The app previously knew a generation was alive only via an in-memory Set,
 * which an app restart emptied — the orphan sweep then marked a HEALTHY
 * detached generation as failed while its agent kept working, and the retry
 * button would have spawned a second agent into the same directory.
 *
 * The fix is the repo's standing rule: authoritative state lives on disk.
 * A `.generating` marker carries {pid, started_at}; liveness is a signal-0
 * probe of that pid. The same marker gives the UI what it never had — a
 * real start time, so "building this problem" can show honest elapsed
 * progress instead of a decorative loop.
 *
 *   spawn ──► .generating {pid, started_at}
 *                │
 *                ├─ agent finishes ──► .validated / .failed  (terminal)
 *                │                      └─ marker cleared (close handler
 *                │                         or the next sweep)
 *                └─ app restarts ──► sweep probes pid:
 *                       alive → leave it generating (the truth)
 *                       dead  → .failed (a real orphan)
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface GeneratingMarker {
  pid: number;
  started_at: string;
}

const MARKER = '.generating';

export function writeGeneratingMarker(dir: string, pid: number, now = Date.now()): void {
  writeFileSync(
    path.join(dir, MARKER),
    JSON.stringify({ pid, started_at: new Date(now).toISOString() }),
  );
}

export function readGeneratingMarker(dir: string): GeneratingMarker | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, MARKER), 'utf8')) as Partial<GeneratingMarker>;
    if (typeof raw.pid !== 'number' || typeof raw.started_at !== 'string') return null;
    return { pid: raw.pid, started_at: raw.started_at };
  } catch {
    return null;
  }
}

export function clearGeneratingMarker(dir: string): void {
  rmSync(path.join(dir, MARKER), { force: true });
}

/** Signal-0 probe. Injectable in tests via the sweep's parameter. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the sweep should do with a `generating` item after an app restart.
 * Pure — liveness arrives as a value, disk facts as booleans.
 */
export function sweepVerdict(opts: {
  marker: GeneratingMarker | null;
  alive: boolean;
  hasTerminalMarker: boolean;
}): 'leave' | 'fail' | 'clear-marker' {
  // Finished generations reconcile from their terminal marker; a stale
  // .generating alongside one is leftover bookkeeping.
  if (opts.hasTerminalMarker) return 'clear-marker';
  if (opts.marker && opts.alive) return 'leave';
  return 'fail';
}

/**
 * Live progress for a generating item, read straight from the directory the
 * agent is writing into. Observed file order is source → tests → docs →
 * problem.json → .validated, so a manifest on disk means the agent is
 * wrapping up.
 */
export function generationProgress(dir: string): {
  since: string | null;
  files: number;
  phase: 'building' | 'finalizing';
} {
  const marker = readGeneratingMarker(dir);
  let files = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else files++;
    }
  };
  walk(dir, 0);
  return {
    since: marker?.started_at ?? null,
    files,
    phase: existsSync(path.join(dir, 'problem.json')) ? 'finalizing' : 'building',
  };
}

/**
 * Strip host-side Python bytecode from a generated problem dir. The
 * generator and the validator both run the suite, each leaving __pycache__
 * for whatever Python ran them — a candidate's first look at the repo
 * showed .pyc files from two interpreter versions (docs/problem-generation
 * limitation #7). Called before validation AND after it, because the
 * validator's own run re-creates what the first sweep removed.
 */
export function removePythonArtifacts(dir: string): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__pycache__') rmSync(p, { recursive: true, force: true });
      else if (e.name !== 'node_modules' && e.name !== '.git') removePythonArtifacts(p);
    } else if (e.name.endsWith('.pyc')) {
      rmSync(p, { force: true });
    }
  }
}
