/**
 * Auth verification against REAL signatures: an in-test ES256 keypair and an
 * HS256 secret sign genuine JWTs; nothing is mocked below the crypto layer.
 * Pure — no network (JWKS injected), no model calls, frozen clock.
 */
import { createHmac, createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveInternalToken, makeAuth, parseCookies, tokenFromReq, verifySupabaseJwt, type Jwks } from './auth.js';

const T0 = 1_700_000_000_000; // frozen clock (repo convention)

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
const JWKS: Jwks = { keys: [{ ...jwk, kid: 'k1', kty: 'EC' } as never] };

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

function signES256(payload: Record<string, unknown>, kid = 'k1'): string {
  const body = `${b64({ alg: 'ES256', typ: 'JWT', kid })}.${b64(payload)}`;
  const sig = cryptoSign('sha256', Buffer.from(body), {
    key: createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }) as string),
    dsaEncoding: 'ieee-p1363',
  });
  return `${body}.${sig.toString('base64url')}`;
}

function signHS256(payload: Record<string, unknown>, secret: string): string {
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

const CLAIMS = {
  sub: 'uuid-123',
  email: 'Taker@Example.com',
  aud: 'authenticated',
  exp: Math.floor(T0 / 1000) + 3600,
};

describe('verifySupabaseJwt', () => {
  it('accepts a valid ES256 token via JWKS', () => {
    const out = verifySupabaseJwt(signES256(CLAIMS), { jwks: JWKS, nowMs: T0 });
    expect(out).toEqual({ sub: 'uuid-123', email: 'Taker@Example.com' });
  });
  it('accepts a valid HS256 token via secret', () => {
    const out = verifySupabaseJwt(signHS256(CLAIMS, 's3cret'), { hsSecret: 's3cret', nowMs: T0 });
    expect(out?.sub).toBe('uuid-123');
  });
  it('rejects expired, wrong-aud, unknown-kid, tampered, and garbage tokens', () => {
    expect(
      verifySupabaseJwt(signES256({ ...CLAIMS, exp: Math.floor(T0 / 1000) - 1 }), { jwks: JWKS, nowMs: T0 }),
    ).toBeNull();
    expect(
      verifySupabaseJwt(signES256({ ...CLAIMS, aud: 'other' }), { jwks: JWKS, nowMs: T0 }),
    ).toBeNull();
    // unknown kid with MULTIPLE keys present: no fallback guessing
    const twoKeys: Jwks = { keys: [...JWKS.keys, { ...JWKS.keys[0]!, kid: 'k2' }] };
    expect(
      verifySupabaseJwt(signES256(CLAIMS, 'nope'), { jwks: twoKeys, nowMs: T0 }),
    ).toBeNull();
    const good = signES256(CLAIMS);
    const tampered = good.slice(0, -6) + 'AAAAAA';
    expect(verifySupabaseJwt(tampered, { jwks: JWKS, nowMs: T0 })).toBeNull();
    expect(verifySupabaseJwt('garbage', { jwks: JWKS, nowMs: T0 })).toBeNull();
    expect(verifySupabaseJwt('', { jwks: JWKS, nowMs: T0 })).toBeNull();
  });
  it('rejects an HS256 token when only JWKS is configured (no alg confusion)', () => {
    expect(verifySupabaseJwt(signHS256(CLAIMS, 'x'), { jwks: JWKS, nowMs: T0 })).toBeNull();
  });
});

describe('cookie/bearer extraction', () => {
  it('parses cookies and prefers the Authorization header', () => {
    expect(parseCookies('a=1; ip_jwt=tok; b=2')).toEqual({ a: '1', ip_jwt: 'tok', b: '2' });
    expect(tokenFromReq({ headers: { cookie: 'ip_jwt=cookie-tok' } })).toBe('cookie-tok');
    expect(
      tokenFromReq({ headers: { cookie: 'ip_jwt=c', authorization: 'Bearer h' } }),
    ).toBe('h');
    expect(tokenFromReq({ headers: {} })).toBeNull();
  });
});

describe('makeAuth', () => {
  const cfg = {
    supabaseUrl: 'https://x.supabase.co',
    adminEmails: ['founder@x.com', 'helper@x.com'],
    localUserId: 'u1',
    internalToken: deriveInternalToken('svc'),
  };
  const auth = makeAuth(cfg, async () => JWKS, () => T0);

  it('auth off resolves every request to the local admin', async () => {
    const off = makeAuth({ supabaseUrl: null, adminEmails: [], localUserId: 'u1' });
    expect(await off.resolve({ headers: {} })).toEqual({ id: 'u1', email: null, admin: true });
    expect(off.enabled).toBe(false);
    expect(off.internalToken).toBeNull();
  });

  it('maps the FIRST admin email to the local user id; other admins keep their sub', async () => {
    const founder = signES256({ ...CLAIMS, email: 'Founder@X.com' });
    const u = await auth.resolve({ headers: { authorization: `Bearer ${founder}` } });
    expect(u).toEqual({ id: 'u1', email: 'founder@x.com', admin: true });
    const helper = signES256({ ...CLAIMS, sub: 'uuid-h', email: 'helper@x.com' });
    const h = await auth.resolve({ headers: { authorization: `Bearer ${helper}` } });
    expect(h).toEqual({ id: 'uuid-h', email: 'helper@x.com', admin: true });
  });

  it('a stranger gets their sub as id and no admin', async () => {
    const t = signES256(CLAIMS);
    const u = await auth.resolve({ headers: { cookie: `ip_jwt=${t}` } });
    expect(u).toEqual({ id: 'uuid-123', email: 'taker@example.com', admin: false });
  });

  it('no token, bad token → null', async () => {
    expect(await auth.resolve({ headers: {} })).toBeNull();
    expect(await auth.resolve({ headers: { cookie: 'ip_jwt=garbage' } })).toBeNull();
  });

  it('internal token authenticates server-to-server as internal admin', async () => {
    const tok = deriveInternalToken('svc');
    expect(auth.internalToken).toBe(tok);
    const u = await auth.resolve({ headers: { 'x-ip-internal': tok } });
    expect(u).toEqual({ id: 'u1', email: null, admin: true, internal: true });
    expect(await auth.resolve({ headers: { 'x-ip-internal': 'wrong'.padEnd(64, 'x') } })).toBeNull();
  });

  it('refetches JWKS once on unknown kid (rotation), then gives up', async () => {
    let calls = 0;
    const rotating = makeAuth(cfg, async () => {
      calls += 1;
      return calls === 1 ? { keys: [] } : JWKS;
    }, () => T0);
    const t = signES256(CLAIMS);
    const u = await rotating.resolve({ headers: { authorization: `Bearer ${t}` } });
    expect(u?.id).toBe('uuid-123');
    expect(calls).toBe(2);
  });
});
