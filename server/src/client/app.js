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
  // Leaving the intake abandons the client-side flow; the target AND its
  // conversation persist on disk and surface on the index as resumable.
  if (!window.location.hash.startsWith('#/new')) {
    flowTargetId = null;
    plan.tid = null; plan.turns = []; plan.proposal = null; plan.busy = false; plan.error = ''; plan.gateOpen = null;
  }
  if (lastStateJson) render(JSON.parse(lastStateJson));
});

// ---- attachments (client-side until Build my plan) ----
// They concatenate into the target's context string — the reference
// material IS the moat input, so it gets a real region, not a text link.
// Binary kinds (image/pdf) carry base64 data instead of text: a screenshot
// read with readAsText was mojibake in the prompt, which made the single
// most valuable evidence class (an assessment preview the candidate SAW)
// invisible to the planner.
const attachments = [];

const BINARY_KINDS = { 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'image/gif': 'image', 'application/pdf': 'pdf' };

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
    const kind = BINARY_KINDS[f.type];
    const reader = new FileReader();
    if (kind) {
      if (f.size > 10 * 1024 * 1024) {
        el('e-err').textContent = f.name + ' is over 10MB — trim it down';
        continue;
      }
      reader.onload = () => {
        // readAsDataURL gives "data:<mime>;base64,<data>" — keep only the data.
        const data = String(reader.result).split(',')[1] || '';
        attachments.push({ kind, name: f.name, media_type: f.type, data });
        renderAttachments();
      };
      reader.readAsDataURL(f);
    } else {
      reader.onload = () => {
        attachments.push({ kind: 'file', name: f.name, content: String(reader.result).slice(0, 100_000) });
        renderAttachments();
      };
      reader.readAsText(f);
    }
  }
  el('e-file').value = '';
});

/** Text-and-link context string; binary attachments travel separately. */
function buildContext() {
  return attachments.filter((a) => !a.data).map((a) =>
    a.kind === 'link' ? '--- link: ' + a.content + ' ---' : '--- file: ' + a.name + ' ---\n' + a.content
  ).join('\n\n');
}

/** Binary attachments as {name, media_type, data} for the /api/target body. */
function buildBinaryAttachments() {
  return attachments.filter((a) => a.data).map((a) => ({ name: a.name, media_type: a.media_type, data: a.data }));
}

// ---- first-run flow: build → clarify → confirm → season ----

let flowTargetId = null;
/** Drafts shown by the classic confirm wall (was an accidental global). */
let drafts = [];

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
      attachments: buildBinaryAttachments(),
    }),
  });
  const s = await r.json();
  btn.disabled = false;
  btn.textContent = 'Build my plan';
  if (s.error) { err.textContent = s.error; return; }
  flowTargetId = s.id;
  planStart(s.id);
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

// ---- conversational planner ----
// The intake form IS the first message; after Build the surface becomes a
// conversation with the planner (design: Zenkai Planning Screen, approved
// 2026-08-06). Everything here renders from `plan` state kept OUTSIDE the
// DOM (adapt-panel precedent) so the 5s poll can't destroy it. The classic
// wizard above stays intact as the no-API-key fallback (server 501s).
const plan = { tid: null, turns: [], proposal: null, busy: false, error: '', gateOpen: null };

function planStart(id) {
  plan.tid = id; plan.turns = []; plan.proposal = null; plan.error = ''; plan.gateOpen = null;
  planTurn(null);
}

/** Resume from disk — the conversation replays; nothing was lost. */
function planResume(id) {
  plan.tid = id; plan.turns = []; plan.proposal = null; plan.error = ''; plan.gateOpen = null;
  plan.busy = true;
  renderPlan();
  fetch('/api/plan/conversation?target=' + encodeURIComponent(id))
    .then((r) => r.json())
    .then((d) => {
      plan.busy = false;
      if (d.error) { plan.error = d.error; renderPlan(); return; }
      if (!d.planner_available) { runClarify(null); return; }
      plan.turns = d.turns || [];
      plan.proposal = d.proposal || null;
      if (plan.turns.length === 0) planTurn(null);
      else renderPlan();
    })
    .catch(() => { plan.busy = false; plan.error = 'could not load the conversation'; renderPlan(); });
}

