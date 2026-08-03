/**
 * The injection transform must be additive and failure-transparent: merged
 * defaults reach the workbench config, and any unexpected HTML shape passes
 * through byte-identical — a broken IDE boot would be strictly worse than a
 * returning recommendation modal.
 */
import { describe, expect, it } from 'vitest';
import { injectWorkbenchDefaults } from './workbench-inject.js';

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
