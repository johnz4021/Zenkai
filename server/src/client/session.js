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
    if (f.contaminated) {
      html += '<p class="cite">Followed an interviewer nudge — recorded, but not counted toward your patterns.</p>';
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
