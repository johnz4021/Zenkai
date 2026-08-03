/**
 * Home app client (design review 2026-07-31, approved mockups
 * firstrun-E-attach + variant-C/A).
 *
 * Two views, server-driven from /api/state:
 *   entry   — first run: the screen IS the input. Build my plan runs
 *             clarify (0-3 questions, best-guess drafts) → spec confirm →
 *             the season appears immediately, before the first problem
 *             finishes. No research step: the plan is built from what the
 *             candidate knows and pastes (CEO review 2026-08-02).
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

// ---- routing: the route decides what's visible; the poll only fills it ----
// #/       all plans (index)
// #/new    make a plan (intake + flow)
// #/t/<id> one season timeline
// The old design derived visibility from hasTargets on every poll and
// focusout, which yanked the user off the intake page — navigation intent
// and data state are separate things.
function route() {
  const h = window.location.hash || '#/';
  if (h.startsWith('#/new')) return { page: 'new' };
  if (h.startsWith('#/t/')) return { page: 'timeline', id: decodeURIComponent(h.slice(4)) };
  return { page: 'index' };
}

window.addEventListener('hashchange', () => {
  // Leaving the intake abandons the client-side flow; the target persists
  // on disk and surfaces on the index as "finish setting up".
  if (!window.location.hash.startsWith('#/new')) flowTargetId = null;
  if (lastStateJson) render(JSON.parse(lastStateJson));
});

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

// ---- first-run flow: build → clarify → confirm → season ----

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
  runClarify(null);
});

function specShapeLine(c) {
  return (c.interviewer ? 'live interviewer' : 'no interviewer (OA)') + ' · ' +
    (c.time_limit_ms ? Math.round(c.time_limit_ms / 60000) + ' min' : 'untimed') + ' · ' +
    'starts from ' + esc(c.starts_from) + ' · ' +
    (c.submit === 'one_shot' ? 'graded once at submit' : 'iterate freely');
}

function runClarify(answers) {
  flow('<h2>Working out the round\'s shape…</h2><div class="progress"><div class="fill"></div></div>');
  fetch('/api/clarify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: flowTargetId, answers: answers || undefined }) })
    .then((r) => r.json())
    .then((d) => {
      if (d.error) {
        flow('<p class="err">' + esc(d.error) + '</p><p class="meta">Your description is saved.</p>' +
          '<button id="re-clarify" class="primary" type="button">try again</button>');
        el('re-clarify').addEventListener('click', () => runClarify(answers));
        return;
      }
      // One answer round-trip max: after answers, or with none needed, confirm.
      if (d.questions && d.questions.length && !answers) renderQuestions(d);
      else renderConfirm(d.drafts);
    });
}

/** 0-3 structured questions from the reasoner. Options, a recommended tag,
 *  a free-text escape per question, and a global "use your best guess". */
