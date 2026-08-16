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

// ---- beta auth (WU4) ------------------------------------------------------
// Server truth: every /api/* route 401s without a valid JWT (cookie ip_jwt).
// This block only manages the token's lifecycle in the browser: acquire it
// (Google OAuth redirect or email OTP, both plain GoTrue REST — no SDK, the
// repo has a no-bundler rule), persist it (localStorage + cookie, the cookie
// is what the server reads), hand it to the session origin (#token fragment
// on session links), and clear it on 401. Auth off = this is all inert.
let authCfg = null; // {enabled, supabase_url?, anon_key?}
let loggedOut = false;
// Which auth tab is showing. Module-level so a re-render (mode swap, or an
// error path re-rendering the screen) does not bounce the user back to Sign in
// and lose the mode they picked.
let loginMode = 'in'; // 'in' | 'up'

/** The ONLY door to PostHog. The vendored bundle is served at a neutral path
 *  but ad blockers still kill it for a real slice of users, and then
 *  window.posthog simply does not exist — a bare posthog.* call anywhere in
 *  this file would throw inside whatever handler made it, breaking the button
 *  for exactly the users least likely to report it. app.test.ts pins that no
 *  bare call exists. Usage: track('capture', 'event', {...}),
 *  track('identify', id). */
function track(method) {
  try {
    if (window.posthog && typeof window.posthog[method] === 'function') {
      window.posthog[method].apply(window.posthog, [].slice.call(arguments, 1));
    }
  } catch (e) { /* analytics never break the app */ }
}

function jwt() { try { return window.localStorage.getItem('ip_jwt') || ''; } catch { return ''; } }
function setJwt(t) {
  try { window.localStorage.setItem('ip_jwt', t); } catch { /* private mode */ }
  document.cookie = 'ip_jwt=' + t + '; path=/; SameSite=Lax; max-age=86400' +
    (window.location.protocol === 'https:' ? '; Secure' : '');
}
function clearJwt() {
  try { window.localStorage.removeItem('ip_jwt'); } catch { /* private mode */ }
  document.cookie = 'ip_jwt=; path=/; max-age=0';
}
/** Session links carry the token as a fragment: the session origin is a
 *  different host, so the cookie does not travel — the chrome sets its own. */
function sessionHref(u) {
  return authCfg && authCfg.enabled && jwt()
    ? u + '#token=' + encodeURIComponent(jwt())
    : u;
}

