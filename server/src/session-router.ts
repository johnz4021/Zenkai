/**
 * Session router (multi-session WU-E, TODOS #22).
 *
 *   browser ── session.zenkai.run (ONE public origin) ──► router :sessionPort
 *        │                                                   │ sid = ?sid ?? ip_sid cookie
 *        │  GET /session?sid=X ── Set-Cookie ip_sid=X ──► 302 /session
 *        └─ every other path + WS ───────────────────────► proxy 127.0.0.1:<entry.port>
 *
 * Why a cookie, not a path prefix: every browser-facing session path is
 * root-absolute (`/api/*`, `/voice/tts/*`, the IDE iframe at `/?folder=`,
 * the workbench's own assets and WS) — a prefix would mean rewriting the
 * chrome, both clients, and openvscode. The cookie rides all of it,
 * including WS upgrades and the <audio> element, because everything is
 * same-origin. The 302 sets it before the iframe's first request.
 *
 * The router does NO auth — each session server verifies the JWT itself
 * (it must anyway: it listens on all interfaces for the container's trace
 * WS). /trace never traverses the router: the extension dials the session's
 * own port directly with its per-session token.
 *
 * The single-live-entry grace (route a sid-less request to the only live
 * session) exists for auth-OFF local dev only. With auth on it would proxy
 * a stale-cookied visitor into a stranger's open-path shell (/session and
 * /client/* skip the JWT gate by design), so the grace is disabled there.
 *
 * resolveEntry is injected so unit tests run the real router against stub
 * backends on ephemeral ports — no docker, no model calls.
 */

import http from 'node:http';
import httpProxy from 'http-proxy';
import { parseCookies } from './auth.js';
import type { SessionEntry } from './session-registry.js';

export const SID_COOKIE = 'ip_sid';

export interface RouterDeps {
  /** Live entry for a sid, or null. Reads the registry (reconciled by the
   *  app's sweep/launch paths; the router itself never writes). */
  resolveEntry(sid: string): SessionEntry | null;
  /** All live entries — for the auth-off single-entry grace. */
  liveEntries(): SessionEntry[];
  /** Grace switch: TRUE disables the sid-less fallback (auth is on). */
  authEnabled: boolean;
  /** For Secure cookie decisions behind the tunnel. */
  publicIsHttps: boolean;
}

/** Pure routing decision, unit-tested exhaustively. */
export function resolveRoute(
  reqUrl: string | undefined,
  cookieHeader: string | undefined,
  deps: Pick<RouterDeps, 'resolveEntry' | 'liveEntries' | 'authEnabled'>,
):
  | { kind: 'set-cookie-redirect'; sid: string; entry: SessionEntry }
  | { kind: 'proxy'; entry: SessionEntry }
  | { kind: 'ended-page' }
  | { kind: 'unroutable' } {
  const u = new URL(reqUrl ?? '/', 'http://x');
  const qSid = u.searchParams.get('sid');
  if (u.pathname === '/session' && qSid) {
    const entry = deps.resolveEntry(qSid);
    if (entry) return { kind: 'set-cookie-redirect', sid: qSid, entry };
    return { kind: 'ended-page' };
  }
  const sid = qSid ?? parseCookies(cookieHeader)[SID_COOKIE] ?? null;
  if (sid) {
    const entry = deps.resolveEntry(sid);
    if (entry) return { kind: 'proxy', entry };
  }
  if (!deps.authEnabled) {
    const live = deps.liveEntries();
    if (live.length === 1) return { kind: 'proxy', entry: live[0]! };
  }
  return u.pathname === '/session' ? { kind: 'ended-page' } : { kind: 'unroutable' };
}

/** Served while a just-spawned session's port is not accepting yet. It
 *  refreshes ITSELF every 2s until the proxy succeeds — the first version
 *  told the user to refresh manually, which on the sample round (the
 *  activation moment) read as a broken product: the owner backed out of a
 *  blank page mid-launch (2026-08-18). Also: charset was missing, so the
 *  em-dash rendered as mojibake. */
export const WARMUP_PAGE = `<!doctype html>
<meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Zenkai</title>
<body style="background:#0e0e0f;color:#96979b;font-family:sans-serif;display:flex;justify-content:center;padding-top:20vh">
<div style="max-width:420px;text-align:center"><p style="color:#f4f4f5;font-size:20px">Getting your room ready…</p>
<p>This takes a few seconds — the page will come up on its own.</p></div>`;

const ENDED_PAGE = `<!doctype html>
<meta charset="utf-8"><title>Zenkai</title>
<body style="background:#0e0e0f;color:#96979b;font-family:sans-serif;display:flex;justify-content:center;padding-top:20vh">
<div style="max-width:420px"><p style="color:#f4f4f5;font-size:20px">That round has ended.</p>
<p>Your feedback card lives under <b>history</b> on the home page. Head back and start a fresh one.</p></div>`;

export function makeSessionRouter(deps: RouterDeps): http.Server {
  const proxy = httpProxy.createProxyServer({ ws: true });
  proxy.on('error', (_e, _req, resOrSocket) => {
    const res = resOrSocket as http.ServerResponse;
    if (res && 'headersSent' in res && !res.headersSent && typeof res.writeHead === 'function') {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(WARMUP_PAGE);
    } else if (resOrSocket && 'destroy' in resOrSocket) {
      (resOrSocket as { destroy: () => void }).destroy();
    }
  });

  const server = http.createServer((req, res) => {
    const route = resolveRoute(req.url, req.headers.cookie, deps);
    if (route.kind === 'set-cookie-redirect') {
      res.writeHead(302, {
        location: '/session',
        'set-cookie':
          `${SID_COOKIE}=${encodeURIComponent(route.sid)}; Path=/; SameSite=Lax; Max-Age=14400` +
          (deps.publicIsHttps ? '; Secure' : ''),
      });
      return res.end();
    }
    if (route.kind === 'proxy') {
      proxy.web(req, res, { target: `http://127.0.0.1:${route.entry.port}` });
      return;
    }
    if (route.kind === 'ended-page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(ENDED_PAGE);
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no session for this request — reopen it from the home page' }));
  });

  server.on('upgrade', (req, socket, head) => {
    const route = resolveRoute(req.url, req.headers.cookie, deps);
    if (route.kind === 'proxy') {
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${route.entry.port}` });
    } else {
      socket.destroy();
    }
  });

  return server;
}
