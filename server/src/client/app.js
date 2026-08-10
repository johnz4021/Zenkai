/**
 * Home app client (Cowork-grammar redesign D1, 2026-08-07).
 *
 * Two views, server-driven from /api/state:
 *   entry   — a planning conversation. The composer IS the intake: the
 *             first Send creates the target and kicks off the planner; the
 *             chat holds nothing but prose while ALL structure lives in the
 *             plan panel (the confirm gate), maintained by the model's
 *             propose_rounds tool. Nothing is generated until confirm.
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
// #/         the composer landing (practice IS the front door, 2026-08-10)
// #/plans    all plans (the old index)
// #/history  practice history — the reps strip + judged cards
// #/new      make a plan (intake + flow)
// #/t/<id>   one season timeline
// #/practice legacy alias — render() canonicalizes it to #/
// The old design derived visibility from hasTargets on every poll and
// focusout, which yanked the user off the intake page — navigation intent
// and data state are separate things.
function route() {
  const h = window.location.hash || '#/';
  if (h.startsWith('#/new')) return { page: 'new' };
  if (h.startsWith('#/plans')) return { page: 'plans' };
  if (h.startsWith('#/history')) return { page: 'history' };
  if (h.startsWith('#/t/')) return { page: 'timeline', id: decodeURIComponent(h.slice(4)) };
  // '#/' and the legacy '#/practice' alias are both the composer landing.
  return { page: 'practice' };
}

window.addEventListener('hashchange', () => {
  const h = window.location.hash;
  // Leaving the intake abandons the client-side flow; the target AND its
  // conversation persist on disk and surface on the plans page as resumable.
  if (!h.startsWith('#/new')) {
    flowTargetId = null;
    resetPlan();
  }
  // Leaving the landing drops the un-started flow the same way — a rep that
  // reached Start lives in reps.json and needs nothing from this tab. The
  // '#/practice' → '#/' canonicalizing redirect must NOT count as leaving,
  // or the transient would erase in-progress composer state.
  if (!(h === '' || h === '#/' || h.startsWith('#/practice'))) resetRep();
  if (lastStateJson) render(JSON.parse(lastStateJson));
});

// ---- planning surface: Cowork grammar (design D1, 2026-08-07) ----
// The chat contains NOTHING but prose; ALL structure lives in the plan
// panel, which the model maintains through its propose_rounds tool. The
// composer IS the entry — there is no form. State lives OUTSIDE the DOM
// (adapt-panel precedent) so the 5s poll can't destroy it.

let flowTargetId = null; // non-null while a planning conversation owns #entry

const attachments = [];
const BINARY_KINDS = { 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'image/gif': 'image', 'application/pdf': 'pdf' };
// A paste longer than this becomes a chip instead of composer text — the
// candidate's own material must never dominate the viewport.
const PASTE_CHIP_CHARS = 400;

const plan = {
  tid: null, turns: [], proposal: null, busy: false, error: '',
  gateOpen: null,          // panel row index whose rationale is expanded
  include: {},             // draft index -> checkbox state
  tier: {},                // draft index -> user's tier override (free, T2-B)
  openChips: {},           // turn index -> expanded paste chip
  flash: false,            // one render's worth of row-flash after an update
  readOnly: false,         // no API key: replay + confirm, but no sending
  askDismissed: null,      // turn index whose pinned options were waved off
};

let renderedTurnCount = 0; // autoscroll fires only when this grows

function resetPlan() {
  renderedTurnCount = 0;
  plan.tid = null; plan.turns = []; plan.proposal = null; plan.busy = false;
  plan.error = ''; plan.gateOpen = null; plan.include = {}; plan.tier = {};
  plan.openChips = {}; plan.flash = false; plan.readOnly = false; plan.askDismissed = null;
  attachments.length = 0;
}

function buildContext() {
  return attachments.filter((a) => !a.data).map((a) =>
    a.kind === 'link' ? '--- link: ' + a.content + ' ---' : '--- ' + a.name + ' ---\n' + a.content
  ).join('\n\n');
}

function buildBinaryAttachments() {
  return attachments.filter((a) => a.data).map((a) => ({ name: a.name, media_type: a.media_type, data: a.data }));
}

function specShapeLine(c) {
  return (c.interviewer ? 'live interviewer' : 'no interviewer (OA)') + ' · ' +
    (c.time_limit_ms ? Math.round(c.time_limit_ms / 60000) + ' min' : 'untimed') + ' · ' +
    'starts from ' + esc(c.starts_from) + ' · ' +
    (c.submit === 'one_shot' ? 'graded once at submit' : 'iterate freely');
}

function specDateLine(spec) {
  if (!spec.date) return 'date not set';
  const n = daysUntil(spec.date);
  return fmtDate(spec.date) + (n !== null ? ' · ' + n + ' day' + (n === 1 ? '' : 's') : '');
}

function planResume(id) {
  resetPlan();
  plan.tid = id; plan.busy = true;
  flowTargetId = id;
  renderPlan();
  fetch('/api/plan/conversation?target=' + encodeURIComponent(id))
    .then((r) => r.json())
    .then((d) => {
      plan.busy = false;
      if (d.error) { plan.error = d.error; renderPlan(); return; }
      // A conversation already on disk is shown even without a key: the
      // candidate keeps sight of their plan and can still confirm it
      // (accept-spec needs no key; naming and blueprints degrade on their
      // own). Only sending is dead, and the notice says so.
      plan.turns = d.turns || [];
      plan.proposal = d.proposal || null;
      plan.readOnly = !d.planner_available;
      if (plan.readOnly) {
        plan.error = plan.turns.length
          ? 'ANTHROPIC_API_KEY is not set, so I cannot reply — your conversation and plan are intact, and you can still confirm below'
          : 'conversational planning needs ANTHROPIC_API_KEY in .env — set it and restart the app';
        renderPlan();
        return;
      }
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
      if (status === 501) {
        plan.error = 'conversational planning needs ANTHROPIC_API_KEY in .env — set it and restart the app';
        renderPlan();
        return;
      }
      if (body.error) { plan.error = body.error; renderPlan(); return; }
      // We already rendered the user's message optimistically — keep only
      // the assistant's side of the server echo.
      const incoming = (body.turns || []).filter((t) => (message ? t.role !== 'user' : true));
      plan.turns = plan.turns.concat(incoming);
      for (const t of incoming) {
        if (t.proposal) { plan.proposal = t.proposal; plan.flash = true; }
      }
      renderPlan();
    })
    .catch(() => {
      plan.busy = false;
      plan.error = 'the planner did not answer — your conversation is saved, try again';
      renderPlan();
    });
}

/** First Send: the message IS the intake. Create the target, then kick off. */
async function planFirstSend(text) {
  plan.busy = true; plan.error = '';
  if (text) plan.turns.push({ role: 'user', at: new Date().toISOString(), prose: text });
  renderPlan();
  // Label from typed words, else from the first pasted chip's words.
  const seed = text || (attachments.find((a) => a.content) || {}).content || '';
  const label = seed.split(/[.,\n]/)[0].split(/\s+/).slice(0, 5).join(' ').slice(0, 40) || 'plan';
  try {
    const r = await fetch('/api/target', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, description: text, context: buildContext(), attachments: buildBinaryAttachments() }),
    });
    const sBody = await r.json();
    if (sBody.error) { plan.busy = false; plan.error = sBody.error; if (text) plan.turns.pop(); renderPlan(); return; }
    plan.tid = sBody.id;
    flowTargetId = sBody.id;
    attachments.length = 0;
    // The kickoff turn (server side) carries the description + attachments;
    // our optimistic turn already shows the words, so drop the echo.
    plan.turns = [];
    planTurn(null);
  } catch {
    plan.busy = false; plan.error = 'could not reach the app server'; renderPlan();
  }
}

