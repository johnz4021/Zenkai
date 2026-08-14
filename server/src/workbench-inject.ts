/**
 * Workbench settings injection (QA ISSUE-009 + the ide-settings KNOWN ISSUE).
 *
 * VS Code Web reads workbench settings from browser IndexedDB, so the
 * User/Machine settings.json seeded into .ide-data never reach the UI —
 * verified failing long before this file existed (see session.ts's
 * ensureIdeDataDir comment). The one channel the browser DOES honor at boot
 * is the workbench HTML itself: openvscode embeds its bootstrap options as
 * HTML-escaped JSON in <meta id="vscode-workbench-web-configuration"
 * data-settings="...">, and `productConfiguration.configurationDefaults`
 * inside it applies as settings defaults.
 *
 * Our session server already proxies every IDE request, so it intercepts
 * the boot HTML and merges our defaults in. Pure text-in/text-out here;
 * fetching and serving stay in session.ts. If the meta tag ever changes
 * shape, the transform returns the input unchanged — the page still boots,
 * we just lose the defaults (and the modal comes back, which is visible).
 */

const META_RE = /(<meta[^>]*id="vscode-workbench-web-configuration"[^>]*data-settings=")([^"]*)(")/;

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Merge `defaults` into the workbench config's
 * productConfiguration.configurationDefaults. Returns the html unchanged
 * when the meta tag is missing or unparseable — never break the boot.
 */
export function injectWorkbenchDefaults(html: string, defaults: Record<string, unknown>): string {
  const m = html.match(META_RE);
  if (!m) return html;
  try {
    const cfg = JSON.parse(unescapeAttr(m[2]!)) as {
      productConfiguration?: { configurationDefaults?: Record<string, unknown> };
      enableWorkspaceTrust?: boolean;
    };
    cfg.productConfiguration = {
      ...cfg.productConfiguration,
      configurationDefaults: {
        ...cfg.productConfiguration?.configurationDefaults,
        ...defaults,
      },
    };
    // Workspace trust is NOT a setting the workbench reads from
    // configurationDefaults — `security.workspace.trust.enabled: false` in
    // ide-settings.json provably never stopped the modal (QA 2026-08-14,
    // three sessions), and openvscode-server 1.105 has no
    // --disable-workspace-trust flag. The one lever the web workbench does
    // honor is this top-level IWorkbenchConstructionOptions field in the
    // boot config. Every workspace here is a problem repo we generated into
    // a disposable container; there is no trust decision to make.
    cfg.enableWorkspaceTrust = false;
    return html.replace(META_RE, `$1${escapeAttr(JSON.stringify(cfg))}$3`);
  } catch {
    return html;
  }
}