function planTurn(message) {
  plan.busy = true; plan.error = '';
  renderPlan();
  fetch('/api/plan/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_id: plan.tid, message: message || undefined }),
  })
    .then(async (r) => ({ status: r.status, body: await r.json() }))
    .then(({ status, body }) => {
      plan.busy = false;
      if (status === 501) { runClarify(null); return; } // no API key — classic wizard
      if (body.error) { plan.error = body.error; renderPlan(); return; }
      // We already rendered the user's message optimistically — keep only
      // the assistant's side of the server echo, or every answer shows twice.
      const incoming = (body.turns || []).filter((t) => (message ? t.role !== 'user' : true));
      plan.turns = plan.turns.concat(incoming);
      for (const t of incoming) if (t.proposal) plan.proposal = t.proposal;
      renderPlan();
    })
    .catch(() => {
      plan.busy = false;
      plan.error = 'the planner did not answer — your conversation is saved, try again';
      renderPlan();
    });
}

function specDateLine(spec) {
  if (!spec.date) return 'date not set';
  const n = daysUntil(spec.date);
  return fmtDate(spec.date) + (n !== null ? ' · ' + n + ' day' + (n === 1 ? '' : 's') : '');
}

function renderTraceLine(t, i) {
  const urls = (t.searched && t.searched.urls) || [];
  const conflicts = t.proposal && t.proposal.conflict ? 1 : 0;
  if (!urls.length && !conflicts) return '';
  // Verdicts come from the proposal's sources, matched by url.
  const verdictOf = {};
  if (t.proposal) for (const s of t.proposal.sources || []) verdictOf[s.url] = s.verdict;
  let html = '<button type="button" class="traceline" data-trace="' + i + '">Looked up · ' + urls.length +
    ' source' + (urls.length === 1 ? '' : 's') +
    (conflicts ? ' · <span class="cnum">' + conflicts + ' conflict</span>' : ' · 0 conflicts') + ' ▾</button>';
  html += '<div class="tracelist" hidden data-tracelist="' + i + '">';
  for (const u of urls) {
    const v = verdictOf[u] || '';
    html += '<div class="tracerow"><a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + '</a>' +
      (v ? '<span class="' + (v === 'conflicts' ? 'cnum' : 'meta') + '">' + esc(v) + '</span>' : '') + '</div>';
  }
  html += '</div>';
  return html;
}

function renderConflict(c) {
  return '<div class="conflict">' +
    '<div class="chead">A source disagrees with you · keeping your version</div>' +
    '<div class="csides">' +
    '<div class="cside"><div class="clabel">You told me</div>' + esc(c.yours) + '</div>' +
    '<div class="cside"><div class="clabel">A public source says</div>' + esc(c.theirs) +
    (c.source_url ? '<div class="meta" style="margin-top:6px"><a href="' + esc(c.source_url) + '" target="_blank" rel="noopener">' + esc(c.source_url) + '</a></div>' : '') +
    '</div></div>' +
    '<div class="cfoot"><p>Your evidence outranks a public source. Say so if the source is closer to what you were told.</p>' +
    '<button type="button" class="c-override" data-theirs="' + esc(c.theirs) + '">Use their version instead</button></div>' +
    '</div>';
}

function renderQuestionBlock(q, qi) {
  let html = '<div class="q"><p class="qtext">' + esc(q.question) + '</p>' +
    '<p class="meta qwhy">' + esc(q.why) + '</p>';
  q.options.forEach((op) => {
    const rec = q.recommended && q.recommended === op.label;
    html += '<button type="button" class="opt qanswer" data-q="' + esc(q.question) + '" data-a="' + esc(op.label) + '">' +
      '<span>' + esc(op.label) + (rec ? ' <em class="rec">recommended</em>' : '') +
      (op.detail ? '<br /><span class="meta">' + esc(op.detail) + '</span>' : '') + '</span></button>';
  });
  html += '<p class="meta" style="margin:8px 0 0">None of these? Say it in the message box below.</p></div>';
  return html;
}

