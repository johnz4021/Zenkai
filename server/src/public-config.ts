/**
 * Beta config surface (beta branch — zenkai.run scoped beta).
 *
 *   .env / shell ──► resolvePublicConfig(env) ──► PublicConfig
 *                        │
 *                        ├─► app.ts     browser-facing URLs, bind host, caps
 *                        ├─► session.ts (via cli.ts) public session URL
 *                        └─► auth.ts    supabase project, admin emails
 *
 * Why this exists: exposing the product at zenkai.run requires the five
 * browser-facing URLs that were hardcoded to localhost (app.ts session_url ×3,
 * IP_APP_URL ×2) to be configurable, plus auth/caps/retention knobs — while a
 * bare `cli.ts app` on a dev machine stays byte-identical to pre-beta
 * behavior. Every default below reproduces the literal that was previously
 * inline; public-config.test.ts pins that equivalence.
 *
 * Pure: reads nothing but its argument. cli.ts calls it once after .env load.
 */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  /** Server-side only. Never reaches the client or any spawned child. */
  serviceKey: string;
  /** Legacy HS256 projects only; new projects verify via JWKS. */
  jwtSecret?: string;
}

export interface PublicConfig {
  /** Browser-facing app origin. Default: http://localhost:3300 */
  appPublicUrl: string;
  /** Browser-facing session origin. Default: http://localhost:3200 */
  sessionPublicUrl: string;
  /** Bind host for the APP server only. The session server must stay on all
   *  interfaces — the container's trace WS dials host.docker.internal, which
   *  resolves to the docker gateway IP, never loopback. */
  appBindHost?: string;
  /** null = auth OFF = local dev: every request is IP_USER_ID/'u1', admin. */
  supabase: SupabaseConfig | null;
  adminEmails: string[];
  caps: {
    /** Builds generating at once, across reps AND queue paths. */
    maxConcurrentBuilds: number;
    maxRepsPerUserDay: number;
    maxPendingPerUser: number;
    /**
     * Global builds per day, across ALL users. The per-user caps above only
     * bound a gated identity; signup is open by decision (2026-08-12), so a
     * fresh email resets them for free. This is the only cap that bounds the
     * model bill. Unset = Infinity = today's behavior.
     */
    maxBuildsPerDay: number;
  };
  /** Multi-session (TODOS #22). false = legacy single-session, byte-identical. */
  multiSession: boolean;
  sessions: {
    /** Live rooms at once; RAM-bound (~1GB per room on the beta box). */
    maxConcurrentSessions: number;
    /** Per person. Admins bypass (the founder tests concurrency alone). */
    maxSessionsPerUser: number;
  };
  retention: {
    /** null = reaper off. */
    days: number | null;
    reapNodeModules: boolean;
  };
  /**
   * Willingness-to-pay gate (paywall.ts). THIS ONE REALLY DENIES: a user past
   * the free limits who declines does not get that round. Unset = OFF = local
   * dev, byte-identical.
   *
   * This flag is the ONLY thing protecting a dev box: a local .env that
   * configures Supabase while leaving IP_AUTH_ADMIN_EMAILS at the
   * you@example.com placeholder makes the founder a non-admin on their own
   * machine, so the admin bypass in gateVerdict does not fire there. Arming
   * this locally really will gate you.
   *
   * It is also the kill switch: unset it and `systemctl restart zenkai-app`
   * (~10s, and KillMode=process means live rounds survive the restart).
   */
  paywall: {
    /** IP_PAYWALL_GATE=1 */
    enabled: boolean;
    /** Integer dollars, never a display string — see GateView.price_usd. */
    priceUsd: number;
    /** Free session launches before the gate. 0 is meaningful (gate the
     *  first round) — see the zeroOr note in resolvePublicConfig. */
    freeRounds: number;
    /** Free targets before the gate. A guardrail, not the experiment. */
    freePlans: number;
    /** Rounds a SUBSCRIBER gets per billing period. Resets on the Stripe
     *  period boundary (billing.ts periodStart), so last month's rounds never
     *  eat this month's. Unlimited would be a liability: at ~$2 a round a
     *  heavy user costs more than they pay. */
    paidRounds: number;
  };
  /**
   * Stripe subscription billing (billing.ts). null = OFF — the gate still
   * works and the manual grant path still comps, there is just nothing to buy.
   *
   * All-or-nothing like `supabase` above: half a billing config is a
   * misconfiguration, and a box that renders a Subscribe button it cannot
   * honour is worse than one with no button at all.
   *
   * NOTE these are SECRETS. child-env.ts must drop STRIPE_API_KEY and
   * STRIPE_WEBHOOK_SECRET for every child kind — its generator/session paths
   * are denylists, so a new key reaches every agentic `claude -p` run unless
   * it is named there explicitly.
   */
  stripe: {
    /** Restricted key (rk_) preferred over a secret key (sk_): least
     *  privilege, so a leak can do far less. */
    apiKey: string;
    webhookSecret: string;
    /** The Price to subscribe to. One Product per plan; Prices are for
     *  variants of the same plan (monthly vs annual). */
    priceId: string;
  } | null;
}