function renderQuestions(d) {
  let html = '<h2>Quick check before the plan gets built</h2>' +
    '<p class="meta">Your description leaves something worth settling — wrong answers here cost you generated rounds of the wrong shape.</p>';
  d.questions.forEach((q, qi) => {
    html += '<div class="q" data-qi="' + qi + '"><p class="qtext">' + esc(q.question) + '</p>' +
      '<p class="meta qwhy">' + esc(q.why) + '</p>';
    q.options.forEach((op, oi) => {
      const rec = q.recommended && q.recommended === op.label;
      html += '<label class="opt"><input type="radio" name="q' + qi + '" value="' + oi + '"' + (rec ? ' checked' : '') + ' />' +
        '<span>' + esc(op.label) + (rec ? ' <em class="rec">recommended</em>' : '') +
        (op.detail ? '<br /><span class="meta">' + esc(op.detail) + '</span>' : '') + '</span></label>';
    });
    html += '<label class="opt"><input type="radio" name="q' + qi + '" value="other" />' +
      '<span>something else: <input type="text" class="otherbox" data-qi="' + qi + '" placeholder="say it in a few words" /></span></label>';
    html += '</div>';
  });
  html += '<button id="q-submit" class="primary" type="button">that\'s right — build the plan</button> ' +
    '<button id="q-skip" type="button">use your best guess</button>';
  flow(html);
  for (const box of el('entry-flow').querySelectorAll('.otherbox')) {
    box.addEventListener('focus', () => {
      const radios = el('entry-flow').querySelectorAll('input[name="q' + box.dataset.qi + '"]');
      radios[radios.length - 1].checked = true;
    });
  }
  el('q-skip').addEventListener('click', () => renderConfirm(d.drafts));
  el('q-submit').addEventListener('click', () => {
    const answers = d.questions.map((q, qi) => {
      const picked = el('entry-flow').querySelector('input[name="q' + qi + '"]:checked');
      if (!picked) return { question: q.question, answer: '(no answer — use your best guess)' };
      if (picked.value === 'other') {
        const box = el('entry-flow').querySelector('.otherbox[data-qi="' + qi + '"]');
        return { question: q.question, answer: box.value.trim() || '(no answer — use your best guess)' };
      }
      return { question: q.question, answer: q.options[Number(picked.value)].label };
    });
    runClarify(answers);
  });
}

/** The confirm gate, now over one OR MORE drafts. Each can be dropped;
 *  unsupported drafts render as honest declines and are never accepted. */
