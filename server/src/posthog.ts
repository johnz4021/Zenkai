/**
 * PostHog capture + page snippet (beta observability).
 *
 *   .env (IP_POSTHOG_*) ──► resolvePublicConfig ──► cfg.pub.posthog
 *                                                        │
 *              ┌─────────────────────────────────────────┤
 *              ▼                                         ▼
 *   makePh(cfg).capture()                    posthogSnippet(cfg, opts)
 *   app.ts / session.ts server events        <script> markup for appPage()
 *   → POST {host}/i/v0/e (fire-and-forget)   and sessionPage() — vendored
 *                                            bundle + guarded init
 *
 * Why it exists: the beta launches with zero visibility — every measurement
 * is JSONL on the box, which answers "what happened" only after an ssh. The
 * JSONL files REMAIN authoritative (db.ts:1 — the record, never the runtime);
 * PostHog is a mirror with dashboards. Nothing ever reads back from it.
 *
 * Two shapes, both deliberate:
 *
 *   makePh mirrors makeDb exactly: null cfg = every method a no-op,
 *   fetchImpl injectable so unit tests touch no network, void-prefixed fetch
 *   that never blocks a handler, no retries, one console.warn per failure
 *   STREAK. One addition — capture() is INCAPABLE of throwing synchronously,
 *   because one call site sits inside app.ts's top-level error boundary: a
 *   throw there would swallow the 500 and hang the request.
 *
 *   posthogSnippet is PURE and returns the exact markup both pages embed.
 *   It exists as a function (not inline template-literal prose) because the
 *   inline init is the one piece of JS the new Function() parse tests do not
 *   cover — building it here lets posthog.test.ts extract and parse it, and
 *   a stray `${` can never interpolate server state into garbage.
 *
 * The vendored bundle is array.full.no-external.js served at a NEUTRAL path
 * (/vendor/insight-<version>.js): EasyPrivacy matches "posthog" and "ph" in
 * URL paths, not just domains, and `no-external` means the bundle never
 * lazy-loads anything from PostHog's CDN — deterministic under ad blockers.
 * The version in the path IS the cache buster, which is why this one asset
 * may be served immutable while everything else is no-store: the no-store
 * rule exists because "no build step means no cache busting" (app.ts:1615),
 * and here the dependency version busts it.
 *
 * Identity rule (owner decision 2026-08-15): the Supabase user id ONLY.
 * No email, no name — call sites must not put either in properties.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface PosthogPublicConfig {
  key: string;
  host: string;
  replayRound: boolean;
}

export interface Ph {
  enabled: boolean;
  /** Fire-and-forget. NEVER throws, NEVER blocks — safe inside a catch. */
  capture(distinctId: string, event: string, properties?: Record<string, unknown>): void;
  /** Awaited variant for a process about to exit (session finalize): a
   *  void'ed fetch would be lost with the event loop. Bounded — the caller
   *  is on the path where a candidate is waiting for their grade, so a hung
   *  endpoint may cost at most `timeoutMs`, never a hang. Never rejects. */
  captureAndWait(
    distinctId: string,
    event: string,
    properties?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<void>;
}

const NOOP: Ph = {
  enabled: false,
  capture: () => {},
  captureAndWait: () => Promise.resolve(),
};

export function makePh(
  cfg: Pick<PosthogPublicConfig, 'key' | 'host'> | null,
  fetchImpl: typeof fetch = fetch,
): Ph {
  if (!cfg) return NOOP;
  const { key, host } = cfg;

  // One log line per failure STREAK, the db.ts discipline: a dead network
  // must not turn the app log into a scroll of identical warnings.
  let failing = false;

  const post = (body: Record<string, unknown>, signal?: AbortSignal): Promise<void> =>
    fetchImpl(`${host}/i/v0/e`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      failing = false;
    });

  const row = (distinctId: string, event: string, properties?: Record<string, unknown>) => ({
    api_key: key,
    event,
    distinct_id: distinctId,
    properties: { ...(properties ?? {}), $lib: 'zenkai-server' },
    timestamp: new Date().toISOString(),
  });

  const warnOnce = (e: unknown): void => {
    if (!failing) {
      failing = true;
      console.warn(`[posthog] capture failing (${String(e).slice(0, 120)}) — analytics only, nothing else affected`);
    }
  };

  return {
    enabled: true,
    capture: (distinctId, event, properties) => {
      // The outer try is the never-throws contract: JSON.stringify can throw
      // on a circular property bag, and one call site lives inside app.ts's
      // top-level catch where a throw swallows the 500.
      try {
        void post(row(distinctId, event, properties)).catch(warnOnce);
      } catch (e) {
        warnOnce(e);
      }
    },
    captureAndWait: async (distinctId, event, properties, timeoutMs = 1500) => {
      try {
        await post(row(distinctId, event, properties), AbortSignal.timeout(timeoutMs));
      } catch (e) {
        warnOnce(e);
      }
    },
  };
}

/**
 * Env → config for SESSION processes, which cannot call resolvePublicConfig:
 * a spawned session deliberately receives a partial Supabase config (no
 * service key — WU8), and the all-or-nothing rule there would throw. Lenient
 * on purpose where public-config is strict: a session must never refuse to
 * run over analytics config, so a malformed key here is null, not an error —
 * the APP already validated loudly at boot.
 */
