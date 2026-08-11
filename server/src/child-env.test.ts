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
});