function renderConfirm(allDrafts) {
  drafts = allDrafts || [];
  const usable = drafts.filter((x) => !x.unsupported);
  let html = '<h2>' + (usable.length > 1 ? 'Confirm your rounds — the plan covers all of them' : 'Confirm the shape') + '</h2>';
  drafts.forEach((x, i) => {
    if (x.unsupported) {
      html += '<div class="specbox dropped"><p><b>' + esc(x.spec.label) + '</b> — can\'t run honestly</p>' +
        '<p class="meta">' + esc(x.unsupported) + '</p></div>';
      return;
    }
    html += '<div class="specbox" data-di="' + i + '"><p><b>' + esc(x.spec.label) + '</b>' +
      (usable.length > 1 ? ' <label class="keep"><input type="checkbox" checked data-di="' + i + '" /> include</label>' : '') +
      '</p><p class="meta">' + specShapeLine(x.spec.capabilities) +
      (x.spec.emphasis ? ' · emphasis: ' + esc(x.spec.emphasis) : '') + '</p>' +
      '<p class="rationale">' + esc(x.rationale) + '</p></div>';
  });
  if (usable.length === 0) {
    html += '<p class="meta">Rather than fake it, none of this is offered. Edit the description if that\'s wrong.</p>' +
      '<button id="back-edit" type="button">edit description</button>';
    flow(html);
    el('back-edit').addEventListener('click', backToForm);
    return;
  }
  html += '<button id="accept" class="primary" type="button">looks right — build my plan</button> ' +
    '<button id="back-edit" type="button">edit description</button>';
  flow(html);
  el('back-edit').addEventListener('click', backToForm);
  el('accept').addEventListener('click', async () => {
    const kept = drafts.filter((x, i) => {
      if (x.unsupported) return false;
      const cb = el('entry-flow').querySelector('input[type="checkbox"][data-di="' + i + '"]');
      return !cb || cb.checked;
    }).map((x) => x.spec);
    if (!kept.length) return;
    flow('<h2>Building your plan…</h2><div class="progress"><div class="fill"></div></div>');
    const r = await fetch('/api/accept-spec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: flowTargetId, specs: kept }) });
    const s = await r.json();
    if (s.error) {
      flow('<p class="err">' + esc(s.error) + '</p><button id="re-confirm" class="primary" type="button">back</button>');
      el('re-confirm').addEventListener('click', () => renderConfirm(drafts));
      return;
    }
    // The payoff moment: the whole season appears NOW — day 1 keeps
    // generating behind it.
    const id = flowTargetId;
    flowTargetId = null;
    el('entry-flow').hidden = true;
    el('entry-form').hidden = false;
    window.location.hash = '#/t/' + encodeURIComponent(id);
    refresh(true);
  });
}

function backToForm() {
  el('entry-flow').hidden = true;
  el('entry-form').hidden = false;
}

// ---- season timeline ----

/** Days until an ISO date, or null when absent/garbled — a stored bad
 *  date must degrade to "no date", never render "NaN days". */
function daysUntil(iso) {
  if (!iso) return null;
  const t = Date.parse(iso + 'T23:59:59');
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - Date.now()) / 86400000));
}

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
  const capsOf = (item) => ((t.specs.find((x) => x.id === item.spec_id) || t.specs[0] || {}).capabilities);
  const days = row.days || [];
  let html = '<div class="season">';

  // Header: the days-remaining number is the page's loudest fact.
  const leftDays = daysUntil(t.interview_date);
  if (t.interview_date && leftDays !== null) {
    const left = leftDays;
    if (left === 0 || Date.parse(t.interview_date + 'T23:59:59') < Date.now()) {
      const ago = Math.max(1, Math.floor((Date.now() - Date.parse(t.interview_date + 'T00:00:00')) / 86400000));
      html += '<h2 class="daysleft">' + esc(t.label) + ' was ' + ago + ' day' + (ago === 1 ? '' : 's') + ' ago — how did it go?</h2>';
      html += '<p class="meta"><a href="#/new" class="addlink">+ prepare for the next one</a></p></div>';
      return html;
    }
    html += '<h2 class="daysleft"><b data-count="' + left + '">' + left + '</b> days to ' + esc(t.label) + '</h2>';
    const total = row.queue ? row.queue.items.length : 0;
    const done = row.queue ? row.queue.items.filter((i) => i.status === 'done' || i.status === 'skipped').length : 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    html += '<div class="seasonbar"><div class="fill" style="width:' + pct + '%"></div></div>';
    html += '<div class="paceline"><span>' + (row.queue ? row.queue.pace.per_week + ' rounds/week keeps you on pace' : '') + '</span>' +
      '<span>' + done + ' / ' + total + ' done</span></div>';
  } else {
    html += '<h2 class="daysleft">' + esc(t.label) + '</h2><p class="meta">no date set</p>';
  }

  // The adaptation surface: what changed last, and the door for what you
  // just learned. The plan re-shapes only through an approved preview.
  html += '<div class="adaptrow">' +
    (row.adaptation ? '<span class="meta">' + fmtDate(row.adaptation.at.slice(0, 10)) + ' — ' + esc(row.adaptation.summary) + '</span>' : '<span></span>') +
    '<a href="#" class="addlearn" data-t="' + esc(t.id) + '">+ add what you learned</a></div>' +
    '<div class="adaptpanel" data-t="' + esc(t.id) + '" hidden></div>';

  html += '<ol class="runway">';
  for (const d of days) {
    if (d.kind === 'interview') {
      html += '<li class="interview"><span class="date">' + fmtDate(d.date) + '</span><span class="dot"></span>' +
        '<span class="body">' + fmtDate(d.date) + ' — ' + esc(t.label) + '</span></li>';
      continue;
    }
    if (d.kind === 'collapsed') {
      html += '<li class="collapsed"><span class="date"></span><span class="dot"></span>' +
        '<span class="body">' + d.count + ' more round' + (d.count === 1 ? '' : 's') + ' over the next ' + d.span_days + ' days</span></li>';
      continue;
    }
    // Today's completions, visible the moment they happen — finishing a
    // round must never render as an emptier timeline (QA ISSUE-002).
    if (d.kind === 'done-today') {
      for (const i of d.items) {
        html += '<li class="past donetoday"><span class="date">TODAY</span><span class="dot done"></span>' +
          '<span class="body"><span class="ok">✓</span>' + esc(itemTitle(i)) + '</span></li>';
      }
      continue;
    }
    if (d.kind === 'complete') {
      html += '<li class="today complete" aria-current="date"><span class="date">DONE</span><span class="dot"></span>' +
        '<div class="body"><div class="grow"><div class="title">season complete — ' + d.done_count +
        ' round' + (d.done_count === 1 ? '' : 's') + ' done</div>' +
        '<div class="metaline">every round is judged — your feedback lives in each finished row above</div></div></div></li>';
      continue;
    }
    if (d.kind === 'quiet') {
      html += '<li class="quiet"><span class="date"></span><span class="dot"></span>' +
        '<span class="body">· ' + d.count + ' quiet days ·</span></li>';
      continue;
    }
    const item = d.items[0] || null;
    if (d.today) {
      html += '<li class="today" aria-current="date"><span class="date">TODAY</span><span class="dot"></span><div class="body">';
      if (!item) {
        html += '<div class="grow"><span class="title meta">nothing scheduled — the plan resumes tomorrow</span></div>';
      } else if (item.status === 'ready') {
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline">' + metaLine(capsOf(item)) + '</div>' +
          (item.stale ? '<div class="metaline stale">built for the old round shape — still startable, or rebuild it to match the plan</div>' : '') +
          (state.focus ? '<div class="aimed">aimed at: ' + esc(state.focus.description) + '</div>' : '') + '</div>';
        if (item.stale) {
          html += '<button class="rebuild" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">rebuild</button> ';
        }
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
          '<div class="metaline">not built yet — generating takes about 5 minutes</div></div>' +
          '<button class="primary gen" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">Generate</button>';
      }
      html += '</div></li>';
      continue;
    }
    if (d.past) {
      const done = d.items.filter((i) => i.status === 'done');
      if (done.length) {
        for (const i of done) {
          html += '<li class="past"><span class="date">' + fmtDate(d.date) + '</span><span class="dot done"></span>' +
            '<span class="body"><span class="ok">✓</span>' + esc(itemTitle(i)) + '</span></li>';
        }
      } else {
        html += '<li class="past empty"><span class="date">' + fmtDate(d.date) + '</span><span class="dot"></span>' +
          '<span class="body">—</span></li>';
      }
      continue;
    }
    // future — actionable (QA D3): build tomorrow's problem tonight. The
    // server's one-at-a-time and session-live 409s still guard everything.
    if (item) {
      let action = '';
      if (item.status === 'pending') {
        action = ' <button class="mini gen" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">Generate</button>';
      } else if (item.status === 'ready' && !state.session_live) {
        action = ' <button class="mini start" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">Start</button>';
      } else if (item.status === 'failed') {
        action = ' <button class="mini retry" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">retry</button>';
      } else if (item.status === 'generating') {
        action = ' <span class="meta">building…</span>';
      }
      html += '<li class="future"><span class="date">' + fmtDate(d.date) + '</span><span class="dot"></span>' +
        '<span class="body">' + esc(itemTitle(item)) +
        (item.stale ? ' <span class="stale">— built for the old shape</span>' : '') + action + '</span></li>';
    } else {
      html += '<li class="future empty"><span class="date">' + fmtDate(d.date) + '</span><span class="dot"></span>' +
        '<span class="body"></span></li>';
    }
  }
  html += '</ol>';
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
    const boot = el('boot');
    if (boot) boot.remove();
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