/** The confirm gate: only confirmable rounds plus the commit button. The
 *  most imminent round is expanded (description + why); the rest are one
 *  line — a four-round loop must not swallow the conversation. */
function renderGate() {
  const p = plan.proposal;
  if (!p) return '';
  const usable = [];
  const declined = [];
  p.drafts.forEach((d, i) => (d.unsupported ? declined : usable).push({ d, i }));
  if (!usable.length && !declined.length) return '';
  const dated = usable.filter((x) => x.d.spec.date).sort((a, b) => (a.d.spec.date < b.d.spec.date ? -1 : 1));
  const undated = usable.filter((x) => !x.d.spec.date);
  const ordered = dated.concat(undated);
  const openIdx = plan.gateOpen === null ? (ordered.length ? ordered[0].i : null) : plan.gateOpen;

  let html = '<div id="plan-gate"><div class="gatehead"><span class="micro" style="margin:0">Rounds to confirm</span>' +
    '<span class="meta">nothing is generated until you confirm</span></div>';
  for (const { d, i } of ordered) {
    const open = i === openIdx;
    html += '<div class="gaterow">' +
      '<label class="gcheck"><input type="checkbox" checked data-gi="' + i + '" /> <b>' + esc(d.spec.label) + '</b></label>' +
      '<span class="gmeta">' + specShapeLine(d.spec.capabilities) + '</span>' +
      '<button type="button" class="gexpand" data-gx="' + i + '" aria-expanded="' + open + '">' +
      '<span class="gdate' + (d.spec.date ? '' : ' nodate') + '">' + specDateLine(d.spec) + '</span> ' + (open ? '▴' : '▾') + '</button>' +
      '</div>';
    if (open) {
      // The rationale is what makes the gate auditable. Emphasis stays in
      // the data (generation reads it) but not here — it is a paragraph
      // written FOR the generator, and it buried the gate in text.
      html += '<div class="gatedetail"><b>Why this shape:</b> ' + esc(d.rationale || '') + '</div>';
    }
  }
  for (const { d } of declined) {
    html += '<div class="gatedecline">' + esc(d.spec.label) + ' — can\'t run honestly: ' + esc(d.unsupported) + '</div>';
  }
  html += '<div class="gatecommit"><button id="gate-confirm" class="primary" type="button">Confirm and build the plan</button>' +
    '<span class="meta" id="gate-note"></span></div></div>';
  return html;
}

function renderPlan() {
  // Navigated away mid-turn: the conversation is on disk; render nothing.
  if (!plan.tid || route().page !== 'new') return;
  el('entry-form').hidden = true;
  const f = el('entry-flow');
  f.hidden = false;
  const composerText = el('plan-msg') ? el('plan-msg').value : '';

  // Only the LATEST assistant turn is interactive: its questions and its
  // conflict are the current state. Older turns render as plain history —
  // stale radio groups piling up per turn is how the page became a wall.
  let lastAssistant = -1;
  plan.turns.forEach((t, i) => { if (t.role === 'assistant') lastAssistant = i; });

  let html = '<div id="plan-chat">';
  plan.turns.forEach((t, i) => {
    if (t.role === 'user') {
      html += '<div class="turn-user">' + esc(t.prose) +
        ((t.attachments || []).length
          ? '<div class="att">attached: ' + t.attachments.map(esc).join(', ') + '</div>'
          : '') + '</div>';
    } else {
      const current = i === lastAssistant;
      html += '<div class="turn-planner' + (current ? '' : ' history') + '">';
      for (const para of (t.prose || '').split('\n\n')) {
        if (para.trim()) html += '<p>' + esc(para.trim()) + '</p>';
      }
      if (current && t.proposal && t.proposal.conflict) html += renderConflict(t.proposal.conflict);
      html += renderTraceLine(t, i);
      if (current && t.proposal) for (const q of t.proposal.questions || []) html += renderQuestionBlock(q);
      html += '</div>';
    }
  });
  if (plan.busy) {
    html += '<div class="turn-planner"><p class="meta">working — reading your material' +
      (plan.turns.length ? ' and thinking it through' : '') + '…</p>' +
      '<div class="progress"><div class="fill"></div></div></div>';
  }
  if (plan.error) html += '<p class="err">' + esc(plan.error) + '</p>';
  html += '</div>';

  html += renderGate();

  html += '<div id="plan-composer">' +
    '<textarea id="plan-msg" rows="1" aria-label="Message the planner" placeholder="Answer, correct me, or ask what a round shape is"' + (plan.busy ? ' disabled' : '') + '></textarea>' +
    '<button id="plan-send" type="button"' + (plan.busy ? ' disabled' : '') + '>Send</button></div>';

  f.innerHTML = html;
  if (el('plan-msg')) el('plan-msg').value = composerText;
  wirePlan(f);
  f.scrollTop = f.scrollHeight;
}