// The planner writes markdown — links, bold, inline code, short numbered
// lists. Render the small subset it actually uses; raw ** and merged list
// items read as broken output (live failure 2026-08-08). Escape FIRST,
// then mark up: esc() has already neutralised '<', so every tag below is
// one we wrote.
function linkify(escaped) {
  return escaped
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    // Single newlines are the model's line breaks (list items, short
    // enumerations); paragraphs were already split on blank lines.
    .replace(/\n/g, '<br>');
}

function renderTurns() {
  // One model turn can render as SEVERAL assistant bubbles (tool call,
  // then narration). "Current" is everything after the last user message;
  // an ask's pills stay live until a user message answers them.
  let lastUser = -1;
  plan.turns.forEach((t, i) => { if (t.role === 'user') lastUser = i; });
  let html = '';
  plan.turns.forEach((t, i) => {
    if (t.role === 'user') {
      const long = (t.prose || '').length > PASTE_CHIP_CHARS;
      html += '<div class="turn-user">';
      if (long) {
        const open = !!plan.openChips[i];
        html += '<button type="button" class="pastechip" data-chip="' + i + '">' +
          '<span>' + (open ? '▾' : '▸') + '</span><span>pasted · ' + (t.prose.length > 999 ? (t.prose.length / 1000).toFixed(1) + 'k' : t.prose.length) + ' chars</span></button>' +
          (open ? '<div class="pastebody">' + esc(t.prose) + '</div>' : '');
      } else {
        html += esc(t.prose);
      }
      if ((t.attachments || []).length) {
        html += '<div class="att">attached: ' + t.attachments.map(esc).join(', ') + '</div>';
      }
      html += '</div>';
    } else {
      // A tool-only message (the model calls propose_rounds, then narrates
      // in the NEXT message) carries no words — the panel is its feedback.
      // Rendering it painted an empty bubble on every proposal turn.
      if (!(t.prose || '').trim() && !(t.questions && t.questions.length) && !(t.unreadable && t.unreadable.length)) return;
      html += '<div class="turn-planner' + (i > lastUser ? '' : ' history') + '">';
      for (const para of (t.prose || '').split('\n\n')) {
        if (para.trim()) html += '<p>' + linkify(esc(para.trim())) + '</p>';
      }
      // A link the fetch tool could not read is a dead end unless the
      // candidate hears about it — many sites (reddit.com among them) are
      // blocked at the tool layer, and their OWN links are the ones that
      // fail. Name the site, say why, point at the composer.
      if (t.unreadable && t.unreadable.length) {
        for (const u of t.unreadable) {
          let host = u.url;
          try { host = new URL(u.url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
          html += '<div class="unread"><b>' + esc(host) + '</b> — ' + esc(u.reason) +
            '. Paste the text here instead and I\'ll use it.</div>';
        }
      }
      html += '</div>';
    }
  });
  if (plan.busy) {
    html += '<div class="turn-planner"><p class="meta">working' +
      (plan.turns.length <= 1 ? ' — reading your material' : '') + '…</p>' +
      '<div class="progress"><div class="fill"></div></div></div>';
  }
  if (plan.error) html += '<p class="err">' + esc(plan.error) + '</p>';
  return html;
}

/** The plan panel: the ONE structured surface (Cowork's plan pane). */
function renderPanel() {
  const p = plan.proposal;
  let body = '';
  if (!p) {
    body = '<div class="paceline">' + (plan.busy ? 'thinking…' : 'the plan appears here as we talk') + '</div>';
  } else {
    const usable = [];
    const declined = [];
    p.drafts.forEach((d, i) => (d.unsupported ? declined : usable).push({ d, i }));
    const dated = usable.filter((x) => x.d.spec.date).sort((a, b) => (a.d.spec.date < b.d.spec.date ? -1 : 1));
    const ordered = dated.concat(usable.filter((x) => !x.d.spec.date));
    const openIdx = plan.gateOpen === null ? (ordered.length ? ordered[0].i : null) : plan.gateOpen;
    for (const { d, i } of ordered) {
      const included = plan.include[i] !== false;
      const tier = plan.tier[i] || d.spec.evidence_tier || 'public_prior';
      const open = i === openIdx;
      body += '<div class="gaterow' + (plan.flash ? ' flash' : '') + '">' +
        '<label class="gcheck"><input type="checkbox"' + (included ? ' checked' : '') + ' data-gi="' + i + '" /> ' +
        '<span style="color:' + (included ? 'var(--text-1)' : 'var(--text-2)') + '">' + esc(d.spec.label) + '</span></label>' +
        '<div class="gshape">' + specShapeLine(d.spec.capabilities) + '</div>' +
        '<div class="grow2">' +
        '<span class="gdate' + (d.spec.date ? '' : ' nodate') + '">' + specDateLine(d.spec) + '</span>' +
        '<button type="button" class="tier" data-ti="' + i + '" title="How this round is evidenced — click to override">' +
        esc(tier === 'public_prior' ? 'public' : tier) + '</button>' +
        '<button type="button" class="gexpand" data-gx="' + i + '" aria-expanded="' + open + '">' + (open ? 'why ▴' : 'why ▾') + '</button>' +
        '</div>' +
        (open ? '<div class="gatedetail"><b>Why this shape:</b> ' + esc(d.rationale || '') + '</div>' : '') +
        '</div>';
    }
    for (const { d } of declined) {
      body += '<div class="gatedecline">' + esc(d.spec.label) + ' — can\'t run honestly: ' + esc(d.unsupported) + '</div>';
    }
    body += '<div class="paceline">' +
      (p.pace_per_week
        ? p.pace_per_week + ' rounds/week — from your answer'
        : '3 rounds/week — default until you tell me your daily time') + '</div>';
  }
  const n = p ? p.drafts.filter((d, i) => !d.unsupported && plan.include[i] !== false).length : 0;
  return '<aside id="plan-panel">' +
    '<div class="phead"><p class="micro">The plan</p>' +
    '<div class="meta">nothing is generated until you confirm</div></div>' +
    '<div class="pbody">' + body + '</div>' +
    '<div class="pfoot"><button id="gate-confirm" class="primary" type="button"' + (n === 0 ? ' disabled' : '') + '>' +
    (n === 1 ? 'Confirm 1 round and build the plan' : 'Confirm ' + n + ' rounds and build the plan') + '</button>' +
    '<span class="meta" id="gate-note"></span></div>' +
    '</aside>';
}

/** The open question, if any: the latest ask with no user message after it
 *  and no dismissal. Options are pinned to the composer rather than left in
 *  the transcript — scrolling back to find a live control is not a UI. */
function pendingAsk() {
  let lastUser = -1;
  let ask = null;
  plan.turns.forEach((t, i) => {
    if (t.role === 'user') { lastUser = i; ask = null; return; }
    if (t.questions && t.questions.length && i > lastUser) ask = { turn: i, questions: t.questions };
  });
  if (!ask || plan.askDismissed === ask.turn || plan.busy) return null;
  return ask;
}

function renderAskCard() {
  const ask = pendingAsk();
  if (!ask) return '';
  let html = '<div id="plan-ask"><button type="button" id="ask-dismiss" aria-label="Dismiss and type instead">×</button>';
  ask.questions.forEach((q, qi) => {
    html += '<div class="askrow"><div class="askq">' + esc(q.question) + '</div><div class="askopts">';
    q.options.forEach((o, oi) => {
      // Indexes, not labels, ride the dataset — labels are model text.
      html += '<button type="button" class="qopt" data-t="' + ask.turn + '" data-q="' + qi + '" data-o="' + oi + '">' +
        esc(o.label) +
        (q.recommended === o.label ? '<span class="rec">suggested</span>' : '') +
        '</button>';
      if (o.detail) html += '<span class="optdetail">' + esc(o.detail) + '</span>';
    });
    html += '</div></div>';
  });
  return html + '<div class="askor">or just type your answer below</div></div>';
}

function renderComposer() {
  let chips = '';
  if (attachments.length) {
    chips = '<div id="plan-attach">' + attachments.map((a, i) =>
      '<div class="attach"><span class="name">' + esc(a.name) + '</span>' +
      '<span class="kind">' + esc(a.kind) + '</span>' +
      '<button type="button" data-i="' + i + '" aria-label="remove ' + esc(a.name) + '">×</button></div>'
    ).join('') + '</div>';
  }
  return '<div id="plan-composer">' + renderAskCard() + chips +
    '<div class="row">' +
    '<textarea id="plan-msg" rows="2" aria-label="Message the planner" placeholder="' +
    (plan.tid ? 'Answer, correct me, or ask what a round shape is' : 'Describe the interview — paste everything you have') + '"' +
    (plan.busy || plan.readOnly ? ' disabled' : '') + '></textarea>' +
    '<button id="plan-attach-btn" class="mini" type="button" style="min-height:40px"' + (plan.readOnly ? ' disabled' : '') + '>Attach</button>' +
    '<button id="plan-send" type="button"' + (plan.busy || plan.readOnly ? ' disabled' : '') + '>Send</button></div>' +
    '<div class="linkrow"><input id="plan-link" placeholder="add a link (optional) — a repo, a thread, a writeup" aria-label="Add a link (optional)" />' +
    '<button id="plan-addlink" type="button">add</button></div>' +
    '<div class="helper">Correct me where I am wrong. What you saw yourself outranks anything I find.</div>' +
    '</div>';
}

function renderPlan() {
  if (route().page !== 'new') return;
  const f = el('entry-flow');
  const prevMsg = el('plan-msg') ? el('plan-msg').value : '';
  const prevLink = el('plan-link') ? el('plan-link').value : '';
  const focusId = document.activeElement ? document.activeElement.id : '';
  const hadFocus = focusId === 'plan-msg';

  let chat = '';
  if (!plan.tid && plan.turns.length === 0) {
    chat = '<div id="plan-intro">Describe the interview you\'re preparing for — company, what the recruiter said, ' +
      'what a friend told you, a screenshot of the assessment preview. Paste everything; I\'ll sort out what matters ' +
      'and build a practice plan you confirm before anything is generated.</div>' +
      (plan.error ? '<p class="err">' + esc(plan.error) + '</p>' : '');
  } else {
    chat = renderTurns();
  }

  const hasPanel = Boolean(plan.tid || plan.turns.length);
  f.innerHTML = '<div id="plan-wrap"' + (hasPanel ? '' : ' class="nopanel"') + '>' +
    '<div id="plan-main"><div id="plan-chat">' + chat + '</div>' + renderComposer() + '</div>' +
    (hasPanel ? renderPanel() : '') +
    '</div>';
  plan.flash = false;

  if (el('plan-msg')) {
    el('plan-msg').value = prevMsg;
    if (hadFocus) el('plan-msg').focus();
  }
  if (el('plan-link')) {
    el('plan-link').value = prevLink;
    if (focusId === 'plan-link') el('plan-link').focus();
  }
  wirePlan(f);
  // The PAGE scrolls, not #plan-chat — scroll to the composer when a new
  // turn arrived so the reply is never invisible below the fold (QA
  // ISSUE-002). Count-gated: re-renders from tier clicks etc. must not yank.
  if (plan.turns.length !== renderedTurnCount) {
    renderedTurnCount = plan.turns.length;
    if (plan.turns.length && el('plan-composer')) el('plan-composer').scrollIntoView({ block: 'end' });
  }
}

function wirePlan(f) {
  const send = () => {
    const box = el('plan-msg');
    const text = box.value.trim();
    if (plan.busy) return;
    if (!plan.tid) {
      // Chips alone are a valid intake — a candidate who pasted Erik's
      // messages has said plenty without typing a word.
      if (!text && attachments.length === 0) return;
      box.value = '';
      planFirstSend(text);
      return;
    }
    // Mid-conversation, link/pasted chips ride the message itself — the
    // target's context field was consumed by the kickoff and /api/plan/turn
    // takes only text. Without this, a chip added later silently vanished.
    const extra = buildContext();
    if (!text && !extra) return;
    box.value = '';
    const message = text + (extra ? (text ? '\n\n' : '') + extra : '');
    for (let i = attachments.length - 1; i >= 0; i--) {
      if (!attachments[i].data) attachments.splice(i, 1);
    }
    plan.turns.push({ role: 'user', at: new Date().toISOString(), prose: message });
    planTurn(message);
  };
  if (el('plan-send')) el('plan-send').addEventListener('click', send);
  if (el('plan-msg')) {
    el('plan-msg').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    // A long paste becomes a chip, not a wall (Cowork treatment).
    el('plan-msg').addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (text && text.length > PASTE_CHIP_CHARS) {
        e.preventDefault();
        attachments.push({ kind: 'pasted', name: 'pasted · ' + (text.length > 999 ? (text.length / 1000).toFixed(1) + 'k' : text.length) + ' chars', content: text });
        renderPlan();
      }
    });
  }
  if (el('ask-dismiss')) el('ask-dismiss').addEventListener('click', () => {
    const ask = pendingAsk();
    if (ask) plan.askDismissed = ask.turn;
    renderPlan();
    if (el('plan-msg')) el('plan-msg').focus();
  });
  if (el('plan-attach-btn')) el('plan-attach-btn').addEventListener('click', () => el('e-file').click());
  const addLink = () => {
    const box = el('plan-link');
    let url = (box.value || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    attachments.push({ kind: 'link', name: url, content: url });
    box.value = '';
    renderPlan();
  };
  if (el('plan-addlink')) el('plan-addlink').addEventListener('click', addLink);
  if (el('plan-link')) el('plan-link').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addLink(); }
  });
  const attach = el('plan-attach');
  if (attach) {
    for (const b of attach.querySelectorAll('button[data-i]')) {
      b.addEventListener('click', () => { attachments.splice(Number(b.dataset.i), 1); renderPlan(); });
    }
  }
  for (const b of f.querySelectorAll('.qopt')) {
    b.addEventListener('click', () => {
      if (plan.busy) return;
      const turn = plan.turns[Number(b.dataset.t)];
      const q = turn && turn.questions && turn.questions[Number(b.dataset.q)];
      const opt = q && q.options[Number(b.dataset.o)];
      if (!opt) return;
      plan.turns.push({ role: 'user', at: new Date().toISOString(), prose: opt.label });
      planTurn(opt.label);
    });
  }
  for (const b of f.querySelectorAll('[data-chip]')) {
    b.addEventListener('click', () => {
      plan.openChips[Number(b.dataset.chip)] = !plan.openChips[Number(b.dataset.chip)];
      renderPlan();
    });
  }
  for (const cb of f.querySelectorAll('.gcheck input[type="checkbox"]')) {
    cb.addEventListener('change', () => {
      plan.include[Number(cb.dataset.gi)] = cb.checked;
      renderPlan();
    });
  }
  for (const b of f.querySelectorAll('.tier')) {
    b.addEventListener('click', () => {
      // Free override in both directions (T2 decision B, 2026-08-07): the
      // candidate's plan, the candidate's call. The planner's own rating is
      // still what it proposed — this only changes the stored tier.
      const order = ['firsthand', 'secondhand', 'public_prior'];
      const i = Number(b.dataset.ti);
      const d = plan.proposal.drafts[i];
      const cur = plan.tier[i] || d.spec.evidence_tier || 'public_prior';
      plan.tier[i] = order[(order.indexOf(cur) + 1) % order.length];
      plan.flash = true;
      renderPlan();
    });
  }
  for (const b of f.querySelectorAll('.gexpand')) {
    b.addEventListener('click', () => { plan.gateOpen = Number(b.dataset.gx); renderPlan(); });
  }
  if (el('gate-confirm')) el('gate-confirm').addEventListener('click', async () => {
    const p = plan.proposal;
    const kept = [];
    p.drafts.forEach((d, i) => {
      if (d.unsupported || plan.include[i] === false) return;
      const tier = plan.tier[i] || d.spec.evidence_tier;
      kept.push(Object.assign({}, d.spec, tier ? { evidence_tier: tier } : {}));
    });
    if (!kept.length) return;
    el('gate-confirm').disabled = true;
    el('gate-note').textContent = 'building your plan…';
    const r = await fetch('/api/accept-spec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_id: plan.tid, specs: kept, pace_per_week: p.pace_per_week }),
    });
    const sBody = await r.json();
    if (sBody.error) {
      el('gate-confirm').disabled = false;
      el('gate-note').textContent = '';
      plan.error = sBody.error;
      renderPlan();
      return;
    }
    // The payoff moment: the whole season appears NOW.
    const id = plan.tid;
    resetPlan();
    flowTargetId = null;
    window.location.hash = '#/t/' + encodeURIComponent(id);
    refresh(true);
  });
}