// ---- all plans (index) ----

function renderIndex(state) {
  let html = '<h2 class="daysleft" style="font-size:15px">your plans</h2>';
  for (const row of state.targets) {
    const t = row.target;
    if (!t.specs.length) {
      // Orphan from an abandoned intake: visible and resumable, never dead.
      html += '<a href="#/new" class="plancard setup" data-resume="' + esc(t.id) + '">' +
        '<h2>' + esc(t.label) + '</h2>' +
        '<span class="go">finish setting up →</span></a>';
      continue;
    }
    const total = row.queue ? row.queue.items.length : 0;
    const done = row.queue ? row.queue.items.filter((i) => i.status === 'done' || i.status === 'skipped').length : 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    let left = '';
    const n = daysUntil(t.interview_date);
    if (n !== null) left = n === 0 ? 'interview passed' : n + ' days left';
    const nextItem = row.next;
    const nextLine = nextItem
      ? (nextItem.status === 'generating' ? 'building: ' : 'next: ') + esc(nextItem.title || nextItem.planned_title || nextItem.label)
      : done === total && total > 0 ? 'season complete' : '';
    html += '<a href="#/t/' + encodeURIComponent(t.id) + '" class="plancard">' +
      '<h2>' + esc(t.label) + '</h2>' +
      '<span class="meta">' + left + (left && total ? ' · ' : '') + (total ? done + '/' + total + ' done' : '') + '</span>' +
      '<div class="bar"><div class="fill" style="width:' + pct + '%"></div></div>' +
      '<div class="nextline">' + nextLine + '</div></a>';
  }
  el('index').innerHTML = html;
  for (const a of el('index').querySelectorAll('[data-resume]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      resumeIntake(a.dataset.resume);
    });
  }
}