function renderLogin(msg) {
  loggedOut = true;
  // The shell's sections live in #page — there is no <main> in appPage(), and
  // querying one returned null, so appendChild threw and killed initAuth: the
  // boot skeleton sat there forever and NO login box ever rendered. It stayed
  // invisible in local dev because auth is off without IP_SUPABASE_*, so
  // initAuth returns early and this function never runs. Found on the live box
  // (2026-08-12), the first time the logged-out path was ever exercised.
  const page = el('page');
  if (!page) return; // nothing sane to render into; leave the page as-is
  for (const s of page.querySelectorAll(':scope > section')) s.hidden = true;
  // render() is what normally removes the boot skeleton, and it never runs on
  // this path — without this the placeholder bars sit above the login box.
  const boot = el('boot');
  if (boot) boot.remove();
  let box = el('login');
  if (!box) {
    box = document.createElement('section');
    box.id = 'login';
    page.appendChild(box);
  }
  // The signed-out masthead keeps the mark only: practice/plans/history all
  // route into surfaces that 401 until there is a token, so linking them is a
  // broken affordance on the one screen that has to earn trust.
  const navright = document.querySelector('nav .navright');
  if (navright) navright.hidden = true;
  document.body.classList.add('wide');
  box.hidden = false;
  const signUp = loginMode === 'up';
  box.innerHTML =
    '<div class="loginpane">' +
    '<div class="loginsay">' +
    '<h1>Practice the interview you actually have.</h1>' +
    '<p class="desc">You describe the round you are facing. Zenkai generates a real repo with a real bug, ' +
    'sits an interviewer beside you who listens while you work, then grades the trace and aims the next ' +
    'one at what you missed.</p>' +
    '<dl class="expect">' +
    '<div><dt>The round</dt><dd>A real editor in your browser. About 45 minutes.</dd></div>' +
    '<div><dt>The interviewer</dt><dd>Speaks and listens. Asks why, not just what.</dd></div>' +
    '<div><dt>After</dt><dd>A graded card quoting what you actually said and did.</dd></div>' +
    '</dl></div>' +
    '<div class="loginbox">' +
    '<div class="modes" role="tablist">' +
    '<button class="mode" id="mode-in" type="button" role="tab" aria-selected="' + (signUp ? 'false' : 'true') + '">Sign in</button>' +
    '<button class="mode" id="mode-up" type="button" role="tab" aria-selected="' + (signUp ? 'true' : 'false') + '">Sign up</button>' +
    '</div>' +
    '<p class="loginfine">' + (signUp
      ? 'Free while in beta. Your first round can start right after.'
      : 'Welcome back. Your plans and graded rounds are where you left them.') + '</p>' +
    '<button id="login-google" class="primary" type="button">Continue with Google</button>' +
    '<div class="loginsep">or</div>' +
    '<div><label for="login-email">Email</label>' +
    '<div class="loginrow"><input id="login-email" type="email" placeholder="you@school.edu" autocomplete="email"></div></div>' +
    '<div><label for="login-pass">Password</label>' +
    '<div class="loginrow"><input id="login-pass" type="password"' +
      (signUp ? ' placeholder="at least 6 characters"' : '') +
      ' autocomplete="' + (signUp ? 'new-password' : 'current-password') + '"></div></div>' +
    '<button id="login-submit" class="primary" type="button">' + (signUp ? 'Create account' : 'Sign in') + '</button>' +
    '<p id="login-msg">' + esc(msg || '') + '</p>' +
    '<p class="loginfine">Free while in beta. Everyone shares one daily build budget, so rounds can run out before the day does.</p>' +
    '</div></div>';
  const say = (m, tone) => {
    const n = el('login-msg');
    n.textContent = m;
    n.classList.toggle('bad', tone === 'bad');
    n.classList.toggle('good', tone === 'good');
  };
  // Carry what was typed across the swap. Someone who fills the form, then
  // realises they need the other tab, should not start over.
  const swap = (mode) => {
    if (loginMode === mode) return;
    const typed = el('login-email').value;
    const pass = el('login-pass').value;
    loginMode = mode;
    renderLogin();
    el('login-email').value = typed;
    el('login-pass').value = pass;
  };
  el('mode-in').addEventListener('click', () => swap('in'));
  el('mode-up').addEventListener('click', () => swap('up'));
  el('login-google').addEventListener('click', () => {
    window.location.href = authCfg.supabase_url + '/auth/v1/authorize?provider=google&redirect_to=' +
      encodeURIComponent(window.location.origin + '/');
  });
  const gotrue = (p, body) => fetch(authCfg.supabase_url + '/auth/v1/' + p, {
    method: 'POST',
    headers: { apikey: authCfg.anon_key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Email + password, plain GoTrue REST (no SDK — the repo has a no-bundler
  // rule). Replaced the OTP/magic-code flow: a 6-digit code round-trips
  // through email, which is the one dependency this beta cannot rely on
  // (built-in Supabase SMTP is rate-limited to a handful an hour, and custom
  // SMTP was never set up). A password needs no delivery at all.
  //
  // The two tabs still mean something: `signup` refuses to sign an existing
  // user in, and `token` refuses to create an account, so a typo'd address
  // says so instead of silently minting a second empty account.
  const submit = async () => {
    const email = el('login-email').value.trim();
    const password = el('login-pass').value;
    if (!email) { say('enter your email first', 'bad'); return; }
    if (!password) { say('enter your password', 'bad'); return; }
    if (signUp && password.length < 6) { say('password needs at least 6 characters', 'bad'); return; }
    const btn = el('login-submit');
    btn.disabled = true;
    say('working');
    let r;
    try {
      r = signUp
        ? await gotrue('signup', { email, password })
        : await gotrue('token?grant_type=password', { email, password });
    } catch {
      btn.disabled = false;
      say('could not reach the sign-in service — try again', 'bad');
      return;
    }
    let body = {};
    try { body = await r.json(); } catch { /* a body-less error is still an error */ }
    btn.disabled = false;
    if (!r.ok) {
      // GoTrue puts the human-readable reason in msg or error_description.
      const why = String(body.msg || body.error_description || body.error || '');
      if (!signUp && /invalid login credentials/i.test(why)) {
        say('wrong email or password — or switch to Sign up if you are new', 'bad');
      } else if (signUp && /already|registered|exists/i.test(why)) {
        say('there is already an account with that email — switch to Sign in', 'bad');
      } else {
        say(why || 'that did not work (' + r.status + ') — try again', 'bad');
      }
      return;
    }
    if (!body.access_token) {
      // Signup succeeded but returned no session: Supabase has "Confirm
      // email" ON, so the account is pending a link this beta probably cannot
      // deliver. Say it plainly — the fix is the operator's (turn confirmation
      // off, or configure SMTP), not something the user can work around.
      say('account created — check your email to confirm it, then sign in', 'good');
      loginMode = 'in';
      return;
    }
    setJwt(body.access_token);
    window.location.reload();
  };
  el('login-submit').addEventListener('click', submit);
  // Enter submits from either field. A password form that needs a mouse is a
  // password form people abandon.
  for (const id of ['login-email', 'login-pass']) {
    el(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
}

async function initAuth() {
  try {
    authCfg = await (await fetch('/api/auth-config')).json();
  } catch {
    authCfg = { enabled: false }; // server unreachable: refresh() shows that
  }
  if (!authCfg.enabled) return true;
  // OAuth return lands as #access_token=… in the fragment.
  const h = window.location.hash || '';
  if (h.indexOf('access_token=') !== -1) {
    const p = new window.URLSearchParams(h.replace(/^#/, ''));
    const t = p.get('access_token');
    if (t) setJwt(t);
    window.history.replaceState(null, '', '#/');
  }
  if (!jwt()) { renderLogin(); return false; }
  showSignout();
  return true;
}

/**
 * Reveal the masthead's sign out. Driven by AUTH state — auth is on and this
 * browser holds a token — never by a successful /api/state.
 *
 * That distinction is the whole point (live report 2026-08-15: "I can't sign
 * out right now"). Visibility used to be set inside render(), and render is
 * exactly what does NOT run when the app is unhappy: a thrown state fetch
 * returns at the banner, and a render that throws returns at "this page is
 * out of date". Both leave a signed-in user with no exit — and a stuck app is
 * when you most want to leave the account, not least. The class is applied
 * once at boot and nothing clears it but renderLogin's own reload.
 */
function showSignout() {
  const s = el('nav-signout');
  if (s) s.classList.toggle('on', Boolean(authCfg && authCfg.enabled && jwt()));
}

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
// Assistant research reports run long; a HISTORY turn past this folds to its
// first sentence (the pastechip pattern). The CURRENT turn never folds — it
// may end in the question the candidate must read. Prompt-side brevity
// (prompts/planner.md) is the fix; this is the safety net for scrollback and
// resumed replays (owner report 2026-08-15: walls of research nobody read).
const PLANNER_FOLD_CHARS = 700;

const plan = {
  tid: null, turns: [], proposal: null, busy: false, error: '',
  gateOpen: null,          // panel row index whose rationale is expanded
  include: {},             // draft index -> checkbox state
  tier: {},                // draft index -> user's tier override (free, T2-B)
  openChips: {},           // turn index -> expanded paste chip
  flash: false,            // one render's worth of row-flash after an update
  readOnly: false,         // no API key: replay + confirm, but no sending
  askDismissed: null,      // turn index whose pinned options were waved off
  buildArmed: false,       // an unsettled build was clicked once; the second
                           // click ships it (owner request 2026-08-15).
                           // Transient — any other interaction disarms it.
};

let renderedTurnCount = 0; // autoscroll fires only when this grows

function resetPlan() {
  renderedTurnCount = 0;
  plan.tid = null; plan.turns = []; plan.proposal = null; plan.busy = false;
  plan.error = ''; plan.gateOpen = null; plan.include = {}; plan.tier = {};
  plan.openChips = {}; plan.flash = false; plan.readOnly = false; plan.askDismissed = null;
  plan.buildArmed = false;
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
    (c.submit === 'one_shot' ? 'graded once at submit' : 'graded as you go');
}

/** Same vocabulary as specShapeLine, compressed for the landing readout —
 *  the three words that distinguish one round shape from another. */
function specShapeShort(c) {
  return (c.interviewer ? 'live' : 'OA') + ' · ' +
    (c.time_limit_ms ? Math.round(c.time_limit_ms / 60000) + 'm' : 'untimed') + ' · ' +
    (c.starts_from === 'blank' ? 'from scratch' : c.starts_from === 'diff' ? 'review' : 'repo');
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
  // Talking to the planner is the opposite of "build it anyway".
  plan.buildArmed = false;
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
    // WTP gate. Status-checked before the error branch for the same reason as
    // launchCommon, plus one specific to this path: wirePlan's send() clears
    // the composer BEFORE calling here and there is no draft persistence
    // anywhere, so a gated user would lose everything they typed. Restore it.
    if (r.status === 402 && sBody.paywall && !paywallOpen) {
      plan.busy = false;
      if (text) plan.turns.pop();
      // Replay target if this ends in a Checkout redirect. Carries the typed
      // text, which the composer already cleared and nothing else persists.
      paywallIntent = { kind: 'plan', text: text };
      let proceed = false;
      try { proceed = await showPaywallGate(sBody.paywall); } catch { proceed = false; }
      if (proceed) { renderPlan(); planFirstSend(text); return; }
      const box = el('plan-msg');
      if (box && text) box.value = text; // their words, back where they left them
      renderPlan();
      return;
    }
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

/** The fold's one-line summary: the first sentence, capped. */
function firstSentence(s) {
  const m = (s || '').match(/^[\s\S]{0,158}?[.!?](?=\s|$)/);
  return m ? m[0].trim() : (s || '').slice(0, 140).trim() + '…';
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
      // A long HISTORY note folds to its first sentence; reuses the
      // pastechip toggle (indexes are per-turn, so user chips and fold
      // chips can't collide). Unreadable-link repairs render OUTSIDE the
      // fold below — a dead end must stay visible.
      const foldable = (t.prose || '').length > PLANNER_FOLD_CHARS && i <= lastUser;
      if (foldable && !plan.openChips[i]) {
        html += '<button type="button" class="pastechip foldnote" data-chip="' + i + '">' +
          '<span>▸</span><span>' + linkify(esc(firstSentence(t.prose))) + '</span>' +
          '<span class="foldmeta">· read the full note</span></button>';
      } else {
        if (foldable) {
          html += '<button type="button" class="pastechip foldnote" data-chip="' + i + '">' +
            '<span>▾</span><span>' + linkify(esc(firstSentence(t.prose))) + '</span></button>';
        }
        for (const para of (t.prose || '').split('\n\n')) {
          if (para.trim()) html += '<p>' + linkify(esc(para.trim())) + '</p>';
        }
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
    for (const { d, i } of declined) {
      // Decision 2B, applied to THIS door (live report 2026-08-15: an
      // Amazon HM round — half LP conversation, half live coding — was the
      // plan's ONLY draft, so the model's honest decline left "Confirm 0
      // rounds" with no way forward; the practice door already offers
      // "Build the closest version" on the same flag). The decline stays
      // the DEFAULT: the checkbox is opt-IN, and ticking it means "build
      // the closest supported version" — the spec beneath is a fully valid
      // round; unsupported is a caveat about fidelity, not a broken spec.
      const included = plan.include[i] === true;
      body += '<div class="gaterow gatedecline' + (plan.flash ? ' flash' : '') + '">' +
        '<label class="gcheck"><input type="checkbox"' + (included ? ' checked' : '') + ' data-gi="' + i + '" /> ' +
        '<span style="color:' + (included ? 'var(--text-1)' : 'var(--text-2)') + '">' + esc(d.spec.label) + '</span></label>' +
        '<div class="gshape">' + specShapeLine(d.spec.capabilities) + '</div>' +
        '<div class="gdeclinewhy">can\'t run honestly: ' + esc(d.unsupported) +
        (included ? '' : ' — tick to build the closest version anyway') + '</div>' +
        '</div>';
    }
    body += '<div class="paceline">' +
      (p.pace_per_week
        ? p.pace_per_week + ' rounds/week — from your answer'
        : '3 rounds/week — default until you tell me your daily time') + '</div>';
    // Season topics render BEFORE the confirm button freezes them: after
    // accept they are append-only (rounds bind to this list and the season
    // page counts drills over it).
    if (p.topics && p.topics.length) {
      body += '<div class="paceline gtopics">this season tests: ' +
        p.topics.map((t) => esc(t.label || t.id)).join(' · ') + '</div>';
    }
  }
  // Usable drafts count unless UNticked; declined drafts count only when
  // ticked — the model's decline is the default, overriding it is deliberate.
  const n = p ? p.drafts.filter((d, i) => (d.unsupported ? plan.include[i] === true : plan.include[i] !== false)).length : 0;
  const declinedOnly = Boolean(p) && n === 0 && p.drafts.some((d) => d.unsupported);
  // Soft readiness (owner decision 2026-08-15): the button never gates on
  // the model — the user outranks it — but the note beneath says whether
  // the shape is still moving. `summary` is the model's own settle signal
  // (prompts/planner.md); open questions keep it honest after a reopener.
  const asks = openAskCount();
  const settled = planSettled();
  // Armed = an unsettled build was clicked once and is waiting for a second
  // click. A settle landing in between makes the arming moot — the normal
  // one-click path is correct again.
  const armed = plan.buildArmed && !settled;
  const label = armed
    ? 'Build anyway →'
    : n === 1 ? 'Confirm 1 round and build the plan' : 'Confirm ' + n + ' rounds and build the plan';
  const note = !p ? ''
    : declinedOnly
      // Without this line the settled note read "ready when you are" above
      // a disabled button — a contradiction with no visible cause.
      ? 'every round here was declined — tick one above to build its closest version'
    : armed
      ? (asks ? asks + ' question' + (asks === 1 ? '' : 's') + ' still open. ' : 'The shape is still moving. ') +
        'Click again to build now, or keep talking to settle it.'
    : settled ? 'shape settled — ready when you are'
    : 'still working out the shape' +
      (asks ? ' — ' + asks + ' open question' + (asks === 1 ? '' : 's') + ' below' : '');
  const noteClass = armed ? ' armed' : settled ? ' settled' : '';
  return '<aside id="plan-panel">' +
    '<div class="phead"><p class="micro">The plan</p>' +
    '<div class="meta">nothing is generated until you confirm</div></div>' +
    '<div class="pbody">' + body + '</div>' +
    '<div class="pfoot"><button id="gate-confirm" class="primary' + (settled ? '' : ' pending') +
    '" type="button" aria-describedby="gate-note"' + (n === 0 ? ' disabled' : '') + '>' +
    label + '</button>' +
    '<div class="meta' + noteClass + '" id="gate-note">' + note + '</div></div>' +
    '</aside>';
}

/** The model's own settle signal: it writes `summary` once the loop's shape
 *  stops moving (prompts/planner.md), and no question may still be open.
 *  A SIGNAL, never a lock — `summary` is prompt-instructed, not enforced, so
 *  a model that never emits one must not be able to strand the plan. That is
 *  why the unsettled path is a speed bump (two clicks) and not a disable. */
function planSettled() {
  return Boolean(plan.proposal && plan.proposal.summary) && openAskCount() === 0;
}

/** Any interaction that isn't the build button itself cancels a pending
 *  "build anyway" — the armed state must survive only deliberate intent. */
function disarmBuild() {
  if (!plan.buildArmed) return false;
  plan.buildArmed = false;
  return true;
}

/** Open planner questions after the last user message. Unlike pendingAsk,
 *  neither dismissal nor a busy model is checked — waving the pills away
 *  doesn't make the plan more settled. */
function openAskCount() {
  let lastUser = -1;
  let n = 0;
  plan.turns.forEach((t, i) => {
    if (t.role === 'user') { lastUser = i; n = 0; return; }
    if (t.questions && t.questions.length && i > lastUser) n = t.questions.length;
  });
  return n;
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
    // The correction invitation earns its place only once there is
    // something to correct — before the first reply it read as noise
    // (QA 2026-08-15).
    (plan.tid ? '<div class="helper">Correct me where I am wrong. What you saw yourself outranks anything I find.</div>' : '') +
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
    // One sentence, not a briefing (QA 2026-08-15): the placeholder already
    // shows what to paste, and the trust line ('nothing generated until you
    // confirm') is the part worth saying twice.
    chat = '<div id="plan-intro">Describe the interview you\'re preparing for — paste everything you have ' +
      '(recruiter email, JD, screenshots). Nothing is generated until you confirm the plan.</div>' +
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
      // Mirror of the panel's count: declined ships only when ticked (2B —
      // the override is the user's), usable ships unless unticked.
      if (d.unsupported ? plan.include[i] !== true : plan.include[i] === false) return;
      const tier = plan.tier[i] || d.spec.evidence_tier;
      kept.push(Object.assign({}, d.spec, tier ? { evidence_tier: tier } : {}));
    });
    if (!kept.length) return;
    // Speed bump (owner request 2026-08-15): while the planner is still
    // clarifying, the first click ARMS rather than builds — the button
    // relabels to "Build anyway →" and the note says why. The second click
    // ships it. Never a disable: the settle signal is model-written, so a
    // planner that forgets it must not be able to strand the plan.
    if (!planSettled() && !plan.buildArmed) {
      plan.buildArmed = true;
      renderPlan();
      return;
    }
    plan.buildArmed = false;
    el('gate-confirm').disabled = true;
    // The accept is SLOW (queue sourcing + one naming call per spec) — the
    // same indeterminate bar the chat's busy state uses, not a bare line.
    el('gate-note').innerHTML = 'building your plan…<div class="progress"><div class="fill"></div></div>';
    const r = await fetch('/api/accept-spec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_id: plan.tid, specs: kept, pace_per_week: p.pace_per_week }),
    });
    const sBody = await r.json();
    if (sBody.error) {
      plan.error = sBody.error;
      renderPlan(); // button + note re-render from state
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
  busy: false,           // a re-infer is in flight; confirm STAYS rendered
  draftsStale: false,    // a shape answer settled locally and the drafts don't
                         // reflect it yet — Start re-checks before shipping (T3)
  recheckTimer: null,    // debounce handle for the background re-check
  recheckDirty: false,   // an answer landed mid-flight → re-fire once at landing
  startQueued: false,    // Start pressed while stale/in-flight — go at landing
  repId: null,           // client-generated at confirm so a double-click
                         // carries the SAME id into the server's mkdir lock
  description: '',
  drafts: [], questions: [], answers: [], chosen: 0,
  // The gap model (design review 2026-08-12): ONE list, two views — the
  // rail renders settled gaps, the question column renders open ones.
  gaps: [], brief: '', degraded: false,
  // The paste + attachment count that PRODUCED the current gaps. Step 1's
  // forward action compares against these: unchanged means going back to the
  // confirm screen is free, changed means an explicit regenerate.
  sourceText: null, sourceAttachN: 0,
  flashIds: [],          // gap ids to .flash after the next render, then cleared
  pendingFocus: null,    // gap id whose first control gets focus post-render
  editingGap: null,      // rail gap id whose editor is open (compact readback,
                         // owner report 2026-08-15) — transient, never persisted
  pendingEditFocus: null, // one-shot: focus that editor after the next render
  linkOpen: false,       // the link input appears on request, not by default
  error: '',
};

const REP_STORE_KEY = 'zenkai-rep-v1';

/** The wait phases used to ride the container's aria-live; that region is
 *  gone (decision 6A), so transitions announce themselves — once each. */
let lastWaitAnnounced = null;

function resetRep() {
  rep.phase = 'input'; rep.busy = false; rep.repId = null; rep.description = '';
  rep.draftsStale = false; rep.recheckDirty = false; rep.startQueued = false;
  if (rep.recheckTimer) { clearTimeout(rep.recheckTimer); rep.recheckTimer = null; }
  rep.drafts = []; rep.questions = []; rep.answers = []; rep.chosen = 0;
  rep.gaps = []; rep.brief = ''; rep.degraded = false;
  rep.sourceText = null; rep.sourceAttachN = 0;
  rep.flashIds = []; rep.pendingFocus = null;
  rep.editingGap = null; rep.pendingEditFocus = null;
  rep.linkOpen = false;
  rep.error = '';
  lastWaitAnnounced = null;
  try { sessionStorage.removeItem(REP_STORE_KEY); } catch { /* storage denied */ }
}

/** A refresh used to cost one textarea; with the gap screen it would cost a
 *  co-authoring session — the loss scales with how good the screen is (T10).
 *  Versioned key + discard-on-mismatch: schema drift falls back to blank. */
function saveRep() {
  try {
    sessionStorage.setItem(REP_STORE_KEY, JSON.stringify({
      phase: rep.phase, repId: rep.repId, description: rep.description,
      drafts: rep.drafts, chosen: rep.chosen, gaps: rep.gaps,
      brief: rep.brief, degraded: rep.degraded, answers: rep.answers,
      sourceText: rep.sourceText, sourceAttachN: rep.sourceAttachN,
      draftsStale: rep.draftsStale,
    }));
  } catch { /* storage full or denied — the feature degrades to pre-T10 */ }
}

function hydrateRep() {
  try {
    const raw = sessionStorage.getItem(REP_STORE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!Array.isArray(s.gaps) || !Array.isArray(s.drafts)) return;
    rep.repId = s.repId || null;
    rep.description = typeof s.description === 'string' ? s.description : '';
    rep.drafts = s.drafts; rep.chosen = Number.isInteger(s.chosen) ? s.chosen : 0;
    rep.gaps = s.gaps; rep.brief = s.brief || ''; rep.degraded = Boolean(s.degraded);
    rep.answers = Array.isArray(s.answers) ? s.answers : [];
    rep.sourceText = typeof s.sourceText === 'string' ? s.sourceText : null;
    rep.sourceAttachN = Number.isInteger(s.sourceAttachN) ? s.sourceAttachN : 0;
    // A reload kills an in-flight re-check, but staleness survives it — the
    // Start gate re-verifies. Old snapshots hydrate false (they predate this).
    rep.draftsStale = Boolean(s.draftsStale);
    rep.questions = rep.gaps.filter((g) => g.status === 'open');
    // In-flight states don't survive a reload; clamp to what the data holds.
    rep.phase = s.phase === 'started' ? 'started'
      : rep.drafts.length ? 'confirm' : 'input';
  } catch { /* torn or stale snapshot — start blank */ }
}
hydrateRep();

/** Has the paste (or its attachments) changed since the gaps were built?
 *  Drives step 1's forward action: free return vs explicit regenerate. */
function repPasteDirty(currentText) {
  if (rep.sourceText === null) return false;      // nothing built yet
  return (currentText || '').trim() !== rep.sourceText.trim()
    || attachments.length !== rep.sourceAttachN;
}

/** The door's one live region (decision 6A): only DELTAS are announced —
 *  the container aria-live re-read the whole panel on every rebuild. */
function announce(text) {
  const live = el('rep-live');
  if (live) live.textContent = text;
}

/** Past this many changed rows the delta stops being a delta: a correction
 *  re-runs inference over the WHOLE description, so six rows can move at once
 *  and flashing all six reads as "the page redrew" — the exact sensation the
 *  flash exists to prevent (live report 2026-08-12). Collapse instead. */
const FLASH_MAX = 3;

/** An answer is the CANDIDATE's data, not the model's. The server is
 *  stateless per request and re-derives its whole gap list every turn, so a
 *  gap the model renames or forgets simply vanishes — and with it the answer,
 *  out of the rail AND out of the context practiceStart assembles at Start.
 *  Observed live 2026-08-12: answering seniority and part-scope, then
 *  re-inferring, dropped both from the response and the model later re-asked
 *  seniority under a new id.
 *
 *  So the client owns them. Server gaps are authoritative for what is still
 *  OPEN; anything the candidate has answered survives regardless. Renamed
 *  re-asks are caught on the normalized label, which drifts far less than the
 *  id (the live re-ask kept the label "seniority bar" verbatim). */
function mergeGaps(prevGaps, serverGaps, answers) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const answeredIds = new Set((answers || []).map((a) => a.id));
  const mine = new Map(prevGaps.filter((g) => answeredIds.has(g.id)).map((g) => [g.id, g]));
  const myLabels = new Set([...mine.values()].map((g) => norm(g.label)));

  const out = [];
  for (const g of serverGaps) {
    if (mine.has(g.id)) {
      // Prefer the server's settled version (it may carry a tidier value);
      // fall back to ours if it came back open, which is a re-ask.
      out.push(g.status === 'settled' ? g : mine.get(g.id));
      mine.delete(g.id);
      continue;
    }
    // A renamed re-ask of something already answered: drop it silently.
    if (g.status === 'open' && myLabels.has(norm(g.label))) continue;
    out.push(g);
  }
  // Anything answered that the server dropped entirely.
  for (const g of mine.values()) out.push(g);
  return out;
}

/** Old vs new gap lists by STABLE id → what changed. Feeds the visible
 *  .gaterow.flash AND the aria-live sentence — one diff, two outputs, so
 *  sighted and screen-reader users get the same delta at the same threshold. */
function diffGaps(oldGaps, newGaps) {
  const before = new Map(oldGaps.map((g) => [g.id, g]));
  const changed = [];
  const sentences = [];
  for (const g of newGaps) {
    const prev = before.get(g.id);
    if (prev && prev.status === g.status && prev.value === g.value) continue;
    changed.push(g.id);
    if (g.status === 'settled') sentences.push(g.label + ' set to ' + g.value);
    else if (prev && prev.status === 'settled') sentences.push(g.label + ' reopened');
    else sentences.push(g.label + ' still open');
  }
  const collapsed = changed.length > FLASH_MAX;
  return {
    changed,
    // Flash only when the flash still means "look here".
    flash: collapsed ? [] : changed,
    sentence: collapsed
      ? changed.length + ' facts updated — review the confirmed column'
      : sentences.join(' · '),
  };
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
  // ONE step on screen at a time. The composer used to render underneath the
  // confirm screen: still editable, but with its Generate button removed, so
  // an edit fired nothing and then silently rode along on whatever re-infer
  // happened next (proved live 2026-08-12 — text typed during confirm reached
  // the server minutes later attached to an unrelated correction). A live
  // input with no trigger is worse than either a dead one or an honest one.
  if (rep.phase === 'confirm' && rep.drafts.length) {
    // Step 2 keeps the paste as a READ-ONLY referent — "Confirmed from your
    // paste" has to point at something you can see — and that referent IS the
    // way back to step 1.
    const src = (rep.sourceText || rep.description || '').replace(/\s+/g, ' ').trim();
    html += '<button type="button" id="rep-back" aria-label="Back to your paste, to edit it">' +
      '<span class="micro">← your paste</span>' +
      '<span class="rep-src">' + esc(src.slice(0, 140)) + (src.length > 140 ? '…' : '') + '</span>' +
      '</button>';
  } else {
    // The hero IS the textarea's label (label-in-h1: heading semantics and the
    // a11y association in one element — the real-labels rule, no duplication).
    // The composer is ONE framed instrument: borderless textarea, chips, an
    // optional link row (progressive disclosure — the always-open input read
    // as form furniture), and a footer with quiet affordances + the action.
    // The example copy lives in the placeholder; the hero is the real label.
    // Returning here from step 2 keeps the drafts, so the forward action is
    // free when nothing changed and an explicit REGENERATE when it did.
    const dirty = repPasteDirty(keep);
    const returning = rep.drafts.length > 0;
    html += '<h1 class="hero"><label for="rep-paste">What do you want to practice right now?</label></h1>' +
      '<div class="composer-frame">' +
      '<textarea id="rep-paste" placeholder="paste a recruiter email, a JD, a friend’s description…"></textarea>' + chips +
      (rep.linkOpen
        // The explicit link input (planner precedent, user call 2026-08-07:
        // affordances beat discovery). Honest copy: the practice path never
        // fetches — a link rides along with the notes as-is.
        ? '<div class="linkrow"><input id="rep-link" placeholder="add a link (optional) — the posting, a thread; it rides along with your notes" aria-label="Add a link (optional)" />' +
          '<button id="rep-addlink" type="button">add</button></div>'
        : '') +
      '<div class="composer-foot">' +
      '<span class="quiet-affordances"><a href="#" id="rep-attach">attach a file</a> · ' +
      '<a href="#" id="rep-linktoggle">add a link</a></span>' +
      (rep.phase === 'input'
        ? '<button type="button" class="primary" id="rep-infer">' +
          (!returning ? 'Generate my round →' : dirty ? 'Regenerate from your edits →' : 'Back to your round →') +
          '</button>'
        : '<span></span>') +
      '</div></div>';
    // Say what the button will DO before it does it — the whole point of
    // making this deliberate instead of asynchronous.
    if (returning && dirty) {
      html += '<div class="metaline">this rebuilds the confirmed facts and the questions</div>';
    }
  }

  if (rep.phase === 'confirm' && rep.drafts.length) {
    // The gap-derived confirm screen (design review 2026-08-12): ONE list,
    // two views. The rail is the READBACK — model guesses sort first because
    // the screen's job is catching the fact the model was confident and
    // wrong about; questions are gaps it already knows it has.
    const d = rep.drafts[rep.chosen];
    const settled = rep.gaps.filter((g) => g.status === 'settled');
    const open = rep.gaps.filter((g) => g.status === 'open');
    const tierOrder = { inferred: 0, answered: 1, stated: 2 };
    settled.sort((a, b) => (tierOrder[a.evidence] ?? 1) - (tierOrder[b.evidence] ?? 1));
    const tierWord = { inferred: 'guessed', answered: 'you said', stated: 'stated' };
    const startLabel = d.unsupported ? 'Build the closest version →' : 'Start →';

    // DOM order: questions FIRST (they are the task — tab order per pass 6);
    // the grid places the rail visually left, and narrow widths stack the
    // rail above via order:-1.
    const dis = rep.busy ? ' disabled' : '';
    html += '<div id="rep-confirm">';
    html += '<div id="rep-open"><div class="micro">Needed before I build</div>';
    if (rep.busy) {
      // A re-infer runs 8-20s — in the BACKGROUND (owner decision
      // 2026-08-15): the screen never blanks and the controls stay live, so
      // the user keeps answering while it flies. The wait still gets the
      // SAME progress bar the first inference gets: a 12px grey line alone
      // was invisible (live report 2026-08-12: "sudden generation after a
      // wait with no indicator"). Only the correction box disables — it
      // rewrites the description and stays a blocking, explicit apply.
      html += '<div class="metaline" style="margin-top:8px">re-checking the shape…</div>' +
        '<div class="progress"><div class="fill"></div></div>';
    }
    if (open.length === 0 && !rep.busy) {
      // The column degrades, never empties (the zero-gap COMMON case).
      html += '<div class="metaline" style="margin-top:10px">nothing — the shape is settled. Anything you want different?</div>';
    }
    for (const g of open) {
      html += '<div class="askrow" data-gap="' + esc(g.id) + '" style="margin-top:14px"><div class="askq">' + esc(g.question) + '</div>' +
        '<div class="optdetail">' + esc(g.why) + '</div>' +
        '<div class="askopts">' +
        g.options.map((o, oi) =>
          '<button type="button" class="qopt" data-gap="' + esc(g.id) + '" data-o="' + oi + '">' + esc(o.label) +
          (o.detail ? ' <span class="rec">' + esc(o.detail) + '</span>' : '') + '</button>').join('') +
        '</div>' +
        // Options are SHORTCUTS, never a gate (rule 3): every open value
        // keeps a real text path beside the pills.
        (g.closed ? '' :
          '<div class="gapinput-row">' +
          '<label for="gapfree-' + esc(g.id) + '" class="rep-srlabel" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">' + esc(g.label) + '</label>' +
          '<input id="gapfree-' + esc(g.id) + '" class="gapinput" data-gap="' + esc(g.id) + '" placeholder="or type your own…">' +
          '</div>') +
        '</div>';
    }
    // The control you clicked carries its own state. The busy line above sits
    // at the TOP of this column; the correction box is at the bottom, so on a
    // scrolled screen that line is the one thing you cannot see. Feedback has
    // to live where the click happened.
    html += '<div id="rep-note">not right? change it on the left, or say so below — plain words work</div>' +
      '<div class="row" style="display:flex;gap:8px;margin-top:6px">' +
      '<label for="rep-change" class="rep-srlabel" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">what should be different</label>' +
      '<input id="rep-change" placeholder="e.g. actually it’s Rust, and harder" style="flex:1;background:var(--panel);color:var(--text-1);border:1px solid var(--line);border-radius:6px;padding:10px 12px;font:inherit;min-height:44px"' + dis + '>' +
      '<button type="button" id="rep-rechecks" class="mini" style="min-height:44px"' + dis + '>' +
      (rep.busy ? 'applying…' : 'apply') + '</button></div>';
    html += '</div>'; // #rep-open

    html += '<div id="rep-rail"><div class="micro">Confirmed from your paste</div>';
    if (rep.degraded) {
      html += '<div class="metaline" style="margin-top:6px">I couldn’t get a full read on this — check these facts before starting</div>';
    }
    if (rep.drafts.length > 1) {
      // T14: never a silent discard — the selector is TODO #37.
      html += '<div class="metaline" style="margin-top:6px">your material describes ' + rep.drafts.length +
        ' rounds — building “' + esc(d.spec.label) + '”</div>';
    }
    for (const g of settled) {
      // Compact readback (owner report 2026-08-15): the always-open 44px
      // controls made the rail outgrow the viewport — every answer moved a
      // full edit box + why-line into this column, and Start (grid row 2)
      // sank below all of it. The value is now a click-to-edit button; the
      // control and its why-line render only for the row being edited.
      const editing = g.id === rep.editingGap;
      html += '<div class="gaterow" data-gap="' + esc(g.id) + '">' +
        '<label class="micro" for="gap-' + esc(g.id) + '">' + esc(g.label) +
        ' <span class="tier">' + (tierWord[g.evidence] || 'guessed') + '</span></label>' +
        (editing
          ? (g.closed && g.options.length
            ? '<select id="gap-' + esc(g.id) + '" class="gapedit" data-gap="' + esc(g.id) + '">' +
              g.options.map((o) => '<option' + (o.label === g.value ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
              (g.options.some((o) => o.label === g.value) ? '' : '<option selected>' + esc(g.value) + '</option>') +
              '</select>'
            : '<input id="gap-' + esc(g.id) + '" class="gapedit" data-gap="' + esc(g.id) + '" value="' + esc(g.value) + '">') +
            '<div class="gapwhy">' + esc(g.why) + '</div>'
          : '<button type="button" id="gap-' + esc(g.id) + '" class="gapval" data-gap="' + esc(g.id) + '"' +
            ' aria-label="change ' + esc(g.label) + ' — currently ' + esc(g.value) + '">' + esc(g.value) + '</button>') +
        '</div>';
    }
    html += '<div class="metaline" style="margin-top:10px">' + esc(specShapeLine(d.spec.capabilities)) + '</div>';
    html += '</div>'; // #rep-rail

    // The commit band spans BOTH columns and sits ABOVE them (owner call
    // 2026-08-15): anything placed inside a column rides that column's
    // length, and the rail is ~70px per confirmed fact — eight facts put
    // Start off-screen. A band above the grid costs the columns no space
    // and its position never depends on how long either one gets.
    //
    // It is LAST in the DOM on purpose: the questions are the task and must
    // keep the first tab stop (tab order, pass 6). CSS grid rows do the
    // visual reordering, so reading order and tab order stay independent.
    html += renderRepCommit(d, startLabel, open.length);
    html += '</div>'; // #rep-confirm
  }
  if (rep.phase === 'clarifying') {
    html += '<div class="metaline" style="margin-top:18px">reading your notes…</div>' +
      '<div class="progress"><div class="fill"></div></div>';
  }
  if (rep.error) html += '<div class="err" style="margin-top:12px">' + esc(rep.error) + '</div>';
  html += '</div>';
  host.innerHTML = html;
  const pasteEl = el('rep-paste');
  if (pasteEl) {
    pasteEl.value = keep;
    // Typing re-renders only the footer action (free-return vs regenerate),
    // so the label always matches what the button will actually do.
    pasteEl.addEventListener('input', () => {
      const btn = el('rep-infer');
      if (!btn || !rep.drafts.length) return;
      const d = repPasteDirty(pasteEl.value);
      btn.textContent = d ? 'Regenerate from your edits →' : 'Back to your round →';
    });
  }
  if (el('rep-link')) el('rep-link').value = keepLink;
  wirePractice();
  // Post-render (decision 6A): the flash marks what the last answer changed
  // in the rail; focus follows the task to the next open question. Both are
  // one-shot — consumed here, never re-applied by the next render.
  if (rep.phase === 'confirm') {
    for (const gid of rep.flashIds) {
      const row = host.querySelector('.gaterow[data-gap="' + CSS.escape(gid) + '"]');
      if (row) row.classList.add('flash');
    }
    rep.flashIds = [];
    if (rep.pendingFocus && !rep.busy) {
      const row = host.querySelector('.askrow[data-gap="' + CSS.escape(rep.pendingFocus) + '"]');
      const ctl = row && row.querySelector('button, input, select');
      if (ctl) ctl.focus();
      rep.pendingFocus = null;
    }
    // The just-opened rail editor gets focus — one-shot, so later renders
    // never steal it back while the editor stays open.
    if (rep.pendingEditFocus) {
      const ctl = host.querySelector('.gaterow[data-gap="' + CSS.escape(rep.pendingEditFocus) + '"] .gapedit');
      if (ctl) ctl.focus();
      rep.pendingEditFocus = null;
    }
  }
}

/** The commit block: brief → decline → Start, in reading order. One
 *  builder, two placements — grid row 2 while questions are open, inside
 *  the right column once settled (owner report 2026-08-15). */
function renderRepCommit(d, startLabel, openCount) {
  // A band, not a block: what you're about to build on the left, the action
  // on the right. Sits above both columns so neither can push it off-screen.
  let html = '<div id="rep-commit"><div class="commit-text">';
  if (rep.brief) html += '<div id="rep-brief">' + esc(rep.brief) + '</div>';
  if (d.unsupported) {
    // Decision 2B: the decline is visible and the choice is the user's.
    html += '<div id="rep-unsupported">can’t run this honestly: ' + esc(d.unsupported) + '</div>';
  }
  // Readiness is VISIBLE but never a gate (owner request 2026-08-15): the
  // three states the screen can be in read differently at a glance — ready
  // (loud white primary), re-checking, and still-open-questions (both quiet
  // steel outline). Start works in all three; the questions are shortcuts,
  // not a gate (rule 3), so "start anyway" stays one click away.
  const ready = openCount === 0 && !rep.busy;
  const note = rep.busy
    ? 're-checking your answers…'
    : openCount
      ? openCount + ' question' + (openCount === 1 ? '' : 's') + ' still open — start anyway if you’re happy'
      : 'ready to build';
  html += '<div id="rep-ready" class="' + (ready ? 'is-ready' : 'is-pending') + '">' + note + '</div>';
  html += '</div>'; // .commit-text
  // A queued Start survives re-renders: the label comes from state, so the
  // background landing that resumes it can repaint freely in between.
  html += '<div class="rep-actions"><button type="button" class="primary' + (ready ? '' : ' pending') + '" id="rep-start"' +
    (rep.startQueued ? ' disabled>Checking your answers…' : '>' + startLabel) + '</button></div>';
  return html + '</div>'; // #rep-commit
}

/** The wait state (design 4A): honest elapsed from the .generating marker,
 *  the shape named in plain words, and explicit permission to leave. */
function renderRepWait() {
  const mine = (lastReps || []).find((x) => x.id === rep.repId);
  const status = !mine ? 'starting' : mine.status === 'ready' ? 'ready' : mine.status === 'failed' ? 'failed' : 'building';
  if (status !== lastWaitAnnounced) {
    lastWaitAnnounced = status;
    if (status === 'ready') announce('Your round is ready');
    else if (status === 'failed') announce('The build failed — you can retry');
    else if (status === 'building') announce('Building your round — about five minutes');
  }
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
  const linktoggle = el('rep-linktoggle');
  if (linktoggle) linktoggle.addEventListener('click', (e) => {
    e.preventDefault();
    rep.linkOpen = !rep.linkOpen;
    renderPractice();
    if (rep.linkOpen && el('rep-link')) el('rep-link').focus();
  });
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
  // Step 2 → step 1. The gaps SURVIVE, so coming back is free when nothing
  // changed; only an edit costs a rebuild.
  const back = el('rep-back');
  if (back) back.addEventListener('click', () => {
    rep.phase = 'input';
    saveRep();
    renderPractice();
    const t = el('rep-paste');
    if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  });
  const infer = el('rep-infer');
  if (infer) infer.addEventListener('click', () => {
    // Returning with an untouched paste is navigation, not inference — never
    // spend a model call to show the user what they already confirmed.
    const cur = el('rep-paste');
    if (rep.drafts.length && !repPasteDirty(cur ? cur.value : '')) {
      rep.phase = 'confirm';
      saveRep();
      renderPractice();
      return;
    }
    practiceClarify(rep.answers);
  });
  const paste = el('rep-paste');
  if (paste) paste.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) practiceClarify();
  });
  // Answers key on the gap's STABLE id (T12) — never an array index, which
  // re-inference is free to reorder. Every answer settles locally; shape
  // answers additionally schedule the background re-check (coherence still
  // lives in the server's draftToSpec gate — Start ships nothing stale).
  for (const b of f.querySelectorAll('.qopt')) {
    b.addEventListener('click', () => {
      const g = rep.gaps.find((x) => x.id === b.dataset.gap);
      if (g) answerGap(g.id, g.options[Number(b.dataset.o)].label);
    });
  }
  for (const input of f.querySelectorAll('.gapinput')) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); answerGap(input.dataset.gap, input.value); }
    });
  }
  // Compact rail: the value button opens that row's editor (one at a time).
  for (const b of f.querySelectorAll('.gapval')) {
    b.addEventListener('click', () => {
      rep.editingGap = b.dataset.gap;
      rep.pendingEditFocus = b.dataset.gap;
      renderPractice();
    });
  }
  for (const ctl of f.querySelectorAll('.gapedit')) {
    // Rail rows are the editable readback (decision 1A) — committing a
    // change routes through the same answer path as the question column.
    // Commit and Escape both close the editor back to the compact row.
    const commit = () => {
      const g = rep.gaps.find((x) => x.id === ctl.dataset.gap);
      if (!g) return;
      const v = ctl.value.trim();
      rep.editingGap = null;
      if (!v || v === g.value) { renderPractice(); return; } // never mind
      answerGap(g.id, ctl.value);
    };
    ctl.addEventListener('change', commit);
    ctl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { rep.editingGap = null; renderPractice(); }
    });
  }
  const recheck = el('rep-rechecks');
  if (recheck) recheck.addEventListener('click', () => {
    const change = el('rep-change');
    if (!change || !change.value.trim() || rep.busy) return;
    rep.description = rep.description + '\n\nCorrection: ' + change.value.trim();
    // A correction re-runs inference over the WHOLE description, so it is the
    // most disruptive update the screen can make — it gets the same
    // revert-on-failure snapshot a shape answer gets.
    practiceClarify(rep.answers, { snapshot: JSON.parse(JSON.stringify(rep.gaps)) });
  });
  const change = el('rep-change');
  if (change) change.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el('rep-rechecks').click(); }
  });
  const start = el('rep-start');
  if (start) start.addEventListener('click', () => practiceStart(start));
}

