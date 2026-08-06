/**
 * Panes surface client — Monaco + tabs + run panel.
 *
 * CLASSIC SCRIPT on purpose (no import/export/top-level await): served raw
 * with no bundler and parse-guarded by `new Function` in chrome.test.ts,
 * same contract as session.js.
 *
 * This file IS the trace emitter for the panes surface — the IDE extension
 * does not exist here. It reproduces the extension's three activity events
 * at the extension's cadence (1s edit coalescing), posts them to
 * /api/panes-event, and lets the SERVER assign every seq. Scoring-free by
 * design: it reports what happened and renders what came back.
 */
/* global monaco, require */
(() => {
  const $ = (id) => document.getElementById(id);
  const editorHost = $('editor');
  if (!editorHost) return; // not a panes page

  const postEvent = (type, payload) => {
    fetch('/api/panes-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, payload }),
    }).catch(() => {}); // trace loss is the server's problem to notice, not a UI error
  };

  const LANG = { py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', json: 'json', md: 'markdown' };
  const langOf = (p) => LANG[p.split('.').pop()] || 'plaintext';

  // ---- state ----
  const models = new Map(); // path -> monaco model
  const editCounts = new Map(); // path -> changes since last edit event
  const editTimers = new Map(); // path -> 1s coalescing timer
  const saveTimers = new Map(); // path -> autosave debounce timer
  const inflightSaves = new Set(); // promises; Run flushes these first
  let editor = null;
  let activePath = null;

  const save = (path) => {
    const m = models.get(path);
    if (!m) return;
    const p = fetch('/api/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content: m.getValue() }),
    })
      .then(() => postEvent('file_save', { path }))
      .catch(() => {})
      .finally(() => inflightSaves.delete(p));
    inflightSaves.add(p);
  };

  const flushSaves = () => {
    for (const [path, t] of saveTimers) {
      clearTimeout(t);
      saveTimers.delete(path);
      save(path);
    }
    return Promise.all([...inflightSaves]);
  };

  const renderTabs = (files) => {
    const tabs = $('tabs');
    tabs.textContent = '';
    for (const f of files) {
      const b = document.createElement('button');
      b.textContent = f;
      b.addEventListener('click', () => open(f));
      tabs.appendChild(b);
    }
  };

  const markActive = () => {
    for (const b of $('tabs').children) b.classList.toggle('active', b.textContent === activePath);
  };

  const open = async (path) => {
    if (path === activePath) return;
    if (!models.has(path)) {
      const r = await fetch('/api/file?path=' + encodeURIComponent(path));
      if (!r.ok) return;
      const { content } = await r.json();
      const m = monaco.editor.createModel(content, langOf(path));
      models.set(path, m);
      m.onDidChangeContent((e) => {
        // The extension coalesces edits per document on a 1s window; the
        // stuck detector and judge read that cadence — match it exactly.
        editCounts.set(path, (editCounts.get(path) || 0) + e.changes.length);
        if (!editTimers.has(path)) {
          editTimers.set(path, setTimeout(() => {
            const n = editCounts.get(path) || 0;
            editCounts.delete(path);
            editTimers.delete(path);
            if (n > 0) postEvent('edit', { path, changes: n });
          }, 1000));
        }
        clearTimeout(saveTimers.get(path));
        saveTimers.set(path, setTimeout(() => {
          saveTimers.delete(path);
          save(path);
        }, 800));
      });
    }
    activePath = path;
    editor.setModel(models.get(path));
    markActive();
    postEvent('file_open', { path });
    editor.focus();
  };

  const boot = async () => {
    const r = await fetch('/api/files');
    const { files } = await r.json();
    // Graphite Steel: sink the editor ground to the shell's --sunk tone so the
    // pane reads as one instrument; syntax colors inherit from vs-dark.
    monaco.editor.defineTheme('zenkai-graphite', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#131314',
        'editorLineNumber.foreground': '#66676b',
        'editorLineNumber.activeForeground': '#96979b',
        'editorCursor.foreground': '#f4f4f5',
        'editor.selectionBackground': '#35708f55',
        'editor.inactiveSelectionBackground': '#35708f2e',
        'focusBorder': '#35708f',
      },
    });
    editor = monaco.editor.create(editorHost, {
      theme: 'zenkai-graphite',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
    });
    renderTabs(files);
    // Open the most likely working file first: a declared model path if the
    // server listed one, else the first file.
    if (files.length > 0) await open(files[0]);
  };

  // ---- run panel ----
  const runBtn = $('run');
  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      $('runstate').textContent = 'saving…';
      await flushSaves();
      $('runstate').textContent = 'running…';
      try {
        const r = await fetch('/api/run', { method: 'POST' });
        const out = await r.json();
        if (out.error) {
          $('runstate').textContent = out.error === 'busy' ? 'a run is already in progress' : 'run refused: ' + out.error;
        } else {
          $('runstate').textContent = out.exit_code === 0 ? 'passed' : 'failed';
          // Presentation hook only: lets the stylesheet color the verdict.
          $('runstate').className = out.exit_code === 0 ? 'pass' : 'fail';
          $('runout').textContent = out.tail || out.summary || '';
          $('runout').scrollTop = $('runout').scrollHeight;
        }
      } catch {
        $('runstate').textContent = 'run failed to start';
      }
      runBtn.disabled = false;
    });
  }

  // Monaco's AMD loader was configured inline by the page; editor.main pulls
  // the actual editor. Boot only after it lands.
  require(['vs/editor/editor.main'], () => {
    boot().catch((e) => {
      $('runstate') && ($('runstate').textContent = 'editor failed to load');
      console.error('panes boot failed', e);
    });
  });
})();
