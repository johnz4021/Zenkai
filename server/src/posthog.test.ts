/**
 * The two contracts that make analytics safe to have at all: capture can
 * NEVER throw or block (one call site is inside app.ts's top-level catch —
 * a throw there swallows the 500), and the snippet is parseable, guarded JS
 * (it is the one script the new Function() tests don't reach organically,
 * and it renders on every page).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isPosthogAssetUrl,
  makePh,
  posthogAssetPath,
  posthogSnippet,
} from './posthog.js';

const CFG = { key: 'phc_test123', host: 'https://us.i.posthog.com' };

describe('makePh — the db.ts discipline', () => {
  it('null cfg is a total no-op: no fetch, no throw', async () => {
    const fetchSpy = vi.fn();
    const ph = makePh(null, fetchSpy as unknown as typeof fetch);
    expect(ph.enabled).toBe(false);
    ph.capture('u1', 'anything');
    await ph.captureAndWait('u1', 'anything');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('capture posts the documented single-event shape and never awaits', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: unknown, init: { body: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> });
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    const ph = makePh(CFG, fetchImpl);
    ph.capture('user-1', 'round_launched', { origin: 'practice' });
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://us.i.posthog.com/i/v0/e');
    expect(calls[0]!.body).toMatchObject({
      api_key: 'phc_test123',
      event: 'round_launched',
      distinct_id: 'user-1',
      properties: { origin: 'practice', $lib: 'zenkai-server' },
    });
    expect(typeof calls[0]!.body.timestamp).toBe('string');
  });

  it('NEVER throws — not on a rejecting fetch, not on a synchronously-throwing one', async () => {
    const rejecting = (() => Promise.reject(new Error('down'))) as unknown as typeof fetch;
    const throwing = (() => {
      throw new Error('sync boom');
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => makePh(CFG, rejecting).capture('u', 'e')).not.toThrow();
      expect(() => makePh(CFG, throwing).capture('u', 'e')).not.toThrow();
      // Circular properties would make JSON.stringify throw inside capture.
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => makePh(CFG, rejecting).capture('u', 'e', circular)).not.toThrow();
      await expect(makePh(CFG, rejecting).captureAndWait('u', 'e')).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r));
    } finally {
      warn.mockRestore();
    }
  });

  it('warns once per failure streak, not once per event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rejecting = (() => Promise.reject(new Error('down'))) as unknown as typeof fetch;
      const ph = makePh(CFG, rejecting);
      ph.capture('u', 'a');
      ph.capture('u', 'b');
      ph.capture('u', 'c');
      await new Promise((r) => setImmediate(r));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('captureAndWait is BOUNDED — a hung endpoint costs the timeout, never a hang', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A fetch that respects its AbortSignal but never resolves on its own —
      // the shape of a wedged endpoint.
      const hung = ((_: unknown, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch;
      const t0 = Date.now();
      await makePh(CFG, hung).captureAndWait('u', 'round_ended', {}, 50);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('posthogConfigFromEnv — the session process path', () => {
  it('is LENIENT where public-config is strict: a session never dies over analytics', async () => {
    const { posthogConfigFromEnv } = await import('./posthog.js');
    expect(posthogConfigFromEnv({})).toBeNull();
    expect(posthogConfigFromEnv({ IP_POSTHOG_KEY: 'phx_secret' })).toBeNull(); // wrong kind: null, no throw
    expect(posthogConfigFromEnv({ IP_POSTHOG_KEY: 'phc_a', IP_POSTHOG_HOST: 'garbage' })?.host).toBe(
      'https://us.i.posthog.com', // bad host: fall back, never refuse
    );
    expect(
      posthogConfigFromEnv({ IP_POSTHOG_KEY: 'phc_a', IP_POSTHOG_REPLAY_ROUND: '1' })?.replayRound,
    ).toBe(true);
  });
});

describe('the vendored asset path', () => {
  it('is neutral — no "posthog", no "ph", no ad-blocker path token', () => {
    const p = posthogAssetPath('1.417.1');
    expect(p).toBe('/vendor/insight-1.417.1.js');
    expect(p).not.toMatch(/posthog|analytics|telemetry|tracking/i);
    // "ph" as a SEGMENT (the blocklist token) — 'insight' containing no
    // standalone ph token is the point of the name.
    expect(p).not.toMatch(/\/ph[-./]/);
    expect(isPosthogAssetUrl(p)).toBe(true);
    expect(isPosthogAssetUrl('/vendor/insight-1.417.1.js?x=1')).toBe(true);
    expect(isPosthogAssetUrl('/vendor/monaco/loader.js')).toBe(false);
    expect(isPosthogAssetUrl('/vendor/insight-../../.env.js')).toBe(false);
  });
});

describe('posthogSnippet — the one inline script, parse-tested here', () => {
  const opts = { assetPath: posthogAssetPath('1.417.1') };

  it('null cfg renders NOTHING — the unset box stays byte-identical', () => {
    expect(posthogSnippet(null, opts)).toBe('');
  });

  it('emits parseable JS that guards on window.posthog before touching it', () => {
    const html = posthogSnippet(CFG, {
      ...opts,
      blockSelector: 'iframe, #editor',
      maskTextSelector: '#log',
      distinctId: 'u1',
    });
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(inline.length).toBeGreaterThan(0);
    expect(() => new Function(inline)).not.toThrow();
    // The guard precedes the init — an ad-blocked bundle must be a no-op.
    expect(inline.indexOf('if (!window.posthog')).toBeGreaterThan(0);
    expect(inline.indexOf('if (!window.posthog')).toBeLessThan(inline.indexOf('.init('));
    // Loads deferred: half a megabyte must not block first paint.
    expect(html).toContain('defer');
    // Network capture off — posthog must not monkey-patch fetch on pages
    // that run the workbench, voice polling and the trace pipeline.
    expect(inline).toContain('capture_performance: false');
    expect(inline).toContain('maskAllInputs: true');
    expect(inline).toContain('blockSelector');
    expect(inline).toContain('window.posthog.identify("u1")');
  });

  it('an odd distinct id is SKIPPED, never quoted into the page', () => {
    const html = posthogSnippet(CFG, { ...opts, distinctId: '</script><svg onload=x>' });
    expect(html).not.toContain('identify');
    expect(html).not.toContain('svg');
  });

  it('a config value that could escape the script block kills the snippet, not the page', () => {
    expect(posthogSnippet({ key: 'phc_a</script>', host: CFG.host }, opts)).toBe('');
  });
});
