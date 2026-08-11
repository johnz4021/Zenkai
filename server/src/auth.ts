/**
 * Beta auth (WU3) — Supabase JWT verification, in-process on BOTH servers.
 *
 *   browser ── cookie ip_jwt / Authorization: Bearer ──► resolve(req)
 *   app ──── x-ip-internal (derived token) ────────────► resolve(req)  server-to-server
 *   container ── /trace?token= ──── (NOT here; see traceUpgradeAllowed)
 *
 *      resolve(req) ──► AuthUser { id, email, admin, internal } | null
 *
 * Why in-process and not edge-only: the session server must listen on all
 * interfaces (the container's trace WS dials the docker GATEWAY ip —
 * session.ts), so anything on the LAN can reach :3200 around the tunnel.
 * Network binding cannot be the gate; verifying the JWT on every request is.
 *
 * Why the internal token is DERIVED (sha256 of the service key + purpose tag)
 * rather than random-per-boot: the app probes the session server
 * (probeSession/postSession, app.ts) and sessions OUTLIVE app restarts by
 * design. A random token would 401 those probes after a restart and the app
 * would stop seeing its own live session. Derivation keeps it stable without
 * handing the service key itself to session processes (WU8: keys are
 * allowlisted per child, the service key reaches no child).
 *
 * Identity: the JWT `sub` (Supabase uuid) IS the internal user id — it lands
 * directly in gaps/<id>.json, feedback user_id, rep ownership. The FIRST
 * admin email maps to the local user id ('u1') so the founder's pre-beta gap
 * graph and targets stay theirs. Auth off (no supabase config) = every
 * request resolves to the local admin — pre-beta behavior, byte-identical.
 *
 * Unit tests sign real ES256/HS256 JWTs with in-test keys; no network, no
 * model calls (verification is pure; the JWKS fetcher is injected).
 */

import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import type http from 'node:http';
import type { SupabaseConfig } from './public-config.js';

export interface AuthUser {
  /** Internal user id: 'u1' (or IP_USER_ID) for the founder, JWT sub otherwise. */
  id: string;
  email: string | null;
  admin: boolean;
  /** True for server-to-server calls authenticated by the internal token. */
  internal?: boolean;
}

export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  [k: string]: unknown;
}
export interface Jwks {
  keys: Jwk[];
}

export interface VerifyOpts {
  jwks?: Jwks;
  hsSecret?: string;
  nowMs: number;
}

const b64urlJson = (part: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/**
 * Pure JWT verification for Supabase access tokens. Returns the claims that
 * matter or null — never throws on malformed input (unauthenticated requests
 * are routine, not exceptional). Checks signature, exp, and aud
 * ('authenticated', Supabase's fixed audience for user tokens).
 */
export function verifySupabaseJwt(
  token: string,
  opts: VerifyOpts,
): { sub: string; email: string | null } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (!header || !payload) return null;

  const signed = Buffer.from(`${h}.${p}`);
  let sig: Buffer;
  try {
    sig = Buffer.from(s, 'base64url');
  } catch {
    return null;
  }

  const alg = header.alg;
  let ok = false;
  if (alg === 'HS256' && opts.hsSecret) {
    const expected = createHmac('sha256', opts.hsSecret).update(signed).digest();
    ok = expected.length === sig.length && timingSafeEqual(expected, sig);
  } else if ((alg === 'ES256' || alg === 'RS256') && opts.jwks) {
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    const jwk =
      opts.jwks.keys.find((k) => k.kid === kid) ??
      (opts.jwks.keys.length === 1 ? opts.jwks.keys[0] : undefined);
    if (!jwk) return null;
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      ok = cryptoVerify(
        'sha256',
        signed,
        alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
        sig,
      );
    } catch {
      return null;
    }
  }
  if (!ok) return null;

  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (exp * 1000 <= opts.nowMs) return null;
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes('authenticated') : aud === 'authenticated';
  if (!audOk) return null;
  if (typeof payload.sub !== 'string' || !payload.sub) return null;

  return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Cookie both origins use; set by the login flow (app) and the #token handoff (session). */
export const AUTH_COOKIE = 'ip_jwt';