function upsertRepAnswer(id, question, answer) {
  const i = rep.answers.findIndex((a) => a.id === id);
  const entry = { id, question, answer };
  if (i >= 0) rep.answers[i] = entry; else rep.answers.push(entry);
}

/** One answer path for pills, free-text, and rail edits. EVERY answer
 *  settles locally and instantly (owner decision 2026-08-15 — the blocking
 *  per-answer re-infer froze the screen 8-20s per shape answer). A shape
 *  answer additionally marks the drafts stale and schedules ONE debounced
 *  background re-check carrying ALL answers; flavor rides along on that
 *  re-check's ANSWERS (the server's gate re-settles it). Nothing is lost:
 *  Start refuses to ship stale drafts (T3). */
function answerGap(id, answer) {
  const g = rep.gaps.find((x) => x.id === id);
  const a = (answer || '').trim();
  if (!g || !a) return;
  upsertRepAnswer(g.id, g.question, a);
  if (g.id === 'named-problem') {
    // The binding is MECHANICAL — a model round trip adds nothing here.
    // Settle locally; Start ships this row's value as source_ref and the
    // server's re-resolution is the only one that counts.
    g.status = 'settled'; g.value = a; g.evidence = 'answered';
    rep.questions = rep.gaps.filter((x) => x.status === 'open');
    announce('problem set to ' + a);
    saveRep();
    renderPractice();
    return;
  }
  g.status = 'settled'; g.value = a; g.evidence = 'answered';
  rep.questions = rep.gaps.filter((x) => x.status === 'open');
  announce(g.label + ' set to ' + a);
  const nextOpen = rep.gaps.find((x) => x.status === 'open');
  rep.pendingFocus = nextOpen ? nextOpen.id : null;
  if (g.affects === 'shape') {
    // The spec only learns a shape answer through re-inference — never
    // client-side patching (T3). Stale until a re-check lands.
    rep.draftsStale = true;
    scheduleRecheck();
  }
  saveRep();
  renderPractice();
}

