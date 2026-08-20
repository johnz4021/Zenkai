/**
 * WU8's whole point in four assertions: stranger-reachable children can't
 * read what they don't receive. The sandbox case is the security-critical
 * one — generated test code executes on the host via validate.ts.
 */
import { describe, expect, it } from 'vitest';
import { childEnv } from './child-env.js';

const BASE = {
  PATH: '/usr/bin',
  HOME: '/Users/x',
  ANTHROPIC_API_KEY: 'sk-ant',
  ELEVENLABS_API_KEY: 'el-key',
  IP_SUPABASE_SERVICE_KEY: 'svc',
  IP_SUPABASE_ANON_KEY: 'anon',
  IP_SUPABASE_URL: 'https://x.supabase.co',
  IP_USER_ID: 'u1',
};

describe('childEnv', () => {
  it('sandbox: allowlist only — no keys, no IP_* config at all', () => {
    const env = childEnv('sandbox', BASE);
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/x' });
  });

  it('generator: keeps the Anthropic key, drops voice + every supabase secret', () => {
    const env = childEnv('generator', BASE, { IP_USER_ID: 'uuid-me' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    expect(env.IP_SUPABASE_SERVICE_KEY).toBeUndefined();
    expect(env.IP_SUPABASE_ANON_KEY).toBeUndefined();
    expect(env.IP_USER_ID).toBe('uuid-me'); // extra overrides base
  });

  it('session: keeps both API keys (judge + voice); never the service key', () => {
    const env = childEnv('session', BASE, { IP_SESSION_ID: 'sess-1' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(env.ELEVENLABS_API_KEY).toBe('el-key');
    expect(env.IP_SUPABASE_URL).toBe('https://x.supabase.co'); // JWKS auth needs it
    expect(env.IP_SUPABASE_SERVICE_KEY).toBeUndefined();
    expect(env.IP_SESSION_ID).toBe('sess-1');
  });

  it('the service key reaches NO child kind, ever', () => {
    for (const kind of ['sandbox', 'generator', 'session'] as const) {
      expect(childEnv(kind, BASE).IP_SUPABASE_SERVICE_KEY).toBeUndefined();
    }
  });

  it('Stripe credentials reach NO child kind, ever', () => {
    // A generator is an agentic claude -p run reading stranger-authored prose.
    // These lists are DENYLISTS for generator/session, so a new secret leaks
    // by default — this is the assertion that catches the next one.
    const withStripe = { ...BASE, STRIPE_API_KEY: 'rk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
    for (const kind of ['sandbox', 'generator', 'session'] as const) {
      const env = childEnv(kind, withStripe);
      expect(env.STRIPE_API_KEY).toBeUndefined();
      expect(env.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    }
  });

  it('the Gmail app password reaches NO child kind, ever', () => {
    // It does not read mail, it SENDS as the founder — leaked, it is a
    // trusted From: header aimed at every beta user. The welcome sweep runs
    // in cli.ts; no child has any use for this.
    const withMail = { ...BASE, IP_GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' };
    for (const kind of ['sandbox', 'generator', 'session'] as const) {
      expect(childEnv(kind, withMail).IP_GMAIL_APP_PASSWORD).toBeUndefined();
    }
  });

  it('PostHog: sessions keep it (they emit round events); generators and the sandbox never see it', () => {
    // Deliberately GENERATOR_DROP, not ALWAYS_DROP: phc_ is a public key that
    // ships to every browser — it guards nothing. Dropping it from generators
    // is noise reduction (the anon key's reasoning), not secret custody.
    const withPh = { ...BASE, IP_POSTHOG_KEY: 'phc_x', IP_POSTHOG_HOST: 'https://us.i.posthog.com', IP_POSTHOG_REPLAY_ROUND: '1' };
    const session = childEnv('session', withPh);
    expect(session.IP_POSTHOG_KEY).toBe('phc_x');
    expect(session.IP_POSTHOG_HOST).toBe('https://us.i.posthog.com');
    expect(session.IP_POSTHOG_REPLAY_ROUND).toBe('1');
    for (const kind of ['sandbox', 'generator'] as const) {
      const env = childEnv(kind, withPh);
      expect(env.IP_POSTHOG_KEY).toBeUndefined();
      expect(env.IP_POSTHOG_HOST).toBeUndefined();
      expect(env.IP_POSTHOG_REPLAY_ROUND).toBeUndefined();
    }
  });
});