/** Re-enter the intake flow for a target created but never confirmed —
 *  its description is already on disk; /api/infer reads it. */
function resumeIntake(id) {
  window.location.hash = '#/new';
  flowTargetId = id;
  runClarify(null);
}

function wireTimeline(container) {
  for (const b of container.querySelectorAll('button.start')) {
    b.addEventListener('click', () => launch(b.dataset.t, b.dataset.i));
  }
  for (const b of container.querySelectorAll('button.gen')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      const r = await fetch('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: b.dataset.t, item_id: b.dataset.i }) });
      const s = await r.json();
      if (s.error) { el('banner').innerHTML = '<div class="banner">' + esc(s.error) + '</div>'; b.disabled = false; return; }
      refresh(true);
    });
  }
  for (const b of container.querySelectorAll('button.retry')) {
    b.addEventListener('click', async () => {
      await fetch('/api/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: b.dataset.t, item_id: b.dataset.i }) });
      refresh(true);
    });
  }
  for (const b of container.querySelectorAll('button.rebuild')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      const r = await fetch('/api/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: b.dataset.t, item_id: b.dataset.i }) });
      const s = await r.json();
      if (s.error) { el('banner').innerHTML = '<div class="banner">' + esc(s.error) + '</div>'; b.disabled = false; return; }
      refresh(true);
    });
  }
  for (const a of container.querySelectorAll('a.addlearn')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (!adapt || adapt.tid !== a.dataset.t) adapt = { tid: a.dataset.t, phase: 'input', material: '' };
      renderAdaptPanel(container);
    });
  }
  renderAdaptPanel(container);
}

// ---- adapt: "add what you learned" → diff preview → approve → apply ----
// The panel state lives OUTSIDE the DOM so the 5s poll can re-render the
// timeline without losing a half-typed paste or an unapproved preview
// (same survival trick as flowTargetId on the entry page).
let adapt = null; // { tid, phase: 'input'|'busy'|'preview'|'error', material, result, error }

function rerender() {
  if (lastStateJson) render(JSON.parse(lastStateJson));
}