// Long enough to batch a flurry of pill clicks into one model call, short
// enough that the re-check usually lands while the user answers the rest —
// so Start stays instant in the common case.
const RECHECK_DEBOUNCE_MS = 1200;

/** The background re-check (owner decision 2026-08-15): one debounced
 *  re-infer carries ALL answers so far. While one is in flight another
 *  answer just marks it dirty — the landing re-fires once with everything. */
function scheduleRecheck() {
  if (rep.busy) { rep.recheckDirty = true; return; }
  if (rep.recheckTimer) clearTimeout(rep.recheckTimer);
  rep.recheckTimer = setTimeout(runRecheck, RECHECK_DEBOUNCE_MS);
}

function runRecheck() {
  if (rep.recheckTimer) { clearTimeout(rep.recheckTimer); rep.recheckTimer = null; }
  if (rep.busy) { rep.recheckDirty = true; return; }
  // No snapshot: answers are client-owned (mergeGaps re-seats them), so a
  // failed round trip has nothing to revert — Start re-verifies instead.
  practiceClarify(rep.answers);
}

// A background re-check may land while the user is typing in a gap input or
// the correction box; renderPractice's innerHTML rebuild would destroy their
// in-progress text and focus. Same pattern as the poll's pendingState guard.
let repRenderPending = false;

function renderPracticeSafe() {
  const a = document.activeElement;
  if (userIsTyping() && a && a.closest('#practice-flow')) {
    repRenderPending = true;
    return;
  }
  renderPractice();
}