const strip = (u: string): string => u.replace(/\/+$/, '');

function intOr(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** intOr's sibling for knobs where ZERO is a meaningful setting rather than
 *  garbage. Every cap in this file wants intOr (a cap of 0 would deadlock the
 *  product); the paywall's free allowances want this one, because 0 means
 *  "gate immediately" and is how the flow gets exercised at all. An empty or
 *  absent value still takes the fallback — only an explicit number is honored. */
function zeroOr(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Stripe ids and keys have stable, documented prefixes, and checking them is
 * the whole difference between a boot that refuses and a BUYER who presses
 * Subscribe and gets a 502.
 *
 * Presence is not enough, because both easy mistakes produce three non-empty
 * values. The Dashboard lists the publishable key first and calls it an API
 * key; a Product id sits right beside the Price id on the same page. Verified
 * 2026-08-14 against the live API: a `pk_` key returns
 * `403 secret_key_required` on EVERY server call, so billing read as
 * "configured" while being structurally incapable of a single charge — the
 * exact state the all-or-nothing rule above exists to prevent, walked into
 * through a different door.
 *
 * Only the type prefix is ever quoted back; the rest of the value is a secret
 * and stays out of the message and the logs.
 */
function expectPrefix(name: string, value: string, allowed: readonly string[], hint: string): void {
  if (allowed.some((p) => value.startsWith(p))) return;
  throw new Error(`${name} starts with "${value.slice(0, 8)}" — ${hint}`);
}

export function resolvePublicConfig(env: Record<string, string | undefined>): PublicConfig {
  // Billing is all-or-nothing, same rule and same reasoning as Supabase below:
  // a Subscribe button on a box that cannot complete a purchase is worse than
  // no button. Unset = billing off = today's behaviour exactly.
  const sKey = env.STRIPE_API_KEY?.trim();
  const sHook = env.STRIPE_WEBHOOK_SECRET?.trim();
  const sPrice = env.STRIPE_PRICE_ID?.trim();
  if ((sKey || sHook || sPrice) && !(sKey && sHook && sPrice)) {
    throw new Error(
      'STRIPE_API_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID must be set together (or none)',
    );
  }
  if (sKey && sHook && sPrice) {
    expectPrefix(
      'STRIPE_API_KEY',
      sKey,
      ['sk_', 'rk_'],
      'that is the PUBLISHABLE key, which the server cannot use — every call ' +
        'returns 403 secret_key_required. Use the secret key (sk_) or, better, ' +
        'a restricted key (rk_) with write on Checkout Sessions, Customers and ' +
        'Billing Portal Sessions and read on Subscriptions and Prices.',
    );
    expectPrefix(
      'STRIPE_WEBHOOK_SECRET',
      sHook,
      ['whsec_'],
      'a webhook signing secret starts with whsec_ — take it from `stripe listen` or the endpoint page in the Dashboard.',
    );
    expectPrefix(
      'STRIPE_PRICE_ID',
      sPrice,
      ['price_'],
      'that looks like a Product id, not a Price. A Product is WHAT you sell; ' +
        'a Price is how much and how often. Checkout charges a Price.',
    );
  }
  const stripeCfg =
    sKey && sHook && sPrice ? { apiKey: sKey, webhookSecret: sHook, priceId: sPrice } : null;
  const url = env.IP_SUPABASE_URL?.trim();
  const anonKey = env.IP_SUPABASE_ANON_KEY?.trim();
  const serviceKey = env.IP_SUPABASE_SERVICE_KEY?.trim();
  // Auth is all-or-nothing: a partial Supabase config is a misconfiguration,
  // and silently running half-authed would be worse than refusing.
  if ((url || anonKey || serviceKey) && !(url && anonKey && serviceKey)) {
    throw new Error(
      'IP_SUPABASE_URL, IP_SUPABASE_ANON_KEY and IP_SUPABASE_SERVICE_KEY must be set together (or none)',
    );
  }
  return {
    appPublicUrl: strip(env.IP_PUBLIC_APP_URL?.trim() || 'http://localhost:3300'),
    sessionPublicUrl: strip(env.IP_PUBLIC_SESSION_URL?.trim() || 'http://localhost:3200'),
    ...(env.IP_APP_BIND?.trim() ? { appBindHost: env.IP_APP_BIND.trim() } : {}),
    supabase:
      url && anonKey && serviceKey
        ? {
            url: strip(url),
            anonKey,
            serviceKey,
            ...(env.IP_SUPABASE_JWT_SECRET?.trim()
              ? { jwtSecret: env.IP_SUPABASE_JWT_SECRET.trim() }
              : {}),
          }
        : null,
    adminEmails: (env.IP_AUTH_ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    caps: {
      maxConcurrentBuilds: intOr(env.IP_MAX_CONCURRENT_BUILDS, Infinity),
      maxRepsPerUserDay: intOr(env.IP_MAX_REPS_PER_USER_DAY, Infinity),
      maxPendingPerUser: intOr(env.IP_MAX_PENDING_REPS_PER_USER, Infinity),
      maxBuildsPerDay: intOr(env.IP_MAX_BUILDS_PER_DAY, Infinity),
    },
    retention: {
      days: env.IP_RETENTION_DAYS ? intOr(env.IP_RETENTION_DAYS, 0) || null : null,
      reapNodeModules: env.IP_REAP_NODE_MODULES === '1',
    },
    multiSession: env.IP_MULTI_SESSION === '1',
    sessions: {
      maxConcurrentSessions: intOr(env.IP_MAX_CONCURRENT_SESSIONS, 2),
      maxSessionsPerUser: intOr(env.IP_MAX_SESSIONS_PER_USER, 1),
    },
    paywall: {
      enabled: env.IP_PAYWALL_GATE === '1',
      priceUsd: intOr(env.IP_PAYWALL_PRICE_USD, 39),
      // zeroOr, NOT intOr: intOr treats 0 as garbage and returns the fallback,
      // and here 0 is a legitimate value — "gate the very first round" is both
      // a real config and the only practical way to exercise the flow locally.
      // Using intOr would make IP_PAYWALL_FREE_ROUNDS=0 silently mean 3.
      freeRounds: zeroOr(env.IP_PAYWALL_FREE_ROUNDS, 3),
      freePlans: zeroOr(env.IP_PAYWALL_FREE_PLANS, 3),
      paidRounds: zeroOr(env.IP_PAYWALL_PAID_ROUNDS, 4),
    },
    stripe: stripeCfg,
  };
}
