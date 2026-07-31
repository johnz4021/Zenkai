/**
 * Home app client (design review 2026-07-31, approved mockups
 * firstrun-E-attach + variant-C/A).
 *
 * Two views, server-driven from /api/state:
 *   entry   — first run: the screen IS the input. Build my plan runs
 *             research (cited, confirm-gated) → spec confirm → the season
 *             appears immediately, before the first problem finishes.
 *   seasons — the dated forward-only runway. TODAY holds the page's only
 *             primary action; the past is neutral history, never debt.
 *
 * Polling is focus-safe: identical state skips the render, and a render
 * never fires while the user is inside a form control — the old 5s
 * innerHTML wipe destroyed focus and scroll every poll.
 *
 * Plain JS, no build step, parseable by app.test.ts (new Function).
 */

/* global document, window, fetch, FileReader */

function esc(s) { return String(s).replace(/</g, '&lt;'); }
function el(id) { return document.getElementById(id); }

// ---- attachments (client-side until Build my plan) ----
// They concatenate into the target's context string — the reference
// material IS the moat input, so it gets a real region, not a text link.
const attachments = [];

function renderAttachments() {
  const list = el('e-attachlist');
  list.innerHTML = attachments.map((a, i) =>
    '<div class="attach"><span class="name">' + esc(a.name) + '</span>' +
    '<span class="kind">' + esc(a.kind) + '</span>' +
    '<button type="button" data-i="' + i + '" aria-label="remove ' + esc(a.name) + '">×</button></div>'
  ).join('');
  for (const b of list.querySelectorAll('button')) {
    b.addEventListener('click', () => { attachments.splice(Number(b.dataset.i), 1); renderAttachments(); });
  }
}

el('e-addlink').addEventListener('click', () => {
  const input = el('e-link');
  const url = input.value.trim();
  if (!url) return;
  attachments.push({ kind: 'link', name: url, content: url });
  input.value = '';
  renderAttachments();
});
el('e-link').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el('e-addlink').click(); }
});
el('e-browse').addEventListener('click', () => el('e-file').click());
el('e-file').addEventListener('change', () => {
  for (const f of el('e-file').files) {
    const reader = new FileReader();
    reader.onload = () => {
      attachments.push({ kind: 'file', name: f.name, content: String(reader.result).slice(0, 100_000) });
      renderAttachments();
    };
    reader.readAsText(f);
  }
  el('e-file').value = '';
});

function buildContext() {
  return attachments.map((a) =>
    a.kind === 'link' ? '--- link: ' + a.content + ' ---' : '--- file: ' + a.name + ' ---\n' + a.content
  ).join('\n\n');
}

// ---- first-run flow: build → research → confirm → spec → season ----

let flowTargetId = null;
let draft = null;

function flow(html) {
  el('entry-form').hidden = true;
  const f = el('entry-flow');
  f.hidden = false;
  f.innerHTML = html;
}

el('e-build').addEventListener('click', async () => {
  const desc = el('e-desc').value.trim();
  const err = el('e-err');
  if (!desc) { err.textContent = 'say something about the round — one sentence is enough'; return; }
  err.textContent = '';
  const btn = el('e-build');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const r = await fetch('/api/target', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: el('e-company').value.trim() || desc.split(/[.,]/)[0].slice(0, 40),
      date: el('e-date').value.trim(),
      description: desc,
      context: buildContext(),
    }),
  });
  const s = await r.json();
  btn.disabled = false;
  btn.textContent = 'Build my plan';
  if (s.error) { err.textContent = s.error; return; }
  flowTargetId = s.id;
  runResearch();
});