// The #e-file input is shared by the plan composer and the practice door;
// re-render whichever surface owns the current route.
function rerenderComposerHost() {
  if (route().page === 'practice') renderPractice();
  else renderPlan();
}

// Binary/text file attach — the input lives in static HTML so this binds once.
el('e-file').addEventListener('change', () => {
  for (const file of el('e-file').files) {
    const kind = BINARY_KINDS[file.type];
    const reader = new FileReader();
    if (kind) {
      if (file.size > 10 * 1024 * 1024) {
        const msg = file.name + ' is over 10MB — trim it down';
        if (route().page === 'practice') rep.error = msg; else plan.error = msg;
        rerenderComposerHost();
        continue;
      }
      reader.onload = () => {
        attachments.push({ kind, name: file.name, media_type: file.type, data: String(reader.result).split(',')[1] || '' });
        rerenderComposerHost();
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => {
        attachments.push({ kind: 'file', name: file.name, content: String(reader.result).slice(0, 100_000) });
        rerenderComposerHost();
      };
      reader.readAsText(file);
    }
  }
  el('e-file').value = '';
});


// ---- the practice door (CEO + design reviews, 2026-08-08) ----
// Paste what you gathered, confirm the inferred shape, one rep — no target,
// no queue, no pace. State lives OUTSIDE the DOM (the plan/adapt pattern)
// so the 5s poll can't destroy a half-typed correction. The readback shows
// a menu ONLY where a closed vocabulary exists (check.kind); language /
// size / difficulty are open blueprint prose and render as editable text —
// affordance matches constraint (design D4).

const rep = {
  phase: 'input',        // input | clarifying | confirm | started
  repId: null,           // client-generated at confirm so a double-click
                         // carries the SAME id into the server's mkdir lock
  description: '',
  drafts: [], questions: [], answers: [], chosen: 0,
  overrides: { language: '', size: '', difficulty: '' },
  error: '',
};

function resetRep() {
  rep.phase = 'input'; rep.repId = null; rep.description = '';
  rep.drafts = []; rep.questions = []; rep.answers = []; rep.chosen = 0;
  rep.overrides = { language: '', size: '', difficulty: '' };
  rep.error = '';
}

// The closed vocabulary, human-labeled. These four ARE all the round kinds
// the validator can prove — an honest menu (anything else is prose).
const REP_KINDS = [
  ['one_failing_test', 'Debugging'],
  ['all_failing', 'Build to a test suite'],
  ['all_passing', 'Extend / refactor (keep green)'],
  ['diff_present', 'Code review'],
];

function repKindLabel(kind) {
  const hit = REP_KINDS.find((k) => k[0] === kind);
  return hit ? hit[1] : kind;
}

function renderPractice() {
  if (route().page !== 'practice') return;
  const host = el('practice-flow');
  const paste = el('rep-paste');
  const keep = paste ? paste.value : rep.description;
  const keepLink = el('rep-link') ? el('rep-link').value : '';
  const chips = attachments.length
    ? '<div id="plan-attach">' + attachments.map((a, i) =>
        '<span class="attach"><span class="name">' + esc(a.name) + '</span>' +
        '<button type="button" data-ri="' + i + '" aria-label="remove ' + esc(a.name) + '">×</button></span>').join('') + '</div>'
    : '';
  let html = '<div id="practice-wrap">';
  if (rep.phase === 'started') {
    html += renderRepWait() + '</div>';
    host.innerHTML = html;
    for (const b of host.querySelectorAll('.repstart')) {
      b.addEventListener('click', () => launchRep(b.dataset.rep, b));
    }
    for (const b of host.querySelectorAll('.repretry')) {
      b.addEventListener('click', () => repRetry(b.dataset.rep, b));
    }
    return;
  }
  // The hero IS the textarea's label (label-in-h1: heading semantics and the
  // a11y association in one element — the real-labels rule, no duplication).
  html += '<h1 class="hero"><label for="rep-paste">What are you preparing for?</label></h1>' +
    '<textarea id="rep-paste" placeholder=""></textarea>' + chips +
    '<div class="metaline">paste a recruiter email, a JD, a friend’s description — ' +
    '<a href="#" id="rep-attach">attach a file</a></div>' +
    // The explicit link input (planner precedent, user call 2026-08-07:
    // affordances beat discovery). Honest copy: the practice path never
    // fetches — a link rides along with the notes as-is.
    '<div class="linkrow"><input id="rep-link" placeholder="add a link (optional) — the posting, a thread; it rides along with your notes" aria-label="Add a link (optional)" />' +
    '<button id="rep-addlink" type="button">add</button></div>';

  if (rep.phase === 'confirm' && rep.drafts.length) {
    const d = rep.drafts[rep.chosen];
    const kind = d.spec.check.kind;
    html += '<div class="micro" style="margin-top:22px">Inferred shape</div>' +
      '<div class="rep-shape">' +
      '<label for="rep-kind">round type</label>' +
      '<select id="rep-kind">' + REP_KINDS.map((k) =>
        '<option value="' + k[0] + '"' + (k[0] === kind ? ' selected' : '') + '>' + k[1] + '</option>').join('') + '</select>' +
      '<span class="shape-seg"><span class="shape-word">in</span>' +
      '<label for="rep-lang">language</label>' +
      '<input id="rep-lang" value="' + esc(rep.overrides.language) + '" placeholder="any language" style="width:13ch"></span>' +
      '<span class="shape-seg"><span class="shape-word">· about</span>' +
      '<label for="rep-size">size in files</label>' +
      '<input id="rep-size" inputmode="numeric" value="' + esc(rep.overrides.size) + '" placeholder="' +
        esc(String(d.spec.check.max_source_files || '')) + '" style="width:5ch">' +
      '<span class="shape-word">files</span></span>' +
      '<span class="shape-seg"><span class="shape-word">·</span>' +
      '<label for="rep-diff">difficulty</label>' +
      '<input id="rep-diff" value="' + esc(rep.overrides.difficulty) + '" placeholder="medium" style="width:9ch">' +
      '<span class="shape-word">difficulty</span></span>' +
      '</div>' +
      '<div class="metaline">' + esc(specShapeLine(d.spec.capabilities)) + '</div>';
    if (rep.questions.length) {
      // The clarifier genuinely couldn't guess — its questions render inline,
      // options as pills (the ask-card pattern); an answer re-infers.
      for (let qi = 0; qi < rep.questions.length; qi++) {
        const q = rep.questions[qi];
        html += '<div class="askrow" style="margin-top:14px"><div class="askq">' + esc(q.question) + '</div><div class="askopts">' +
          q.options.map((o, oi) =>
            '<button type="button" class="qopt" data-q="' + qi + '" data-o="' + oi + '">' + esc(o.label) +
            (q.recommended === o.label ? ' <span class="rec">suggested</span>' : '') + '</button>').join('') +
          '</div></div>';
      }
    }
    html += '<div id="rep-note">not right? change it above, or say so below — plain words work</div>' +
      '<div class="row" style="display:flex;gap:8px;margin-top:6px">' +
      '<label for="rep-change" class="rep-srlabel" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">what should be different</label>' +
      '<input id="rep-change" placeholder="e.g. actually it’s Rust, and harder" style="flex:1;background:var(--panel);color:var(--text-1);border:1px solid var(--line);border-radius:6px;padding:10px 12px;font:inherit;min-height:44px">' +
      '<button type="button" id="rep-rechecks" class="mini" style="min-height:44px">apply</button></div>';
  }
  if (rep.phase === 'clarifying') {
    html += '<div class="metaline" style="margin-top:18px">reading your notes…</div>' +
      '<div class="progress"><div class="fill"></div></div>';
  }
  if (rep.error) html += '<div class="err" style="margin-top:12px">' + esc(rep.error) + '</div>';
  html += '<div class="rep-actions">' +
    (rep.phase === 'confirm'
      ? '<button type="button" class="primary" id="rep-start">Start →</button>'
      : rep.phase === 'input'
        ? '<button type="button" class="primary" id="rep-infer">Read my notes →</button>'
        : '') +
    '</div></div>';
  host.innerHTML = html;
  const pasteEl = el('rep-paste');
  if (pasteEl) pasteEl.value = keep;
  if (el('rep-link')) el('rep-link').value = keepLink;
  wirePractice();
}

/** The wait state (design 4A): honest elapsed from the .generating marker,
 *  the shape named in plain words, and explicit permission to leave. */
function renderRepWait() {
  const mine = (lastReps || []).find((x) => x.id === rep.repId);
  if (!mine) {
    return '<div class="micro">Building your round</div><div class="metaline">starting…</div>';
  }
  if (mine.status === 'ready') {
    return '<div class="micro">Ready</div>' +
      '<h2 style="margin:10px 0 4px">' + esc(mine.title) + '</h2>' +
      '<div class="metaline">' + esc(specShapeLine(mine.spec.capabilities)) + '</div>' +
      '<div class="rep-actions"><button type="button" class="primary repstart" data-rep="' + esc(mine.id) + '">Start session →</button></div>';
  }
  if (mine.status === 'failed') {
    return '<div class="micro">Build failed</div>' +
      '<div class="err" style="margin:10px 0">' + (mine.phase === 'draft_failed'
        ? 'couldn’t shape the round from your notes — retry, or start over with more detail'
        : 'the build died partway — retry usually works') + '</div>' +
      '<div class="rep-actions"><button type="button" class="mini repretry" data-rep="' + esc(mine.id) + '">Retry</button></div>';
  }
  const g = mine.generating || {};
  return '<div class="micro">Building your round</div>' +
    '<h2 style="margin:10px 0 4px">' + esc(mine.label) + '</h2>' +
    '<div class="metaline">' +
      (mine.phase === 'drafting' ? 'shaping the round' : genProgressLine(mine)) +
      (mine.phase === 'drafting' && g.since ? ' · <span class="genclock" data-since="' + esc(g.since) + '"></span>' : '') +
    '</div>' +
    '<div class="progress"><div class="fill det" data-since="' + esc(g.since || '') + '"></div></div>' +
    '<p class="meta" style="margin-top:16px">You can close this. It’ll be waiting under <b>history</b> — the tab title flips when it’s ready (~5 min).</p>';
}

function wirePractice() {
  const attach = el('rep-attach');
  if (attach) attach.addEventListener('click', (e) => { e.preventDefault(); el('e-file').click(); });
  const addRepLink = () => {
    const box = el('rep-link');
    let url = (box.value || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    attachments.push({ kind: 'link', name: url, content: url });
    box.value = '';
    renderPractice();
  };
  if (el('rep-addlink')) el('rep-addlink').addEventListener('click', addRepLink);
  if (el('rep-link')) el('rep-link').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addRepLink(); }
  });
  const f = el('practice-flow');
  for (const b of f.querySelectorAll('[data-ri]')) {
    b.addEventListener('click', () => { attachments.splice(Number(b.dataset.ri), 1); renderPractice(); });
  }
  const infer = el('rep-infer');
  if (infer) infer.addEventListener('click', () => practiceClarify());
  const paste = el('rep-paste');
  if (paste) paste.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) practiceClarify();
  });
  for (const b of f.querySelectorAll('.qopt')) {
    b.addEventListener('click', () => {
      const q = rep.questions[Number(b.dataset.q)];
      const o = q.options[Number(b.dataset.o)];
      practiceClarify(rep.answers.concat([{ question: q.question, answer: o.label }]));
    });
  }
  const kind = el('rep-kind');
  if (kind) kind.addEventListener('change', () => {
    // A check.kind flip has coherence consequences (can_run_tests,
    // starts_from…) that live in the server's draftToSpec gate — re-infer
    // with the choice as an answer instead of editing the spec by hand.
    practiceClarify(rep.answers.concat([
      { question: 'Which round shape should this practice be?', answer: repKindLabel(kind.value) },
    ]));
  });
  const recheck = el('rep-rechecks');
  if (recheck) recheck.addEventListener('click', () => {
    const change = el('rep-change');
    if (!change || !change.value.trim()) return;
    rep.description = rep.description + '\n\nCorrection: ' + change.value.trim();
    practiceClarify(rep.answers);
  });
  const change = el('rep-change');
  if (change) change.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el('rep-rechecks').click(); }
  });
  for (const [lang, key] of [['rep-lang', 'language'], ['rep-size', 'size'], ['rep-diff', 'difficulty']]) {
    const input = el(lang);
    if (input) input.addEventListener('input', () => { rep.overrides[key] = input.value; });
  }
  const start = el('rep-start');
  if (start) start.addEventListener('click', () => practiceStart(start));
}