function wirePlan(f) {
  const send = () => {
    const box = el('plan-msg');
    const text = box.value.trim();
    if (!text || plan.busy) return;
    box.value = '';
    plan.turns.push({ role: 'user', at: new Date().toISOString(), prose: text });
    planTurn(text);
  };
  if (el('plan-send')) el('plan-send').addEventListener('click', send);
  if (el('plan-msg')) el('plan-msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  for (const b of f.querySelectorAll('.qanswer')) {
    b.addEventListener('click', () => {
      if (plan.busy) return;
      const text = b.dataset.q + ' — ' + b.dataset.a;
      plan.turns.push({ role: 'user', at: new Date().toISOString(), prose: text });
      planTurn(text);
    });
  }
  for (const b of f.querySelectorAll('.c-override')) {
    b.addEventListener('click', () => {
      if (plan.busy) return;
      const text = 'Go with the source\'s version: ' + b.dataset.theirs;
      plan.turns.push({ role: 'user', at: new Date().toISOString(), prose: text });
      planTurn(text);
    });
  }
  for (const b of f.querySelectorAll('.gexpand')) {
    b.addEventListener('click', () => {
      plan.gateOpen = Number(b.dataset.gx);
      renderPlan();
    });
  }
  for (const b of f.querySelectorAll('[data-trace]')) {
    b.addEventListener('click', () => {
      const list = f.querySelector('[data-tracelist="' + b.dataset.trace + '"]');
      if (list) list.hidden = !list.hidden;
    });
  }
  if (el('gate-confirm')) el('gate-confirm').addEventListener('click', async () => {
    const kept = [];
    for (const cb of f.querySelectorAll('.gcheck input[type="checkbox"]')) {
      if (cb.checked) kept.push(plan.proposal.drafts[Number(cb.dataset.gi)].spec);
    }
    if (!kept.length) { el('gate-note').textContent = 'nothing included'; return; }
    el('gate-confirm').disabled = true;
    el('gate-note').textContent = 'building your plan…';
    const r = await fetch('/api/accept-spec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: plan.tid, specs: kept }) });
    const s = await r.json();
    if (s.error) {
      el('gate-confirm').disabled = false;
      el('gate-note').textContent = '';
      plan.error = s.error;
      renderPlan();
      return;
    }
    // The payoff moment: the whole season appears NOW.
    const id = plan.tid;
    plan.tid = null; plan.turns = []; plan.proposal = null; plan.gateOpen = null;
    flowTargetId = null;
    el('entry-flow').hidden = true;
    el('entry-form').hidden = false;
    window.location.hash = '#/t/' + encodeURIComponent(id);
    refresh(true);
  });
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

/** Dated rounds for a target, nearest first. Spec dates win; the target's
 *  single date stands in for specs without one (and for pre-dates targets,
 *  where it renders under the target's own label). */
function roundDates(t) {
  const byDate = {};
  const out = [];
  for (const s of t.specs || []) {
    const date = s.date || t.interview_date;
    if (!date) continue;
    if (byDate[date]) { byDate[date].labels.push(s.label); continue; }
    byDate[date] = { date, labels: [s.label] };
    out.push(byDate[date]);
  }
  if (!out.length && t.interview_date) out.push({ date: t.interview_date, labels: [t.label] });
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out.map((r) => ({
    date: r.date,
    label: r.labels.join(' · '),
    passed: Date.parse(r.date + 'T23:59:59') < Date.now(),
  }));
}

/** Tick marks on the season bar, one per upcoming round day — the loop's
 *  milestones on the single spine, never separate bars. */
function seasonTicks(t, rounds) {
  const upcoming = rounds.filter((r) => !r.passed);
  if (upcoming.length < 2) return ''; // one round = the bar's end IS the tick
  const end = Date.parse(upcoming[upcoming.length - 1].date + 'T23:59:59');
  const span = end - Date.now();
  if (span <= 0) return '';
  let out = '';
  for (const r of upcoming) {
    const pct = Math.round(((Date.parse(r.date + 'T23:59:59') - Date.now()) / span) * 100);
    out += '<span class="tick" style="left:' + Math.min(99, Math.max(1, pct)) + '%" title="' + esc(r.label) + ' · ' + fmtDate(r.date) + '"></span>';
  }
  return out;
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

// ---- generation progress (server sends {since, files, phase} while an
//      item generates; the 8-minute wall is the generator's real timeout).
//      The clock/bar tick client-side every second via data-since — the
//      focus-safe poll skips identical states, which would freeze them. ----
const GEN_WALL_MS = 8 * 60000;

function genProgressLine(item) {
  const g = item.generating || {};
  const bits = [
    g.phase === 'finalizing' ? 'finalizing' : 'building',
    g.since ? '<span class="genclock" data-since="' + esc(g.since) + '"></span>' : '',
    g.files ? g.files + ' files written' : '',
    'usually 5–8 min',
  ].filter(Boolean);
  return bits.join(' · ');
}

function genProgressPct(item) {
  const since = item.generating && item.generating.since;
  const t = since ? Date.parse(since) : NaN;
  if (Number.isNaN(t)) return 8; // no marker yet — a sliver, not a lie
  return Math.min(95, Math.round(((Date.now() - t) / GEN_WALL_MS) * 100));
}

function tickGenClocks() {
  for (const n of document.querySelectorAll('.genclock[data-since]')) {
    const t = Date.parse(n.dataset.since);
    if (Number.isNaN(t)) continue;
    const ms = Math.max(0, Date.now() - t);
    n.textContent = Math.floor(ms / 60000) + 'm ' + String(Math.floor((ms % 60000) / 1000)).padStart(2, '0') + 's';
  }
  for (const f of document.querySelectorAll('.progress .fill.det[data-since]')) {
    const t = Date.parse(f.dataset.since);
    if (Number.isNaN(t)) continue;
    f.style.width = Math.min(95, Math.round(((Date.now() - t) / GEN_WALL_MS) * 100)) + '%';
  }
}
window.setInterval(tickGenClocks, 1000);

function renderSeason(row, state) {
  const t = row.target;
  const capsOf = (item) => ((t.specs.find((x) => x.id === item.spec_id) || t.specs[0] || {}).capabilities);
  const days = row.days || [];
  let html = '<div class="season">';

  // Header: the days-remaining number is the page's loudest fact — and it
  // counts to the NEAREST round, because that is what governs today. One
  // loop, several rounds, several dates (per-round dates, 2026-08-06).
  const rounds = roundDates(t);
  const upcoming = rounds.filter((r) => !r.passed);
  const passed = rounds.filter((r) => r.passed);
  if (rounds.length && upcoming.length === 0) {
    // EVERY dated round has happened — the season-over takeover.
    const last = rounds[rounds.length - 1];
    const ago = Math.max(1, Math.floor((Date.now() - Date.parse(last.date + 'T00:00:00')) / 86400000));
    html += '<h2 class="daysleft">' + esc(t.label) + ' was ' + ago + ' day' + (ago === 1 ? '' : 's') + ' ago — how did it go?</h2>';
    html += '<p class="meta"><a href="#/new" class="addlink">+ prepare for the next one</a></p></div>';
    return html;
  }
  if (upcoming.length) {
    const nearest = upcoming[0];
    const loopEnd = rounds[rounds.length - 1];
    const left = daysUntil(nearest.date);
    html += '<h2 class="daysleft"><b data-count="' + left + '">' + left + '</b> days to ' + esc(nearest.label) + '</h2>';
    if (loopEnd.date !== nearest.date) {
      html += '<p class="meta" style="margin:-14px 0 16px">loop ends ' + fmtDate(loopEnd.date) + '</p>';
    }
    const total = row.queue ? row.queue.items.length : 0;
    const done = row.queue ? row.queue.items.filter((i) => i.status === 'done' || i.status === 'skipped').length : 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    // One bar spans the whole loop; a tick marks each round day inside it.
    html += '<div class="seasonbar"><div class="fill" style="width:' + pct + '%"></div>' + seasonTicks(t, rounds) + '</div>';
    html += '<div class="paceline"><span>' + (row.queue ? row.queue.pace.per_week + ' rounds/week keeps you on pace' : '') + '</span>' +
      '<span>' + done + ' / ' + total + ' done</span></div>';
    // A round that already happened, mid-loop: the debrief moment, inline —
    // never a takeover while later rounds still need prep.
    for (const r of passed) {
      const ago = Math.max(1, Math.floor((Date.now() - Date.parse(r.date + 'T00:00:00')) / 86400000));
      html += '<p class="meta debrief">' + esc(r.label) + ' was ' + ago + ' day' + (ago === 1 ? '' : 's') +
        ' ago — how did it go? <a href="#" class="addlearn" data-t="' + esc(t.id) + '">tell the plan</a></p>';
    }
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
      // Per-round markers carry the round's own label; the single-date
      // compat path has none and keeps the target label.
      html += '<li class="interview"><span class="date">' + fmtDate(d.date) + '</span><span class="dot"></span>' +
        '<span class="body">' + fmtDate(d.date) + ' — ' + esc(d.label || t.label) + '</span></li>';
      continue;
    }
    if (d.kind === 'unscheduled') {
      html += '<li class="quiet"><span class="date"></span><span class="dot"></span>' +
        '<span class="body">date not set — ' + d.count + ' confirmed round' + (d.count === 1 ? '' : 's') +
        ' unscheduled (add the date via “+ add what you learned”)</span></li>';
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
          '<span class="body"><span class="ok">✓</span>' + esc(itemTitle(i)) + feedbackToggle(i) + feedbackPanel(i) + '</span></li>';
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
        // Honest progress (QA ISSUE-007/008): elapsed from the real start
        // marker, live file count, phase, and a bar that measures elapsed
        // against the 8-minute generation wall — the old bar was an
        // infinite loop that looked identical at second 5 and minute 8.
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline">' + genProgressLine(item) + '</div>' +
          '<div class="progress"><div class="fill det"' +
          (item.generating && item.generating.since ? ' data-since="' + esc(item.generating.since) + '"' : '') +
          ' style="width:' + genProgressPct(item) + '%"></div></div></div>';
      } else if (item.status === 'failed') {
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline err">couldn\'t build this one</div></div>' +
          '<button class="retry" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">retry</button>';
      } else {
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline">not built yet — usually 5–8 minutes to generate</div></div>' +
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
            '<span class="body"><span class="ok">✓</span>' + esc(itemTitle(i)) + feedbackToggle(i) + feedbackPanel(i) + '</span></li>';
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
  // Fetch and render fail for completely different reasons, and conflating
  // them sent this QA hunting a healthy server: a render TypeError (stale
  // cached client meeting a newer payload) reported itself as "app server
  // unreachable". Each failure now names itself.
  let text;
  try {
    const r = await fetch('/api/state');
    text = await r.text();
  } catch {
    const boot = el('boot');
    if (boot) boot.remove();
    el('banner').innerHTML = '<div class="banner">app server unreachable — retrying</div>';
    return;
  }
  if (!force && text === lastStateJson) return;
  if (userIsTyping()) { pendingState = text; return; } // never yank focus
  lastStateJson = text;
  try {
    render(JSON.parse(text));
    el('banner').innerHTML = ''; // recovered — clear any stale error
  } catch (e) {
    const boot = el('boot');
    if (boot) boot.remove();
    el('banner').innerHTML =
      '<div class="banner">this page is out of date — reload to pick up the latest version' +
      ' <button id="hardreload" type="button">reload</button></div>';
    const rb = el('hardreload');
    if (rb) rb.addEventListener('click', () => window.location.reload(true));
    console.error('[zenkai] render failed', e);
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
      // Abandoned mid-planning: honest about being unfinished, with exactly
      // two ways out — pick the conversation back up, or delete it. (Live
      // use grew 5 orphans out of 8 targets when the only option was a
      // dead "finish setting up" that restarted from scratch.)
      html += '<a href="#/new" class="plancard setup" data-resume="' + esc(t.id) + '">' +
        '<h2>' + esc(t.label) + '</h2>' +
        '<span class="go">resume planning →</span>' +
        '<button type="button" class="carddel" data-del="' + esc(t.id) + '">delete</button></a>';
      continue;
    }
    const total = row.queue ? row.queue.items.length : 0;
    const done = row.queue ? row.queue.items.filter((i) => i.status === 'done' || i.status === 'skipped').length : 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    let left = '';
    const cardRounds = roundDates(t);
    const cardUpcoming = cardRounds.filter((r) => !r.passed);
    if (cardUpcoming.length) {
      left = daysUntil(cardUpcoming[0].date) + ' days to ' + (cardRounds.length > 1 ? 'next round' : 'interview');
    } else if (cardRounds.length) {
      left = 'interview passed';
    }
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
  for (const b of el('index').querySelectorAll('[data-del]')) {
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!window.confirm('Delete this plan and its conversation? This cannot be undone.')) return;
      const r = await fetch('/api/target/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: b.dataset.del }) });
      const s = await r.json();
      if (s.error) { el('banner').innerHTML = '<div class="banner">' + esc(s.error) + '</div>'; return; }
      refresh(true);
    });
  }
}

/** Pick an unfinished plan's conversation back up — replayed from disk, so
 *  a closed tab or restarted app costs nothing. */
function resumeIntake(id) {
  window.location.hash = '#/new';
  flowTargetId = id;
  planResume(id);
}

function wireTimeline(container) {
  for (const b of container.querySelectorAll('button.start')) {
    b.addEventListener('click', () => launch(b.dataset.t, b.dataset.i, b));
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
  for (const a of container.querySelectorAll('a.fbtoggle')) {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const sid = a.dataset.s;
      if (openFeedback.has(sid)) { openFeedback.delete(sid); rerender(); return; }
      openFeedback.add(sid);
      if (!feedbackCache[sid]) {
        try {
          const r = await fetch('/api/feedback?session=' + encodeURIComponent(sid));
          const d = await r.json();
          feedbackCache[sid] = d.card || { state: 'unassessed', reason: d.error || 'No feedback recorded for this session.' };
        } catch {
          feedbackCache[sid] = { state: 'unassessed', reason: 'Could not load feedback.' };
        }
      }
      rerender();
    });
  }
  renderAdaptPanel(container);
}

// ---- judged feedback on finished rows ----
// The card the session page rendered at grading time, re-readable forever
// from the plan: the session server that first showed it is torn down
// minutes after the round ends, and feedback nobody can re-read is
// feedback that never happened. State lives outside the DOM (poll-safe,
// same trick as `adapt`).
const openFeedback = new Set();
const feedbackCache = {};

function feedbackToggle(i) {
  if (!i.session_id) return '';
  return ' <a href="#" class="fbtoggle" data-s="' + esc(i.session_id) + '">' +
    (openFeedback.has(i.session_id) ? 'hide feedback' : 'feedback') + '</a>';
}

function feedbackPanel(i) {
  if (!i.session_id || !openFeedback.has(i.session_id)) return '';
  const card = feedbackCache[i.session_id];
  if (!card) return '<div class="fbcard"><p class="meta">loading…</p></div>';
  return '<div class="fbcard">' + renderCardHtml(card) + '</div>';
}

/** Read-only render of an assessment card — same content the session page
 *  shows at grading time, minus the interactive bits that need the (long
 *  dead) session server: no "did this match?" buttons, and the bug is shown
 *  only when solved (an unsolved problem stays re-runnable unspoiled). */
function renderCardHtml(card) {
  let html = '';
  if (card.state === 'unassessed') {
    return '<p class="desc"><b>Session not assessed.</b> ' + esc(card.reason || '') + '</p>';
  }
  for (const c of card.newly_closed || []) {
    html += '<div class="fbrow closedmark"><p class="desc">Closed: ' + esc(c.description) + '</p></div>';
  }
  if (card.summary) html += '<p class="desc">' + esc(card.summary) + '</p>';
  for (const r of card.rows || []) {
    const cls = r.verdict === 'strong' ? 'v-strong' : r.verdict === 'weak' ? 'v-weak' : r.verdict === 'unassessable' ? 'v-none' : '';
    html += '<div class="fbrow ' + cls + '">' +
      '<p class="desc"><b class="dim">' + esc(r.dimension) + '</b> · ' +
      (r.verdict === 'unassessable' ? 'not assessable this session' : esc(r.verdict)) + '</p>' +
      '<p class="desc">' + esc(r.analysis) + '</p>';
    for (const q of r.quotes || []) {
      html += '<p class="cite"><span class="clk">' + esc(q.clock) + '</span>  ' + esc(q.text) + '</p>';
    }
    if (r.unreceipted) html += '<p class="cite">No verifiable citation survived for this claim — weigh it accordingly.</p>';
    html += '</div>';
  }
  if (card.bug && card.solved) {
    html += '<div class="fbrow"><p class="desc"><b>The bug:</b> ' + esc(card.bug.description) + '</p></div>';
  }
  if (card.focus) {
    html += '<div class="fbfocus"><p class="k">next session focus</p><p>' + esc(card.focus.description) + '</p></div>';
  }
  return html;
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
  const blueprints = d.blueprints || [];
  if (!d.new_specs.length && !d.repointed.length && !d.flagged.length && !blueprints.length) {
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
  for (const bp of blueprints) {
    // Recipe changes: the durable generation prompt this adapt rewrites.
    const label = (adapt.result.drafts.find((s) => s.spec.id === bp.spec_id) || {}).spec;
    html += '<details class="bpchange"><summary class="meta">blueprint ' +
      (bp.action === 'new' ? 'created' : 'revised') + ': <b>' +
      esc(label ? label.label : bp.spec_id) + '</b></summary>' +
      '<pre class="bpview">' + esc(bp.markdown) + '</pre></details>';
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
  // Full material travels to apply: the server appends it VERBATIM to
  // learnings.md before anything else — the excerpt is only the legacy
  // display field.
  const material = adapt.material || '';
  adapt.phase = 'busy';
  rerender();
  const r = await fetch('/api/adapt/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: tid, diff, material: material, material_excerpt: material.slice(0, 280) }) });
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

// Feedback lands ON the button, not in a banner 480px away (QA ISSUE-006:
// click Start, nothing changes where you're looking). The button carries
// the state; an inline metaline under it carries the words; the timeout —
// previously a silent give-up — surfaces an actionable error.
function launchStatus(btn, text, isError) {
  const host = btn.parentElement.querySelector('.grow') || btn.parentElement;
  let line = host.querySelector('.launchline');
  if (!line) {
    line = document.createElement('div');
    line.className = 'metaline launchline';
    host.appendChild(line);
  }
  line.textContent = text;
  line.classList.toggle('err', Boolean(isError));
}

async function launch(targetId, itemId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  const r = await fetch('/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: targetId, item_id: itemId }) });
  const s = await r.json();
  if (s.error) {
    if (btn) { btn.disabled = false; btn.textContent = 'Start'; launchStatus(btn, s.error, true); }
    else el('banner').innerHTML = '<div class="banner">' + esc(s.error) + '</div>';
    return;
  }
  // Honest about the cold path: a first launch on a machine may build the
  // runtime image. "a few seconds" was a lie a user reasonably read as a hang.
  if (btn) launchStatus(btn, 'booting the container and editor — up to a minute the first time…');
  const until = Date.now() + 180000;
  const tick = async () => {
    const live = (await (await fetch('/api/session-live')).json()).live;
    if (live) { window.location.href = s.url; return; }
    if (Date.now() < until) { window.setTimeout(tick, 2000); return; }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Start';
      launchStatus(btn, "couldn't start — is Docker running? Try again.", true);
    }
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