async function practiceClarify(answers, opts) {
  // The composer only exists in step 1. In step 2 the paste is FROZEN at what
  // produced the gaps, so corrections are the only way the description can
  // grow — no more silent accumulation from an editable box with no button.
  const paste = el('rep-paste');
  const basePaste = paste ? paste.value : (rep.sourceText ?? rep.description);
  const cut = rep.description.indexOf('\n\nCorrection: ');
  rep.description = basePaste + (cut >= 0 ? rep.description.slice(cut) : '');
  // Link-only input works: a landing that says "paste anything" must accept
  // someone who only dropped a link or a file. Seed the description from the
  // first text-bearing attachment; binary-only gets a stock line (the server
  // gate requires a non-empty description).
  if (!rep.description.trim() && attachments.length) {
    rep.description = (attachments.find((a) => a.content) || {}).content || 'see the attached material';
  }
  if (!rep.description.trim()) { rep.error = 'describe the round in a sentence or two first'; renderPractice(); return; }
  // First inference replaces the screen; a RE-inference keeps the confirm
  // screen rendered (busy) so the ~8s round trip is never a blank page.
  const firstRun = rep.phase !== 'confirm';
  const snapshot = opts && opts.snapshot;
  rep.error = ''; rep.answers = answers || [];
  if (firstRun) rep.phase = 'clarifying'; else rep.busy = true;
  renderPractice();
  let s;
  // Hoisted out of the try because the 402 branch below needs the STATUS, not
  // just the body — and `r` would otherwise be scoped to the try block.
  let status = 0;
  try {
    const r = await fetch('/api/practice/clarify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: rep.description,
        context: buildContext(),
        answers: rep.answers.length ? rep.answers : undefined,
        attachments: buildBinaryAttachments(),
      }),
    });
    status = r.status;
    s = await r.json();
  } catch {
    // A network drop must never strand busy=true — the background path
    // would silently stop re-checking and Start would queue forever.
    s = { error: 'the app server didn’t answer — check the connection' };
  }
  // WTP gate, checked BEFORE the error branch for the same reason as
  // launchCommon and planFirstSend: a 402 carries a readable sentence in
  // `error`, so without this the gate DEGRADES INTO AN INLINE ERROR MESSAGE
  // and the card never opens.
  //
  // Found in QA 2026-08-15, and it mattered more than the other two: this is
  // the composer's own endpoint — "Generate my round" on the landing screen,
  // the first thing every new user touches. The gate fired correctly on the
  // server and the whole instrument (gated → would_pay → would_pay_confirmed)
  // recorded NOTHING on the most-travelled path in the product.
  if (status === 402 && s.paywall && !paywallOpen) {
    rep.busy = false;
    rep.startQueued = false;
    rep.phase = rep.drafts.length ? 'confirm' : 'input';
    // Their typed words live in rep.description; saveRep puts them in
    // sessionStorage so even a Checkout redirect comes back to them.
    saveRep();
    paywallIntent = { kind: 'clarify', answers: rep.answers, opts: opts || null };
    let proceed = false;
    try { proceed = await showPaywallGate(s.paywall); } catch { proceed = false; }
    if (proceed) { practiceClarify(answers, opts); return; }
    renderPractice();
    return;
  }
  if (s.error) {
    // A failed CORRECTION restores the pre-answer gaps: the optimistic
    // settle must not survive a round trip that never happened.
    if (snapshot) { rep.gaps = snapshot; rep.questions = rep.gaps.filter((g) => g.status === 'open'); rep.error = s.error; }
    else if (!firstRun) {
      // A failed BACKGROUND re-check loses nothing: answers are client-
      // owned and the drafts stay stale — Start re-verifies them.
      rep.draftsStale = true;
      rep.error = 'couldn’t re-check — your answers are kept; Start will verify them';
    } else {
      rep.error = s.error;
    }
    rep.busy = false;
    rep.startQueued = false;
    rep.phase = rep.drafts.length ? 'confirm' : 'input';
    if (firstRun || snapshot) renderPractice(); else renderPracticeSafe();
    return;
  }
  const oldGaps = rep.gaps;
  rep.drafts = s.drafts || []; rep.chosen = 0;
  // Answered gaps survive whatever the model did with its list.
  rep.gaps = mergeGaps(oldGaps, s.gaps || [], rep.answers);
  rep.brief = s.brief || ''; rep.degraded = Boolean(s.degraded);
  // Open gaps ARE the questions — same render, answers keyed by gap id.
  rep.questions = rep.gaps.filter((g) => g.status === 'open');
  // One diff, two outputs (decision 6A): changed rows flash, and the live
  // region hears only the delta, never the whole panel.
  if (!firstRun) {
    const delta = diffGaps(oldGaps, rep.gaps);
    rep.flashIds = delta.flash;
    if (delta.sentence) announce(delta.sentence);
  }
  // Focus follows the task only on the FIRST inference — a background
  // landing must never steal focus from whatever the user is doing.
  if (firstRun) {
    const nextOpen = rep.gaps.find((g) => g.status === 'open');
    rep.pendingFocus = nextOpen ? nextOpen.id : null;
  }
  // Stamp what produced these gaps, so step 1 can tell "go back" from
  // "rebuild" without guessing.
  rep.sourceText = basePaste;
  rep.sourceAttachN = attachments.length;
  // The rep id is minted at confirm-render, ONCE — Start can be mashed and
  // every click carries this same id into the server's mkdir lock.
  rep.repId = rep.repId || 'rep-' + Date.now().toString(36);
  // Stay-in-input guard: a background landing must not yank the user out
  // of editing their paste (they pressed ← back mid-flight).
  if (firstRun || rep.phase !== 'input') rep.phase = 'confirm';
  rep.busy = false;
  if (rep.recheckDirty) {
    // Answers arrived mid-flight: this response is slightly stale (mergeGaps
    // already re-seated them) — one more re-check carries everything.
    rep.recheckDirty = false;
    scheduleRecheck();
  } else {
    rep.draftsStale = false; // the drafts now reflect every answer
  }
  saveRep();
  if (firstRun) renderPractice(); else renderPracticeSafe();
  // A Start pressed during the flight resumes the moment the drafts are
  // verified fresh; if another re-check was scheduled it stays queued.
  if (rep.startQueued && !rep.draftsStale && !rep.busy) {
    rep.startQueued = false;
    const sb = el('rep-start');
    if (sb) practiceStart(sb);
  }
}

async function practiceStart(btn) {
  const d = rep.drafts[rep.chosen];
  if (!d) return;
  // Stale drafts never ship (T3): a shape answer that hasn't been through
  // re-inference is missing from the spec. Flush the debounce, queue the
  // start — the landing calls back here with fresh drafts. In the common
  // case the background re-check already landed and this gate is free.
  if (rep.draftsStale || rep.busy) {
    rep.startQueued = true;
    btn.disabled = true; btn.textContent = 'Checking your answers…';
    if (!rep.busy) runRecheck();
    return;
  }
  btn.disabled = true; btn.textContent = 'Starting…';
  // The spec ships VERBATIM: every shape answer already landed in it through
  // the server's re-inference, and the client never patches a spec again
  // (T3, 2026-08-12 review — the hardcoded {language, difficulty} assembly
  // silently ate every other answer). Flavor gaps ride as context lines,
  // GENERICALLY: one line per settled flavor gap with a value — including
  // standing model guesses the user left in place. The rail is honest:
  // what you see is what rides.
  const prose = rep.gaps
    .filter((g) => g.status === 'settled' && g.affects === 'flavor' && g.value)
    .map((g) => g.label + ': ' + g.value)
    .join('\n');
  // Real-set binding: a row the candidate EDITED wins over the draft's
  // decoration; the server re-resolves whatever ships (its resolution is
  // the only one that counts). No row and no decoration = invention.
  const srcRow = rep.gaps.find((g) => g.id === 'named-problem');
  let sourceRefs; let sourceAutos;
  if (srcRow && srcRow.evidence === 'answered' && srcRow.value) {
    // An edited row replaces the WHOLE set with what they typed (comma-
    // separated refs supported); the server re-resolves every ref.
    sourceRefs = srcRow.value.split(',').map((x) => x.trim()).filter(Boolean);
    sourceAutos = sourceRefs.map(() => false);
  } else if (d.source && d.source.slug) {
    const parts = d.source.parts || [d.source];
    sourceRefs = parts.map((p) => p.slug);
    sourceAutos = parts.map((p) => p.picked_by === 'auto');
  }
  const r = await fetch('/api/practice', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rep_id: rep.repId,
      spec: d.spec,
      // The task hypothesis (round-task on the rail) routes the generation
      // skeleton server-side; the server re-validates against its enum.
      task: d.task || undefined,
      description: rep.description,
      context: [buildContext(), prose].filter(Boolean).join('\n\n') || undefined,
      source_refs: sourceRefs && sourceRefs.length ? sourceRefs : undefined,
      source_autos: sourceAutos && sourceAutos.length ? sourceAutos : undefined,
    }),
  });
  const s = await r.json();
  if (s.error && !String(s.error).startsWith('already building')) {
    btn.disabled = false; btn.textContent = 'Start →'; rep.error = s.error; renderPractice(); return;
  }
  rep.phase = 'started';
  saveRep();
  renderPractice();
  refresh(true);
}

async function launchRep(repId, btn) {
  repReadyUnseen = false;
  // origin is per call site, never defaulted — the falsifier metric divides
  // on it (2026-08-10 CEO review).
  await launchCommon('/api/practice/launch', { rep_id: repId, origin: 'practice' }, btn, 'Start session →');
}

/** "practice again" on a finished row — the SAME artifact, restored to its
 *  pristine bytes server-side inside the launch critical section, so the
 *  candidate never inherits their own edits. Boot semantics are launchCommon's
 *  (identical to every other door); origin is its own value, never reused from
 *  the first run, because the falsifier metric divides on it. */
