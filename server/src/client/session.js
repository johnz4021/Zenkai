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

/* global document, window, fetch */

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
async function pollMessages() {
  try {
    const r = await fetch('/api/messages?since=' + lastSeq + '&vsince=' + lastHeardSeq);
    const s = await r.json();
    // What the mic heard, echoed back — the candidate must SEE their voice
    // registering, or a quiet agent is indistinguishable from a dead one.
    for (const h of s.heard || []) {
      lastHeardSeq = Math.max(lastHeardSeq, h.seq);
      if (h.untranscribed) {
        say('you (voice)', '(heard speech — transcription unavailable)', 'pending');
      } else {
        say('you (voice)', h.text);
      }
    }
    for (const m of s.messages) {
      lastSeq = Math.max(lastSeq, m.seq);
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      say('interviewer', m.text);
      // Voice: the turn's audio is fetched from the STORED (guarded) event.
      if (window.ipVoice) window.ipVoice.speak(m.seq);
    }
    if (s.thinking && !thinkingEl) thinkingEl = say('interviewer', '…', 'pending');
    if (!s.thinking && thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  } catch {}
}
setInterval(pollMessages, 2000);
pollMessages();

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

document.getElementById('end').addEventListener('click', async () => {
  const btn = document.getElementById('end');
  btn.disabled = true;
  btn.textContent = 'Classifying…';
  // Release the mic FIRST — the session record closes with /api/end, and a
  // live mic past that point streams audio nobody will ever score.
  if (window.ipVoice) window.ipVoice.stop();
  const res = await fetch('/api/end', { method: 'POST' });
  const card = await res.json();
  render(card);
  btn.textContent = 'Session ended';
});

function esc(s) { return String(s).replace(/</g, '&lt;'); }

function render(card) {
  document.getElementById('log').style.display = 'none';
  document.getElementById('f').style.display = 'none';
  const el = document.getElementById('feedback');
  el.style.display = 'block';
  let html = '';

  // Three DISTINCT states — assessed / per-dimension unassessable /
  // assessment failed. Collapsing any pair reads as success.
  if (card.state === 'unassessed') {
    html += '<h2>Session not assessed</h2>';
    html += '<div class="row"><p class="desc">' + esc(card.reason) + '</p></div>';
    el.innerHTML = html;
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
  el.innerHTML = html;
  const sb = document.getElementById('showbug');
  if (sb) sb.addEventListener('click', () => {
    document.getElementById('bugtext').style.display = 'block';
    sb.style.display = 'none';
  });
}
