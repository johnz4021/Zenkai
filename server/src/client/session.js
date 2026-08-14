/**
 * Session chrome client. Served by the session runtime at /client/session.js.
 *
 * Extracted from a template literal in chrome.ts BEFORE the voice work lands:
 * mic capture, presence detection, playback, and state indicators would have
 * tripled an untyped, untooling-visible string. Plain JS on purpose — the
 * server has no bundle step, and this file must stay parseable by
 * chrome.test.ts (new Function). When PR2 grows real logic here (presence
 * detection, endpointing), the SCORING parts move to pure modules with unit
 * tests; this file stays a thin shell.
 *
 * Server-driven throughout: this page renders what the backend says and
 * never reads editor state from the iframe.
 */

/* global document, window, fetch, WebSocket, location */

// Count up untimed, count DOWN when the round carries a limit (data-limit,
// set by the server from the round spec). The server owns enforcement; this
// clock is display only.
const clockEl = document.getElementById('clock');
// Seed from the server's elapsed time, not page load: a mid-round reload
// used to restart the displayed countdown at the full limit while the
// server kept enforcing the real deadline (QA 2026-08-14).
const t0 = Date.now() - Number(clockEl.dataset.elapsed || 0);
const limitMs = Number(clockEl.dataset.limit || 0);
const clockTimer = setInterval(() => {
  const elapsed = Date.now() - t0;
  const shown = limitMs > 0 ? Math.max(0, Math.ceil((limitMs - elapsed) / 1000)) : Math.floor(elapsed / 1000);
  clockEl.textContent =
    String(Math.floor(shown / 60)).padStart(2, '0') + ':' + String(shown % 60).padStart(2, '0');
  if (limitMs > 0 && limitMs - elapsed < 5 * 60_000) clockEl.style.color = '#ff6fae';
}, 1000);

async function pollStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    const c = s.counts || {};
    const n = (k) => c[k] || 0;
    const el = document.getElementById('status');
    // A one-shot round has no Run Tests button, so the debugging-round
    // trigger ("first failing test run") can NEVER arm — the candidate
    // would read a status describing an impossible event for the whole
    // round. State the rule that actually governs their round instead.
    // No-interviewer rounds get no trigger clause at all: "trigger armed"
    // describes someone who is not there (QA 2026-08-14). No-run rounds
    // have nothing to run, at submit or otherwise.
    const trigger = el.dataset.oneShot === '1'
      ? (el.dataset.noRun === '1' ? 'nothing runs this round' : 'suite runs once at submit')
      : (el.dataset.interviewer === '1'
          ? (s.trigger_armed ? 'trigger armed ✓' : 'waiting for first failing test run')
          : '');
    el.textContent =
      'observing: ' + n('edit') + ' edits · ' + n('file_save') + ' saves · ' +
      n('test_run') + ' test runs' + (trigger ? ' · ' + trigger : '');
  } catch {}
}
const statusTimer = setInterval(pollStatus, 3000);
pollStatus();

