/**
 * Home app client. Served at /client/app.js by the app server (:3300).
 *
 * Same discipline as session.js: server-driven throughout, plain JS, no
 * build step, parseable by chrome.test.ts. Renders /api/state; every
 * mutation is a POST the server validates.
 */

/* global document, window, fetch */

function esc(s) { return String(s).replace(/</g, '&lt;'); }

let inferTargetId = null;
let draft = null;

async function refresh() {
  try {
    const r = await fetch('/api/state');
    const s = await r.json();
    render(s);
  } catch {
    document.getElementById('targets').innerHTML = '<p class="err">app server unreachable</p>';
  }
}

function render(s) {
  const banner = document.getElementById('banner');
  banner.innerHTML = s.session_live
    ? '<div class="banner">A session is running — <a href="' + esc(s.session_url) + '" style="color:inherit">rejoin it</a>. One session at a time.</div>'
    : '';

  const el = document.getElementById('targets');
  if (!s.targets.length) {
    el.innerHTML = '<p class="meta">No targets yet. Add what you\'re interviewing for below.</p>';
    return;
  }
  let html = '';
  for (const row of s.targets) {
    const t = row.target;
    html += '<div class="target">';
    html += '<h2>' + esc(t.label) + '</h2>';
    html += '<p class="meta">' + (t.interview_date ? 'interview ' + esc(t.interview_date) : 'no date set');
    if (row.queue) html += ' · pace ' + row.queue.pace.per_week + '/week';
    html += '</p>';

    if (!t.specs.length) {
      html += '<p class="meta">No round shape confirmed yet.</p>' +
        '<button class="primary infer" data-t="' + esc(t.id) + '">infer the round shape</button>';
    } else if (row.queue) {
      for (const i of row.queue.items) {
        const isNext = row.next && row.next.id === i.id;
        html += '<div class="item ' + esc(i.status) + '">';
        html += '<span class="st">' + esc(i.status) + '</span>';
        html += '<span>' + esc(i.label) + (i.note ? ' <span class="note">[' + esc(i.note) + ']</span>' : '') + '</span>';
        if (isNext && i.status === 'ready' && !s.session_live) {
          html += '<button class="primary start" data-t="' + esc(t.id) + '" data-i="' + esc(i.id) + '">start</button>';
        }
        if ((i.status === 'pending' || i.status === 'ready') ) {
          html += '<button class="skip" data-t="' + esc(t.id) + '" data-i="' + esc(i.id) + '">skip</button>';
        }
        html += '</div>';
      }
    }
    html += '</div>';
  }
  el.innerHTML = html;

  for (const b of el.querySelectorAll('button.start')) {
    b.addEventListener('click', () => launch(b.dataset.t, b.dataset.i));
  }
  for (const b of el.querySelectorAll('button.skip')) {
    b.addEventListener('click', async () => {
      await fetch('/api/skip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: b.dataset.t, item_id: b.dataset.i }) });
      refresh();
    });
  }
  for (const b of el.querySelectorAll('button.infer')) {
    b.addEventListener('click', () => startInfer(b.dataset.t));
  }
}

async function launch(targetId, itemId) {
  const r = await fetch('/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: targetId, item_id: itemId }) });
  const s = await r.json();
  if (s.error) { window.alert(s.error); return; }
  // The session process boots a container; poll until it serves, then go.
  const until = Date.now() + 180000;
  const tick = async () => {
    const live = (await (await fetch('/api/session-live')).json()).live;
    if (live) { window.location.href = s.url; return; }
    if (Date.now() < until) window.setTimeout(tick, 2000);
  };
  document.getElementById('banner').innerHTML = '<div class="banner">Starting your session — the environment takes a minute to boot…</div>';
  tick();
}

function startInfer(targetId) {
  inferTargetId = targetId;
  const box = document.getElementById('inferbox');
  box.style.display = 'block';
  box.scrollIntoView();
  // Research is optional and comes FIRST when wanted — its confirmed
  // findings feed the shape inference.
  box.innerHTML = '<h2>round shape</h2>' +
    '<p class="meta">Optionally, look up what this round looks like from public writeups (Blind, LeetCode discuss, GitHub — cited, ~2 min). Skip if you already know.</p>' +
    '<button id="do-research">research it first</button> ' +
    '<button id="skip-research" class="primary">I know the round — infer the shape</button>';
  document.getElementById('do-research').addEventListener('click', () => runResearch(targetId));
  document.getElementById('skip-research').addEventListener('click', () => runInfer(targetId));
}

function runResearch(targetId) {
  const box = document.getElementById('inferbox');
  box.innerHTML = '<h2>researching…</h2><p class="meta">Searching public sources for this round\'s shape. A minute or two.</p>';
  fetch('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: targetId }) })
    .then((r) => r.json())
    .then((d) => {
      if (d.error) {
        box.innerHTML = '<p class="err">' + esc(d.error) + '</p><button id="skip-research" class="primary">continue without research</button>';
        document.getElementById('skip-research').addEventListener('click', () => runInfer(targetId));
        return;
      }
      let html = '<h2>what turned up — check it before it\'s used</h2>';
      html += '<p>' + esc(d.summary) + '</p>';
      if (!d.findings.length) html += '<p class="meta">No citable findings — the summary above is all there was.</p>';
      for (const f of d.findings) {
        html += '<p class="cite meta">· ' + esc(f.claim) + '<br>&nbsp;&nbsp;<a href="' + esc(f.url) + '" target="_blank" style="color:inherit">' + esc(f.url) + '</a></p>';
      }
      html += '<button id="confirm-research" class="primary">looks right — use it</button> ' +
        '<button id="reject-research">ignore it</button>';
      box.innerHTML = html;
      document.getElementById('confirm-research').addEventListener('click', async () => {
        await fetch('/api/research/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: targetId }) });
        runInfer(targetId);
      });
      document.getElementById('reject-research').addEventListener('click', () => runInfer(targetId));
    });
}

function runInfer(targetId) {
  const box = document.getElementById('inferbox');
  box.innerHTML = '<h2>round shape</h2><p class="meta">Reading your description…</p>';
  fetch('/api/infer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: targetId }) })
    .then((r) => r.json())
    .then((d) => {
      if (d.error) { box.innerHTML = '<p class="err">' + esc(d.error) + '</p>'; return; }
      draft = d;
      renderDraft(d);
    });
}

function renderDraft(d) {
  const box = document.getElementById('inferbox');
  if (d.unsupported) {
    box.innerHTML = '<h2>can\'t run this round honestly</h2><p>' + esc(d.unsupported) + '</p>' +
      '<p class="meta">Rather than fake it, this round isn\'t offered. Adjust the description if that\'s wrong.</p>';
    return;
  }
  const c = d.spec.capabilities;
  box.innerHTML = '<h2>confirm the round shape</h2>' +
    '<div class="specbox">' +
    '<p><b>' + esc(d.spec.label) + '</b></p>' +
    '<p class="meta">' +
    (c.interviewer ? 'live interviewer' : 'no interviewer (OA)') + ' · ' +
    (c.time_limit_ms ? Math.round(c.time_limit_ms / 60000) + ' min' : 'untimed') + ' · ' +
    'starts from ' + esc(c.starts_from) + ' · ' +
    (c.submit === 'one_shot' ? 'graded once at submit' : 'iterate freely') +
    (d.spec.emphasis ? ' · emphasis: ' + esc(d.spec.emphasis) : '') +
    '</p></div>' +
    '<p class="rationale">' + esc(d.rationale) + '</p>' +
    '<button id="acceptspec" class="primary">looks right — build my queue</button> ' +
    '<button id="discardspec">discard</button>';
  document.getElementById('acceptspec').addEventListener('click', async () => {
    const r = await fetch('/api/accept-spec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: inferTargetId, spec: draft.spec }) });
    const s = await r.json();
    if (s.error) { window.alert(s.error); return; }
    box.style.display = 'none';
    refresh();
  });
  document.getElementById('discardspec').addEventListener('click', () => { box.style.display = 'none'; });
}

document.getElementById('nt-add').addEventListener('click', async () => {
  const label = document.getElementById('nt-label').value.trim();
  const err = document.getElementById('nt-err');
  if (!label) { err.textContent = 'label required'; return; }
  const r = await fetch('/api/target', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label,
      date: document.getElementById('nt-date').value,
      description: document.getElementById('nt-desc').value,
      context: document.getElementById('nt-context').value,
    }),
  });
  const s = await r.json();
  if (s.error) { err.textContent = s.error; return; }
  for (const id of ['nt-label', 'nt-date', 'nt-desc', 'nt-context']) document.getElementById(id).value = '';
  err.textContent = '';
  await refresh();
  startInfer(s.id);
});

setInterval(refresh, 5000);
refresh();
