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
    expect(on.paywall).toEqual({
      enabled: true,
      priceUsd: 39,
      freeRounds: 3,
      freePlans: 3,
      paidRounds: 4,
    });
    // Billing is a separate switch: arming the gate sells nothing by itself.
    expect(on.stripe).toBeNull();

    const tuned = resolvePublicConfig({
      IP_PAYWALL_GATE: '1',
      IP_PAYWALL_PRICE_USD: '19',
      IP_PAYWALL_FREE_ROUNDS: '5',
      IP_PAYWALL_FREE_PLANS: '2',
    });
    expect(tuned.paywall).toEqual({
      enabled: true,
      priceUsd: 19,
      freeRounds: 5,
      freePlans: 2,
      paidRounds: 4,
    });
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

  describe('stripe config', () => {
    const good = {
      STRIPE_API_KEY: 'rk_test_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc',
      STRIPE_PRICE_ID: 'price_1abc',
    };

    it('is all-or-nothing, and absent means billing is simply off', () => {
      expect(resolvePublicConfig({}).stripe).toBeNull();
      expect(() => resolvePublicConfig({ STRIPE_API_KEY: 'rk_test_abc' })).toThrow(
        /must be set together/,
      );
      expect(resolvePublicConfig(good).stripe).toEqual({
        apiKey: 'rk_test_abc',
        webhookSecret: 'whsec_abc',
        priceId: 'price_1abc',
      });
      expect(resolvePublicConfig({ ...good, STRIPE_API_KEY: 'sk_live_abc' }).stripe?.apiKey).toBe(
        'sk_live_abc',
      );
    });

    it('REFUSES the publishable key — presence alone let a dead Subscribe button ship', () => {
      // The one that actually happened (2026-08-14): pk_ passed the
      // all-or-nothing check, billing read as configured, and every server
      // call came back 403 secret_key_required. The buyer found out, not the
      // operator. The Dashboard lists the publishable key first and labels it
      // an API key, so this is a paste away at every key rotation.
      expect(() => resolvePublicConfig({ ...good, STRIPE_API_KEY: 'pk_test_abc' })).toThrow(
        /PUBLISHABLE key/,
      );
      expect(() => resolvePublicConfig({ ...good, STRIPE_API_KEY: 'pk_live_abc' })).toThrow(
        /403 secret_key_required/,
      );
    });

    it('REFUSES a Product id where a Price belongs — Checkout charges a Price', () => {
      expect(() => resolvePublicConfig({ ...good, STRIPE_PRICE_ID: 'prod_Uhhj0Z' })).toThrow(
        /Product id, not a Price/,
      );
    });

    it('REFUSES a webhook secret that is not one', () => {
      // An API key pasted into the webhook slot verifies NOTHING, and the
      // failure surfaces as "every event is forged" long after go-live.
      expect(() => resolvePublicConfig({ ...good, STRIPE_WEBHOOK_SECRET: 'sk_test_abc' })).toThrow(
        /starts with whsec_/,
      );
    });

    it('quotes back only the type prefix — the rest of a key never reaches a log', () => {
      const secret = 'pk_test_51SuperSecretRemainderThatMustNotLeak';
      try {
        resolvePublicConfig({ ...good, STRIPE_API_KEY: secret });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(String(e)).toContain('pk_test_');
        expect(String(e)).not.toContain('SuperSecretRemainder');
      }
    });
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

describe('posthog config', () => {
  it('unset means OFF, byte-identical — no key, no analytics, nothing rendered', () => {
    expect(resolvePublicConfig({}).posthog).toBeNull();
    // Replay flag alone arms nothing — it modifies a config that must exist.
    expect(resolvePublicConfig({ IP_POSTHOG_REPLAY_ROUND: '1' }).posthog).toBeNull();
  });

  it('the key alone is enough; the host defaults and trims its slash', () => {
    const c = resolvePublicConfig({ IP_POSTHOG_KEY: 'phc_abc123' });
    expect(c.posthog).toEqual({
      key: 'phc_abc123',
      host: 'https://us.i.posthog.com',
      replayRound: false,
    });
    const eu = resolvePublicConfig({
      IP_POSTHOG_KEY: 'phc_abc123',
      IP_POSTHOG_HOST: 'https://eu.i.posthog.com/',
    });
    expect(eu.posthog?.host).toBe('https://eu.i.posthog.com');
  });

  it('a host with no key is half a config and refuses to boot', () => {
    expect(() => resolvePublicConfig({ IP_POSTHOG_HOST: 'https://us.i.posthog.com' })).toThrow(
      /set both or neither/,
    );
  });

  it('REFUSES a personal API key — phx_ is a SECRET and this key ships to every browser', () => {
    // The pk_-in-STRIPE_API_KEY lesson (2026-08-14) applied forward: presence
    // checks pass on the wrong key type; only the prefix tells them apart.
    expect(() => resolvePublicConfig({ IP_POSTHOG_KEY: 'phx_abc123' })).toThrow(/personal API key/);
    expect(() => resolvePublicConfig({ IP_POSTHOG_KEY: 'garbage' })).toThrow(/IP_POSTHOG_KEY/);
  });

  it('the round-replay flag rides the block and is off unless explicitly 1', () => {
    expect(
      resolvePublicConfig({ IP_POSTHOG_KEY: 'phc_a', IP_POSTHOG_REPLAY_ROUND: '1' }).posthog
        ?.replayRound,
    ).toBe(true);
    expect(
      resolvePublicConfig({ IP_POSTHOG_KEY: 'phc_a', IP_POSTHOG_REPLAY_ROUND: 'yes' }).posthog
        ?.replayRound,
    ).toBe(false);
  });
});
