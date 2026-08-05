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

const CLIENT_FILES = ['session.js', 'voice.js', 'presence.js', 'app.js', 'panes.js'];

/** A named client script, or null for anything not explicitly listed. */
export function clientScript(name = 'session.js'): string | null {
  if (!CLIENT_FILES.includes(name)) return null;
  return readFileSync(path.join(here, 'client', name), 'utf8');
}

/** What the page needs to know about the round's shape — derived from the
 *  RoundSpec by the caller. The page renders from capabilities; it never
 *  branches on a format name. */
export interface SessionPageView {
  interviewer: boolean;
  time_limit_ms: number | null;
  one_shot: boolean;
  /** The kickoff suite run — true only for rounds whose trigger is a failure. */
  autorun: boolean;
  /** Which renderer fills the main pane: the nested VS Code workbench or
   *  the HackerRank-style panes layout. From resolveSurface(caps). */
  surface: 'ide' | 'panes';
  /** Drives the panes Run button (absent on no-run and one-shot rounds —
   *  the same condition that hides the IDE's Run Tests affordance). */
  can_run_tests: boolean;
  /** The problem spec, panes only: rendered server-side into the statement
   *  pane. LLM-generated text — escaped before it touches markup. */
  statement: string;
  /** Where "← back to plan" points — the app's timeline for this round's
   *  target when known, the app root otherwise. QA ISSUE-004: the session
   *  page had zero links; a graded candidate was stranded on :3200. */
  back_url?: string | null;
  /** Container path the IDE opens. Per-session (QA ISSUE-005): VS Code Web
   *  keys workbench state by folder URI in browser IndexedDB, so a constant
   *  path resurrects the previous round's tabs. */
  workspace_path?: string;
}

