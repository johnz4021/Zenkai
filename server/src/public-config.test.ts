/**
 * Pins the WU1 contract: an empty env resolves to exactly the literals that
 * were previously hardcoded inline (app.ts session_url ×3, IP_APP_URL ×2),
 * so a dev machine with no .env changes behaves byte-identically to pre-beta.
 */
import { describe, expect, it } from 'vitest';
import { resolvePublicConfig } from './public-config.js';

describe('resolvePublicConfig', () => {
  it('empty env reproduces the pre-beta literals exactly', () => {
    const c = resolvePublicConfig({});
    expect(c.appPublicUrl).toBe('http://localhost:3300');
    expect(c.sessionPublicUrl).toBe('http://localhost:3200');
    expect(c.appBindHost).toBeUndefined();
    expect(c.supabase).toBeNull();
    expect(c.adminEmails).toEqual([]);
    expect(c.caps.maxConcurrentBuilds).toBe(Infinity);
    expect(c.caps.maxRepsPerUserDay).toBe(Infinity);
    expect(c.caps.maxPendingPerUser).toBe(Infinity);
    expect(c.retention.days).toBeNull();
    expect(c.retention.reapNodeModules).toBe(false);
    // The regression that protects the dev machine: merging the WTP probe
    // must leave a box with no .env entry for it byte-identical.
    expect(c.paywall.enabled).toBe(false);
  });

  it('the paywall gate is opt-in — price and limits alone do not arm it', () => {
    const off = resolvePublicConfig({ IP_PAYWALL_PRICE_USD: '19', IP_PAYWALL_FREE_ROUNDS: '0' });
    expect(off.paywall.enabled).toBe(false);

    const on = resolvePublicConfig({ IP_PAYWALL_GATE: '1' });
    expect(on.paywall).toEqual({ enabled: true, priceUsd: 39, freeRounds: 3, freePlans: 3 });

    const tuned = resolvePublicConfig({
      IP_PAYWALL_GATE: '1',
      IP_PAYWALL_PRICE_USD: '19',
      IP_PAYWALL_FREE_ROUNDS: '5',
      IP_PAYWALL_FREE_PLANS: '2',
    });
    expect(tuned.paywall).toEqual({ enabled: true, priceUsd: 19, freeRounds: 5, freePlans: 2 });
  });

  it('a free allowance of ZERO is honored — intOr would have eaten it', () => {
    // The whole point of zeroOr. IP_PAYWALL_FREE_ROUNDS=0 means "gate the very
    // first round", which is a real config AND the only way to exercise the
    // flow locally. Under intOr this silently resolved to the default of 3 and
    // every verification step would have run against the wrong limit.
    const c = resolvePublicConfig({ IP_PAYWALL_GATE: '1', IP_PAYWALL_FREE_ROUNDS: '0', IP_PAYWALL_FREE_PLANS: '0' });
    expect(c.paywall.freeRounds).toBe(0);
    expect(c.paywall.freePlans).toBe(0);

    // Garbage and empty still take the fallback — only a real number counts.
    expect(resolvePublicConfig({ IP_PAYWALL_GATE: '1', IP_PAYWALL_FREE_ROUNDS: 'junk' }).paywall.freeRounds).toBe(3);
    expect(resolvePublicConfig({ IP_PAYWALL_GATE: '1', IP_PAYWALL_FREE_ROUNDS: '' }).paywall.freeRounds).toBe(3);
    expect(resolvePublicConfig({ IP_PAYWALL_GATE: '1', IP_PAYWALL_FREE_ROUNDS: '-2' }).paywall.freeRounds).toBe(3);

    // And the caps still use intOr — a cap of 0 would deadlock the product.
    expect(resolvePublicConfig({ IP_MAX_CONCURRENT_BUILDS: '0' }).caps.maxConcurrentBuilds).toBe(Infinity);
  });

  it('beta env resolves the public origins, trimming trailing slashes', () => {
    const c = resolvePublicConfig({
      IP_PUBLIC_APP_URL: 'https://zenkai.run/',
      IP_PUBLIC_SESSION_URL: 'https://session.zenkai.run',
      IP_APP_BIND: '127.0.0.1',
    });
    expect(c.appPublicUrl).toBe('https://zenkai.run');
    expect(c.sessionPublicUrl).toBe('https://session.zenkai.run');
    expect(c.appBindHost).toBe('127.0.0.1');
  });

  it('supabase config is all-or-nothing', () => {
    expect(() => resolvePublicConfig({ IP_SUPABASE_URL: 'https://x.supabase.co' })).toThrow(
      /must be set together/,
    );
    const c = resolvePublicConfig({
      IP_SUPABASE_URL: 'https://x.supabase.co/',
      IP_SUPABASE_ANON_KEY: 'anon',
      IP_SUPABASE_SERVICE_KEY: 'service',
    });
    expect(c.supabase).toEqual({ url: 'https://x.supabase.co', anonKey: 'anon', serviceKey: 'service' });
  });

  it('admin emails are lowercased and trimmed; caps parse with sane fallbacks', () => {
    const c = resolvePublicConfig({
      IP_AUTH_ADMIN_EMAILS: ' Zhang4021@Gmail.com , ,x@y.z',
      IP_MAX_CONCURRENT_BUILDS: '1',
      IP_MAX_REPS_PER_USER_DAY: 'garbage',
      IP_RETENTION_DAYS: '14',
      IP_REAP_NODE_MODULES: '1',
    });
    expect(c.adminEmails).toEqual(['zhang4021@gmail.com', 'x@y.z']);
    expect(c.caps.maxConcurrentBuilds).toBe(1);
    expect(c.caps.maxRepsPerUserDay).toBe(Infinity); // garbage → unlimited, never 0
    expect(c.retention.days).toBe(14);
    expect(c.retention.reapNodeModules).toBe(true);
  });
});

describe('multi-session config (WU-D)', () => {
  it('defaults: multi OFF, sane caps', () => {
    const c = resolvePublicConfig({});
    expect(c.multiSession).toBe(false);
    expect(c.sessions).toEqual({ maxConcurrentSessions: 2, maxSessionsPerUser: 1 });
  });
  it('beta env enables and caps', () => {
    const c = resolvePublicConfig({ IP_MULTI_SESSION: '1', IP_MAX_CONCURRENT_SESSIONS: '3' });
    expect(c.multiSession).toBe(true);
    expect(c.sessions.maxConcurrentSessions).toBe(3);
  });
});
