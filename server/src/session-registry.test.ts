/**
 * The registry's reconcile matrix is the safety boundary for multi-session:
 * a wrong drop becomes `docker rm -f` on a healthy cold boot (the :291-305
 * incident, industrialized). Frozen clock, injected probes/pids — pure.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IDE_PORT_BASE,
  SESSION_HARD_TTL_MS,
  SESSION_PORT_BASE,
  allocateSlot,
  inBootWindow,
  launchVerdict2,
  loadRegistry,
  newSessionId,
  reconcileEntries,
  registryPath,
  saveRegistry,
  type ProbeResult,
  type SessionEntry,
} from './session-registry.js';

const T0 = 1_700_000_000_000;
const entry = (over: Partial<SessionEntry>): SessionEntry => ({
  sid: 'sess-1-aa',
  user_id: 'u-a',
  port: SESSION_PORT_BASE,
  ide_port: IDE_PORT_BASE,
  pid: 100,
  problem_dir: 'reps/rep-a/problem',
  started_at: T0 - 60_000,
  ...over,
});
const probe = (o: Partial<ProbeResult>): ProbeResult => ({
  reachable: false,
  ended: false,
  session_id: null,
  ...o,
});

describe('reconcileEntries', () => {
  const alive = () => true;
  const dead = () => false;

  it('keeps a reachable entry whose identity matches; stamps ended_at once', () => {
    const e = entry({});
    const p = new Map([[e.sid, probe({ reachable: true, session_id: e.sid })]]);
    expect(reconcileEntries([e], p, dead, T0)).toEqual({ entries: [e], changed: false });

    const pEnded = new Map([[e.sid, probe({ reachable: true, ended: true, session_id: e.sid })]]);
    const out = reconcileEntries([e], pEnded, dead, T0);
    expect(out.changed).toBe(true);
    expect(out.entries[0]!.ended_at).toBe(T0);
    // second observation does not re-stamp
    const again = reconcileEntries(out.entries, pEnded, dead, T0 + 5_000);
    expect(again.changed).toBe(false);
    expect(again.entries[0]!.ended_at).toBe(T0);
  });

  it('sid mismatch on the port = unreachable (port squatter)', () => {
    const e = entry({});
    const p = new Map([[e.sid, probe({ reachable: true, session_id: 'sess-OTHER' })]]);
    // pid alive → kept (maybe still booting while something else answered)
    expect(reconcileEntries([e], p, alive, T0).entries).toHaveLength(1);
    // pid dead → dropped
    expect(reconcileEntries([e], p, dead, T0).entries).toHaveLength(0);
  });

  it('NEVER drops an unreachable cold boot while the pid lives (within TTL)', () => {
    const e = entry({ started_at: T0 - 10 * 60_000 }); // 10 min in, still building images
    const out = reconcileEntries([e], new Map(), alive, T0);
    expect(out.entries).toHaveLength(1);
    expect(out.changed).toBe(false);
  });

  it('drops unreachable when pid is dead, or past HARD_TTL even with a live pid', () => {
    expect(reconcileEntries([entry({})], new Map(), dead, T0).entries).toHaveLength(0);
    const ancient = entry({ started_at: T0 - SESSION_HARD_TTL_MS - 1 });
    expect(reconcileEntries([ancient], new Map(), alive, T0).entries).toHaveLength(0);
  });

  it('boot window is copy-selection only, never a drop input', () => {
    expect(inBootWindow(entry({ started_at: T0 - 60_000 }), T0)).toBe(true);
    expect(inBootWindow(entry({ started_at: T0 - 6 * 60_000 }), T0)).toBe(false);
  });
});

describe('allocateSlot / launchVerdict2', () => {
  const caps = { maxConcurrentSessions: 2, maxSessionsPerUser: 1 };

  it('allocates the first free pair; null when the cap is exhausted', () => {
    expect(allocateSlot([], 2)).toEqual({ port: SESSION_PORT_BASE, idePort: IDE_PORT_BASE });
    const one = entry({ port: SESSION_PORT_BASE });
    expect(allocateSlot([one], 2)).toEqual({ port: SESSION_PORT_BASE + 1, idePort: IDE_PORT_BASE + 1 });
    const two = [one, entry({ sid: 'sess-2-bb', port: SESSION_PORT_BASE + 1 })];
    expect(allocateSlot(two, 2)).toBeNull();
  });

  it('per-user cap counts only LIVE entries; admins bypass it', () => {
    const mineLive = entry({ user_id: 'me' });
    expect(launchVerdict2([mineLive], 'me', false, 'other/dir', caps)).toBe('your-session-live');
    expect(launchVerdict2([mineLive], 'me', true, 'other/dir', caps)).toBe('ok');
    const mineEnded = entry({ user_id: 'me', ended_at: T0 });
    expect(launchVerdict2([mineEnded], 'me', false, 'other/dir', caps)).toBe('ok');
  });

  it('global cap counts live entries across users', () => {
    const a = entry({ user_id: 'a' });
    const b = entry({ sid: 'sess-2-bb', user_id: 'b', port: SESSION_PORT_BASE + 1 });
    expect(launchVerdict2([a, b], 'c', false, 'other/dir', caps)).toBe('all-slots-busy');
  });

  it('same problem_dir in the registry (even ended) → already-launching', () => {
    const a = entry({ ended_at: T0 });
    expect(launchVerdict2([a], 'someone', false, a.problem_dir, caps)).toBe('already-launching');
  });
});

describe('persistence + ids', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('round-trips atomically; a torn file loads as empty', () => {
    root = mkdtempSync(path.join(tmpdir(), 'registry-'));
    const reg = { entries: [entry({})] };
    saveRegistry(root, reg);
    expect(loadRegistry(root)).toEqual(reg);
    writeFileSync(registryPath(root), '{"entries":[{"sid":'); // torn
    expect(loadRegistry(root)).toEqual({ entries: [] });
  });

  it('multi-mode sids stay within the sess-[\\w-]+ vocabulary', () => {
    const sid = newSessionId(T0);
    expect(sid).toMatch(/^sess-\d+-[0-9a-f]{4}$/);
    expect(sid).toMatch(/^sess-[\w-]+$/);
  });
});
