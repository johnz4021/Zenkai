/**
 * Minimal session chrome, served by the session runtime.
 *
 * Design decisions honored in minimal form (full styling arrives with the
 * production shell): rows + hairline dividers, ONE accent (focus only),
 * utility copy (D2), observations-vs-patterns framing (D1), remediation
 * leads when present (D3), two-line evidence citations (variant A).
 *
 * Client behavior lives in client/session.js (served at /client/session.js)
 * — extracted from an inline template literal before voice tripled it.
 * This file owns markup and style only.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_FILES = ['session.js', 'voice.js', 'presence.js'];

/** A named client script, or null for anything not explicitly listed. */
export function clientScript(name = 'session.js'): string | null {
  if (!CLIENT_FILES.includes(name)) return null;
  return readFileSync(path.join(here, 'client', name), 'utf8');
}

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
  header button { background: none; border: 1px solid var(--line); color: #e6e6ea; padding: 5px 12px; font: inherit; cursor: pointer; }
  header #mute { margin-left: auto; color: var(--dim); }
  header #mute.on { color: #e6e6ea; border-color: #e6e6ea; }
  main { flex: 1; display: flex; min-height: 0; }
  iframe { flex: 1; border: 0; }
  aside { width: 340px; border-left: 1px solid var(--line); display: flex; flex-direction: column; }
  #log { flex: 1; overflow-y: auto; padding: 10px 14px; }
  #log .u { margin: 0 0 8px; }
  #log .u b { color: var(--dim); font-weight: normal; }
  #log .pending { color: var(--dim); }
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
  .row .dim { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
  .v-strong .dim { color: var(--accent); }
  .v-weak .dim { color: #e6a23c; }
  .v-none { opacity: .55; }
  #feedback button { background: none; border: 1px solid var(--line); color: var(--dim); padding: 4px 10px; font: inherit; cursor: pointer; }
  .focus { border: 1px solid var(--accent); padding: 10px; margin-top: 14px; }
  .focus .k { color: var(--accent); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
  .meta { color: var(--dim); margin-top: 12px; }
</style>
<header>
  <span>session <b>${sessionId}</b></span>
  <span class="t" id="clock">00:00</span>
  <span class="t" id="status">observing: —</span>
  <span class="t" id="voicechip">voice: —</span>
  <button id="mute" title="mute the mic">mute</button>
  <button id="end">End session</button>
</header>
<main>
  <iframe src="/?folder=/home/workspace/problem"></iframe>
  <aside>
    <div id="log">
      <p class="u"><b>interviewer</b> — just talk. The mic is live (headphones recommended); think out loud freely — the interviewer only replies when you actually address it, and answers spec questions. Where the bug is, you won't get. Typing here works the same way. Mute is in the header.</p>
      <p class="u"><b>observed</b> — edits, saves, file opens, this chat, and test runs made with the <b>Run Tests</b> button in the editor's status bar. Terminal commands are not observed. Silences ≥20s with no activity anywhere count as going quiet. The suite runs once automatically at start.</p>
    </div>
    <div id="feedback"></div>
    <form id="f"><input id="msg" autocomplete="off" placeholder="ask / note an assumption…" /><button>send</button></form>
  </aside>
</main>
<script src="/client/session.js"></script>
<script type="module">
  import { startVoice } from '/client/voice.js';
  const chip = document.getElementById('voicechip');
  const muteBtn = document.getElementById('mute');
  fetch('/api/status').then(r => r.json()).then(s => {
    if (!s.voice || !s.voice.enabled) { chip.textContent = 'voice: off'; muteBtn.style.display = 'none'; return; }
    const v = startVoice({ onState: (c) => { chip.textContent = 'voice: ' + c; } });
    window.ipVoice = v;
    muteBtn.addEventListener('click', () => muteBtn.classList.toggle('on', v.toggleMute()));
  });
</script>
`;
}
