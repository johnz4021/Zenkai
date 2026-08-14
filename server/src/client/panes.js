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

  // Writes carry the page's session id so a stale page whose server died is
  // refused by whichever session binds :3200 next (QA 2026-08-14).
  const SID = ((document.getElementById('sid') || {}).textContent || '');
  const sidHeaders = (h) => Object.assign({ 'x-ip-session': SID }, h || {});

  const postEvent = (type, payload) =>
    fetch('/api/panes-event', {
      method: 'POST',
      headers: sidHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ type, payload }),
    }).catch(() => {}); // trace loss is the server's problem to notice, not a UI error

  const LANG = { py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', json: 'json', md: 'markdown' };
  const langOf = (p) => LANG[p.split('.').pop()] || 'plaintext';

  // ---- state ----
  const models = new Map(); // path -> monaco model
  const editCounts = new Map(); // path -> changes since last edit event
  const editTimers = new Map(); // path -> 1s coalescing timer
  const saveTimers = new Map(); // path -> autosave debounce timer
  const inflight = new Set(); // in-flight save PUTs and edit posts; every flush awaits these
  let editor = null;
  let activePath = null;

  const save = (path) => {
    const m = models.get(path);
    if (!m) return;
    const p = fetch('/api/file', {
      method: 'PUT',
      headers: sidHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ path, content: m.getValue() }),
    })
      .then(() => postEvent('file_save', { path }))
      .catch(() => {})
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };

  /** Emit any edit events still sitting in their 1s coalescing window.
   *  Without this the LAST edits before a fast submit land after
   *  session_end — the judge reads the trace snapshot taken at
   *  session_end, so they are invisible to it and it writes "made unseen
   *  edits" about work it cannot see. Same class as the save flush below,
   *  found by /qa 2026-08-12 on a one-shot LC round. */
  const flushEdits = () => {
    for (const [path, t] of editTimers) {
      clearTimeout(t);
      editTimers.delete(path);
      const n = editCounts.get(path) || 0;
      editCounts.delete(path);
      if (n <= 0) continue;
      // Tracked so the flush AWAITS the post: a fire-and-forget edit would
      // still race /api/end and land after the judge's snapshot.
      const p = postEvent('edit', { path, changes: n }).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  };

  const flushSaves = () => {
    flushEdits();
    for (const [path, t] of saveTimers) {
      clearTimeout(t);
      saveTimers.delete(path);
      save(path);
    }
    return Promise.all([...inflight]);
  };
  // Submit path (session.js endSession) must flush too: on a one_shot round
  // the Run button doesn't exist, so without this hook nothing ever flushed
  // and the last <800ms of typing was graded away by the submit run.
  window.ipPanesFlush = flushSaves;

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
    // Prose wraps; code scrolls. Review rounds' whole deliverable is a
    // markdown write-up — without wrap it edited as one endless line
    // (QA 2026-08-14).
    editor.updateOptions({ wordWrap: langOf(path) === 'markdown' ? 'on' : 'off' });
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
        const r = await fetch('/api/run', { method: 'POST', headers: sidHeaders() });
        const out = await r.json();
        if (out.error) {
          $('runstate').textContent = out.error === 'busy' ? 'a run is already in progress' : 'run refused: ' + out.error;
        } else {
          // Say what the fraction IS: "failed 0/17" read as its own opposite
          // when all 17 failed (QA 2026-08-14) — the number beside "failed"
          // is the PASS count.
          const counts = typeof out.passed === 'number' && typeof out.total === 'number'
            ? out.passed + '/' + out.total + ' passing' : '';
          $('runstate').textContent = (out.exit_code === 0 ? 'passed' : 'failed') + (counts ? ' — ' + counts : '');
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
