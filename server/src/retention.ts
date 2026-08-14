/**
 * Retention (beta WU10) — the disk math that makes an open beta survivable.
 *
 *   reps on disk ──► gatherRepDiskFacts ──► planReaping (PURE) ──► applyReaping
 *
 * A launched node rep is a ~60MB problem dir, and 99.9% of that is
 * node_modules — cache, not data (the Lovable lesson: nobody stores installed
 * deps). A graded session needs only its trace (~16KB), the manifest, and the
 * markers to stay re-judgeable (`cli.ts rejudge` reads exactly those), so:
 *
 *   1. node_modules reap — .used AND assessed AND carded → delete
 *      problem/node_modules. 60MB → ~2MB, nothing user-visible changes.
 *   2. slim — RETENTION_DAYS past .used → problem/ reduced to problem.json
 *      + markers. ~2MB → ~100KB. History cards and rejudge keep working.
 *   3. UNCONSUMED WORK IS NEVER AGE-REAPED (TODOS #27's rule: an unsolved
 *      problem stays re-runnable). The pending-per-user cap bounds it instead.
 *
 * Walks reps/ ONLY — the founder's problems/ and targets/ are admin data and
 * not this module's to touch. Pure planner (injected nowMs, no I/O) so the
 * reap matrix is unit-tested without a filesystem.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** Files that survive a slim: enough to render the history card, prove the
 *  round ran, and rejudge it from the trace. */
export const SLIM_KEEP = ['problem.json', '.used', '.validated', '.failed'] as const;

export interface RepDiskFacts {
  id: string;
  /** Absolute problem dir. */
  dir: string;
  /** .used mtime, or null = never launched = untouchable. */
  usedMtimeMs: number | null;
  /** The consuming session is judged AND carded — the reap precondition. */
  graded: boolean;
  hasNodeModules: boolean;
  /** Nothing but SLIM_KEEP left already. */
  slimmed: boolean;
}

export interface ReapAction {
  kind: 'node_modules' | 'slim';
  id: string;
  dir: string;
}

export interface RetentionPolicy {
  /** null = slim pass off. */
  days: number | null;
  reapNodeModules: boolean;
}

export function planReaping(
  facts: RepDiskFacts[],
  nowMs: number,
  policy: RetentionPolicy,
): ReapAction[] {
  const out: ReapAction[] = [];
  for (const f of facts) {
    if (f.usedMtimeMs === null) continue; // unconsumed: never age-reaped
    if (!f.graded) continue; // a crashed/unjudged round stays intact for rejudge/rerun
    if (
      policy.days !== null &&
      !f.slimmed &&
      nowMs - f.usedMtimeMs > policy.days * 86_400_000
    ) {
      out.push({ kind: 'slim', id: f.id, dir: f.dir });
      continue; // slim implies node_modules goes too
    }
    if (policy.reapNodeModules && f.hasNodeModules) {
      out.push({ kind: 'node_modules', id: f.id, dir: f.dir });
    }
  }
  return out;
}

/** Disk truth for every rep problem dir under <root>/reps. */
export function gatherRepDiskFacts(root: string): RepDiskFacts[] {
  const repsDir = path.join(root, 'reps');
  if (!existsSync(repsDir)) return [];
  const out: RepDiskFacts[] = [];
  for (const id of readdirSync(repsDir)) {
    const dir = path.join(repsDir, id, 'problem');
    if (!/^rep-[\w-]+$/.test(id) || !existsSync(dir)) continue;
    const usedFile = path.join(dir, '.used');
    let usedMtimeMs: number | null = null;
    let graded = false;
    if (existsSync(usedFile)) {
      usedMtimeMs = statSync(usedFile).mtimeMs;
      // .used names the session that consumed the problem; graded = that
      // session's assessment AND feedback both landed.
      const sid = readFileSync(usedFile, 'utf8').trim();
      graded =
        /^sess-[\w-]+$/.test(sid) &&
        existsSync(path.join(root, 'assessments', `${sid}.json`)) &&
        existsSync(path.join(root, 'feedback', `${sid}.json`));
    }
    const entries = readdirSync(dir);
    out.push({
      id,
      dir,
      usedMtimeMs,
      graded,
      hasNodeModules: entries.includes('node_modules'),
      slimmed: entries.every((e) => (SLIM_KEEP as readonly string[]).includes(e)),
    });
  }
  return out;
}

export function applyReaping(actions: ReapAction[]): void {
  for (const a of actions) {
    try {
      if (a.kind === 'node_modules') {
        rmSync(path.join(a.dir, 'node_modules'), { recursive: true, force: true });
        console.log(`[retention] reaped node_modules of ${a.id}`);
      } else {
        for (const e of readdirSync(a.dir)) {
          if (!(SLIM_KEEP as readonly string[]).includes(e)) {
            rmSync(path.join(a.dir, e), { recursive: true, force: true });
          }
        }
        console.log(`[retention] slimmed ${a.id}`);
      }
    } catch (e) {
      console.warn(`[retention] ${a.kind} failed for ${a.id}: ${String(e).slice(0, 160)}`);
    }
  }
}