function renderAdaptPanel(container) {
  const panel = container.querySelector('.adaptpanel');
  if (!panel) return;
  if (!adapt || adapt.tid !== panel.dataset.t) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  const cancel = () => { adapt = null; rerender(); };
  if (adapt.phase === 'input' || adapt.phase === 'error') {
    panel.innerHTML = '<textarea class="learnbox" placeholder="paste it raw — an invite email, problem titles from the assessment, what a friend who interviewed told you"></textarea>' +
      (adapt.phase === 'error' ? '<p class="err">' + esc(adapt.error) + '</p>' : '') +
      '<div class="btnrow"><button class="primary do-preview" type="button">see what changes</button> ' +
      '<button class="do-cancel" type="button">cancel</button></div>';
    const box = panel.querySelector('.learnbox');
    box.value = adapt.material || '';
    box.addEventListener('input', () => { adapt.material = box.value; });
    panel.querySelector('.do-preview').addEventListener('click', () => previewAdapt(adapt.tid));
    panel.querySelector('.do-cancel').addEventListener('click', cancel);
    return;
  }
  if (adapt.phase === 'busy') {
    panel.innerHTML = '<p class="meta">reading it…</p><div class="progress"><div class="fill"></div></div>';
    return;
  }
  // preview — the confirm gate: nothing is written until "re-shape".
  const d = adapt.result.diff;
  if (!d.new_specs.length && !d.repointed.length && !d.flagged.length) {
    panel.innerHTML = '<p class="meta">nothing to change — the plan already matches what you pasted.</p>' +
      '<div class="btnrow"><button class="do-cancel" type="button">close</button></div>';
    panel.querySelector('.do-cancel').addEventListener('click', cancel);
    return;
  }
  let html = '<p class="adaptsum">' + esc(d.summary) + '</p>';
  for (const s of adapt.result.drafts) {
    if (s.unsupported) {
      html += '<div class="specbox dropped"><p><b>' + esc(s.spec.label) + '</b> — can\'t run honestly</p>' +
        '<p class="meta">' + esc(s.unsupported) + '</p></div>';
      continue;
    }
    html += '<div class="specbox"><p><b>' + esc(s.spec.label) + '</b> <span class="meta">' +
      (s.supersedes ? 'replaces ' + esc(s.supersedes) : 'additional round') + '</span></p>' +
      '<p class="meta">' + specShapeLine(s.spec.capabilities) + '</p>' +
      '<p class="rationale">' + esc(s.rationale) + '</p></div>';
  }
  for (const r of d.repointed) {
    html += '<p class="meta repoint">' + esc(r.old_title) + ' → <b>' + esc(r.new_title || r.new_label) + '</b></p>';
  }
  if (d.flagged.length) {
    html += '<p class="meta">' + d.flagged.length + ' already-built problem' + (d.flagged.length === 1 ? '' : 's') +
      ' no longer match' + (d.flagged.length === 1 ? 'es' : '') + ' — you\'ll be offered a rebuild on each.</p>';
  }
  html += '<div class="btnrow"><button class="primary do-apply" type="button">re-shape the plan</button> ' +
    '<button class="do-cancel" type="button">discard</button></div>';
  panel.innerHTML = html;
  panel.querySelector('.do-apply').addEventListener('click', () => applyAdapt(adapt.tid));
  panel.querySelector('.do-cancel').addEventListener('click', cancel);
}