function runResearch() {
  flow('<h2>Looking up this round…</h2>' +
    '<p class="meta">Public writeups only — you\'ll see every source before anything gets used. A minute or two.</p>' +
    '<div class="progress"><div class="fill"></div></div>' +
    '<a href="#" id="skip-research" class="meta">skip — I know the round</a>');
  el('skip-research').addEventListener('click', (e) => { e.preventDefault(); runInfer(); });
  fetch('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: flowTargetId }) })
    .then((r) => r.json())
    .then((d) => {
      if (!el('entry-flow').innerHTML.includes('Looking up')) return; // user skipped
      if (d.error) {
        flow('<p class="err">' + esc(d.error) + '</p>' +
          '<button id="re-research" type="button">try again</button> ' +
          '<button id="skip2" class="primary" type="button">continue without research</button>');
        el('re-research').addEventListener('click', runResearch);
        el('skip2').addEventListener('click', runInfer);
        return;
      }
      if (!d.findings || !d.findings.length) {
        flow('<p class="meta">Nothing solid found publicly — going with what you told me.</p>');
        window.setTimeout(runInfer, 900);
        return;
      }
      let html = '<h2>What turned up — check it before it\'s used</h2><p>' + esc(d.summary) + '</p><div class="findings">';
      for (const f of d.findings) {
        html += '<p class="meta">· ' + esc(f.claim) + '<br>&nbsp;&nbsp;<a href="' + esc(f.url) + '" target="_blank" rel="noreferrer">' + esc(f.url) + '</a></p>';
      }
      html += '</div><button id="use-research" class="primary" type="button">looks right — use it</button> ' +
        '<button id="drop-research" type="button">ignore it</button>';
      flow(html);
      el('use-research').addEventListener('click', async () => {
        await fetch('/api/research/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: flowTargetId }) });
        runInfer();
      });
      el('drop-research').addEventListener('click', runInfer);
    });
}

function runInfer() {
  flow('<h2>Working out the round\'s shape…</h2><div class="progress"><div class="fill"></div></div>');
  fetch('/api/infer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: flowTargetId }) })
    .then((r) => r.json())
    .then((d) => {
      if (d.error) {
        flow('<p class="err">' + esc(d.error) + '</p><p class="meta">Your description is saved.</p>' +
          '<button id="re-infer" class="primary" type="button">try again</button>');
        el('re-infer').addEventListener('click', runInfer);
        return;
      }
      draft = d;
      if (d.unsupported) {
        flow('<h2>Can\'t run this round honestly</h2><p>' + esc(d.unsupported) + '</p>' +
          '<p class="meta">Rather than fake it, this round isn\'t offered. Edit the description if that\'s wrong.</p>' +
          '<button id="back-edit" type="button">edit description</button>');
        el('back-edit').addEventListener('click', backToForm);
        return;
      }
      const c = d.spec.capabilities;
      flow('<h2>Confirm the shape</h2>' +
        '<div class="specbox"><p><b>' + esc(d.spec.label) + '</b></p><p class="meta">' +
        (c.interviewer ? 'live interviewer' : 'no interviewer (OA)') + ' · ' +
        (c.time_limit_ms ? Math.round(c.time_limit_ms / 60000) + ' min' : 'untimed') + ' · ' +
        'starts from ' + esc(c.starts_from) + ' · ' +
        (c.submit === 'one_shot' ? 'graded once at submit' : 'iterate freely') +
        (d.spec.emphasis ? ' · emphasis: ' + esc(d.spec.emphasis) : '') + '</p></div>' +
        '<p class="rationale">' + esc(d.rationale) + '</p>' +
        '<button id="accept" class="primary" type="button">looks right — build my plan</button> ' +
        '<button id="back-edit" type="button">edit description</button>');
      el('back-edit').addEventListener('click', backToForm);
      el('accept').addEventListener('click', async () => {
        flow('<h2>Building your plan…</h2><div class="progress"><div class="fill"></div></div>');
        const r = await fetch('/api/accept-spec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: flowTargetId, spec: draft.spec }) });
        const s = await r.json();
        if (s.error) {
          flow('<p class="err">' + esc(s.error) + '</p><button id="re-infer" class="primary" type="button">back</button>');
          el('re-infer').addEventListener('click', runInfer);
          return;
        }
        // The payoff moment: the whole season appears NOW — day 1 keeps
        // generating behind it.
        flowTargetId = null;
        el('entry').hidden = true;
        el('entry-flow').hidden = true;
        el('entry-form').hidden = false;
        refresh(true);
      });
    });
}

function backToForm() {
  el('entry-flow').hidden = true;
  el('entry-form').hidden = false;
}

// ---- season timeline ----

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function fmtDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return String(d).padStart(2, '0') + ' ' + MONTHS[m - 1];
}

function metaLine(caps) {
  if (!caps) return '';
  return [
    caps.time_limit_ms ? Math.round(caps.time_limit_ms / 60000) + ' min' : 'untimed',
    caps.interviewer ? 'live interviewer' : 'no interviewer',
    caps.submit === 'one_shot' ? 'one shot' : 'iterate freely',
  ].join(' · ');
}

function itemTitle(item) {
  return item.title || item.planned_title || item.label;
}

function renderSeason(row, state) {
  const t = row.target;
  const caps = (t.specs[0] || {}).capabilities;
  const days = row.days || [];
  let html = '<div class="season">';

  // Header: the days-remaining number is the page's loudest fact.
  if (t.interview_date) {
    const left = Math.max(0, Math.ceil((Date.parse(t.interview_date + 'T23:59:59') - Date.now()) / 86400000));
    if (left === 0 || Date.parse(t.interview_date + 'T23:59:59') < Date.now()) {
      const ago = Math.max(1, Math.floor((Date.now() - Date.parse(t.interview_date + 'T00:00:00')) / 86400000));
      html += '<h2 class="daysleft">' + esc(t.label) + ' was ' + ago + ' day' + (ago === 1 ? '' : 's') + ' ago — how did it go?</h2>';
      html += '<p class="meta"><a href="#" class="addlink" data-entry>+ prepare for the next one</a></p></div>';
      return html;
    }
    html += '<h2 class="daysleft"><b>' + left + '</b> days to ' + esc(t.label) + '</h2>';
    const total = row.queue ? row.queue.items.length : 0;
    const done = row.queue ? row.queue.items.filter((i) => i.status === 'done' || i.status === 'skipped').length : 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    html += '<div class="seasonbar"><div class="fill" style="width:' + pct + '%"></div></div>';
    html += '<div class="paceline"><span>' + (row.queue ? row.queue.pace.per_week + ' rounds/week keeps you on pace' : '') + '</span>' +
      '<span>' + done + ' / ' + total + ' done</span></div>';
  } else {
    html += '<h2 class="daysleft">' + esc(t.label) + '</h2><p class="meta">no date set</p>';
  }

  html += '<ol class="runway">';
  for (const d of days) {
    if (d.kind === 'interview') {
      html += '<li class="interview"><span class="date">' + fmtDate(d.date) + '</span><span class="dot">◇</span>' +
        '<span class="body">' + fmtDate(d.date) + ' — ' + esc(t.label) + '</span></li>';
      continue;
    }
    if (d.kind === 'collapsed') {
      html += '<li class="collapsed"><span class="date"></span><span class="dot">⋮</span>' +
        '<span class="body">' + d.count + ' more round' + (d.count === 1 ? '' : 's') + ' over the next ' + d.span_days + ' days</span></li>';
      continue;
    }
    const item = d.items[0] || null;
    if (d.today) {
      html += '<li class="today" aria-current="date"><span class="date">TODAY</span><span class="dot">●</span><div class="body">';
      if (!item) {
        html += '<div class="grow"><span class="title meta">nothing scheduled — the plan resumes tomorrow</span></div>';
      } else if (item.status === 'ready') {
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline">' + metaLine(caps) + '</div>' +
          (state.focus ? '<div class="aimed">aimed at: ' + esc(state.focus.description) + '</div>' : '') + '</div>';
        if (!state.session_live) {
          html += '<button class="primary start" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">Start</button>';
        }
      } else if (item.status === 'generating') {
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline">building this problem — about 5 minutes</div>' +
          '<div class="progress"><div class="fill"></div></div></div>';
      } else if (item.status === 'failed') {
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline err">couldn\'t build this one</div></div>' +
          '<button class="retry" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">retry</button>';
      } else {
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline">queued</div></div>';
      }
      html += '</div></li>';
      continue;
    }
    if (d.past) {
      const done = d.items.filter((i) => i.status === 'done');
      if (done.length) {
        for (const i of done) {
          html += '<li class="past"><span class="date">' + fmtDate(d.date) + '</span><span class="dot done">✓</span>' +
            '<span class="body">' + esc(itemTitle(i)) + '</span></li>';
        }
      } else {
        html += '<li class="past empty"><span class="date">' + fmtDate(d.date) + '</span><span class="dot">·</span>' +
          '<span class="body">—</span></li>';
      }
      continue;
    }
    // future
    if (item) {
      html += '<li class="future"><span class="date">' + fmtDate(d.date) + '</span><span class="dot">○</span>' +
        '<span class="body">' + esc(itemTitle(item)) + '</span></li>';
    } else {
      html += '<li class="future empty"><span class="date">' + fmtDate(d.date) + '</span><span class="dot"></span>' +
        '<span class="body"></span></li>';
    }
  }
  html += '</ol>';
  html += '<a href="#" class="addlink" data-entry>+ add another interview</a>';
  html += '</div>';
  return html;
}

// ---- state polling (focus-safe) ----

let lastStateJson = '';
let pendingState = null;

function userIsTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
}

async function refresh(force) {
  try {
    const r = await fetch('/api/state');
    const text = await r.text();
    if (!force && text === lastStateJson) return;
    if (userIsTyping()) { pendingState = text; return; } // never yank focus
    lastStateJson = text;
    render(JSON.parse(text));
  } catch {
    el('banner').innerHTML = '<div class="banner">app server unreachable — retrying</div>';
  }
}

document.addEventListener('focusout', () => {
  if (pendingState) {
    const s = pendingState;
    pendingState = null;
    lastStateJson = s;
    window.setTimeout(() => render(JSON.parse(s)), 50);
  }
});

function render(state) {
  el('banner').innerHTML = state.session_live
    ? '<div class="banner">A session is running — <a href="' + esc(state.session_url) + '">rejoin it</a>. One session at a time.</div>'
    : '';

  const hasTargets = state.targets.length > 0;
  // Mid-flow the entry section owns the screen regardless of state.
  if (flowTargetId !== null) return;
  el('entry').hidden = hasTargets;
  el('seasons').hidden = !hasTargets;
  if (!hasTargets) return;

  const seasons = el('seasons');
  seasons.innerHTML = state.targets.map((row) => renderSeason(row, state)).join('');
  for (const b of seasons.querySelectorAll('button.start')) {
    b.addEventListener('click', () => launch(b.dataset.t, b.dataset.i));
  }
  for (const b of seasons.querySelectorAll('button.retry')) {
    b.addEventListener('click', async () => {
      await fetch('/api/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: b.dataset.t, item_id: b.dataset.i }) });
      refresh(true);
    });
  }
  for (const a of seasons.querySelectorAll('[data-entry]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      el('seasons').hidden = true;
      el('entry').hidden = false;
      el('e-desc').focus();
    });
  }
}

async function launch(targetId, itemId) {
  const r = await fetch('/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: targetId, item_id: itemId }) });
  const s = await r.json();
  if (s.error) { el('banner').innerHTML = '<div class="banner">' + esc(s.error) + '</div>'; return; }
  el('banner').innerHTML = '<div class="banner">Starting your session — the environment takes a minute to boot…</div>';
  const until = Date.now() + 180000;
  const tick = async () => {
    const live = (await (await fetch('/api/session-live')).json()).live;
    if (live) { window.location.href = s.url; return; }
    if (Date.now() < until) window.setTimeout(tick, 2000);
  };
  tick();
}

window.setInterval(refresh, 5000);
refresh(true);
