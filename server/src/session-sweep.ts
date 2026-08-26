/**
 * Session lifecycle sweep (multi-session WU-G, TODOS #22).
 *
 *   registry + probes + docker ps ──► planSessionSweep (PURE) ──► actions
 *                                                                    │
 *              drop-entry / shutdown-ended / rm-container / rm-ide-data
 *                                                                    ▼
 *                                                            applySessionSweep
 *
 * Why it exists: ended sessions linger on purpose (their HTTP server serves
 * the card), but under dynamic ports a lingering server is a leaked slot —
 * and a crashed session leaves a live container + a held ide-data dir that
 * nothing else reconciles. The sweep closes both, on the same 10-minute
 * interval as generation sweeps and retention.
 *
 * Rules the tests pin:
 *   - shutdown-ended keys on ended_at + 30 MIN, never started_at — a
 *     45-minute round must not lose its card at the moment of grading. The
 *     card survives regardless (app /api/feedback + the WU-C confirm home).
 *   - cleanup order is container BEFORE ide-data (the dir is a live bind
 *     mount until the container dies).
 *   - orphan containers = docker ps names matching ip-session-<something>
 *     minus the registry. Never matches legacy 'ip-session' (no dash), and
 *     the launch path appends the entry before spawning, so a just-born
 *     container always has its entry.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { reconcileEntries, type ProbeResult, type SessionEntry } from './session-registry.js';

export const ENDED_LINGER_MS = 30 * 60 * 1000;

export type SweepAction =
  | { kind: 'persist'; entries: SessionEntry[] }
  | { kind: 'shutdown-ended'; sid: string; port: number }
  | { kind: 'rm-container'; sid: string; container: string }
  | { kind: 'rm-ide-data'; sid: string }
  | { kind: 'orphan-container'; container: string };

export function planSessionSweep(
  entries: SessionEntry[],
  probes: Map<string, ProbeResult>,
  pidAlive: (pid: number) => boolean,
  dockerNames: string[],
  nowMs: number,
): SweepAction[] {
  const actions: SweepAction[] = [];
  const out = reconcileEntries(entries, probes, pidAlive, nowMs);
  const kept = new Set(out.entries.map((e) => e.sid));
  if (out.changed) actions.push({ kind: 'persist', entries: out.entries });

  // Dropped entries: their container/ide-data may outlive the process.
  for (const e of entries) {
    if (kept.has(e.sid)) continue;
    actions.push({ kind: 'rm-container', sid: e.sid, container: `ip-session-${e.sid}` });
    actions.push({ kind: 'rm-ide-data', sid: e.sid });
  }

  // Graded rounds whose card window has passed: free the slot politely.
  for (const e of out.entries) {
    if (e.ended_at !== undefined && nowMs - e.ended_at > ENDED_LINGER_MS) {
      actions.push({ kind: 'shutdown-ended', sid: e.sid, port: e.port });
    }
  }

  // Containers wearing our per-session prefix with no registry entry.
  const known = new Set(entries.map((e) => `ip-session-${e.sid}`));
  for (const name of dockerNames) {
    if (/^ip-session-sess-[\w-]+$/.test(name) && !known.has(name)) {
      actions.push({ kind: 'orphan-container', container: name });
    }
  }
  return actions;
}

export function listSessionContainers(): string[] {
  const out = spawnSync('docker', ['ps', '--format', '{{.Names}}', '--filter', 'name=ip-session-'], {
    encoding: 'utf8',
  });
  return (out.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

export function applySessionSweep(
  actions: SweepAction[],
  deps: {
    root: string;
    save(entries: SessionEntry[]): void;
    postShutdown(port: number): Promise<{ ok: boolean }>;
  },
): void {
  for (const a of actions) {
    try {
      if (a.kind === 'persist') {
        deps.save(a.entries);
      } else if (a.kind === 'shutdown-ended') {
        void deps.postShutdown(a.port).then((r) => {
          if (r.ok) console.log(`[sweep] reaped ended session ${a.sid} (card lives in history)`);
        });
      } else if (a.kind === 'rm-container' || a.kind === 'orphan-container') {
        // Container FIRST: ide-data is a live mount until it dies.
        spawnSync('docker', ['rm', '-f', a.container], { encoding: 'utf8' });
        console.log(`[sweep] removed container ${a.container}`);
        // Network AFTER the container (rm fails while attached). Derived from
        // the container name; legacy 'ip-session' has none and no-ops.
        // Net name derived inline (same convention as the ip-session-<sid>
        // container name above) — avoids importing session.ts into the app.
        if (a.container.startsWith('ip-session-')) {
          const net = a.container.replace(/^ip-session-/, 'ip-net-');
          spawnSync('docker', ['network', 'rm', net], { encoding: 'utf8' });
        }
      } else {
        const dir = path.join(deps.root, '.ide-data', a.sid);
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          console.log(`[sweep] removed ide-data for ${a.sid}`);
        }
      }
    } catch (e) {
      console.warn(`[sweep] ${a.kind} failed: ${String(e).slice(0, 160)}`);
    }
  }
}