export function posthogConfigFromEnv(
  env: Record<string, string | undefined>,
): PosthogPublicConfig | null {
  const key = env.IP_POSTHOG_KEY?.trim();
  if (!key || !key.startsWith('phc_')) return null;
  const host = env.IP_POSTHOG_HOST?.trim();
  return {
    key,
    host: (host && /^https?:\/\//.test(host) ? host : 'https://us.i.posthog.com').replace(/\/+$/, ''),
    replayRound: env.IP_POSTHOG_REPLAY_ROUND === '1',
  };
}

// ---- the vendored browser bundle ----------------------------------------

/** dist file served to browsers. `no-external`: never lazy-loads from
 *  PostHog's CDN, so the vendored asset is genuinely self-contained. */
const DIST_FILE = ['posthog-js', 'dist', 'array.full.no-external.js'];

/** Version of the installed posthog-js — the URL's cache buster. '0' when
 *  unreadable, which still yields a working (merely uncacheable-in-practice)
 *  path rather than a broken page. */
export function posthogAssetVersion(repoRoot: string): string {
  for (const base of [repoRoot, path.join(repoRoot, 'server')]) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(base, 'node_modules', 'posthog-js', 'package.json'), 'utf8'),
      ) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try the next root */
    }
  }
  return '0';
}

/** Absolute path of the bundle on disk, or null when not installed. Checked
 *  at both workspace roots — npm hoists, but nothing guarantees it forever. */
export function posthogAssetFile(repoRoot: string): string | null {
  for (const base of [repoRoot, path.join(repoRoot, 'server')]) {
    const p = path.join(base, 'node_modules', ...DIST_FILE);
    try {
      readFileSync(p, { encoding: 'utf8', flag: 'r' });
      return p;
    } catch {
      /* try the next root */
    }
  }
  return null;
}

/** The neutral, version-stamped URL. "insight", not "posthog" or "ph" — both
 *  of those appear in ad-blocker path rules, and a blocked vendored script is
 *  indistinguishable from a broken one. */
export function posthogAssetPath(version: string): string {
  return `/vendor/insight-${version.replace(/[^\w.]/g, '')}.js`;
}

export function isPosthogAssetUrl(url: string): boolean {
  return /^\/vendor\/insight-[\w.]+\.js$/.test(url.split('?')[0] ?? '');
}

// ---- the inline init snippet ---------------------------------------------

export interface SnippetOpts {
  /** URL of the vendored bundle (posthogAssetPath). */
  assetPath: string;
  /** rrweb blockSelector — regions replay must not record at all. */
  blockSelector?: string;
  /** rrweb maskTextSelector — text rendered as *** in the replay. */
  maskTextSelector?: string;
  /** Server-known identity (session page — the app page identifies client-
   *  side from /api/state). Shape-checked; an odd id is skipped, not quoted. */
  distinctId?: string;
}

/** JSON string literal, refused if it could escape a <script> block. The
 *  inputs are config, not user data — a '<' in any of them is a config error
 *  and the safe output is omission. */
function jsStr(s: string): string | null {
  return s.includes('<') ? null : JSON.stringify(s);
}

/**
 * The exact `<script>` markup a page embeds. '' when cfg is null — an unset
 * box renders byte-identical pages.
 *
 * Written defensively on purpose, in order of the ways it can go wrong:
 *   - the bundle 404s or an ad blocker eats it → window.posthog undefined →
 *     the guard skips init and NOTHING breaks (the ad-blocker drill in
 *     app.test.ts depends on this shape);
 *   - the init itself throws → swallowed; analytics lost, page untouched;
 *   - `defer` + DOMContentLoaded: the bundle never blocks first paint, and
 *     deferred scripts are guaranteed to run before DOMContentLoaded fires,
 *     so init reliably runs after the bundle without polling.
 * capture_performance:false — posthog's network capture monkey-patches
 * window.fetch, which on the session page would wrap the workbench, voice
 * polling and every /api/* call. The trace records all of that better.
 */
export function posthogSnippet(
  cfg: Pick<PosthogPublicConfig, 'key' | 'host'> | null,
  opts: SnippetOpts,
): string {
  if (!cfg) return '';
  const key = jsStr(cfg.key);
  const host = jsStr(cfg.host);
  const asset = jsStr(opts.assetPath) === null ? null : opts.assetPath;
  if (!key || !host || !asset) return '';
  const recording: string[] = ['maskAllInputs: true'];
  if (opts.blockSelector) {
    const b = jsStr(opts.blockSelector);
    if (b) recording.push(`blockSelector: ${b}`);
  }
  if (opts.maskTextSelector) {
    const m = jsStr(opts.maskTextSelector);
    if (m) recording.push(`maskTextSelector: ${m}`);
  }
  const identify =
    opts.distinctId && /^[\w-]{1,64}$/.test(opts.distinctId)
      ? `\n      window.posthog.identify(${JSON.stringify(opts.distinctId)});`
      : '';
  return (
    `<script src="${asset}" defer></script>\n` +
    '<script>\n' +
    '  // Analytics init. Guarded end to end: if the vendored bundle was\n' +
    '  // blocked or 404s, window.posthog does not exist and this does\n' +
    '  // nothing — analytics must never break the page (posthog.ts).\n' +
    "  document.addEventListener('DOMContentLoaded', function () {\n" +
    '    try {\n' +
    '      if (!window.posthog || !window.posthog.init) return;\n' +
    `      window.posthog.init(${key}, {\n` +
    `        api_host: ${host},\n` +
    '        capture_exceptions: true,\n' +
    '        capture_performance: false,\n' +
    `        session_recording: { ${recording.join(', ')} }\n` +
    `      });${identify}\n` +
    '    } catch (e) { /* analytics never break the page */ }\n' +
    '  });\n' +
    '</script>'
  );
}
