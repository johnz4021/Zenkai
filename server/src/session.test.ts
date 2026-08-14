/**
 * The start-up preflight.
 *
 * Regression from a real session: a second `cli.ts session` ran while the
 * first was still live. It picked a problem, marked it used, destroyed the
 * running container and booted a new one — and only THEN discovered the port
 * was taken. The old server proxied to the new container, so the browser kept
 * working and the candidate practiced problem B in a session that thought it
 * was running problem A. The judge got a timeline and a spec from two
 * different problems.
 *
 * The whole fix is that this check runs before anything destructive, so it is
 * worth a test that actually binds a socket.
 */
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPortFree, containerNameFor, ideDataDirFor, traceUpgradeAllowed } from './session.js';

const listeners: http.Server[] = [];

async function listenOnFreePort(): Promise<number> {
  const server = http.createServer();
  listeners.push(server);
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(
    listeners.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe('assertPortFree', () => {
  it('throws when a previous session still holds the port', async () => {
    const port = await listenOnFreePort();
    expect(() => assertPortFree(port)).toThrow(/already in use by pid \d+/);
  });

  it('names the survivor so the message is actionable', async () => {
    const port = await listenOnFreePort();
    expect(() => assertPortFree(port)).toThrow(/kill \d+/);
  });

  it('promises nothing was changed — the point of running it first', async () => {
    const port = await listenOnFreePort();
    expect(() => assertPortFree(port)).toThrow(/Nothing has been changed/);
  });

  it('passes once the port is released', async () => {
    const port = await listenOnFreePort();
    await Promise.all(
      listeners.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    expect(() => assertPortFree(port)).not.toThrow();
  });
});

// --- beta WU2: /trace per-session token -----------------------------------
describe('traceUpgradeAllowed', () => {
  const TOKEN = 'a'.repeat(32);
  it('accepts the minted token', () => {
    expect(traceUpgradeAllowed(`/trace?token=${TOKEN}`, TOKEN)).toBe(true);
  });
  it('rejects a wrong, missing, or truncated token', () => {
    expect(traceUpgradeAllowed(`/trace?token=${'b'.repeat(32)}`, TOKEN)).toBe(false);
    expect(traceUpgradeAllowed('/trace', TOKEN)).toBe(false);
    expect(traceUpgradeAllowed(`/trace?token=${TOKEN.slice(0, 16)}`, TOKEN)).toBe(false);
    expect(traceUpgradeAllowed(undefined, TOKEN)).toBe(false);
  });
  it('tolerates extra query params and ignores them', () => {
    expect(traceUpgradeAllowed(`/trace?x=1&token=${TOKEN}&y=2`, TOKEN)).toBe(true);
  });
});

// --- multi-session WU-A: identity derivation --------------------------------
describe('per-session identity derivation (WU-A)', () => {
  it('legacy mode keeps the historic values exactly', () => {
    expect(containerNameFor('sess-123', false)).toBe('ip-session');
    expect(ideDataDirFor('/r', null)).toBe(path.join('/r', '.ide-data'));
  });
  it('multi mode namespaces both by session id', () => {
    expect(containerNameFor('sess-123-ab', true)).toBe('ip-session-sess-123-ab');
    expect(ideDataDirFor('/r', 'sess-123-ab')).toBe(path.join('/r', '.ide-data', 'sess-123-ab'));
  });
});

describe('memory deposit guard (source contract)', () => {
  // finalize is process-level and untestable here; the guard is a one-line
  // boundary worth pinning as source — qa-* harness sessions polluted the
  // founder's real memory once (2 of 10 store sessions, 100% of the topic
  // ledger, found 2026-08-13) and must never deposit again.
  it('only mint-shaped session ids write memory, and the plan deposit rides the same gate', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'session.ts'), 'utf8');
    // NOT a bare /^sess-/ prefix: the second harness pass minted
    // sess-qa814-* ids that beat exactly that check (2026-08-14).
    expect(src).toContain('const realSession = isMemorableSessionId(cfg.sessionId);');
    expect(src).toContain("result.status === 'assessed' && realSession");
    expect(src).toContain('recordTopicLogRow');
  });
});