async function practiceClarify(answers) {
  const paste = el('rep-paste');
  if (paste && rep.phase === 'input') rep.description = paste.value;
  if (paste && rep.phase === 'confirm') rep.description = paste.value + (rep.description.includes('\n\nCorrection: ') ? rep.description.slice(rep.description.indexOf('\n\nCorrection: ')) : '');
  if (!rep.description.trim()) { rep.error = 'describe the round in a sentence or two first'; renderPractice(); return; }
  rep.phase = 'clarifying'; rep.error = ''; rep.answers = answers || [];
  renderPractice();
  const r = await fetch('/api/practice/clarify', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      description: rep.description,
      context: buildContext(),
      answers: rep.answers.length ? rep.answers : undefined,
      attachments: buildBinaryAttachments(),
    }),
  });
  const s = await r.json();
  if (s.error) { rep.phase = rep.drafts.length ? 'confirm' : 'input'; rep.error = s.error; renderPractice(); return; }
  rep.drafts = s.drafts || []; rep.questions = s.questions || []; rep.chosen = 0;
  // The rep id is minted at confirm-render, ONCE — Start can be mashed and
  // every click carries this same id into the server's mkdir lock.
  rep.repId = rep.repId || 'rep-' + Date.now().toString(36);
  rep.phase = 'confirm';
  renderPractice();
}

