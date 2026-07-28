/**
 * Problem pool.
 *
 *   session ends ──► gap graph updated ──► generate NEXT problem (detached)
 *                                              │  ~5 min, nobody waiting
 *                                              ▼
 *   next session start ──► pick newest unused ──► zero wait
 *
 * Generation takes ~5 minutes. Triggering it at session START would put that
 * wait in front of the candidate, which is far worse than the container boot
 * we already fixed with a warm pool. At session END we already know the new
 * focus gap and have until they come back.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GeneratedProblem } from '@interview-prep/shared';

const USED_MARKER = '.used';

export interface PooledProblem {
  dir: string;
  problem: GeneratedProblem;
  createdMs: number;
}

function readProblem(dir: string): PooledProblem | null {
  const manifest = path.join(dir, 'problem.json');
  if (!existsSync(manifest)) return null;
  try {
    return {
      dir,
      problem: JSON.parse(readFileSync(manifest, 'utf8')) as GeneratedProblem,
      createdMs: statSync(manifest).mtimeMs,
    };
  } catch {
    return null; // half-written problem from a generation still in flight
  }
}

export function listReady(problemsRoot: string): PooledProblem[] {
  if (!existsSync(problemsRoot)) return [];
  return readdirSync(problemsRoot)
    .map((name) => path.join(problemsRoot, name))
    .filter((dir) => statSync(dir).isDirectory() && !existsSync(path.join(dir, USED_MARKER)))
    .map(readProblem)
    .filter((p): p is PooledProblem => p !== null)
    .sort((a, b) => b.createdMs - a.createdMs);
}

/** Newest unused problem, or null when the pool is dry. */
export function pickProblem(problemsRoot: string): PooledProblem | null {
  return listReady(problemsRoot)[0] ?? null;
}

export function markUsed(dir: string, sessionId: string): void {
  writeFileSync(path.join(dir, USED_MARKER), `${sessionId}\n${new Date().toISOString()}\n`);
}