// Interviewer turns arrive here, whether they answer something we asked or
// land unprompted. Server decides what is said; this only renders it.
let lastSeq = -1;
const log = document.getElementById('log');
function say(who, text, cls) {
  const p = document.createElement('p');
  p.className = 'u' + (cls ? ' ' + cls : '');
  p.innerHTML = '<b>' + who + '</b> ' + text.replace(/</g, '&lt;');
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
  return p;
}
let thinkingEl = null;
let lastHeardSeq = -1;
let pollInFlight = false;
// A poke that lands mid-fetch used to be a silent no-op, so that turn waited
// out the full 2s interval — the exact dead air the doorbell exists to kill.
// Remember it instead and re-poll on the way out.
let pokeMissed = false;
async function pollMessages() {
  if (pollInFlight) {
    pokeMissed = true;
    return;
  }
  pollInFlight = true;
  try {
    const r = await fetch('/api/messages?since=' + lastSeq + '&vsince=' + lastHeardSeq);
    const s = await r.json();
    // What the mic heard, echoed back — the candidate must SEE their voice
    // registering, or a quiet agent is indistinguishable from a dead one.
    for (const h of s.heard || []) {
      lastHeardSeq = Math.max(lastHeardSeq, h.seq);
      if (h.untranscribed) {
        // Honest wording: many of these are ambient noise the gate let
        // through, not lost words — "heard speech" made every one read as
        // the candidate's own voice failing ("can you hear me?" ×4 in one
        // real session).
        say('you (voice)', '(heard sound — no words came through)', 'pending');
      } else {
        say('you (voice)', h.text);
      }
    }
    for (const m of s.messages) {
      lastSeq = Math.max(lastSeq, m.seq);
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      say('interviewer', m.text);
      // Voice: the turn's audio is fetched from the STORED (guarded) event.
      // Acks are content-free continuers, and they carry a seq like any other
      // turn — which meant an ack could reassign the <audio> src and cut a
      // real turn off mid-sentence. A courtesy noise never interrupts.
      if (window.ipVoice) window.ipVoice.speak(m.seq, { skipIfBusy: m.kind === 'ack' });
    }
    if (s.thinking && !thinkingEl) thinkingEl = say('interviewer', '…', 'pending');
    if (!s.thinking && thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
    // Server says the cap was reached: end through the SAME path as the
    // button so the mic is released before the record closes. The server
    // holds a grace period before finalizing on its own.
    if (s.time_up) endSession();
  } catch {} finally {
    pollInFlight = false;
    if (pokeMissed) {
      pokeMissed = false;
      void pollMessages();
    }
  }
}
const messagesTimer = setInterval(pollMessages, 2000);
pollMessages();

// Turn doorbell: the server pokes this socket the instant a turn lands, and
// we fetch immediately instead of waiting out the poll interval — that wait
// was 0-2000ms of dead air on EVERY interviewer reply. The poll above stays
// as the fallback; if this socket dies, nothing is lost but immediacy.
let eventsWs = null;
try {
  eventsWs = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/events');
  eventsWs.addEventListener('message', () => { pollMessages(); });
} catch {}

// The session is over: the clock, the observer line, and the interviewer
// poll all describe a room that no longer exists — stop them (QA ISSUE-012,
// the timer kept counting behind the graded card).
function stopSessionLoops() {
  clearInterval(clockTimer);
  clearInterval(statusTimer);
  clearInterval(messagesTimer);
  if (eventsWs) { try { eventsWs.close(); } catch {} eventsWs = null; }
}

document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('msg');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  say('you', text);
  await fetch('/api/utterance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
});

// Run Tests, IDE surface. The button lives in our header where it cannot
// hide behind a focused tab; the run itself happens inside the IDE, so the
// output appears in its Test Results panel — the place a candidate looks.
// (The panes surface renders the same button but panes.js owns it: it must
// flush pending saves and paint the output into its own panel.)
const runButton = document.getElementById('run');
if (runButton && runButton.dataset.endpoint === '/api/ide-run') {
  runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    runButton.textContent = '▶ Running…';
    try {
      const r = await fetch('/api/ide-run', { method: 'POST' });
      const out = await r.json();
      if (out.error) {
        say(
          'system',
          out.error === 'ide_not_connected'
            ? 'The editor is not connected yet — give it a moment and try again.'
            : 'Tests cannot be run in this round.',
          'pending',
        );
      }
    } catch {
      say('system', 'Could not reach the session server to run tests.', 'pending');
    }
    // The IDE panel owns the result; just restore the control.
    setTimeout(() => {
      runButton.textContent = '▶ Run Tests';
      runButton.disabled = false;
    }, 2000);
  });
}

// One end path for the button, the time cap, and (later) submit modes.
let ending = false;
async function endSession() {
  if (ending) return;
  ending = true;
  const btn = document.getElementById('end');
  btn.disabled = true;
  btn.textContent = 'Grading…';
  // Release the mic FIRST — the session record closes with /api/end, and a
  // live mic past that point streams audio nobody will ever score.
  if (window.ipVoice) window.ipVoice.stop();
  // Flush the panes editor's debounced saves BEFORE grading: on a one_shot
  // round the Run button never existed, so this is the only flush — without
  // it the last <800ms of typing is graded away by the submit run.
  if (window.ipPanesFlush) {
    try { await window.ipPanesFlush(); } catch { /* grade what's on disk */ }
  }
  stopSessionLoops();
  const res = await fetch('/api/end', { method: 'POST' });
  if (res.status === 409) { btn.textContent = 'Session ended'; return; }
  const card = await res.json();
  render(card);
  btn.textContent = 'Session ended';
}

document.getElementById('end').addEventListener('click', endSession);

function esc(s) { return String(s).replace(/</g, '&lt;'); }