const DEFAULT_VIEW: SessionPageView = {
  interviewer: true,
  time_limit_ms: null,
  one_shot: false,
  autorun: true,
  surface: 'ide',
  can_run_tests: true,
  statement: '',
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The panes main pane — HackerRank-classic layout: statement left, Monaco
 * center with file tabs, run/output panel bottom. Everything around it
 * (header, clock, chat aside, end/submit flow, voice) is the same chrome
 * the IDE surface uses; this replaces ONLY the iframe.
 */
function panesMain(view: SessionPageView): string {
  return /* html */ `<div id="panes">
    <section id="statement"><h1>Problem</h1><div class="body">${esc(view.statement)}</div></section>
    <section id="work">
      <div id="tabs"></div>
      <div id="editor"></div>
      <div id="testpanel">
        <div id="testbar"><span class="lbl">test results</span><span id="runstate"></span></div>
        <pre id="runout"></pre>
      </div>
    </section>
  </div>
  <script src="/vendor/monaco/loader.js"></script>
  <script>
    // AMD worker bootstrap without a bundler: same-origin loader path plus a
    // data-URI shim so the editor worker resolves absolutely. Worker failure
    // degrades to plain editing — visible in the console, not fatal.
    require.config({ paths: { vs: '/vendor/monaco' } });
    window.MonacoEnvironment = {
      getWorkerUrl: function () {
        var base = location.origin + '/vendor/monaco';
        var boot = 'self.MonacoEnvironment={baseUrl:"' + base + '/"};importScripts("' + base + '/base/worker/workerMain.js");';
        return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(boot);
      },
    };
  </script>
  <script src="/client/panes.js"></script>`;
}

export function sessionPage(sessionId: string, partial: Partial<SessionPageView> = {}): string {
  // Merge over defaults: callers state only what differs from the classic
  // debugging round, and a new capability field never breaks old call sites.
  const view: SessionPageView = { ...DEFAULT_VIEW, ...partial };
  const intro = view.interviewer
    ? `<p class="u"><b>interviewer</b> — just talk. The mic is live (headphones recommended); think out loud freely — the interviewer only replies when you actually address it, and answers spec questions. Where the bug is, you won't get. Typing here works the same way. Mute is in the header.</p>`
    : `<p class="u"><b>no interviewer this round</b> — it runs like an online assessment: nobody replies. The mic stays live and thinking out loud still counts; notes typed here land in your record the same way.</p>`;
  const endLabel = view.one_shot ? 'Submit' : 'End session';
  return /* html */ `<!doctype html>
<meta charset="utf-8" />
<title>session ${sessionId}</title>
<style>
  :root { --accent: #7c5cff; --line: #2a2a2e; --dim: #9a9aa2; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-monospace, monospace; background: #17171a; color: #e6e6ea; display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; gap: 16px; padding: 8px 14px; border-bottom: 1px solid var(--line); }
  header .t { color: var(--dim); }
  header a#back { color: var(--dim); text-decoration: none; }
  header a#back:hover { color: #e6e6ea; }
  header button { background: none; border: 1px solid var(--line); color: #e6e6ea; padding: 5px 12px; font: inherit; cursor: pointer; }
  /* Run Tests lives in OUR header, not in the editor. Both IDE affordances
     (status-bar item, editor-title icon) were observed live being missed by
     a candidate who then asked the interviewer how to run tests — one is a
     label that changes after a run, the other an unlabeled icon among VS
     Code's own. A labeled accent button above the workbench cannot hide
     behind whichever tab happens to be focused. */
  header #run { margin-left: auto; border-color: var(--accent); color: var(--accent); font-weight: 600; padding: 5px 16px; }
  header #run:hover:not(:disabled) { background: var(--accent); color: #17171a; }
  header #run:disabled { opacity: .55; cursor: default; }
  header #run + #mute { margin-left: 0; }
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
  /* Panes surface: statement · editor · test panel. Same chrome around it. */
  #panes { flex: 1; display: flex; min-width: 0; }
  #statement { width: 34%; min-width: 260px; max-width: 480px; overflow-y: auto; padding: 16px 18px; border-right: 1px solid var(--line); }
  #statement h1 { font-size: 12px; font-weight: normal; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 0 0 10px; }
  #statement .body { white-space: pre-wrap; line-height: 1.55; }
  #work { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #tabs { display: flex; border-bottom: 1px solid var(--line); overflow-x: auto; }
  #tabs button { background: none; border: 0; border-right: 1px solid var(--line); color: var(--dim); padding: 7px 14px; font: inherit; cursor: pointer; white-space: nowrap; }
  #tabs button.active { color: #e6e6ea; border-bottom: 2px solid var(--accent); }
  #editor { flex: 1; min-height: 0; }
  #testpanel { height: 180px; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
  #testbar { display: flex; align-items: center; gap: 12px; padding: 6px 12px; border-bottom: 1px solid var(--line); }
  #testbar .lbl { color: var(--dim); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
  #runstate { color: var(--dim); }
  #runout { flex: 1; overflow: auto; margin: 0; padding: 8px 12px; font-size: 12px; }
  /* After grading the container is gone — the work pane is dead. The
     card takes the full width and the way home gets prominent. */
  body.ended main iframe { display: none; }
  body.ended main #panes { display: none; }
  body.ended aside { width: auto; flex: 1; border-left: 0; max-width: 720px; margin: 0 auto; }
  .cardback { display: inline-block; margin-top: 18px; color: var(--accent); text-decoration: none; }
</style>
<header>
  ${view.back_url ? `<a id="back" href="${view.back_url}">← back to plan</a>` : ''}
  <span>session <b>${sessionId}</b></span>
  <span class="t" id="clock"${view.time_limit_ms ? ` data-limit="${view.time_limit_ms}"` : ''}>00:00</span>
  <span class="t" id="status">observing: —</span>
  <span class="t" id="voicechip">voice: —</span>
  ${
    view.can_run_tests && !view.one_shot
      ? `<button id="run" class="primary" data-endpoint="${view.surface === 'panes' ? '/api/run' : '/api/ide-run'}" title="run the test suite">▶ Run Tests</button>`
      : ''
  }
  <button id="mute" title="mute the mic">mute</button>
  <button id="end">${endLabel}</button>
</header>
<main>
  ${view.surface === 'panes' ? panesMain(view) : `<iframe src="/?folder=${view.workspace_path ?? '/home/workspace/problem'}"></iframe>`}
  <aside>
    <div id="log">
      ${intro}
      ${view.surface === 'panes'
        ? `<p class="u"><b>observed</b> — edits, tab switches, saves (automatic), this chat, and test runs via the <b>Run Tests</b> button. Silences ≥20s with no activity anywhere count as going quiet.${view.one_shot ? ' The suite runs ONCE, when you press Submit — make it count.' : ''}</p>`
        : `<p class="u"><b>observed</b> — edits, saves, file opens, this chat, and test runs (the <b>Run Tests</b> button, or a test command in the terminal). Other terminal commands are not observed. Silences ≥20s with no activity anywhere count as going quiet.${view.autorun ? ' The suite runs once automatically at start.' : ''}${view.one_shot ? ' The suite runs ONCE, when you press Submit — make it count.' : ''}</p>`}
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
    if (!s.voice || !s.voice.enabled) {
      // Name the cause. "voice: off" alone reads as a broken feature — it was
      // a missing credential, and nothing on the page said so.
      const why = s.voice && s.voice.reason;
      chip.textContent =
        why === 'no_key' ? 'voice: off (no API key)'
        : why === 'disabled' ? 'voice: off (disabled for this round)'
        : 'voice: off';
      chip.title =
        why === 'no_key'
          ? 'Set ELEVENLABS_API_KEY in .env at the repo root (auto-loaded), then restart the app server. The interviewer still works — text only.'
          : why === 'disabled'
          ? 'This session was started with IP_VOICE=0.'
          : '';
      muteBtn.style.display = 'none';
      return;
    }
    const v = startVoice({ onState: (c) => { chip.textContent = 'voice: ' + c; } });
    window.ipVoice = v;
    muteBtn.addEventListener('click', () => muteBtn.classList.toggle('on', v.toggleMute()));
  });
</script>
`;
}
