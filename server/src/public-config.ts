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
  };
  retention: {
    /** null = reaper off. */
    days: number | null;
    reapNodeModules: boolean;
  };
}

const strip = (u: string): string => u.replace(/\/+$/, '');

function intOr(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function resolvePublicConfig(env: Record<string, string | undefined>): PublicConfig {
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
    supabase: url && anonKey && serviceKey ? { url: strip(url), anonKey, serviceKey } : null,
    adminEmails: (env.IP_AUTH_ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    caps: {
      maxConcurrentBuilds: intOr(env.IP_MAX_CONCURRENT_BUILDS, Infinity),
      maxRepsPerUserDay: intOr(env.IP_MAX_REPS_PER_USER_DAY, Infinity),
      maxPendingPerUser: intOr(env.IP_MAX_PENDING_REPS_PER_USER, Infinity),
    },
    retention: {
      days: env.IP_RETENTION_DAYS ? intOr(env.IP_RETENTION_DAYS, 0) || null : null,
      reapNodeModules: env.IP_REAP_NODE_MODULES === '1',
    },
  };
}