async function practiceAgain(repId, btn) {
  await launchCommon('/api/practice/repeat', { rep_id: repId, origin: 'repeat' }, btn, 'practice again');
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
    caps.submit === 'one_shot' ? 'graded once at submit' : 'graded as you go',
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
    // Self-heal honesty (2026-08-15): a failed first attempt repairs or
    // retries automatically, so a long build is the system working, not
    // stuck — the bar must not read as a hang at minute 9.
    'usually 5–8 min — a rough first pass self-repairs, which can add a few',
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
    // EVERY dated round has happened — the season-over header. Header ONLY:
    // the timeline below must keep rendering (QA 2026-08-14: the old early
    // return here discarded the whole runway, so a ready item had no Start
    // button and a failed item no Retry — the plan soft-locked the moment
    // its last date passed).
    const last = rounds[rounds.length - 1];
    const ago = Math.max(1, Math.floor((Date.now() - Date.parse(last.date + 'T00:00:00')) / 86400000));
    html += '<h2 class="daysleft">' + esc(t.label) + ' was ' + ago + ' day' + (ago === 1 ? '' : 's') + ' ago — how did it go?</h2>';
    html += '<p class="meta"><a href="#/new" class="addlink">+ prepare for the next one</a></p>';
  } else if (upcoming.length) {
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

  // Season topics: what to drill, from the plan's own frozen vocabulary
  // joined with finished rounds. Renders only once something deposited —
  // an all-○ band is a promise, not information. Chips render for DONE
  // rounds only; upcoming rounds never disclose their topics.
  if (row.topic_rollup && row.topic_rollup.some((x) => x.exercised > 0)) {
    const done = row.topic_rollup.filter((x) => x.exercised > 0).length;
    html += '<div class="topicband"><p class="micro">season topics · ' + done + ' of ' + row.topic_rollup.length + ' exercised</p>';
    const sorted = row.topic_rollup.slice().sort((a, b) => b.exercised - a.exercised || a.id.localeCompare(b.id));
    for (const x of sorted) {
      const drill = x.exercised > 0 && x.solved === 0;
      html += '<div class="topicrow' + (drill ? ' drill' : '') + '">' +
        '<span class="tmark">' + (x.exercised > 0 ? '●'.repeat(Math.min(x.exercised, 5)) : '○') + '</span>' +
        '<span class="tlabel">' + esc(x.label) + '</span>' +
        '<span class="meta">' + (x.exercised === 0 ? 'not yet exercised'
          : x.exercised + ' round' + (x.exercised === 1 ? '' : 's') + ' · ' + x.solved + ' solved' + (drill ? ' — drill this' : '')) + '</span>' +
        '</div>';
    }
    html += '</div>';
  }

  // The runway's caption (owner report 2026-08-15: nothing said the rows
  // were practice DAYS, so the timeline read as an undifferentiated list).
  // Dated plans name the row unit; undated plans own up to having no
  // calendar — counts/pace stay on the paceline, never repeated here.
  if (rounds.length) {
    html += '<p class="micro runwaykey">one row = one practice day</p>';
  } else {
    const left = row.queue ? row.queue.items.filter((i) => i.status !== 'done' && i.status !== 'skipped').length : 0;
    html += '<p class="micro runwaykey">your queue, in order — no dates yet' +
      (left ? ' · ' + left + ' round' + (left === 1 ? '' : 's') + ' left' : '') + '</p>';
  }
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
      // A past quiet run dims with the band it stands in for.
      html += '<li class="quiet' + (d.past ? ' past' : '') + '"><span class="date"></span><span class="dot"></span>' +
        '<span class="body">· ' + d.count + ' quiet days ·</span></li>';
      continue;
    }
    const item = d.items[0] || null;
    // Provenance ONLY — the plan row says where a round came from and offers
    // no control over it. Per-item rebinding was removed 2026-08-13: a queue
    // item carries a single `source`, but an algorithmic_set round may be a
    // multi-part OA (the oa-hackerrank-classic skeleton mandates "same count
    // of parts"), so "change this round's problem" is unrepresentable the
    // moment a set has more than one part. Restore it — plural — when
    // `sources[]` lands. A user pick shows its title (they named it); an auto
    // pick stays hidden so the reskin still lands fresh.
    const sourceBits = (it) => {
      if (!it.source) return { line: '' };
      const parts = it.source.parts || [it.source];
      const named = parts.filter((p) => p.picked_by === 'user');
      let label;
      if (parts.length === 1) {
        label = it.source.picked_by === 'user'
          ? 'real set: ' + it.source.title + ' · ' + it.source.difficulty
          : 'real set · ' + it.source.difficulty + ' — revealed when the round starts';
      } else if (named.length) {
        const extra = parts.length - named.length;
        label = 'real set: ' + named.map((p) => p.title).join(', ') + (extra ? ' + ' + extra + ' more, revealed at start' : '');
      } else {
        label = 'real set × ' + parts.length + ' — revealed when the round starts';
      }
      return { line: '<span class="srcline">' + esc(label) + '</span>' };
    };
    if (d.today) {
      html += '<li class="today" aria-current="date"><span class="date">TODAY</span><span class="dot"></span><div class="body">';
      if (!item) {
        html += '<div class="grow"><span class="title meta">nothing scheduled — the plan resumes tomorrow</span></div>';
      } else if (item.status === 'ready') {
        const sb = sourceBits(item);
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline">' + metaLine(capsOf(item)) + '</div>' +
          (sb.line ? '<div class="metaline">' + sb.line + '</div>' : '') +
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
        const sb = sourceBits(item);
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline err">couldn\'t build this one</div>' +
          (sb.line ? '<div class="metaline">' + sb.line + '</div>' : '') + '</div>' +
          '<button class="retry" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">retry</button>';
      } else {
        const sb = sourceBits(item);
        html += '<div class="grow"><div class="title">' + esc(itemTitle(item)) + '</div>' +
          '<div class="metaline">not built yet — usually 5–8 minutes to generate</div>' +
          (sb.line ? '<div class="metaline">' + sb.line + '</div>' : '') + '</div>' +
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
    // The affordance is a quiet text link, not a second "Generate": the
    // duplicated label made TODAY's primary read as one of a crowd (friend
    // walkthrough 2026-08-15). Same .gen wiring, same endpoint.
    if (item) {
      let action = '';
      if (item.status === 'pending') {
        action = ' <button class="quietgen gen" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">build ahead</button>';
      } else if (item.status === 'ready' && !state.session_live) {
        action = ' <button class="mini start" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">Start</button>';
      } else if (item.status === 'failed') {
        action = ' <button class="mini retry" data-t="' + esc(t.id) + '" data-i="' + esc(item.id) + '">retry</button>';
      } else if (item.status === 'generating') {
        action = ' <span class="meta">building…</span>';
      }
      const sb = sourceBits(item);
      html += '<li class="future"><span class="date">' + fmtDate(d.date) + '</span><span class="dot"></span>' +
        '<span class="body">' + esc(itemTitle(item)) +
        (item.stale ? ' <span class="stale">— built for the old shape</span>' : '') +
        (sb.line ? ' <span class="meta">·</span> ' + sb.line : '') + action + '</span></li>';
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
  if (loggedOut) return;
  let text;
  try {
    const r = await fetch('/api/state');
    if (r.status === 401) { clearJwt(); renderLogin('signed out — sign in again'); return; }
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

// An armed "build anyway" survives only deliberate intent: any click that
// isn't the build button, and any keystroke in the composer, cancels it.
// Delegated + bound once — wirePlan rebinds per render and would leak.
document.addEventListener('click', (e) => {
  if (!plan.buildArmed) return;
  if (e.target.closest && e.target.closest('#gate-confirm')) return;
  if (disarmBuild()) renderPlan();
});
document.addEventListener('input', (e) => {
  if (!plan.buildArmed || e.target.id !== 'plan-msg') return;
  if (disarmBuild()) renderPlan();
});

document.addEventListener('focusout', () => {
  if (pendingState) {
    const s = pendingState;
    pendingState = null;
    lastStateJson = s;
    window.setTimeout(() => render(JSON.parse(s)), 50);
  }
  // A practice re-render deferred by renderPracticeSafe flushes here too.
  if (repRenderPending) {
    repRenderPending = false;
    window.setTimeout(renderPractice, 50);
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
      // "interview passed" read as "you passed the interview" (QA
      // 2026-08-15) — this states only what the calendar knows.
      left = 'interview date passed';
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
  // Recent-formats segment (user calls 2026-08-10): the landing is the
  // generator's page, so its readout feeds the generator — the last few
  // distinct SHAPES you generated in, each one tap from a fresh problem.
  // Shapes, not titles: the user remembers "backend live debugging round",
  // never "Hourly usage metering". Dedup by spec.id — regenerate chains
  // share their parent's spec verbatim, so a chain collapses to one row.
  // The seasons have their own tab; the readout doesn't point there.
  const rows = [];
  const seenShapes = new Set();
  for (const x of state.reps || []) {
    if (x.status !== 'ready' && x.status !== 'done') continue;
    if (!x.spec || seenShapes.has(x.spec.id)) continue;
    seenShapes.add(x.spec.id);
    // "another like this", never "regenerate": regenerate reads as
    // rebuild-the-same-thing (which is Retry's job on failed reps) — this
    // link means a FRESH problem in the same confirmed format.
    rows.push('<div>' + esc(x.spec.label) + ' — ' + specShapeShort(x.spec.capabilities) +
      ' · <a href="#" class="rep-regen" data-rep="' + esc(x.id) + '">another like this →</a></div>');
    if (rows.length >= 3) break;
  }
  const lines = (bits.length ? ['<div>' + bits.join(' · ') + '</div>'] : []).concat(rows);
  host.innerHTML = lines.length ? '<div class="statusline">' + lines.join('') + '</div>' : '';
  for (const regen of host.querySelectorAll('.rep-regen')) {
    regen.addEventListener('click', (e) => {
      e.preventDefault();
      if (regen.dataset.busy) return;
      regen.dataset.busy = '1';
      regen.textContent = 'starting…';
      regenerateLike(regen.dataset.rep, state);
    });
  }
}

/**
 * One tap, same confirmed shape, fresh problem: re-post the last rep's
 * spec/description/context under a new id. The server re-proves the spec;
 * a fresh blueprint draft plus the current gap note vary the problem, and
 * the variation line names the previous title so the generator is TOLD not
 * to re-roll the same domain (the never-a-copy rule, aimed at itself).
 */
async function regenerateLike(lastId, state) {
  const last = (state.reps || []).find((x) => x.id === lastId);
  if (!last || !last.spec) return;
  const newId = 'rep-' + Date.now().toString(36);
  // Strip any variation line a previous regeneration appended, so chained
  // regenerations don't stack directives — each round names only its parent.
  const base = (last.description || last.label).replace(/\n\nVariation: a fresh problem[\s\S]*$/, '');
  const r = await fetch('/api/practice', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rep_id: newId,
      spec: last.spec,
      description: base +
        '\n\nVariation: a fresh problem, same shape — do not repeat the previous one ("' + (last.title || last.label) + '").',
      context: last.context || undefined,
    }),
  });
  const s = await r.json();
  if (s.error && !String(s.error).startsWith('already building')) {
    el('banner').innerHTML = '<div class="banner">' + esc(s.error) + '</div>';
    return;
  }
  rep.repId = newId;
  rep.phase = 'started';
  renderPractice();
  refresh(true);
}

// ---- practice history (#/history): the reps strip, extracted from the old
//      index when the composer took over '#/' (2026-08-10). Failed ≠ ready
//      visually, the empty state is a door, and judged cards work for free —
//      reps carry a session_id and the card store is session-keyed. ----
function renderHistory(state) {
  const reps = state.reps || [];
  // The Gaps band leads: where-am-I before what-did-I-do. Its data comes
  // from /api/memory (fetched once per history open), never from the poll.
  let html = renderGapsBand();
  html += '<div class="rep-strip"><h2 class="daysleft" style="font-size:15px">practice history</h2>';
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
      // `repeatable` is the server's disk truth (a pristine archive or a
      // pre-archive snapshot survives) — the button never appears where
      // /api/practice/repeat would refuse. Hidden while a session is live for
      // the same reason Start is: one round at a time.
      if (x.repeatable && !state.session_live) {
        action = '<button type="button" class="mini repagain" data-rep="' + esc(x.id) + '">practice again</button>';
      }
      if (x.session_id) action += feedbackToggle({ session_id: x.session_id });
    } else {
      line = x.status;
    }
    html += '<div class="reprow"><div class="grow"><b>' + esc(x.title || x.label) + '</b>' +
      '<div class="metaline">' + line + '</div>' +
      feedbackPanel({ session_id: x.session_id }) +
      priorAttempts(x) +
      '</div>' + action + '</div>';
  }
  html += '</div>';
  const host = el('history');
  host.innerHTML = html;
  for (const b of host.querySelectorAll('.repstart')) {
    b.addEventListener('click', () => launchRep(b.dataset.rep, b));
  }
  for (const b of host.querySelectorAll('.repagain')) {
    b.addEventListener('click', () => practiceAgain(b.dataset.rep, b));
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
          feedbackCache[sid] = {
            card: d.card || { state: 'unassessed', reason: d.error || 'No feedback recorded for this session.' },
            confirms: d.confirms || {},
          };
        } catch {
          feedbackCache[sid] = { card: { state: 'unassessed', reason: 'Could not load feedback.' }, confirms: {} };
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
          feedbackCache[sid] = {
            card: d.card || { state: 'unassessed', reason: d.error || 'No feedback recorded for this session.' },
            confirms: d.confirms || {},
          };
        } catch {
          feedbackCache[sid] = { card: { state: 'unassessed', reason: 'Could not load feedback.' }, confirms: {} };
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

// ---- the Gaps band (#/history): cross-session memory made visible ----
// Fetched ONCE per history open (never on the 5s poll — render() clears the
// cache whenever the route leaves history, so returning refetches). State
// lives outside the DOM, same trick as feedbackCache.
let memoryCache = null;      // /api/memory payload, or null = not fetched
let memoryFetching = false;

const GAP_DIMS = ['clarify', 'approach', 'communicate', 'implement', 'verify', 'reflect'];

function ensureMemory() {
  if (memoryCache || memoryFetching) return;
  memoryFetching = true;
  fetch('/api/memory')
    .then((r) => r.json())
    .catch((e) => ({ degraded: String(e) }))
    .then((d) => { memoryCache = d; memoryFetching = false; rerender(); });
}

/** One strip cell. Shape backs hue (DESIGN.md): color alone never grades. */
function gapGlyph(row) {
  if (!row) return '<span class="gg g-none" title="not judged">·</span>';
  if (row.verdict === 'strong') return '<span class="gg g-ok" title="strong">■</span>';
  if (row.verdict === 'adequate') return '<span class="gg g-ok" title="adequate">◆</span>';
  if (row.verdict === 'unassessable') return '<span class="gg g-none" title="not assessable">·</span>';
  if (row.unreceipted) return '<span class="gg g-none" title="weak — no receipt survived">▫</span>';
  return '<span class="gg g-weak" title="gap">▫</span>';
}

/** Plain-language state, composed from the reader's arithmetic — never
 *  model-written. */
function gapStateLine(s) {
  if (!s || s.state === 'no signal') return 'not yet assessable';
  // Display words, not the shared verdict-history state vocabulary: "still
  // firing" is detector jargon — a gap doesn't "fire" to a user (QA
  // 2026-08-15).
  if (s.state === 'still firing') {
    return s.weak_count === s.informative_count ? 'still showing up — every round' : 'still showing up';
  }
  if (s.state === 'improving') return 'improving — ' + s.recent_not_weak + ' of last ' + s.recent_informative + ' adequate or better';
  if (s.state === 'quiet lately') return 'quiet lately — no gap in the last 3';
  return 'mixed';
}

function renderGapsBand() {
  const h = memoryCache;
  if (!h) { ensureMemory(); return '<div class="gapsband"><p class="micro">your gaps</p><div class="meta">loading…</div></div>'; }
  if (h.degraded) {
    return '<div class="gapsband"><p class="micro">your gaps</p>' +
      '<div class="meta err">couldn’t load history — feedback cards below still work</div></div>';
  }
  if (!h.sessions || h.sessions.length === 0) {
    return '<div class="gapsband"><p class="micro">your gaps</p>' +
      '<div class="meta">no judged rounds yet — finish one and this becomes your across-rounds view</div></div>';
  }
  const head = h.sessions.length + ' round' + (h.sessions.length === 1 ? '' : 's') +
    (h.solved_count ? ' · ' + h.solved_count + ' solved' : '');
  let sub = '';
  if (h.mode === 'observations') {
    sub = 'patterns need ' + h.sessions_until_patterns + ' more round' + (h.sessions_until_patterns === 1 ? '' : 's');
  } else if (h.trend && h.trend.first.informative >= 4 && h.trend.second.informative >= 4) {
    const pct = (t) => Math.round((100 * t.not_weak) / t.informative);
    // The one defensible claim (judge-measurability moved too): share of
    // ASSESSABLE verdicts that were not weak, early half vs recent half.
    // Said without the hedge-plus-double-negative (QA 2026-08-15): "of what
    // could be assessed … not weak" made the header unreadable.
    sub = 'judged solid: ' + pct(h.trend.first) + '% → ' + pct(h.trend.second) + '% of assessable verdicts (early → recent)';
  }
  const bounds = new Set(h.comparability_boundaries || []);
  let html = '<div class="gapsband"><p class="micro">your gaps</p>' +
    '<div class="meta">' + esc(head) + (sub ? ' · ' + esc(sub) : '') + '</div>';
  for (const dim of GAP_DIMS) {
    const s = h.states ? h.states[dim] : null;
    let strip = '';
    h.sessions.forEach((sess, i) => {
      if (bounds.has(i)) strip += '<span class="gg g-none gb" title="judge prompt changed here — halves may not compare">│</span>';
      strip += gapGlyph(sess.rows.find((r) => r.dimension === dim));
    });
    html += '<div class="gaprow"><span class="dim">' + dim + '</span>' +
      // aria-hidden: the glyphs are visual texture; the state line + counts
      // beside them carry the same information as text.
      '<span class="gapstrip" aria-hidden="true">' + strip + '</span>' +
      '<span class="gapstate">' + esc(gapStateLine(s)) + '</span>' +
      // Full text, CSS-clamped (QA 2026-08-15): the 157-char slice cut every
      // judge citation mid-word with no way to read the rest. A long cite
      // clamps to two lines and toggles open on click (delegated below).
      (s && s.latest_analysis
        ? '<div class="cite gapcite' + (s.latest_analysis.length > 160 ? ' clamped" role="button" tabindex="0" aria-expanded="false' : '') + '">' + esc(s.latest_analysis) + '</div>'
        : '') +
      '</div>';
  }
  if ((h.skipped || 0) + (h.unattributable || 0) > 0) {
    html += '<div class="meta">' +
      (h.skipped ? h.skipped + ' unreadable' : '') +
      (h.skipped && h.unattributable ? ' · ' : '') +
      (h.unattributable ? h.unattributable + ' unattributable' : '') +
      ' session file' + ((h.skipped || 0) + (h.unattributable || 0) === 1 ? '' : 's') + ' excluded</div>';
  }
  return html + '</div>';
}

// Clamped gap citations toggle open in place — delegated for the same
// reason as the card confirms below (the band re-renders on each poll).
document.addEventListener('click', (e) => {
  const cite = e.target.closest('.gapcite.clamped, .gapcite.open');
  if (!cite) return;
  cite.classList.toggle('clamped');
  cite.classList.toggle('open');
  cite.setAttribute('aria-expanded', cite.classList.contains('open') ? 'true' : 'false');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const cite = e.target.closest && e.target.closest('.gapcite.clamped, .gapcite.open');
  if (!cite) return;
  e.preventDefault();
  cite.click();
});

// One delegated listener for every history/timeline card confirm — panels
// re-render on each poll, so per-render wiring would leak or miss.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.fbconfirm .cf');
  if (!btn) return;
  const wrap = btn.closest('.fbconfirm');
  const sid = wrap.dataset.s;
  const agree = btn.dataset.agree === '1';
  try {
    const r = await fetch('/api/card-feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: sid, dimension: wrap.dataset.dim, agree }),
    });
    if (!r.ok) { wrap.textContent = 'could not record that — try reopening the card'; return; }
    if (feedbackCache[sid]) feedbackCache[sid].confirms[wrap.dataset.dim] = agree;
    wrap.textContent = 'did this match? noted — ' + (agree ? 'confirmed' : 'disputed');
  } catch {
    wrap.textContent = 'could not record that — try reopening the card';
  }
});