function render(card) {
  stopSessionLoops();
  // The container is torn down after grading — the editor pane is dead.
  // The card takes the room, and the way home gets prominent (ISSUE-004).
  document.body.classList.add('ended');
  document.getElementById('log').style.display = 'none';
  document.getElementById('f').style.display = 'none';
  const el = document.getElementById('feedback');
  el.style.display = 'block';
  let html = '';

  // Three DISTINCT states — assessed / per-dimension unassessable /
  // assessment failed. Collapsing any pair reads as success.
  // The header back-link is the single source of the way home; the card
  // reuses its href so there is exactly one plumbing path for it.
  const backHref = (document.getElementById('back') || {}).href || null;
  const backLink = backHref
    ? '<a class="cardback" href="' + backHref + '">← back to your plan</a>'
    : '';

  if (card.state === 'unassessed') {
    html += '<h2>Session not assessed</h2>';
    html += '<div class="row"><p class="desc">' + esc(card.reason) + '</p></div>';
    el.innerHTML = html + backLink;
    return;
  }

  for (const c of card.newly_closed) {
    html += '<div class="row closedmark"><p class="desc">Closed: ' + esc(c.description) +
      '</p><p class="cite">fired ' + c.fired_count + ' times before this streak; not observed in 3 straight assessed sessions.</p></div>';
  }

  html += '<h2>' + (card.mode === 'observations' ? 'Session observations' : 'Session findings') + '</h2>';
  if (card.summary) html += '<div class="row"><p class="desc">' + esc(card.summary) + '</p></div>';

  for (const r of card.rows || []) {
    const cls = r.verdict === 'strong' ? 'v-strong' : r.verdict === 'weak' ? 'v-weak' : r.verdict === 'unassessable' ? 'v-none' : '';
    html += '<div class="row ' + cls + '">';
    html += '<p class="desc"><b class="dim">' + esc(r.dimension) + '</b> · ' +
      (r.verdict === 'unassessable' ? 'not assessable this session' : esc(r.verdict)) + '</p>';
    html += '<p class="desc">' + esc(r.analysis) + '</p>';
    for (const q of r.quotes || []) {
      // Quotes are pulled server-side from YOUR trace — never model-written.
      html += '<p class="cite"><span class="clk">' + esc(q.clock) + '</span>  ' + esc(q.text) + '</p>';
    }
    if (r.unreceipted) {
      html += '<p class="cite">No verifiable citation survived for this claim — weigh it accordingly.</p>';
    }
    // "Did this match?" — your confirmations grow the judge's golden test
    // set from real sessions. Disagreements are the most valuable signal.
    if (r.verdict !== 'unassessable') {
      html += '<p class="cite confirm" data-dim="' + esc(r.dimension) + '">did this match? ' +
        '<button class="cf" data-agree="1">yes</button> <button class="cf" data-agree="0">no</button></p>';
    }
    html += '</div>';
  }

  // Bug disclosure gated on solved (tension 2): a problem you did not crack
  // stays re-runnable unless you choose to see the answer.
  if (card.bug) {
    if (card.solved) {
      html += '<div class="row"><p class="desc"><b>The bug:</b> ' + esc(card.bug.description) + '</p></div>';
    } else {
      html += '<div class="row"><button id="showbug">show me the bug (spoils a re-run)</button>' +
        '<p class="desc" id="bugtext" style="display:none"><b>The bug:</b> ' + esc(card.bug.description) + '</p></div>';
    }
  }

  if (card.focus) {
    html += '<div class="focus"><p class="k">next session focus</p><p>' + esc(card.focus.description) + '</p></div>';
  }
  if (card.mode === 'observations') {
    html += '<p class="meta">Session ' + (3 - card.sessions_until_patterns) + ' of 3 before patterns emerge. These are single-session observations, not yet patterns.</p>';
  }
  // Beta (WU9): the memory roadmap note sits BELOW the mechanical line, never
  // replacing it — the claim with a number in it is the credible one. Kept
  // off the landing on purpose: before a round it's a reason not to start;
  // after one it's a reason to come back.
  html += '<p class="meta">Zenkai is learning your patterns across rounds — this card already aims your next problem. Deeper memory is in development: why a gap happens, not just where it showed.</p>';
  html += backLink;
  el.innerHTML = html;
  const sb = document.getElementById('showbug');
  if (sb) sb.addEventListener('click', () => {
    document.getElementById('bugtext').style.display = 'block';
    sb.style.display = 'none';
  });
  for (const btn of el.querySelectorAll('.confirm .cf')) {
    btn.addEventListener('click', async (e) => {
      const wrap = e.target.closest('.confirm');
      await fetch('/api/card-feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dimension: wrap.dataset.dim, agree: e.target.dataset.agree === '1' }),
      });
      wrap.textContent = 'noted — ' + (e.target.dataset.agree === '1' ? 'confirmed' : 'disputed');
    });
  }
}
