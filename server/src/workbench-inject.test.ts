/**
 * The injection transform must be additive and failure-transparent: merged
 * defaults reach the workbench config, and any unexpected HTML shape passes
 * through byte-identical — a broken IDE boot would be strictly worse than a
 * returning recommendation modal.
 */
import { describe, expect, it } from 'vitest';
import { injectWorkbenchDefaults, injectPreBoot, preBootSeedScript } from './workbench-inject.js';

const page = (settings: object) =>
  `<html><head><meta id="vscode-workbench-web-configuration" data-settings="${JSON.stringify(settings)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')}"></head><body></body></html>`;

describe('injectWorkbenchDefaults', () => {
  it('merges defaults into productConfiguration.configurationDefaults', () => {
    const html = page({ folderUri: { path: '/p' }, productConfiguration: { nameShort: 'x' } });
    const out = injectWorkbenchDefaults(html, { 'extensions.ignoreRecommendations': true });
    const attr = out.match(/data-settings="([^"]*)"/)![1]!;
    const cfg = JSON.parse(attr.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    expect(cfg.productConfiguration.nameShort).toBe('x');
    expect(cfg.productConfiguration.configurationDefaults['extensions.ignoreRecommendations']).toBe(true);
    expect(cfg.folderUri.path).toBe('/p');
  });

  it('our defaults win over existing ones; unrelated existing defaults survive', () => {
    const html = page({ productConfiguration: { configurationDefaults: { a: 1, 'update.mode': 'default' } } });
    const out = injectWorkbenchDefaults(html, { 'update.mode': 'none' });
    const cfg = JSON.parse(out.match(/data-settings="([^"]*)"/)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    expect(cfg.productConfiguration.configurationDefaults).toEqual({ a: 1, 'update.mode': 'none' });
  });

  it('no meta tag → byte-identical passthrough, never a broken boot', () => {
    const html = '<html><head></head><body>plain</body></html>';
    expect(injectWorkbenchDefaults(html, { x: 1 })).toBe(html);
  });

  it('unparseable attribute → passthrough', () => {
    const html = '<meta id="vscode-workbench-web-configuration" data-settings="not-json{">';
    expect(injectWorkbenchDefaults(html, { x: 1 })).toBe(html);
  });
});

describe('extension marketplace lockdown (owner call 2026-08-19)', () => {
  const html = (cfg: unknown) =>
    `<html><head></head><body><meta id="vscode-workbench-web-configuration" data-settings="${String(
      JSON.stringify(cfg),
    ).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></body></html>`;
  const readCfg = (out: string) => {
    const m = out.match(/data-settings="([^"]*)"/)!;
    return JSON.parse(
      m[1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    ) as { productConfiguration?: Record<string, unknown> };
  };

  it('strips extensionsGallery so search and install stop existing', () => {
    const out = injectWorkbenchDefaults(
      html({ productConfiguration: { extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' } } }),
      {},
    );
    expect(readCfg(out).productConfiguration).not.toHaveProperty('extensionsGallery');
  });

  it('leaves the rest of productConfiguration intact', () => {
    const out = injectWorkbenchDefaults(
      html({ productConfiguration: { extensionsGallery: { serviceUrl: 'x' }, nameShort: 'OpenVSCode Server' } }),
      { 'a.b': 1 },
    );
    const pc = readCfg(out).productConfiguration!;
    expect(pc.nameShort).toBe('OpenVSCode Server');
    expect((pc.configurationDefaults as Record<string, unknown>)['a.b']).toBe(1);
  });
});

describe('pre-boot view-state seeding — the agent chat panel (2026-08-19)', () => {
  it('seeds the chat view as hidden, in the store the workbench actually reads', () => {
    const s = preBootSeedScript();
    expect(s).toContain('vscode-web-state-db-global');
    expect(s).toContain('ItemTable');
    expect(s).toContain('workbench.panel.chat.hidden');
    expect(s).toContain('\\"isHidden\\":true');
  });

  it('reloads at most once, and only when it changed something', () => {
    const s = preBootSeedScript();
    expect(s).toContain('sessionStorage.getItem');
    expect(s).toContain('changed&&!sessionStorage.getItem');
  });

  it('injects into head, before the workbench script', () => {
    const out = injectPreBoot('<html><head><script src="workbench.js"></script></head></html>', '<script>X</script>');
    expect(out.indexOf('<script>X</script>')).toBeLessThan(out.indexOf('workbench.js'));
  });

  it('never breaks a page it does not understand', () => {
    expect(injectPreBoot('<nothead>', '<script>X</script>')).toBe('<nothead>');
  });
});