async function practiceStart(btn) {
  const d = rep.drafts[rep.chosen];
  if (!d) return;
  btn.disabled = true; btn.textContent = 'Starting…';
  const spec = JSON.parse(JSON.stringify(d.spec));
  const size = parseInt(rep.overrides.size, 10);
  if (Number.isInteger(size) && size >= 1) spec.check.max_source_files = size;
  // Language/difficulty are open blueprint prose, not spec vocabulary —
  // they ride into the drafter as context lines (design D4).
  const prose = [
    rep.overrides.language ? 'Language: ' + rep.overrides.language : '',
    rep.overrides.difficulty ? 'Difficulty: ' + rep.overrides.difficulty : '',
  ].filter(Boolean).join('\n');
  const r = await fetch('/api/practice', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rep_id: rep.repId,
      spec,
      description: rep.description,
      context: [buildContext(), prose].filter(Boolean).join('\n\n') || undefined,
    }),
  });
  const s = await r.json();
  if (s.error && !String(s.error).startsWith('already building')) {
    btn.disabled = false; btn.textContent = 'Start →'; rep.error = s.error; renderPractice(); return;
  }
  rep.phase = 'started';
  renderPractice();
  refresh(true);
}

async function launchRep(repId, btn) {
  repReadyUnseen = false;
  // origin is per call site, never defaulted — the falsifier metric divides
  // on it (2026-08-10 CEO review).
  await launchCommon('/api/practice/launch', { rep_id: repId, origin: 'practice' }, btn, 'Start session →');
}

