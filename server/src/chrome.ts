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
  /** Drives the Run button on BOTH surfaces — alone (un-conflation
   *  2026-08-15): `one_shot` is the autograding contract and never hides
   *  the run loop; a visible suite is a runnable suite. */
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
  /** How far into the round the server says we are, at page render. The
   *  client clock seeds from this instead of page-load time — QA 2026-08-14:
   *  a reload mid-round restarted the displayed countdown at the full limit
   *  while the server kept enforcing the real deadline. */
  elapsed_ms?: number;
  /** Whether the voice runtime is actually on. The intro copy must not
   *  promise a live mic on IP_VOICE=0 / no-key rounds (QA 2026-08-14). */
  voice?: boolean;
  /** Pre-built analytics markup (posthogSnippet — session.ts owns the config
   *  and the block/replay decision). Absent = nothing rendered, and the page
   *  is byte-identical to pre-analytics output. Built OUTSIDE this template
   *  on purpose: the snippet is the one inline script the new Function()
   *  parse tests don't reach, so it lives where posthog.test.ts parses it. */
  analytics?: string;
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

/** The statement pane's one formatting concession: escaped first, then
 *  backticked spans become <code>. Generators backtick identifiers despite
 *  the plain-prose statement rules, and raw backticks read as typos to a
 *  candidate under a clock. Exported for the pin test. */
