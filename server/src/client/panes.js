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
  let modelFiles = []; // manifest model_paths — md files HERE default to source
  const mdPreviewOn = new Map(); // path -> bool, md tabs only

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
  // Submit path (session.js endSession) must flush too: a candidate can
  // type right up to pressing Submit without another Run, so without this
  // hook the last <800ms of typing was graded away by the submit run.
  window.ipPanesFlush = flushSaves;

  const fileTab = (f) => {
    const b = document.createElement('button');
    b.textContent = f;
    b.dataset.path = f;
    b.addEventListener('click', () => open(f));
    return b;
  };

  // Primary files (the round's task) render as tabs; infra files
  // (lockfiles, tool configs — the server partitions) sit behind one quiet
  // "more" control so they stay reachable without crowding the strip. The
  // old strip rendered package-lock.json as a co-equal alphabetical tab.
  const renderTabs = (primary, infra) => {
    const tabs = $('tabs');
    tabs.textContent = '';
    for (const f of primary) tabs.appendChild(fileTab(f));
    if (infra.length > 0) {
      const more = document.createElement('button');
      more.className = 'more';
      more.textContent = '+' + infra.length + ' more \u25be';
      more.addEventListener('click', () => {
        for (const f of infra) tabs.insertBefore(fileTab(f), toggle);
        more.remove();
        markActive();
      });
      tabs.appendChild(more);
    }
    const toggle = document.createElement('button');
    toggle.className = 'mdtoggle';
    toggle.id = 'mdtoggle';
    toggle.style.display = 'none';
    toggle.addEventListener('click', () => {
      if (!activePath) return;
      mdPreviewOn.set(activePath, !mdPreviewOn.get(activePath));
      applyView();
    });
    tabs.appendChild(toggle);
  };

  const markActive = () => {
    for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.path === activePath);
  };

  // Minimal markdown renderer for read-side docs. Everything is
  // HTML-escaped BEFORE any transform, so the output can only contain the
  // tags this function writes; links render as their text (inert — a round
  // is not a browsing session). Headings shift down one level: the pane's
  // own h1 stays the only h1.
  const mdToHtml = (src) => {
    const escMd = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (t) => t
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
    const out = [];
    let inCode = false;
    let inList = false;
    let para = [];
    const flushPara = () => {
      if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
    };
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const line of escMd(src).split('\n')) {
      if (line.trim().startsWith('```')) {
        flushPara(); closeList();
        out.push(inCode ? '</code></pre>' : '<pre><code>');
        inCode = !inCode;
        continue;
      }
      if (inCode) { out.push(line); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushPara(); closeList();
        const lvl = h[1].length + 1;
        out.push('<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>');
        continue;
      }
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) {
        flushPara();
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inline(li[1]) + '</li>');
        continue;
      }
      if (line.trim() === '') { flushPara(); closeList(); continue; }
      para.push(line.trim());
    }
    flushPara(); closeList();
    if (inCode) out.push('</code></pre>');
    return out.join('\n');
  };

  // One view per active tab: markdown tabs flip between rendered preview
  // and Monaco source; everything else is Monaco. Re-renders the preview
  // from the live model each time, so source edits show on toggle-back.
  const applyView = () => {
    const preview = $('mdpreview');
    const toggle = $('mdtoggle');
    const isMd = activePath !== null && langOf(activePath) === 'markdown';
    const showPreview = isMd && mdPreviewOn.get(activePath) === true;
    if (preview) {
      preview.style.display = showPreview ? 'block' : 'none';
      if (showPreview) {
        const m = models.get(activePath);
        preview.innerHTML = mdToHtml(m ? m.getValue() : '');
      }
    }
    editorHost.style.display = showPreview ? 'none' : 'block';
    if (toggle) {
      toggle.style.display = isMd ? 'inline-block' : 'none';
      toggle.textContent = showPreview ? 'edit source' : 'preview';
    }
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
    // Markdown defaults: docs open RENDERED (they are for reading); a
    // model-path .md is the candidate's own deliverable and opens as
    // source. The toggle overrides either way, remembered per tab.
    if (langOf(path) === 'markdown' && !mdPreviewOn.has(path)) {
      mdPreviewOn.set(path, !modelFiles.includes(path));
    }
    applyView();
    markActive();
    postEvent('file_open', { path });
    editor.focus();
  };

  const boot = async () => {
    const r = await fetch('/api/files');
    const { files, primary, infra, model } = await r.json();
    const primaries = primary && primary.length ? primary : files;
    modelFiles = model || [];
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
    renderTabs(primaries, infra || []);
    // Open the most likely working file first: the server puts declared
    // model paths at the head of `primary`, so [0] is the working file —
    // the old files[0] was alphabetical luck and could be a config.
    if (primaries.length > 0) await open(primaries[0]);
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
          var txt = out.tail || out.summary || '';
          var ro = $('runout');
          ro.textContent = txt;
          // Land on the FIRST failure block, not the very bottom: with runs now
          // unbuffered, a candidate's print()s interleave in the progress lines
          // at the TOP, and the old bottom-jump parked print-debuggers under
          // every traceback (first real-user report, 2026-08-21). The first
          // ====== / FAIL / ERROR line is where attention goes; their prints sit
          // just above it. All-pass output has no marker and keeps the old
          // jump-to-end. #runout is a non-wrapping <pre>, so line-count
          // proportion maps exactly onto scrollHeight.
          var lines = txt.split('\n');
          var target = -1;
          for (var li = 0; li < lines.length; li++) {
            if (/^(={10,}|\u23af{5,}|FAIL[ :(]|ERROR: )/.test(lines[li])) { target = li; break; }
          }
          if (target > 0 && ro.scrollHeight > ro.clientHeight) {
            ro.scrollTop = Math.max(0, (target - 2) * (ro.scrollHeight / lines.length));
          } else {
            ro.scrollTop = ro.scrollHeight;
          }
        }
      } catch {
        $('runstate').textContent = 'run failed to start';
      }
      runBtn.disabled = false;
    });
  }

  // ---- pane resizing (owner ask 2026-08-21) ----
  // The statement pane was capped at 480px and the test panel fixed at
  // 180px; a run with a long tail was unreadable. Both splitters drag
  // (pointer capture, so the drag survives leaving the 7px handle), take
  // arrow keys when focused, persist per-browser, and reset on dblclick.
  // Monaco relayouts itself (automaticLayout: true). No trace events: layout
  // is the candidate's viewing preference, not activity.
  const initSplitters = () => {
    const panes = $('panes');
    const statement = $('statement');
    const work = $('work');
    const testpanel = $('testpanel');
    const store = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };
    const stored = (k) => { try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; } };

    const clampW = (px) => Math.round(Math.min(Math.max(px, 200), panes.clientWidth * 0.6));
    const clampH = (px) => Math.round(Math.min(Math.max(px, 64), Math.max(64, work.clientHeight - 160)));
    const setW = (px) => { statement.style.width = clampW(px) + 'px'; store('zenkai.panes.statementW', clampW(px)); };
    const setH = (px) => { testpanel.style.height = clampH(px) + 'px'; store('zenkai.panes.testH', clampH(px)); };

    const wire = (bar, axis, apply, current, reset) => {
      if (!bar) return;
      bar.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { bar.setPointerCapture(e.pointerId); } catch {} // synthetic/odd pointers lack capture
        bar.classList.add('drag');
        document.body.classList.add('resizing', axis === 'v' ? 'rz-v' : 'rz-h');
        const from = current();
        const origin = axis === 'v' ? e.clientX : e.clientY;
        const move = (ev) => {
          const d = (axis === 'v' ? ev.clientX : ev.clientY) - origin;
          // The test panel grows UPWARD: dragging its handle up (negative d)
          // must make it taller, so the vertical delta inverts.
          apply(axis === 'v' ? from + d : from - d);
        };
        const up = () => {
          bar.classList.remove('drag');
          document.body.classList.remove('resizing', 'rz-v', 'rz-h');
          bar.removeEventListener('pointermove', move);
          bar.removeEventListener('pointerup', up);
          bar.removeEventListener('pointercancel', up);
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
      });
      bar.addEventListener('keydown', (e) => {
        const grow = axis === 'v' ? 'ArrowRight' : 'ArrowUp';
        const shrink = axis === 'v' ? 'ArrowLeft' : 'ArrowDown';
        if (e.key !== grow && e.key !== shrink) return;
        e.preventDefault();
        apply(current() + (e.key === grow ? 24 : -24));
      });
      bar.addEventListener('dblclick', reset);
    };

    wire($('splitv'), 'v', setW, () => statement.getBoundingClientRect().width, () => {
      statement.style.width = '';
      try { localStorage.removeItem('zenkai.panes.statementW'); } catch {}
    });
    wire($('splith'), 'h', setH, () => testpanel.getBoundingClientRect().height, () => {
      testpanel.style.height = '';
      try { localStorage.removeItem('zenkai.panes.testH'); } catch {}
    });

    const w = stored('zenkai.panes.statementW');
    const h = stored('zenkai.panes.testH');
    if (w) setW(w);
    if (h) setH(h);
  };
  // A layout bug must never take the editor and trace emitter down with it
  // (17768dc: one bad renderer line broke every practice page render).
  try { initSplitters(); } catch (e) { console.error('splitters failed', e); }

  // Monaco's AMD loader was configured inline by the page; editor.main pulls
  // the actual editor. Boot only after it lands.
  require(['vs/editor/editor.main'], () => {
    boot().catch((e) => {
      $('runstate') && ($('runstate').textContent = 'editor failed to load');
      console.error('panes boot failed', e);
    });
  });
})();
