/**
 * Regression: QA 2026-08-14 — the Workspace Trust modal blocked the IDE at
 * session start in three separate live rounds despite
 * `security.workspace.trust.enabled: false` sitting in ide-settings.json.
 * configurationDefaults never reaches the trust check; the web workbench
 * honors only the top-level `enableWorkspaceTrust` boot option, which the
 * proxy must force to false on every injected page.
 * Report: .gstack/qa-reports/qa-report-interview-prep-2026-08-14.md
 */
import { describe, expect, it } from 'vitest';
import { injectWorkbenchDefaults } from './workbench-inject.js';

const page = (settings: object) =>
  `<html><head><meta id="vscode-workbench-web-configuration" data-settings="${JSON.stringify(settings)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')}"></head><body></body></html>`;

const parse = (out: string) =>
  JSON.parse(out.match(/data-settings="([^"]*)"/)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

describe('injectWorkbenchDefaults — workspace trust', () => {
  it('forces enableWorkspaceTrust: false into the boot config', () => {
    const out = injectWorkbenchDefaults(page({ folderUri: { path: '/p' } }), {});
    expect(parse(out).enableWorkspaceTrust).toBe(false);
  });

  it('overrides an upstream enableWorkspaceTrust: true', () => {
    const out = injectWorkbenchDefaults(page({ enableWorkspaceTrust: true }), {});
    expect(parse(out).enableWorkspaceTrust).toBe(false);
  });

  it('still passes unparseable pages through untouched', () => {
    const html = '<meta id="vscode-workbench-web-configuration" data-settings="not-json{">';
    expect(injectWorkbenchDefaults(html, {})).toBe(html);
  });
});