export function statementHtml(statement: string): string {
  return esc(statement).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

/**
 * The panes main pane — HackerRank-classic layout: statement left, Monaco
 * center with file tabs, run/output panel bottom. Everything around it
 * (header, clock, chat aside, end/submit flow, voice) is the same chrome
 * the IDE surface uses; this replaces ONLY the iframe.
 */
function panesMain(view: SessionPageView): string {
  return /* html */ `<div id="panes">
    <section id="statement"><h1>Problem</h1><div class="body">${statementHtml(view.statement)}</div></section>
    <section id="work">
      <div id="tabs"></div>
      <div id="editor"></div>
      <div id="mdpreview"></div>
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
        // The worker must get the SAME vs-path mapping the page uses: with
        // only baseUrl set, the worker resolves 'vs/language/json/…' under a
        // dir that already IS vs/, doubling the segment into a 404 for every
        // language worker (QA 2026-08-14 — 4 console errors per JSON tab).
        var boot = 'self.MonacoEnvironment={baseUrl:"' + base + '/"};importScripts("' + base + '/base/worker/workerMain.js");require.config({paths:{vs:"' + base + '"}});';
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
  const voiceOn = view.voice !== false;
  // Solo rounds have no aside at all — conversation UI exists iff someone is
  // listening (owner decision 2026-08-15). A live mic recorded silent rooms
  // (TODOS #49) and a composer with no counterpart invited grader-directed
  // notes; a real OA is problem + code + clock + submit. The intro therefore
  // only has interviewer variants; solo etiquette is the #notice line, which
  // also re-homes the aside's other two jobs (time warnings, system errors).
  const intro = voiceOn
    ? `<p class="u"><b>interviewer</b> — just talk. The mic is live (headphones recommended); think out loud freely — the interviewer only replies when you actually address it, and answers spec questions. Where the bug is, you won't get. Typing here works the same way. Mute is in the header.</p>`
    : `<p class="u"><b>interviewer</b> — voice is off this round, so type here. The interviewer only replies when you actually address it, and answers spec questions. Where the bug is, you won't get.</p>`;
  // Three independent facts, three independent clauses (un-conflation
  // 2026-08-15): etiquette (always), the run loop (can_run_tests), the
  // grading contract (one_shot). The old fused ternary could not express
  // "autograded AND runnable", which is what a real OA is.
  const soloNotice = view.interviewer
    ? ''
    : `<div id="notice">no interviewer this round — runs like an online assessment: nobody replies.${
        view.can_run_tests
          ? view.one_shot
            ? ' Run the suite as often as you like — the graded run happens ONCE, when you press Submit.'
            : ''
          : ` Nothing runs this round — press ${view.one_shot ? 'Submit' : 'End session'} when your write-up is ready.`
      }</div>`;
  const endLabel = view.one_shot ? 'Submit' : 'End session';
  return /* html */ `<!doctype html>
<meta charset="utf-8" />
<title>session ${sessionId}</title>
<script>
  // Beta auth handoff (WU4): the app opens this page with #token=<jwt> —
  // the session origin can't see the app origin's cookie. Runs FIRST, before
  // any script or iframe fires a request, so every fetch/WS/proxy asset load
  // below already carries the cookie. Auth off: no fragment, nothing happens.
  (function () {
    if (window.location.hash.indexOf('#token=') === 0) {
      var t = decodeURIComponent(window.location.hash.slice(7));
      document.cookie = 'ip_jwt=' + t + '; path=/; SameSite=Lax; max-age=86400' +
        (window.location.protocol === 'https:' ? '; Secure' : '');
      window.history.replaceState(null, '', window.location.pathname);
    }
  })();
</script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%230e0e0f'/%3E%3Cpath d='M42.8 56 L18.5 56 L19.85 42.5 L44.15 21.5 L36.5 42.5 L53.6 42.5 Z' fill='%23bf2b50'/%3E%3Cpath d='M19.85 42.5 L44.15 21.5 L36.5 42.5 Z' fill='%2399203f'/%3E%3Cpath d='M21.2 8 L45.5 8 L44.15 21.5 L19.85 42.5 L27.5 21.5 L10.4 21.5 Z' fill='%235099c2'/%3E%3Cpath d='M44.15 21.5 L19.85 42.5 L27.5 21.5 Z' fill='%2338708f'/%3E%3Cpath d='M44.15 21.5 L19.85 42.5' stroke='%230e0e0f' stroke-width='1.5'/%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet" />
${view.analytics ? view.analytics + '\n' : ''}<style>
  /* Graphite Steel — the SAME token block as the plan app (app.ts). One skin. */
  :root {
    --bg: #0e0e0f; --panel: #151517; --raised: #1d1e20; --sunk: #131314;
    --text-1: #f4f4f5; --text-2: #96979b; --text-3: #66676b;
    --line: #292a2c; --line-soft: #1c1c1e; --rule: #191919;
    --steel: #35708f; --steel-text: #7ea9c2;
    --ok: #5f9e7a; --weak: #e82b86; --weak-text: #ff6fae; --none: #4a4b4f;
    --mono: 'JetBrains Mono', ui-monospace, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13.5px/1.45 'Archivo', system-ui, sans-serif; background: var(--bg); color: var(--text-1); display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; gap: 16px; padding: 8px 14px; border-bottom: 1px solid var(--line); }
  /* One line, always. The header's spans are flex items with default
     shrink, so a chip growing ("voice: speaking" during TTS) squeezed a
     sibling until its text wrapped to a second line — the whole header
     pumped taller and back with every interviewer turn (measured live,
     2026-08-16: 46px → 62px at 1200px viewport). nowrap forbids the wrap;
     #status is the one designated shrinker and ellipsizes instead. */
  header > span, header a#back { white-space: nowrap; }
  header #status { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
  /* The voice chip cycles listening ↔ hearing you on EVERY speech segment;
     nowrap killed the height pump, but the width change still shifted the
     whole right-side button cluster each swap (owner report, 2026-08-17).
     18ch seats the longest routine state exactly ("voice: hearing you" —
     mono, so ch is per-character). The rare failure states ("voice link
     lost — text only") overflow it once and stay put — a one-time shift on
     an exceptional event, not per-segment jitter. */
  header #voicechip { min-width: 18ch; }
  header .t { color: var(--text-2); font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; }
  header #clock { color: var(--steel-text); }  /* the timer is steel: time is steel's whole job */
  header a#back { color: var(--text-2); text-decoration: none; }
  header a#back:hover { color: var(--text-1); }
  header button { background: none; border: 1px solid var(--line); color: var(--text-1); padding: 5px 12px; font: inherit; cursor: pointer; border-radius: 6px; }
  /* Run Tests lives in OUR header, not in the editor. Both IDE affordances
     (status-bar item, editor-title icon) were observed live being missed by
     a candidate who then asked the interviewer how to run tests — one is a
     label that changes after a run, the other an unlabeled icon among VS
     Code's own. A labeled button above the workbench cannot hide behind
     whichever tab happens to be focused. White fill, not steel: the action
     must never share a color with the indicators. */
  header #run { margin-left: auto; background: var(--text-1); border-color: var(--text-1); color: var(--bg); font-weight: 600; padding: 5px 16px; }
  header #run:hover:not(:disabled) { background: #fff; border-color: #fff; }
  header #run:disabled { opacity: .55; cursor: default; }
  header #run + #mute { margin-left: 0; }
  header #mute { margin-left: auto; color: var(--text-2); }
  header #mute.on { color: var(--text-1); border-color: var(--text-1); }
  main { flex: 1; display: flex; min-height: 0; }
  iframe { flex: 1; border: 0; }
  aside { width: 340px; border-left: 1px solid var(--line); display: flex; flex-direction: column; background: var(--sunk); }
  #log { flex: 1; overflow-y: auto; padding: 10px 14px; }
  #log .u { margin: 0 0 8px; }
  #log .u b { color: var(--text-2); font-weight: normal; }
  #log .pending { color: var(--text-2); }
  form { display: flex; border-top: 1px solid var(--line); }
  input { flex: 1; background: none; border: 0; color: inherit; font: inherit; padding: 10px 14px; outline: none; }
  form button { background: none; border: 0; border-left: 1px solid var(--line); color: var(--text-2); padding: 0 14px; font: inherit; cursor: pointer; }
  #feedback { display: none; padding: 18px; overflow-y: auto; }
  #feedback h2 { font-family: var(--mono); font-size: 12px; font-weight: normal; color: var(--text-2); margin: 0 0 4px; text-transform: uppercase; letter-spacing: .06em; }
  .row { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .row .desc { margin: 0 0 6px; }
  .cite { color: var(--text-2); }
  .cite .clk { color: var(--text-1); }
  .delta { color: var(--text-2); padding-left: 18px; }
  .closedmark { border-left: 2px solid var(--steel); padding-left: 10px; }
  /* Grade grammar: color AND shape (■ strong · ◆ weak · ▫ not-shown + hatch). */
  .row .dim { font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
  .row .dim::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 7px; border: 1px solid var(--none); vertical-align: 0; }
  .v-strong .dim { color: var(--ok); }
  .v-strong .dim::before { background: var(--ok); border-color: var(--ok); }
  .v-weak .dim { color: var(--weak-text); }
  .v-weak .dim::before { background: var(--weak); border-color: var(--weak); transform: rotate(45deg) scale(.9); }
  .v-none { opacity: .55; background: repeating-linear-gradient(45deg, transparent 0 5px, rgba(255, 255, 255, .03) 5px 10px); }
  #feedback button { background: none; border: 1px solid var(--line); color: var(--text-2); padding: 4px 10px; font: inherit; cursor: pointer; border-radius: 6px; }
  .focus { border: 1px solid var(--steel); padding: 10px; margin-top: 14px; border-radius: 6px; }
  .focus .k { color: var(--steel-text); font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
  .meta { color: var(--text-2); margin-top: 12px; }
  .confirm { margin-top: 10px; color: var(--text-2); }
  button.cf { background: none; border: 1px solid #3c3d40; color: var(--text-1); padding: 3px 12px; font: inherit; cursor: pointer; border-radius: 6px; margin-left: 6px; }
  button.cf:hover { border-color: var(--text-3); }
  /* Panes surface: statement · editor · test panel. Same chrome around it. */
  #panes { flex: 1; display: flex; min-width: 0; }
  #statement { width: 34%; min-width: 260px; max-width: 480px; overflow-y: auto; padding: 16px 18px; border-right: 1px solid var(--line); }
  #statement h1 { font-family: var(--mono); font-size: 11px; font-weight: normal; color: var(--text-3); text-transform: uppercase; letter-spacing: .06em; margin: 0 0 10px; }
  #statement .body { white-space: pre-wrap; line-height: 1.55; }
  #statement .body code, #mdpreview code { font-family: var(--mono); font-size: .92em; background: var(--sunk); padding: 1px 5px; border-radius: 4px; }
  /* Markdown preview: the read-side view for .md tabs (panes.js applyView
     toggles it against #editor). Hidden until a markdown tab is active. */
  #mdpreview { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 22px; display: none; line-height: 1.6; max-width: 72ch; }
  #mdpreview h2, #mdpreview h3, #mdpreview h4 { margin: 18px 0 8px; line-height: 1.3; }
  #mdpreview h2 { font-size: 17px; } #mdpreview h3 { font-size: 15px; } #mdpreview h4 { font-size: 13px; }
  #mdpreview p { margin: 0 0 10px; } #mdpreview ul { margin: 0 0 10px; padding-left: 22px; }
  #mdpreview pre { background: var(--sunk); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; overflow-x: auto; margin: 0 0 12px; }
  #mdpreview pre code { background: none; padding: 0; }
  /* Tab-strip controls: the infra overflow and the md preview toggle are
     controls, not files — quieter than tabs, and the toggle hugs the right. */
  #tabs button.more { color: var(--text-3); }
  #tabs button.mdtoggle { margin-left: auto; color: var(--steel-text); border-right: 0; border-left: 1px solid var(--line); }
  #work { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #tabs { display: flex; border-bottom: 1px solid var(--line); overflow-x: auto; }
  #tabs button { background: none; border: 0; border-right: 1px solid var(--line); color: var(--text-2); padding: 7px 14px; font: 12px/1.45 var(--mono); cursor: pointer; white-space: nowrap; border-radius: 0; }
  #tabs button.active { color: var(--text-1); background: var(--sunk); border-bottom: 2px solid var(--steel); }  /* position marker */
  #editor { flex: 1; min-height: 0; }
  #testpanel { height: 180px; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
  #testbar { display: flex; align-items: center; gap: 12px; padding: 6px 12px; border-bottom: 1px solid var(--line); }
  #testbar .lbl { color: var(--text-3); font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
  #runstate { color: var(--text-2); font-family: var(--mono); font-size: 12px; }
  #runstate.pass { color: var(--ok); }
  #runstate.fail { color: var(--weak-text); }
  #runout { flex: 1; overflow: auto; margin: 0; padding: 8px 12px; font: 12px/1.5 var(--mono); }
  /* The solo-round notice: the aside's three jobs (etiquette, time warnings,
     system errors) re-homed into one quiet static line. Never sticky
     (DESIGN.md rule 4); utility copy only (rule 10). */
  #notice { padding: 6px 14px; border-bottom: 1px solid var(--line); color: var(--text-2); font-family: var(--mono); font-size: 12px; }
  /* After grading the container is gone — the work pane is dead. The card
     (#feedback, a MAIN child on every variant — solo pages have no aside to
     host it) takes the full width and the way home gets prominent. */
  body.ended main iframe { display: none; }
  body.ended main #panes { display: none; }
  body.ended aside { display: none; }
  body.ended #notice { display: none; }
  body.ended #feedback { flex: 1; max-width: 720px; margin: 0 auto; }
  .cardback { display: inline-block; margin-top: 18px; color: var(--text-1); text-decoration: underline; }
  :is(button, input, a):focus-visible { outline: 2px solid var(--steel); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
<header>
  ${view.back_url ? `<a id="back" href="${view.back_url}">← back to plan</a>` : ''}
  <span>session <b id="sid">${sessionId}</b></span>
  <span class="t" id="clock"${view.time_limit_ms ? ` data-limit="${view.time_limit_ms}"` : ''}${view.elapsed_ms ? ` data-elapsed="${view.elapsed_ms}"` : ''}>00:00</span>
  <span class="t" id="status"${view.one_shot ? ' data-one-shot="1"' : ''}${view.interviewer ? ' data-interviewer="1"' : ''}${view.can_run_tests ? '' : ' data-no-run="1"'}>observing: —</span>
  ${view.interviewer ? '<span class="t" id="voicechip">voice: —</span>' : ''}
  ${view.interviewer ? '<span class="t" id="intchip" hidden></span>' : ''}
  ${
    view.can_run_tests
      ? `<button id="run" class="primary" data-endpoint="${view.surface === 'panes' ? '/api/run' : '/api/ide-run'}" title="run the test suite">▶ Run Tests</button>`
      : ''
  }
  ${view.interviewer ? '<button id="mute" title="mute the mic">mute</button>' : ''}
  <button id="end">${endLabel}</button>
</header>
${soloNotice}
<main>
  ${view.surface === 'panes' ? panesMain(view) : `<iframe src="/?folder=${view.workspace_path ?? '/home/workspace/problem'}"></iframe>`}
  ${
    view.interviewer
      ? `<aside>
    <div id="log">
      ${intro}
      ${view.surface === 'panes'
        ? `<p class="u"><b>observed</b> — edits, tab switches, saves (automatic), and this chat${view.can_run_tests ? ', and test runs via the <b>Run Tests</b> button' : ''}. Silences ≥20s with no activity anywhere count as going quiet.${view.one_shot ? (view.can_run_tests ? ' Run the suite as often as you like — the graded run happens ONCE, when you press Submit.' : ' Nothing runs in this round — press Submit when your write-up is ready.') : ''}</p>`
        : `<p class="u"><b>observed</b> — edits, saves, which file is focused and roughly where you're scrolled to, and this chat${view.can_run_tests ? ', and test runs (the <b>Run Tests</b> button, or a test command in the terminal). Other terminal commands are not observed' : ''}. Silences ≥20s with no activity anywhere count as going quiet.${view.autorun ? ' The suite runs once automatically at start.' : ''}${view.one_shot ? (view.can_run_tests ? ' Run the suite as often as you like — the graded run happens ONCE, when you press Submit.' : ' Nothing runs in this round — press Submit when your write-up is ready.') : ''}</p>`}
    </div>
    <form id="f"><input id="msg" autocomplete="off" placeholder="ask / note an assumption…" /><button>send</button></form>
  </aside>`
      : ''
  }
  <div id="feedback"></div>
</main>
<script src="/client/session.js"></script>
${
  view.interviewer
    ? `<script type="module">
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
</script>`
    : ''
}
`;
}