function feedbackToggle(i) {
  if (!i.session_id) return '';
  return ' <a href="#" class="fbtoggle" data-s="' + esc(i.session_id) + '">' +
    (openFeedback.has(i.session_id) ? 'hide feedback' : 'feedback') + '</a>';
}

/** Every earlier run of a repeated round, still readable. `runs` is the
 *  append-only ledger, oldest→newest, so everything before the last row is
 *  history — and a "practice again" that hid the previous card would READ as
 *  erasure (the old sid's assessment is still on disk; only the row moved on).
 *  Deliberately plain: the same feedbackToggle/feedbackPanel pair every other
 *  finished row uses, so the per-sid cache and the `a.fbtoggle` wiring cover
 *  these for free. */
function priorAttempts(x) {
  const runs = x.runs || [];
  if (runs.length < 2) return '';
  // The last run owns the row above; drop it, and drop the row's own sid
  // defensively so one card never renders twice under two toggles.
  // Numbering counts over the WHOLE ledger, so "attempt 1" stays the first run
  // even if a row below is dropped.
  const earlier = runs
    .map((r, n) => ({ r, n }))
    .slice(0, -1)
    .filter(({ r }) => r && r.session_id && r.session_id !== x.session_id);
  if (!earlier.length) return '';
  const links = earlier.map(({ r, n }) => {
    // run.at is a full ISO stamp; fmtDate reads the calendar day only, and a
    // garbled one degrades to no date rather than rendering "NaN".
    const day = String(r.at || '').slice(0, 10);
    const when = /^\d{4}-\d{2}-\d{2}$/.test(day) ? ' (' + fmtDate(day) + ')' : '';
    return esc('attempt ' + (n + 1) + when) + feedbackToggle({ session_id: r.session_id });
  }).join(' · ');
  return '<div class="metaline">earlier attempts: ' + links + '</div>' +
    earlier.map(({ r }) => feedbackPanel({ session_id: r.session_id })).join('');
}

function feedbackPanel(i) {
  if (!i.session_id || !openFeedback.has(i.session_id)) return '';
  const entry = feedbackCache[i.session_id];
  if (!entry) return '<div class="fbcard"><p class="meta">loading…</p></div>';
  return '<div class="fbcard">' + renderCardHtml(entry.card, entry.confirms, i.session_id) + '</div>';
}

/** Render of an assessment card — same content the session page shows at
 *  grading time. WU-C reversal: the "did this match?" control now lives HERE
 *  (POSTing to the app), because the session server's copy dies with its tab
 *  and, under multi-session, with the ended-session reap. The bug is still
 *  shown only when solved (an unsolved problem stays re-runnable unspoiled). */
function renderCardHtml(card, confirms, sid) {
  let html = '';
  if (card.state === 'unassessed') {
    return '<p class="desc"><b>Session not assessed.</b> ' + esc(card.reason || '') + '</p>';
  }
  for (const c of card.newly_closed || []) {
    html += '<div class="fbrow closedmark"><p class="desc">Closed: ' + esc(c.description) + '</p></div>';
  }
  if (card.summary) html += '<p class="desc">' + esc(card.summary) + '</p>';
  // Solo cards (card.interviewer === false) collapse unassessable rows into
  // one line — same treatment as the live session card: talk dimensions have
  // no evidence class when nobody was listening, and a column of grey rows
  // reads as the product failing.
  const soloCard = card.interviewer === false;
  const allRows = card.rows || [];
  const shownRows = soloCard ? allRows.filter((r) => r.verdict !== 'unassessable') : allRows;
  for (const r of shownRows) {
    const cls = r.verdict === 'strong' ? 'v-strong' : r.verdict === 'weak' ? 'v-weak' : r.verdict === 'unassessable' ? 'v-none' : '';
    html += '<div class="fbrow ' + cls + '">' +
      '<p class="desc"><b class="dim">' + esc(r.dimension) + '</b> · ' +
      (r.verdict === 'unassessable' ? 'not assessable this session' : esc(r.verdict)) + '</p>' +
      '<p class="desc">' + esc(r.analysis) + '</p>';
    for (const q of r.quotes || []) {
      html += '<p class="cite"><span class="clk">' + esc(q.clock) + '</span>  ' + esc(q.text) + '</p>';
    }
    if (r.unreceipted) html += '<p class="cite">No verifiable citation survived for this claim — weigh it accordingly.</p>';
    if (sid && r.verdict !== 'unassessable') {
      const answered = confirms && Object.prototype.hasOwnProperty.call(confirms, r.dimension);
      html += answered
        ? '<p class="cite">did this match? noted — ' + (confirms[r.dimension] ? 'confirmed' : 'disputed') + '</p>'
        : '<p class="cite fbconfirm" data-s="' + esc(sid) + '" data-dim="' + esc(r.dimension) + '">did this match? ' +
          '<button class="cf" data-agree="1">yes</button> <button class="cf" data-agree="0">no</button></p>';
    }
    html += '</div>';
  }
  if (soloCard && shownRows.length < allRows.length) {
    const hiddenDims = allRows.filter((r) => r.verdict === 'unassessable').map((r) => esc(r.dimension)).join(' · ');
    html += '<div class="fbrow v-none"><p class="desc">Not observable this round (no interviewer): ' + hiddenDims + '</p></div>';
  }
  if (card.bug && card.solved) {
    html += '<div class="fbrow"><p class="desc"><b>The bug:</b> ' + esc(card.bug.description) + '</p></div>';
  }
  if (card.focus) {
    html += '<div class="fbfocus"><p class="k">next session focus</p><p>' + esc(card.focus.description) + '</p></div>';
  }
  // Beta (WU9): same memory roadmap note as the live session card — the
  // history tab is where cards get re-read, so the retention line rides here too.
  html += '<p class="cite">Zenkai is learning your patterns across rounds — this card already aims your next problem.</p>';
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
  // WTP allowance (paywall.ts). First statement, before anything that can
  // throw. ADVISORY ONLY — enforcement is the server's 402 at ten spend
  // routes, always. An absent field means no gate, which is the safe default
  // for admins, a gate-off server, a comped user, and a client newer than its
  // server.
  //
  // NOT a pre-gate: an earlier comment here claimed this gated the "new plan"
  // entry point before the user types. It never did — nothing reads
  // plans_used. What actually protects a gated user's typed words is the
  // draft restore in planFirstSend's 402 branch. Read for the email address
  // and, once billing is on, the remaining-rounds readout.
  paywallAllowance = state.paywall ? { ...state.paywall, email: state.user && state.user.email } : null;
  // Analytics identity: the Supabase user id ONLY (never the email — it
  // stays on the box). posthog-js no-ops a repeat identify with the same id,
  // so calling on every render is free; track() itself no-ops when the
  // bundle was blocked or the box has no analytics configured.
  if (state.user && state.user.id) track('identify', state.user.id);
  // Persistent status lives in the masthead; the banner is for genuine
  // problems only. A full-width bar on every page for a usually-false
  // condition was pure vertical tax.
  el('nav-live').classList.toggle('on', Boolean(state.session_live));
  el('nav-live').href = state.session_url ? sessionHref(state.session_url) : '#/';
  el('nav-kill').classList.toggle('on', Boolean(state.session_live));
  // Only the NAME is a render concern — visibility is owned by initAuth, so
  // a broken state fetch can never take the exit away (see showSignout).
  const signout = el('nav-signout');
  if (signout) {
    const who = state.user && state.user.email;
    signout.title = who ? 'Signed in as ' + who + ' — sign out' : 'Sign out';
  }
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
  // has its own tab too (user call 2026-08-10: the wordmark alone was an
  // undiscoverable way back to the generator).
  if (r.page === 'practice') el('nav-practice').setAttribute('aria-current', 'page');
  else el('nav-practice').removeAttribute('aria-current');
  if (r.page === 'plans') el('nav-plans').setAttribute('aria-current', 'page');
  else el('nav-plans').removeAttribute('aria-current');
  if (r.page === 'history') el('nav-history').setAttribute('aria-current', 'page');
  else el('nav-history').removeAttribute('aria-current');
  // The planning surface gets a wider page column for its two-pane layout.
  document.body.classList.toggle('wide', r.page === 'new');

  // Off the history page: drop the memory snapshot so the next visit
  // refetches — "fetched once per surface open", never once per page load.
  if (r.page !== 'history') memoryCache = null;
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
// ---- willingness-to-pay gate (paywall.ts) ---------------------------------
// A REAL limit. Past the free allowance the server answers 402 and the round
// does not start until the user answers: Subscribe records intent, mints a
// grant, and the launch is retried; "Maybe later" means no round. An earlier
// draft never denied anything, which measured cheap talk — a click that cost
// nothing and changed nothing.
//
// NO CARD FIELDS, EVER. The measurement is the CLICK: pressing
// "Subscribe - $39/mo" while believing it starts checkout has already
// answered the question. The reveal that payments are not switched on yet is
// immediate and in place, so nobody is charged or left misled.
//
// paywallAllowance is ADVISORY, set from render(). It gates the "new plan"
// entry point before the user types a description — the composer is cleared
// before its request and there is no draft persistence, so being stopped at
// the POST would lose their words. Enforcement is always the server's 402.
let paywallAllowance = null;
let paywallOpen = false;

/** Fire-and-forget. keepalive is load-bearing on paths that navigate away:
 *  a plain in-flight fetch is cancelled by a same-tab navigation, and we
 *  would lose exactly the events we are here to measure. */
function probeBeacon(action, fields) {
  try {
    // JSON.stringify drops undefined-valued keys, so empty optional answers
    // never ride as '' — the server-side trim is the backstop, not the norm.
    fetch('/api/paywall/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(Object.assign({ action: action }, fields || {})),
    }).catch(() => {});
  } catch { /* a metric never blocks a launch */ }
}

// ---- surviving the Checkout redirect ------------------------------------
// The gate is reached from two places, and BOTH retry via an in-memory
// continuation: launchCommon closes over endpoint/body and recurses with
// isRetry; planFirstSend closes over the typed text and re-calls itself.
// Navigating to checkout.stripe.com destroys the page and both closures, so
// without persisting the intent a user pays and lands back on a page with
// nothing to resume — the worst possible first impression of a paid product.
//
// Set by whichever caller opened the gate; written to sessionStorage right
// before the redirect; replayed once on return. sessionStorage (not local)
// because an intent is meaningless in another tab and must not outlive the
// tab that formed it.
var PENDING_INTENT_KEY = 'ip_pending_intent';
let paywallIntent = null;

function savePendingIntent() {
  try {
    if (paywallIntent) window.sessionStorage.setItem(PENDING_INTENT_KEY, JSON.stringify(paywallIntent));
  } catch { /* private mode: they land on the app, just without the auto-resume */ }
}

