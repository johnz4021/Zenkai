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
      productConfiguration?: {
        configurationDefaults?: Record<string, unknown>;
        extensionsGallery?: unknown;
      };
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
    // Extension marketplace OFF (owner call 2026-08-19). A candidate mid-round
    // installed ms-python from open-vsx, which gave store.py a native ▷ Run
    // Python File button beside our beaker; they clicked it, it ran a module of
    // stubs, printed nothing, and they reported "clicking run doesn't work for
    // me" and left (sess-1787088863100, install timestamped 17m18s into the
    // round). Removing extensionsGallery is the workbench's own off switch:
    // search and install stop existing. Our trace emitter is mounted at
    // --extensions-dir and is unaffected — it is never installed FROM a
    // gallery. Nothing in a 60-minute interview needs a new extension, and the
    // install also escaped the container (see the /ext mount).
    delete cfg.productConfiguration.extensionsGallery;
    return html.replace(META_RE, `$1${escapeAttr(JSON.stringify(cfg))}$3`);
  } catch {
    return html;
  }
}

/**
 * The view-state keys we seed, and the value each must hold.
 *
 * The auxiliary bar is NOT driven by settings. Verified live 2026-08-19 with
 * chat.disableAIFeatures / chat.agent.enabled / secondarySideBar.
 * defaultVisibility all delivered through configurationDefaults (confirmed
 * present in the injected boot HTML): the Chat view still auto-opened —
 * 191px on first boot, 300px after a reload, greeting the candidate with
 * "Build with agent mode / Let's get started" inside a timed interview.
 * Visibility lives in browser storage instead, which is exactly the channel
 * ide-settings.json's KNOWN-ISSUE named as the remaining lever.
 *
 * CSS is not an alternative: display:none on .part.auxiliarybar leaves a
 * 191px dead gap, because VS Code computes part widths in JS.
 */
const SEED_ITEMS: Record<string, string> = {
  'workbench.panel.chat.hidden': JSON.stringify([
    { id: 'workbench.panel.chat.view.copilot', isHidden: true },
  ]),
};

/** VS Code Web's global state store: one IndexedDB, one object store. */
const STATE_DB = 'vscode-web-state-db-global';
const STATE_STORE = 'ItemTable';

/**
 * A pre-boot script that seeds workbench view state before the workbench
 * reads it.
 *
 * IndexedDB is async and the workbench boots synchronously alongside us, so
 * winning that race outright is not guaranteed. The script therefore writes
 * the keys and reloads ONCE — and only when it actually changed something,
 * guarded by sessionStorage so it can never loop. Steady state (every
 * session after the first on a given browser) is a no-op with no reload.
 *
 * Failure is silent by construction: any throw leaves the workbench booting
 * exactly as it does today, which is the same contract as the meta-tag
 * transform above.
 */
export function preBootSeedScript(): string {
  return `<script>(function(){try{
var ITEMS=${JSON.stringify(SEED_ITEMS)};
var DB=${JSON.stringify(STATE_DB)},STORE=${JSON.stringify(STATE_STORE)},FLAG='ip.viewstate.reloaded';
var req=indexedDB.open(DB,1);
req.onupgradeneeded=function(){var db=req.result;
 if(!db.objectStoreNames.contains(STORE)){db.createObjectStore(STORE);}};
req.onsuccess=function(){var db=req.result;
 if(!db.objectStoreNames.contains(STORE)){db.close();return;}
 var tx=db.transaction(STORE,'readwrite'),st=tx.objectStore(STORE);
 var keys=Object.keys(ITEMS),left=keys.length,changed=false;
 keys.forEach(function(k){var g=st.get(k);
  g.onsuccess=function(){if(g.result!==ITEMS[k]){st.put(ITEMS[k],k);changed=true;}if(--left===0){done();}};
  g.onerror=function(){if(--left===0){done();}};});
 function done(){tx.oncomplete=function(){db.close();
   if(changed&&!sessionStorage.getItem(FLAG)){sessionStorage.setItem(FLAG,'1');location.reload();}};}
};
}catch(e){}})();</script>`;
}

/** Insert the pre-boot script as early in <head> as possible — it must run
 *  before the workbench script reads storage. Unchanged html when there is
 *  no head to insert into. */
export function injectPreBoot(html: string, script: string): string {
  const m = html.match(/<head[^>]*>/i);
  if (!m) return html;
  const at = (m.index ?? 0) + m[0].length;
  return html.slice(0, at) + script + html.slice(at);
}