async function repRetry(repId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Retrying…'; }
  const r = await fetch('/api/practice/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rep_id: repId }) });
  const s = await r.json();
  if (s.error) {
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; launchStatus(btn, s.error, true); }
    return;
  }
  refresh(true);
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
  // "+ new plan" moved here from the masthead when the tabs took its slot —
  // plan creation belongs to the plans page (design 2026-08-10).
  let html = '<h2 class="daysleft" style="font-size:15px">your plans' +
    ' <a href="#/new" class="addlink">+ new plan</a></h2>';
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
// ---- the landing's one status line (design round2-A-minimal, 2026-08-10):
//      everything the old strip and NEXT row said, compressed to a sentence.
//      Repainted every poll — it lives OUTSIDE the composer's repaint guard,
//      so it stays fresh while a half-typed correction stays protected. ----
function renderHomeStatus(state) {
  const host = el('home-status');
  if (!host) return;
  const bits = [];
  // Practice segment — suppressed while the wait card is up (it already
  // says "building" in a much bigger voice).
  if (rep.phase !== 'started') {
    const reps = state.reps || [];
    const building = reps.find((x) => x.status === 'generating');
    const ready = reps.filter((x) => x.status === 'ready').length;
    if (building) {
      const since = (building.generating || {}).since;
      bits.push('building your round' +
        (since ? ' · <span class="genclock" data-since="' + esc(since) + '"></span>' : ''));
    } else if (ready > 0) {
      bits.push('<a href="#/history">' + ready + ' ready →</a>');
    }
  }
  // Plans segment — the first target (already nearest-deadline-first) with an
  // actionable today row; countdown via the same roundDates the plan cards use.
  for (const row of state.targets || []) {
    const today = (row.days || []).find((d) => d.kind === 'day' && d.today && (d.items || []).length);
    if (!today) continue;
    const upcoming = roundDates(row.target).filter((r) => !r.passed);
    const n = upcoming.length ? daysUntil(upcoming[0].date) : null;
    bits.push('<a href="#/plans">next planned: ' + esc(row.target.label) +
      (n === null ? '' : ' in <span class="in-days">' + n + 'd</span>') + ' →</a>');
    break;
  }
  host.innerHTML = bits.length ? '<div class="statusline">' + bits.join(' · ') + '</div>' : '';
}

// ---- practice history (#/history): the reps strip, extracted from the old
//      index when the composer took over '#/' (2026-08-10). Failed ≠ ready
//      visually, the empty state is a door, and judged cards work for free —
//      reps carry a session_id and the card store is session-keyed. ----
function renderHistory(state) {
  const reps = state.reps || [];
  let html = '<div class="rep-strip"><h2 class="daysleft" style="font-size:15px">practice history</h2>';
  if (!reps.length) {
    html += '<div class="meta">No practice yet — <a href="#/">paste a JD or recruiter email</a> and be mid-problem in ten minutes. No plan needed.</div>';
  }
  for (const x of reps) {
    const shape = x.spec && x.spec.capabilities ? specShapeLine(x.spec.capabilities) : '';
    let line = '';
    let action = '';
    if (x.status === 'generating') {
      line = (x.phase === 'drafting' ? 'shaping the round' : genProgressLine(x));
    } else if (x.status === 'ready') {
      line = 'ready · ' + shape;
      if (!state.session_live) action = '<button type="button" class="primary repstart" data-rep="' + esc(x.id) + '">Start</button>';
    } else if (x.status === 'failed') {
      line = '<span class="err">' + (x.phase === 'draft_failed' ? 'couldn’t shape the round from those notes' : 'build failed') + '</span>';
      action = '<button type="button" class="mini repretry" data-rep="' + esc(x.id) + '">Retry</button>';
    } else if (x.status === 'done') {
      line = 'done' + (x.done_at ? ' · ' + fmtDate(x.done_at) : '');
      if (x.session_id) action = feedbackToggle({ session_id: x.session_id });
    } else {
      line = x.status;
    }
    html += '<div class="reprow"><div class="grow"><b>' + esc(x.title || x.label) + '</b>' +
      '<div class="metaline">' + line + '</div>' +
      feedbackPanel({ session_id: x.session_id }) +
      '</div>' + action + '</div>';
  }
  html += '</div>';
  const host = el('history');
  host.innerHTML = html;
  for (const b of host.querySelectorAll('.repstart')) {
    b.addEventListener('click', () => launchRep(b.dataset.rep, b));
  }
  for (const b of host.querySelectorAll('.repretry')) {
    b.addEventListener('click', () => repRetry(b.dataset.rep, b));
  }
  for (const a of host.querySelectorAll('a.fbtoggle')) {
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
}

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

// ---- the rep return signal (design 2A): the user is INVITED to close the
//      tab during a ~5-min build, so the tab itself says when to come back —
//      title flips, favicon plate fills. No notification permission prompt.
let lastReps = [];
let repWasGenerating = new Set();
let repReadyUnseen = false;
const FAVICON_EL = document.querySelector('link[rel="icon"]');
const FAVICON_IDLE = FAVICON_EL ? FAVICON_EL.href : '';
// Ready = the tile inverts: plate blue floods the ground and the Z drops to
// graphite. At 16px the color swap is the whole signal — the mark's internal
// fold is unreadable that small, so don't lean on it.
const FAVICON_READY = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%235099c2'/%3E%3Cpath d='M21.2 8 L45.5 8 L44.15 21.5 L36.5 42.5 L53.6 42.5 L42.8 56 L18.5 56 L19.85 42.5 L27.5 21.5 L10.4 21.5 Z' fill='%230e0e0f'/%3E%3C/svg%3E";

function trackRepSignal(state, page) {
  lastReps = state.reps || [];
  for (const x of lastReps) {
    if (x.status === 'ready' && repWasGenerating.has(x.id)) repReadyUnseen = true;
  }
  repWasGenerating = new Set(lastReps.filter((x) => x.status === 'generating').map((x) => x.id));
  // "Seen" means the ready rep is actually ON SCREEN: the history strip, or
  // the landing — where the status line now shows "N ready" in every phase
  // (the QA ISSUE-004 rationale, satisfied by the line itself).
  if (page === 'history' || page === 'practice') repReadyUnseen = false;
  if (FAVICON_EL) FAVICON_EL.href = repReadyUnseen ? FAVICON_READY : FAVICON_IDLE;
}

/** The tab is one of thirty. Name the page, and for a season put the
 *  countdown itself in the title — the days remaining are readable
 *  without switching to the tab. */
function setTitle(r, state) {
  // Rep signals outrank page names: "come back" is the one thing a
  // backgrounded tab can usefully say.
  if (repReadyUnseen) { document.title = '✓ Ready · Zenkai'; return; }
  const building = (state.reps || []).some((x) => x.status === 'generating');
  const prefix = building ? '(building) ' : '';
  if (r.page === 'practice') { document.title = prefix + 'Zenkai'; return; }
  if (r.page === 'plans') { document.title = prefix + 'your plans · Zenkai'; return; }
  if (r.page === 'history') { document.title = prefix + 'practice history · Zenkai'; return; }
  if (r.page === 'new') { document.title = prefix + 'new plan · Zenkai'; return; }
  if (r.page === 'timeline') {
    const row = state.targets.find((x) => x.target.id === r.id);
    if (row) {
      const n = daysUntil(row.target.interview_date);
      document.title = prefix + (n === null ? '' : n + ' days · ') + row.target.label;
      return;
    }
  }
  document.title = prefix + 'your plans · Zenkai';
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

  // Canonicalize the legacy practice route — the composer lives at '#/'
  // now. Same redirect-in-render pattern as the deleted-target fallback
  // below; hashchange re-renders, and its guard treats the transient and
  // the destination as one surface so composer state survives.
  if (window.location.hash.startsWith('#/practice')) {
    window.location.hash = '#/';
    return;
  }

  const r = route();
  trackRepSignal(state, r.page);
  setTitle(r, state);
  // The old zero-plans redirect to #/new is GONE (2026-08-10): the composer
  // at '#/' IS the correct page for someone with nothing set up — that's
  // the whole point of the flip. Data-driven redirects only.

  el('index').hidden = r.page !== 'plans';
  el('entry').hidden = r.page !== 'new';
  el('practice').hidden = r.page !== 'practice';
  el('history').hidden = r.page !== 'history';
  el('timeline').hidden = r.page !== 'timeline';
  // You-are-here: the active tab wears the steel underline (aria-current
  // drives the CSS, so wayfinding and a11y are one mechanism). The landing
  // marks no tab active — it's home, not a tab.
  if (r.page === 'plans') el('nav-plans').setAttribute('aria-current', 'page');
  else el('nav-plans').removeAttribute('aria-current');
  if (r.page === 'history') el('nav-history').setAttribute('aria-current', 'page');
  else el('nav-history').removeAttribute('aria-current');
  // The planning surface gets a wider page column for its two-pane layout.
  document.body.classList.toggle('wide', r.page === 'new');

  if (r.page === 'plans') {
    renderIndex(state);
    choreograph(el('index'), 'plans');
    return;
  }
  if (r.page === 'history') {
    renderHistory(state);
    return;
  }
  if (r.page === 'practice') {
    // input/confirm hold a half-typed correction — the poll must not repaint
    // under the user (the plan-page rule). The wait state has no inputs, so
    // it repaints freely and the phase flips (drafting → building → ready)
    // arrive within one poll. The status line is a sibling of the flow and
    // repaints on EVERY poll — it carries no inputs, only fresh state.
    if (rep.phase === 'started' || !el('practice-wrap')) renderPractice();
    renderHomeStatus(state);
    return;
  }
  if (r.page === 'new') {
    lastRouteKey = 'new';
    // The conversation owns the section; the poll must never repaint under
    // the user. Build the surface only when it isn't there yet.
    if (!el('plan-wrap')) renderPlan();
    return;
  }
  // timeline
  const row = state.targets.find((x) => x.target.id === r.id);
  if (!row) {
    window.location.hash = '#/plans';
    return;
  }
  const tl = el('timeline');
  tl.innerHTML = '<a href="#/plans" class="backlink">← all plans</a>' + renderSeason(row, state);
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

/** Shared launch: POST, then poll session-live until the editor is up —
 *  identical boot semantics for queue items and reps, one copy of the
 *  Docker error truth. */
async function launchCommon(endpoint, body, btn, idleLabel) {
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const s = await r.json();
  if (s.error) {
    if (btn) { btn.disabled = false; btn.textContent = idleLabel; launchStatus(btn, s.error, true); }
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
      btn.textContent = idleLabel;
      launchStatus(btn, "couldn't start — is Docker running? Try again.", true);
    }
  };
  tick();
}

async function launch(targetId, itemId, btn) {
  await launchCommon('/api/launch', { target_id: targetId, item_id: itemId, origin: 'plans' }, btn, 'Start');
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
