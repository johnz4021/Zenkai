/**
 * Live-session registry (multi-session WU-B, TODOS #22).
 *
 *   launch ──► allocateSlot + append ──► sessions-live.json ──► router routes,
 *                                            │                  sweep reaps,
 *                                            ▼                  /api/state answers
 *                              reconcileEntries(probes, pids)
 *
 * Disk-authoritative, same contract as the .generating marker
 * (generation-state.ts): the app can die and restart at any moment and the
 * worst case is a stale entry the next reconcile drops. App-only writes,
 * temp+rename atomic, and an unparseable file loads as empty — a crash
 * mid-write must never brick launches.
 *
 * The reconcile drop rule is the part that earned review scrutiny:
 *   - reachable AND the probed session_id matches → alive (identity check
 *     catches a port squatter or a stale probe after fast port turnover)
 *   - unreachable → drop ONLY if the pid is dead, or the entry is older than
 *     HARD_TTL (pid-reuse bound). A cold boot is legitimately unreachable for
 *     MINUTES (docker build + npm install run before listen), so "unreachable
 *     for a while" must NEVER be a drop reason by itself — the sweep that
 *     acts on drops runs `docker rm -f` and would corrupt a healthy boot.
 *   - the pid is npx's, not the session's: valid only as a liveness HINT
 *     (the chain collapses on the leaf's process.exit); reachability wins.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface SessionEntry {
  sid: string;
  user_id: string;
  /** The session server's HTTP port (trace WS dials it directly too). */
  port: number;
  ide_port: number;
  /** spawnDetached child pid — the npx wrapper; liveness hint only. */
  pid: number;
  problem_dir: string;
  started_at: number;
  /** Stamped by the first reconcile that observes probe.ended. The sweep's
   *  shutdown clock keys on THIS, never started_at — a 45-minute round must
   *  not lose its card at the moment of grading. */
  ended_at?: number;
}

export interface Registry {
  entries: SessionEntry[];
}

export interface ProbeResult {
  reachable: boolean;
  ended: boolean;
  /** session_id reported by /api/status; null when unreachable/unparseable. */
  session_id: string | null;
}

/** Bounds pid-reuse false-keeps; comfortably above cap+grace+judging. */
export const SESSION_HARD_TTL_MS = 3 * 60 * 60 * 1000;
/** UI copy selector only ("warming up" vs "unresponsive") — NEVER a drop input. */
export const SESSION_BOOT_WINDOW_MS = 5 * 60 * 1000;

/** Port pairs: session 3401+i, ide 3451+i. 3301-3500 verified unused. */
export const SESSION_PORT_BASE = 3401;
export const IDE_PORT_BASE = 3451;

export function newSessionId(nowMs: number): string {
  // Legacy format is `sess-<ms>`; multi adds 4 hex chars because concurrent
  // launches make same-millisecond ids possible, and the sid names a
  // container, a workspace path, a trace file, and an assessment file.
  return `sess-${nowMs}-${randomBytes(2).toString('hex')}`;
}

export interface ReconcileOutcome {
  entries: SessionEntry[];
  changed: boolean;
}

export function reconcileEntries(
  entries: SessionEntry[],
  probes: Map<string, ProbeResult>,
  pidAlive: (pid: number) => boolean,
  nowMs: number,
): ReconcileOutcome {
  const out: SessionEntry[] = [];
  let changed = false;
  for (const e of entries) {
    const probe = probes.get(e.sid) ?? { reachable: false, ended: false, session_id: null };
    const identityOk = probe.reachable && probe.session_id === e.sid;
    if (identityOk) {
      if (probe.ended && e.ended_at === undefined) {
        out.push({ ...e, ended_at: nowMs });
        changed = true;
      } else {
        out.push(e);
      }
      continue;
    }
    // Unreachable (or a stranger answered on the port — same thing for us).
    const drop = !pidAlive(e.pid) || nowMs - e.started_at > SESSION_HARD_TTL_MS;
    if (drop) {
      changed = true; // dropped
    } else {
      out.push(e); // booting or briefly wedged: keep, never rm a healthy boot
    }
  }
  return { entries: out, changed };
}

/** True while the entry may still legitimately be unreachable (cold boot). */
export function inBootWindow(e: SessionEntry, nowMs: number): boolean {
  return nowMs - e.started_at < SESSION_BOOT_WINDOW_MS;
}

export function allocateSlot(
  entries: SessionEntry[],
  maxSlots: number,
): { port: number; idePort: number } | null {
  const used = new Set(entries.map((e) => e.port));
  for (let i = 0; i < maxSlots; i++) {
    const port = SESSION_PORT_BASE + i;
    if (!used.has(port)) return { port, idePort: IDE_PORT_BASE + i };
  }
  return null;
}

export type LaunchVerdict2 = 'ok' | 'your-session-live' | 'all-slots-busy' | 'already-launching';

/** Live = not yet ended. Per-user cap ignores ended entries (a graded round
 *  lingering to serve its card must not block the next launch).
 *
 *  `ignoreEndedOnSameDir` is opt-in and exists for repeat sessions only
 *  (app.ts /api/practice/repeat): an ended entry lingers ~30-40 min to serve
 *  its card, so "practice again" straight after finishing would otherwise
 *  409 on its own just-graded round. A LIVE entry on the dir still blocks
 *  under the flag. The default stays strict — for the queue/launch paths the
 *  same-dir check is the only dirty-relaunch guard inside the registry
 *  window, and the test below pins it. */
export function launchVerdict2(
  entries: SessionEntry[],
  userId: string,
  isAdmin: boolean,
  problemDir: string,
  caps: { maxConcurrentSessions: number; maxSessionsPerUser: number },
  opts?: { ignoreEndedOnSameDir?: boolean },
): LaunchVerdict2 {
  // ADDITIVE to the .used marker check, not a replacement: this covers the
  // in-registry window; .used covers everything after the entry drops.
  const sameDirBlocks = (e: SessionEntry): boolean =>
    e.problem_dir === problemDir && (!opts?.ignoreEndedOnSameDir || e.ended_at === undefined);
  if (entries.some(sameDirBlocks)) return 'already-launching';
  const live = entries.filter((e) => e.ended_at === undefined);
  if (!isAdmin) {
    const mine = live.filter((e) => e.user_id === userId).length;
    if (mine >= caps.maxSessionsPerUser) return 'your-session-live';
  }
  if (live.length >= caps.maxConcurrentSessions) return 'all-slots-busy';
  return 'ok';
}

// ---- persistence ----

export function registryPath(root: string): string {
  return path.join(root, 'sessions-live.json');
}

export function loadRegistry(root: string): Registry {
  const file = registryPath(root);
  if (!existsSync(file)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Registry;
    return Array.isArray(parsed.entries) ? parsed : { entries: [] };
  } catch {
    return { entries: [] }; // torn write: empty beats bricked
  }
}

export function saveRegistry(root: string, reg: Registry): void {
  const file = registryPath(root);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, file);
}
