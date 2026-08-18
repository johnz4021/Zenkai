/**
 * The router is what stands between "two people mid-interview" and "user B
 * watching user A's round". resolveRoute is tested as a matrix; the server
 * is tested for real against two stub backends on ephemeral ports, including
 * a genuine WebSocket upgrade — no docker, no model calls.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSessionRouter, resolveRoute, SID_COOKIE, WARMUP_PAGE } from './session-router.js';
import type { SessionEntry } from './session-registry.js';

const entry = (sid: string, port: number): SessionEntry => ({
  sid, user_id: 'u', port, ide_port: port + 50, pid: 1,
  problem_dir: 'reps/x/problem', started_at: 0,
});

describe('resolveRoute', () => {
  const A = entry('sess-1-aa', 4001);
  const B = entry('sess-2-bb', 4002);
  const deps = (live: SessionEntry[], authEnabled: boolean) => ({
    resolveEntry: (sid: string) => live.find((e) => e.sid === sid) ?? null,
    liveEntries: () => live,
    authEnabled,
  });

  it('?sid on /session sets the cookie via redirect; unknown sid gets the ended page', () => {
    expect(resolveRoute('/session?sid=sess-1-aa', undefined, deps([A], true)))
      .toEqual({ kind: 'set-cookie-redirect', sid: 'sess-1-aa', entry: A });
    expect(resolveRoute('/session?sid=sess-GONE', undefined, deps([A], true)))
      .toEqual({ kind: 'ended-page' });
  });

  it('cookie routes every path; ?sid outranks a stale cookie', () => {
    const cookie = `${SID_COOKIE}=sess-2-bb`;
    for (const p of ['/session', '/api/status', '/voice/tts/3', '/?folder=/w', '/vendor/monaco/loader.js']) {
      expect(resolveRoute(p, cookie, deps([A, B], true))).toEqual({ kind: 'proxy', entry: B });
    }
    expect(resolveRoute('/api/messages?sid=sess-1-aa', cookie, deps([A, B], true)))
      .toEqual({ kind: 'proxy', entry: A });
  });

  it('stale cookie under auth lands on ended/unroutable, NEVER the surviving room', () => {
    const stale = `${SID_COOKIE}=sess-GONE`;
    expect(resolveRoute('/session', stale, deps([A], true))).toEqual({ kind: 'ended-page' });
    expect(resolveRoute('/api/status', stale, deps([A], true))).toEqual({ kind: 'unroutable' });
  });

  it('auth-off grace: a sid-less request routes to the ONLY live session', () => {
    expect(resolveRoute('/api/status', undefined, deps([A], false))).toEqual({ kind: 'proxy', entry: A });
    expect(resolveRoute('/api/status', undefined, deps([A, B], false))).toEqual({ kind: 'unroutable' });
  });
});

describe('router server against stub backends', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const c of cleanups.splice(0)) c(); });

  async function stubBackend(tag: string): Promise<number> {
    const wss = new WebSocketServer({ noServer: true });
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag, path: req.url }));
    });
    srv.on('upgrade', (req, socket, head) =>
      wss.handleUpgrade(req, socket, head, (ws) => ws.send(`ws:${tag}`)));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    cleanups.push(() => srv.close());
    return (srv.address() as AddressInfo).port;
  }

  it('proxies HTTP and WS by cookie, 302-sets the cookie, serves the ended page', async () => {
    const portA = await stubBackend('A');
    const portB = await stubBackend('B');
    const A = entry('sess-1-aa', portA);
    const B = entry('sess-2-bb', portB);
    const router = makeSessionRouter({
      resolveEntry: (sid) => [A, B].find((e) => e.sid === sid) ?? null,
      liveEntries: () => [A, B],
      authEnabled: true,
      publicIsHttps: false,
    });
    await new Promise<void>((r) => router.listen(0, '127.0.0.1', r));
    cleanups.push(() => router.close());
    const base = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;

    // entry link: 302 + Set-Cookie, fragment-preserving location
    const redir = await fetch(`${base}/session?sid=sess-1-aa`, { redirect: 'manual' });
    expect(redir.status).toBe(302);
    expect(redir.headers.get('location')).toBe('/session');
    expect(redir.headers.get('set-cookie')).toContain(`${SID_COOKIE}=sess-1-aa`);

    // cookie-routed HTTP to the right backend
    const viaA = await (await fetch(`${base}/api/status`, { headers: { cookie: `${SID_COOKIE}=sess-1-aa` } })).json();
    expect(viaA.tag).toBe('A');
    const viaB = await (await fetch(`${base}/api/status`, { headers: { cookie: `${SID_COOKIE}=sess-2-bb` } })).json();
    expect(viaB.tag).toBe('B');

    // real WS upgrade through the router, cookie-keyed
    const msg = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/events`, {
        headers: { cookie: `${SID_COOKIE}=sess-2-bb` },
      });
      ws.on('message', (d) => { resolve(String(d)); ws.close(); });
      ws.on('error', reject);
    });
    expect(msg).toBe('ws:B');

    // stale cookie: ended page on /session, 503 elsewhere, WS destroyed
    const ended = await fetch(`${base}/session`, { headers: { cookie: `${SID_COOKIE}=sess-GONE` } });
    expect(await ended.text()).toContain('That round has ended');
    expect((await fetch(`${base}/api/x`, { headers: { cookie: `${SID_COOKIE}=sess-GONE` } })).status).toBe(503);
    await expect(new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/events`, {
        headers: { cookie: `${SID_COOKIE}=sess-GONE` } });
      ws.on('open', resolve);
      ws.on('error', reject);
    })).rejects.toThrow();
  });
});

describe('the warm-up page carries its own retry (owner report 2026-08-18)', () => {
  it('auto-refreshes, declares utf-8, and never tells the user to refresh manually', () => {
    expect(WARMUP_PAGE).toContain('http-equiv="refresh"');
    expect(WARMUP_PAGE).toContain('charset="utf-8"');
    expect(WARMUP_PAGE).not.toMatch(/refresh in a few seconds/);
  });
});
