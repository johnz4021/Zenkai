/**
 * Minimal session chrome, served by the session runtime.
 *
 * Design decisions honored in minimal form (full styling arrives with the
 * production shell): rows + hairline dividers, ONE accent (focus only),
 * utility copy (D2), observations-vs-patterns framing (D1), remediation
 * leads when present (D3), two-line evidence citations (variant A).
 */

export function sessionPage(sessionId: string): string {
  return /* html */ `<!doctype html>
<meta charset="utf-8" />
<title>session ${sessionId}</title>
<style>
  :root { --accent: #7c5cff; --line: #2a2a2e; --dim: #9a9aa2; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-monospace, monospace; background: #17171a; color: #e6e6ea; display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; gap: 16px; padding: 8px 14px; border-bottom: 1px solid var(--line); }
  header .t { color: var(--dim); }
  header button { margin-left: auto; background: none; border: 1px solid var(--line); color: #e6e6ea; padding: 5px 12px; font: inherit; cursor: pointer; }
  main { flex: 1; display: flex; min-height: 0; }
  iframe { flex: 1; border: 0; }
  aside { width: 340px; border-left: 1px solid var(--line); display: flex; flex-direction: column; }
  #log { flex: 1; overflow-y: auto; padding: 10px 14px; }
  #log .u { margin: 0 0 8px; }
  #log .u b { color: var(--dim); font-weight: normal; }
  form { display: flex; border-top: 1px solid var(--line); }
  input { flex: 1; background: none; border: 0; color: inherit; font: inherit; padding: 10px 14px; outline: none; }
  form button { background: none; border: 0; border-left: 1px solid var(--line); color: var(--dim); padding: 0 14px; font: inherit; cursor: pointer; }
  #feedback { display: none; padding: 18px; overflow-y: auto; }
  #feedback h2 { font-size: 13px; font-weight: normal; color: var(--dim); margin: 0 0 4px; text-transform: uppercase; letter-spacing: .06em; }
  .row { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .row .desc { margin: 0 0 6px; }
  .cite { color: var(--dim); }
  .cite .clk { color: #e6e6ea; }
  .delta { color: var(--dim); padding-left: 18px; }
  .closedmark { border-left: 2px solid var(--accent); padding-left: 10px; }
  .focus { border: 1px solid var(--accent); padding: 10px; margin-top: 14px; }
  .focus .k { color: var(--accent); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
  .meta { color: var(--dim); margin-top: 12px; }
</style>
<header>
  <span>session <b>${sessionId}</b></span>
  <span class="t" id="clock">00:00</span>
  <span class="t" id="status">observing: —</span>
  <button id="end">End session</button>
</header>
<main>
  <iframe src="/?folder=/home/workspace/problem"></iframe>
  <aside>
    <div id="log">
      <p class="u"><b>notes</b> — think aloud here; questions and stated assumptions are part of the session record.</p>
      <p class="u"><b>observed</b> — edits, saves, file opens, ≥20s silences, this chat, and test runs made with the <b>Run Tests</b> button in the editor's status bar. Terminal commands are not observed. The suite runs once automatically at start.</p>
    </div>
    <div id="feedback"></div>
    <form id="f"><input id="msg" autocomplete="off" placeholder="ask / note an assumption…" /><button>send</button></form>
  </aside>
</main>
<script>
  const t0 = Date.now();
  setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    document.getElementById('clock').textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);

  async function pollStatus() {
    try {
      const r = await fetch('/api/status');
      const s = await r.json();
      const c = s.counts || {};
      const n = (k) => c[k] || 0;
      document.getElementById('status').textContent =
        'observing: ' + n('edit') + ' edits · ' + n('file_save') + ' saves · ' +
        n('test_run') + ' test runs · ' +
        (s.trigger_armed ? 'trigger armed ✓' : 'waiting for first failing test run');
    } catch {}
  }
  setInterval(pollStatus, 3000);
  pollStatus();

  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('msg');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const p = document.createElement('p');
    p.className = 'u';
    p.innerHTML = '<b>you</b> ' + text.replace(/</g, '&lt;');
    document.getElementById('log').appendChild(p);
    await fetch('/api/utterance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  });

  document.getElementById('end').addEventListener('click', async () => {
    const btn = document.getElementById('end');
    btn.disabled = true;
    btn.textContent = 'Classifying…';
    const res = await fetch('/api/end', { method: 'POST' });
    const card = await res.json();
    render(card);
    btn.textContent = 'Session ended';
  });

  function render(card) {
    document.getElementById('log').style.display = 'none';
    document.getElementById('f').style.display = 'none';
    const el = document.getElementById('feedback');
    el.style.display = 'block';
    let html = '';
    for (const c of card.newly_closed) {
      html += '<div class="row closedmark"><p class="desc">Closed: ' + c.description +
        '</p><p class="cite">fired ' + c.fired_count + ' times before this streak; not observed in 3 straight triggered sessions.</p></div>';
    }
    html += '<h2>' + (card.mode === 'observations' ? 'Session observations' : 'Session findings') + '</h2>';
    if (!card.trigger_occurred) {
      html += '<div class="row"><p class="desc">The trigger condition did not occur this session — nothing to classify.</p></div>';
    } else if (card.findings.length === 0) {
      html += '<div class="row"><p class="desc">No labels fired in the post-trigger window.</p></div>';
    }
    for (const f of card.findings) {
      html += '<div class="row"><p class="desc">' + f.description + '</p>';
      for (const line of f.citation) {
        html += '<p class="cite"><span class="clk">' + line.clock + '</span>  ' + line.what + '</p>';
      }
      if (f.delta_ms != null) {
        const s = Math.round(f.delta_ms / 1000);
        html += '<p class="delta">&#8595; ' + Math.floor(s / 60) + 'm ' + (s % 60) + 's between the two</p>';
      }
      html += '</div>';
    }
    if (card.focus) {
      html += '<div class="focus"><p class="k">next session focus</p><p>' + card.focus.description + '</p></div>';
    }
    if (card.mode === 'observations') {
      html += '<p class="meta">Session ' + (3 - card.sessions_until_patterns) + ' of 3 before patterns emerge. These are single-session observations, not yet patterns.</p>';
    }
    el.innerHTML = html;
  }
</script>
`;
}