async function previewAdapt(tid) {
  if (!adapt || adapt.phase === 'busy') return; // in-flight guard
  adapt.phase = 'busy';
  rerender();
  const r = await fetch('/api/adapt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: tid, material: adapt.material || '' }) });
  const d = await r.json();
  if (!adapt || adapt.tid !== tid) return; // cancelled meanwhile
  if (d.error) { adapt.phase = 'error'; adapt.error = d.error; } else { adapt.phase = 'preview'; adapt.result = d; }
  rerender();
}

async function applyAdapt(tid) {
  if (!adapt || adapt.phase === 'busy') return;
  const diff = adapt.result.diff;
  const excerpt = (adapt.material || '').slice(0, 280);
  adapt.phase = 'busy';
  rerender();
  const r = await fetch('/api/adapt/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: tid, diff, material_excerpt: excerpt }) });
  const d = await r.json();
  if (d.error) {
    if (adapt && adapt.tid === tid) { adapt.phase = 'error'; adapt.error = d.error; rerender(); }
    return;
  }
  if (d.record && d.record.skipped.length) {
    el('banner').innerHTML = '<div class="banner">' + d.record.skipped.length +
      ' round(s) didn\'t change — they moved on while you were deciding (' +
      esc(d.record.skipped.map((s) => s.reason).join(', ')) + ')</div>';
  }
  adapt = null;
  refresh(true);
}

// ---- entrance choreography: staggered rise + count-up, once per page
//      visit, never replayed by the 5s poll; off under reduced motion ----
let lastRouteKey = '';
const reducedMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function choreograph(section, routeKey) {
  const fresh = routeKey !== lastRouteKey;
  lastRouteKey = routeKey;
  section.classList.toggle('animate', fresh && !reducedMotion);
  let i = 0;
  for (const n of section.querySelectorAll('.season > *, .runway li, a.plancard')) {
    n.style.setProperty('--i', i++);
  }
  if (!fresh || reducedMotion) return;
  for (const b of section.querySelectorAll('[data-count]')) {
    const target = Number(b.dataset.count);
    if (!target) continue;
    const t0 = Date.now();
    const tick = () => {
      const k = Math.min(1, (Date.now() - t0) / 500);
      b.textContent = String(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) window.requestAnimationFrame(tick);
    };
    tick();
  }
}

/** The tab is one of thirty. Name the page, and for a season put the
 *  countdown itself in the title — the days remaining are readable
 *  without switching to the tab. */
function setTitle(r, state) {
  if (r.page === 'new') { document.title = 'new plan · Zenkai'; return; }
  if (r.page === 'timeline') {
    const row = state.targets.find((x) => x.target.id === r.id);
    if (row) {
      const n = daysUntil(row.target.interview_date);
      document.title = (n === null ? '' : n + ' days · ') + row.target.label;
      return;
    }
  }
  document.title = 'your plans · Zenkai';
}

function render(state) {
  // Persistent status lives in the masthead; the banner is for genuine
  // problems only. A full-width bar on every page for a usually-false
  // condition was pure vertical tax.
  el('nav-live').classList.toggle('on', Boolean(state.session_live));
  el('nav-live').href = state.session_url || '#/';
  el('nav-kill').classList.toggle('on', Boolean(state.session_live));
  el('banner').innerHTML = '';

  const boot = el('boot');
  if (boot) boot.remove();

  const r = route();
  setTitle(r, state);
  // Data-driven redirects only — never visibility flips: with nothing set
  // up yet, the only page that exists is the intake.
  if (!state.targets.length && r.page !== 'new') {
    window.location.hash = '#/new';
    return; // hashchange re-renders
  }

  el('index').hidden = r.page !== 'index';
  el('entry').hidden = r.page !== 'new';
  el('timeline').hidden = r.page !== 'timeline';
  el('nav-new').hidden = r.page === 'new';

  if (r.page === 'index') {
    renderIndex(state);
    choreograph(el('index'), 'index');
    return;
  }
  if (r.page === 'new') {
    lastRouteKey = 'new';
    // Mid-flow the flow DOM owns the section — never repaint under the user.
    if (flowTargetId === null) {
      el('entry-flow').hidden = true;
      el('entry-form').hidden = false;
    }
    return;
  }
  // timeline
  const row = state.targets.find((x) => x.target.id === r.id);
  if (!row) {
    window.location.hash = '#/';
    return;
  }
  const tl = el('timeline');
  tl.innerHTML = '<a href="#/" class="backlink">← all plans</a>' + renderSeason(row, state);
  wireTimeline(tl);
  choreograph(tl, 'timeline:' + r.id);
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

// Masthead "end session" — discard, never grade (QA D1). Submit inside the
// session remains the one graded path; this is the escape hatch for false
// starts, so they can't pollute the gap graph.
el('nav-kill').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!window.confirm('End without grading? The attempt is discarded (recoverable via rejudge).')) return;
  const r = await fetch('/api/session-kill', { method: 'POST' });
  const s = await r.json();
  if (s.error) el('banner').innerHTML = '<div class="banner">' + esc(s.error) + '</div>';
  refresh(true);
});

window.setInterval(refresh, 5000);
refresh(true);