export function tokenFromReq(req: Pick<http.IncomingMessage, 'headers'>): string | null {
  const bearer = req.headers.authorization;
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7).trim() || null;
  return parseCookies(req.headers.cookie)[AUTH_COOKIE] ?? null;
}

/** Stable server-to-server credential; see the header comment for why derived. */
export function deriveInternalToken(serviceKey: string): string {
  return createHash('sha256').update(`${serviceKey}:ip-internal-v1`).digest('hex');
}

export interface AuthConfig {
  /** null = auth OFF (local dev). The session process gets this WITHOUT ever
   *  holding the service key — JWKS is public. */
  supabaseUrl: string | null;
  /** Legacy HS256 projects only. */
  jwtSecret?: string;
  adminEmails: string[];
  /** IP_USER_ID ?? 'u1' — the identity of everything created pre-beta. */
  localUserId: string;
  /** Server-to-server credential. The app derives it from the service key;
   *  sessions receive it via IP_INTERNAL_TOKEN. */
  internalToken?: string | null;
}

export interface Auth {
  /** null = unauthenticated (only possible when auth is on). */
  resolve(req: Pick<http.IncomingMessage, 'headers'>): Promise<AuthUser | null>;
  internalToken: string | null;
  enabled: boolean;
}

/** Convenience: the app's AuthConfig from its resolved PublicConfig. */
export function authConfigFromPublic(
  supabase: SupabaseConfig | null,
  adminEmails: string[],
  localUserId: string,
): AuthConfig {
  return {
    supabaseUrl: supabase?.url ?? null,
    ...(supabase?.jwtSecret ? { jwtSecret: supabase.jwtSecret } : {}),
    adminEmails,
    localUserId,
    internalToken: supabase ? deriveInternalToken(supabase.serviceKey) : null,
  };
}

export function makeAuth(
  cfg: AuthConfig,
  fetchJwks?: () => Promise<Jwks>,
  nowMs: () => number = Date.now,
): Auth {
  if (!cfg.supabaseUrl) {
    const local: AuthUser = { id: cfg.localUserId, email: null, admin: true };
    return { resolve: async () => local, internalToken: null, enabled: false };
  }
  const supabaseUrl = cfg.supabaseUrl;

  const internalToken = cfg.internalToken ?? null;
  const getJwks =
    fetchJwks ??
    (async (): Promise<Jwks> => {
      const r = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
      if (!r.ok) throw new Error(`jwks fetch ${r.status}`);
      return (await r.json()) as Jwks;
    });
  let jwksCache: Jwks | null = null;

  const resolve = async (req: Pick<http.IncomingMessage, 'headers'>): Promise<AuthUser | null> => {
    const internal = req.headers['x-ip-internal'];
    if (internalToken && typeof internal === 'string' && internal.length === internalToken.length) {
      const a = Buffer.from(internal);
      const b = Buffer.from(internalToken);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return { id: cfg.localUserId, email: null, admin: true, internal: true };
      }
    }

    const token = tokenFromReq(req);
    if (!token) return null;

    let claims: ReturnType<typeof verifySupabaseJwt> = null;
    if (cfg.jwtSecret) {
      claims = verifySupabaseJwt(token, { hsSecret: cfg.jwtSecret, nowMs: nowMs() });
    }
    if (!claims) {
      try {
        jwksCache ??= await getJwks();
        claims = verifySupabaseJwt(token, { jwks: jwksCache, nowMs: nowMs() });
        if (!claims) {
          // Unknown kid can mean key rotation — refetch once, then give up.
          jwksCache = await getJwks();
          claims = verifySupabaseJwt(token, { jwks: jwksCache, nowMs: nowMs() });
        }
      } catch {
        return null;
      }
    }
    if (!claims) return null;

    const email = claims.email?.toLowerCase() ?? null;
    const admin = email !== null && cfg.adminEmails.includes(email);
    // The FIRST admin email is the founder: their pre-beta data (gap graph,
    // targets, reps with no user_id) is keyed by the local user id.
    const id = email !== null && email === cfg.adminEmails[0] ? cfg.localUserId : claims.sub;
    return { id, email, admin };
  };

  return { resolve, internalToken, enabled: true };
}