function takePendingIntent() {
  try {
    var raw = window.sessionStorage.getItem(PENDING_INTENT_KEY);
    window.sessionStorage.removeItem(PENDING_INTENT_KEY); // once, never twice
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Returning from Stripe. Confirms server-side rather than trusting the URL —
 * a success_url is just a link and proves nothing — then replays whatever the
 * user was doing when they hit the gate.
 *
 * Confirm-first matters: the webhook is the durable record but may not have
 * landed yet, and the replayed action would be gated again if we raced it.
 */
async function resumeAfterCheckout() {
  var params = new URLSearchParams(window.location.search);
  var outcome = params.get('checkout');
  if (!outcome) return;
  var sid = params.get('session_id');
  // Clean the URL first so a refresh cannot re-run this.
  try { window.history.replaceState({}, '', window.location.pathname + window.location.hash); } catch { /* ignore */ }
  var intent = takePendingIntent();
  if (outcome !== 'success' || !sid) return; // cancelled: nothing to do, nothing lost
  try {
    await fetch('/api/stripe/confirm?session_id=' + encodeURIComponent(sid));
  } catch { /* the webhook is the backstop; the replay below may still gate */ }
  if (!intent) return;
  if (intent.kind === 'launch' && intent.endpoint) {
    launchCommon(intent.endpoint, intent.body || {}, null, intent.idleLabel || 'Start');
  } else if (intent.kind === 'plan') {
    var box = el('plan-msg');
    if (box && intent.text) box.value = intent.text;
    planFirstSend(intent.text || '');
  } else if (intent.kind === 'clarify') {
    // The composer path. hydrateRep() already ran at module load (app.js:1060,
    // well before this), so rep.description is back from sessionStorage and
    // practiceClarify reads it directly — only the answers need carrying.
    practiceClarify(intent.answers || [], intent.opts || undefined);
  }
}

/**
 * The gate. Resolves true when the caller should retry the request, false
 * when the user declined and nothing should happen.
 *
 * To see it yourself (you are an admin, so the server will never gate you):
 *   showPaywallGate({ price_usd: 39, reason: 'rounds', used: 3, free: 3 })
 * in the devtools console. Deliberately no ?preview= param and no env
 * bypass - a QA hole is a production hole.
 */
function showPaywallGate(pw) {
  return new Promise((resolve) => {
    var host = el('paywall');
    if (!host) { resolve(false); return; }
    paywallOpen = true;
    var prevFocus = document.activeElement;
    var price = '$' + Number(pw.price_usd) + '/mo';
    var unit = pw.reason === 'plans' ? 'plans' : 'rounds';
    var done = false;

    function teardown(result) {
      if (done) return;
      done = true;
      try {
        window.removeEventListener('keydown', onKey);
        host.hidden = true;
        host.innerHTML = '';
        if (prevFocus && prevFocus.focus) prevFocus.focus();
      } catch { /* teardown is best effort */ }
      paywallOpen = false;
      resolve(result);
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      // Steps 2 and 3 are PAST the decision: they already pressed Subscribe,
      // the grant is already recorded, and the action goes through either
      // way. Escaping out of a follow-up must never cost them the round.
      // Step 3 records nothing — an escape IS a skip, and skips are the
      // denominator's silence, not a row.
      if (host.dataset.step === '3') { teardown(true); return; }
      if (host.dataset.step === '2') { probeBeacon('notify_declined'); teardown(true); return; }
      probeBeacon('not_yet');
      teardown(false);
    }

    // TWO steps, and which one is last depends on whether billing is wired.
    // With Stripe configured, Subscribe leaves for hosted Checkout and the
    // card is the whole story. Without it — the beta measurement mode — the
    // same click reveals that the round is free and asks the follow-up that
    // actually costs something (betaReveal below). Either way the gated
    // action goes through; nothing in here can strand the user.
    try {
      host.dataset.step = '';
      // A SUBSCRIBER who has spent this period's rounds gets a different card:
      // they are still gated (unlimited would be a liability at ~$2 a round),
      // but selling someone the subscription they already pay for is the
      // fastest way to lose them. No price, no Subscribe — just when it resets
      // and a way into billing.
      if (pw.subscribed) {
        host.innerHTML =
          '<div class="card" role="dialog" aria-modal="true" aria-labelledby="paywall-h">' +
            '<h2 id="paywall-h">You have used this month’s ' + Number(pw.free) + ' rounds</h2>' +
            '<p>Your plan renews at the start of your next billing period, and the ' +
              'count resets then. Nothing is lost in the meantime — your plans, ' +
              'history and gap graph stay where they are.</p>' +
            '<div class="btnrow">' +
              '<button type="button" class="primary" id="paywall-close">Got it</button>' +
              '<button type="button" id="paywall-portal">Manage billing</button>' +
            '</div>' +
          '</div>';
        host.hidden = false;
        probeBeacon('gated');
        var close = el('paywall-close');
        var portal = el('paywall-portal');
        if (!close) { teardown(false); return; }
        close.addEventListener('click', function () { teardown(false); });
        if (portal) {
          portal.addEventListener('click', async function () {
            portal.disabled = true;
            try {
              var pr = await fetch('/api/stripe/portal', { method: 'POST' });
              var pb = await pr.json();
              if (pb && pb.url) { window.location = pb.url; return; }
              launchStatusInGate(pb && pb.error ? pb.error : 'could not open billing');
            } catch { launchStatusInGate('could not open billing — try again'); }
            portal.disabled = false;
          });
        }
        window.addEventListener('keydown', onKey);
        if (close.focus) close.focus();
        return;
      }

      host.innerHTML =
        '<div class="card" role="dialog" aria-modal="true" aria-labelledby="paywall-h">' +
          '<h2 id="paywall-h">You have used your ' + Number(pw.free) + ' free ' + unit + '</h2>' +
          '<p class="price">' + esc(price) + '</p>' +
          '<p>Zenkai is ' + esc(price) + ' — plans and rounds included. ' +
            'Cancel any time from your account.</p>' +
          '<div class="btnrow">' +
            '<button type="button" class="primary" id="paywall-yes">Subscribe — ' + esc(price) + '</button>' +
            '<button type="button" id="paywall-no">Maybe later</button>' +
          '</div>' +
        '</div>';
      host.hidden = false;
      probeBeacon('gated');

      var yes = el('paywall-yes');
      var no = el('paywall-no');
      if (!yes || !no) { teardown(false); return; }
      no.addEventListener('click', function () {
        probeBeacon('not_yet');
        teardown(false);
      });
      /**
       * Step 2, the beta reveal. Reached only by pressing Subscribe on a box
       * where billing is NOT configured.
       *
       * The click that got here already recorded `would_pay`, which is also
       * the grant — so by this point the round is theirs no matter what they
       * do next, and this card must never read as another obstacle. It says
       * the true thing (free during the beta) and then asks the question that
       * is actually worth something.
       *
       * `would_pay` alone is cheap talk: pressing a button that costs nothing
       * and blocks nothing measures very little, which is exactly why the
       * earlier probe-only draft was rejected. Agreeing to be EMAILED about
       * paying is a second deliberate act with a real cost attached, and the
       * fall-off between the two is the size of the cheap-talk problem —
       * measured rather than assumed. The expected-price box is optional and
       * bounded server-side (expectedText, EXPECTED_MAX).
       */
      function betaReveal() {
        host.dataset.step = '2';
        host.innerHTML =
          '<div class="card" role="dialog" aria-modal="true" aria-labelledby="paywall-h">' +
            '<h2 id="paywall-h">Zenkai is free for the rest of the beta</h2>' +
            '<p>Going ahead now — there is nothing to pay. When paid plans open ' +
              'it will be ' + esc(price) + '.</p>' +
            '<p>Want an email when that happens?</p>' +
            '<label class="sub" for="paywall-expect">What would you expect to pay? (optional)</label>' +
            '<input type="text" id="paywall-expect" maxlength="200" autocomplete="off" />' +
            '<div class="btnrow">' +
              '<button type="button" class="primary" id="paywall-notify">Email me</button>' +
              '<button type="button" id="paywall-nothanks">No thanks</button>' +
            '</div>' +
          '</div>';
        var expect = function () {
          var box = el('paywall-expect');
          return box && box.value ? { expect: box.value } : undefined;
        };
        var notify = el('paywall-notify');
        var nothanks = el('paywall-nothanks');
        // Defensive: if the card failed to build, they still get their round.
        if (!notify || !nothanks) { teardown(true); return; }
        notify.addEventListener('click', function () {
          probeBeacon('would_pay_confirmed', expect());
          betaFeedback();
        });
        nothanks.addEventListener('click', function () {
          probeBeacon('notify_declined', expect());
          betaFeedback();
        });
        if (notify.focus) notify.focus();
      }

      /**
       * Step 3, the favor (owner request 2026-08-15). The round is already
       * granted and the email decision already recorded — this card asks the
       * two questions worth the most from someone who just tried to PAY:
       * what earned that click, and what would make it worth more. Broad on
       * purpose, both optional, and every way out (Send with empty boxes,
       * Skip, Escape) proceeds identically. Skips write nothing: the response
       * rate reads against the step-2 rows, so silence needs no row.
       */
      function betaFeedback() {
        host.dataset.step = '3';
        host.innerHTML =
          '<div class="card" role="dialog" aria-modal="true" aria-labelledby="paywall-h">' +
            '<h2 id="paywall-h">Two quick questions?</h2>' +
            '<p>Your round is going ahead either way — but these two answers ' +
              'genuinely steer what gets built next.</p>' +
            '<label class="sub" for="paywall-value">What’s the most valuable part of Zenkai for you so far?</label>' +
            '<textarea id="paywall-value" rows="2" maxlength="500"></textarea>' +
            '<label class="sub" for="paywall-improve">What’s the one thing you’d most want improved or added?</label>' +
            '<textarea id="paywall-improve" rows="2" maxlength="500"></textarea>' +
            '<div class="btnrow">' +
              '<button type="button" class="primary" id="paywall-send">Send</button>' +
              '<button type="button" id="paywall-skip">Skip</button>' +
            '</div>' +
          '</div>';
        var send = el('paywall-send');
        var skip = el('paywall-skip');
        // Defensive: a broken card still yields the round.
        if (!send || !skip) { teardown(true); return; }
        send.addEventListener('click', function () {
          var v = el('paywall-value');
          var im = el('paywall-improve');
          var value = v && v.value.trim() ? v.value : undefined;
          var improve = im && im.value.trim() ? im.value : undefined;
          // Send with both boxes empty IS a skip — never a 'feedback' row
          // with nothing in it.
          if (value || improve) probeBeacon('feedback', { value: value, improve: improve });
          teardown(true);
        });
        skip.addEventListener('click', function () { teardown(true); });
        var first = el('paywall-value');
        if (first && first.focus) first.focus();
      }

      yes.addEventListener('click', async function () {
        yes.disabled = true;
        no.disabled = true;
        // Record intent BEFORE anything that can navigate away, because a
        // redirect cancels in-flight requests; probeBeacon uses keepalive for
        // exactly this. This is also the grant, so from here the action goes
        // through on every path below.
        probeBeacon('would_pay');
        // No billing on this box: the honest reveal, not a 503. Checking the
        // server-supplied flag rather than trying the route and reading the
        // error keeps the beta path off the failure branch entirely.
        if (!pw.billing_enabled) { betaReveal(); return; }
        yes.textContent = 'Opening checkout...';
        try {
          var r = await fetch('/api/stripe/checkout', { method: 'POST' });
          var b = await r.json();
          if (!b || !b.url) {
            yes.disabled = false;
            no.disabled = false;
            yes.textContent = 'Subscribe — ' + price;
            launchStatusInGate(b && b.error ? b.error : 'could not start checkout — try again');
            return;
          }
          // THE CONTINUATION PROBLEM: a full-page redirect destroys the
          // in-memory closure that would have retried this action. Persist
          // what they were doing so the return path can replay it; without
          // this, someone pays and lands back with nothing happening.
          savePendingIntent();
          window.location = b.url;
        } catch {
          yes.disabled = false;
          no.disabled = false;
          yes.textContent = 'Subscribe — ' + price;
          launchStatusInGate('could not reach checkout — try again');
        }
      });
      window.addEventListener('keydown', onKey);
      if (yes.focus) yes.focus();
    } catch {
      teardown(false);
    }
  });
}

/** One-line error inside the gate card (the card is innerHTML-owned, so this
 *  appends rather than rewriting and losing the buttons). */
function launchStatusInGate(msg) {
  try {
    var card = el('paywall') && el('paywall').querySelector('.card');
    if (!card) return;
    var line = card.querySelector('.gate-err');
    if (!line) {
      line = document.createElement('p');
      line.className = 'gate-err err';
      card.appendChild(line);
    }
    line.textContent = msg;
  } catch { /* cosmetic */ }
}

async function launchCommon(endpoint, body, btn, idleLabel, isRetry) {
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const s = await r.json();
  // WTP gate (paywall.ts). MUST come before the s.error branch and MUST read
  // r.status: nothing else here inspects the status, so a 402 whose body had
  // no `error` key would fall straight into the poll loop below — a 180s hang
  // on "Starting…" in legacy mode, or a navigation to the string "undefined"
  // if some other session happened to be live. The server sends `error` too,
  // so an un-updated call site degrades to a readable sentence.
  if (r.status === 402 && s.paywall && !paywallOpen && !isRetry) {
    // What to replay if this ends in a Checkout redirect (see
    // resumeAfterCheckout) — the closure below does not survive navigation.
    paywallIntent = { kind: 'launch', endpoint: endpoint, body: body, idleLabel: idleLabel };
    let proceed = false;
    try { proceed = await showPaywallGate(s.paywall); } catch { proceed = false; }
    if (!proceed) {
      if (btn) { btn.disabled = false; btn.textContent = idleLabel; }
      return;
    }
    // Through the gate — via a manual comp, or an entitlement already on
    // disk. (A Checkout purchase never reaches here: it redirects away, and
    // resumeAfterCheckout replays this call on return.) isRetry stops any
    // chance of a gate loop.
    return launchCommon(endpoint, body, btn, idleLabel, true);
  }
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
    // Per-sid poll (WU-F): under multi-session, a global boolean would fire
    // on ANOTHER user's boot and navigate this user into their round. The
    // server ignores sid in legacy mode, so this is backward compatible.
    const sidQ = s.session_id ? '?sid=' + encodeURIComponent(s.session_id) : '';
    const r = await (await fetch('/api/session-live' + sidQ)).json();
    if (r.gone) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = idleLabel;
        launchStatus(btn, "couldn't start — is Docker running? Try again.", true);
      }
      return;
    }
    if (r.live) { window.location.href = sessionHref(s.url); return; }
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
  if (!window.confirm('End without grading? This attempt won’t be scored or added to your history.')) return;
  const r = await fetch('/api/session-kill', { method: 'POST' });
  const s = await r.json();
  if (s.error) el('banner').innerHTML = '<div class="banner">' + esc(s.error) + '</div>';
  refresh(true);
});

/**
 * Sign out. Clears the token and hands the page to the login screen — the
 * same landing a 401 produces, so there is one signed-out surface, not two.
 *
 * Local-only by design: the app stores an access token and no refresh token
 * (setJwt), so there is nothing server-side to revoke — the token simply
 * stops being sent and expires on its own (max-age 86400). Worth knowing
 * rather than assuming: this frees the BROWSER, it does not kill a token
 * someone already copied.
 *
 * A live round is the one case worth a confirm. Signing out does NOT end it
 * (the session is its own process on its own port, and its tab carries its
 * own token in the fragment), so someone could sign out believing they had
 * abandoned a graded round and be wrong in the expensive direction.
 */
el('nav-signout').addEventListener('click', (e) => {
  e.preventDefault();
  // nav-kill carries the live flag already (render toggles both from
  // state.session_live) — no second copy of that truth to drift.
  const live = el('nav-kill').classList.contains('on');
  if (live && !window.confirm(
    'Sign out? Your round keeps running and is still graded — this only signs this page out.',
  )) return;
  track('capture', 'signed_out');
  clearJwt();
  // reset() so posthog stops attributing the next person on this browser to
  // the account that just left.
  track('reset');
  renderLogin('signed out');
});

initAuth().then((ok) => {
  if (!ok) return; // login screen owns the page; success path reloads
  window.setInterval(refresh, 5000);
  refresh(true);
  // After auth, because confirming a purchase and replaying the gated action
  // both need a session. Never blocks the app: any failure inside just means
  // the user lands on a working page and clicks again.
  resumeAfterCheckout().catch((e) => console.error('[billing] resume failed', e));
});
