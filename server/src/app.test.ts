/**
 * The home app page ships with no build step, so a syntax error in app.js
 * silently kills the entire surface — same guard as chrome.test.ts. The
 * markup assertions pin the design review's hard-rule fixes: real labels
 * (placeholder-as-label was a violation on all four fields), the stated
 * desktop-only notice, and the a11y landmarks the timeline relies on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPage } from './app.js';
import { clientScript } from './chrome.js';

describe('home app page', () => {
  const html = appPage();
  const js = clientScript('app.js') ?? '';

  it('has a parseable client script', () => {
    expect(js.length).toBeGreaterThan(0);
    expect(() => new Function(js)).not.toThrow();
  });

  it('the page loads the client script and all three page sections', () => {
    expect(html).toContain('/client/app.js');
    expect(html).toContain('id="index"');
    expect(html).toContain('id="entry"');
    expect(html).toContain('id="history"');
    expect(html).toContain('id="timeline"');
  });

  it('the login screen mounts into a container the page actually has', () => {
    // renderLogin queried <main>, which appPage() has never emitted: the
    // appendChild threw, initAuth died, and the logged-out visitor got a boot
    // skeleton forever. Local dev could not catch it — auth is off without
    // IP_SUPABASE_*, so renderLogin never ran until the live box had it on.
    expect(html).toContain('id="page"');
    expect(js).toContain("function renderLogin(");
    expect(js).not.toContain("querySelector('main')");
    expect(js).not.toContain("'main > section'");
    // The skeleton is removed by render(), which never runs on this path.
    expect(js).toContain("if (boot) boot.remove();");
  });

  it('the auth screen has real labels and two honest modes', () => {
    // DESIGN.md rule 5 (real labels, always) records placeholder-as-label as a
    // violation that already shipped once; the login email field was the
    // second time. Both fields now carry a visible <label for>.
    expect(js).toContain('<label for="login-email">Email</label>');
    expect(js).toContain('<label for="login-pass">Password</label>');
    // Sign in / Sign up is a real difference, not two labels on one path: the
    // tab picks the ENDPOINT, so `signup` refuses to sign an existing user in
    // and `token` refuses to create an account. A typo'd address says so
    // instead of silently minting a second empty account nobody finds again.
    expect(js).toContain("gotrue('signup'");
    expect(js).toContain("gotrue('token?grant_type=password'");
    expect(js).toContain('switch to Sign up if you are new');
    expect(js).toContain('switch to Sign in');
    // Password autocomplete must follow the tab or managers offer the wrong
    // thing: a saved password on the signup tab, a new one on sign-in.
    expect(js).toContain("signUp ? 'new-password' : 'current-password'");
    // No email round-trip anywhere in the credential path — that dependency
    // is exactly what this replaced (built-in SMTP is rate-limited, custom
    // SMTP was never configured).
    expect(js).not.toContain("gotrue('otp'");
    expect(js).not.toContain("gotrue('verify'");
    // Signup is open (decision 2026-08-12) — the screen must not claim to be
    // invite-gated when nothing enforces an invite.
    expect(js).not.toContain('small invited beta');
    // Signed-out masthead links route into surfaces that 401.
    expect(js).toContain("nav .navright");
  });

  it('the hidden attribute actually hides — CSS display must not outrank it', () => {
    // `hidden` is only a UA display:none. #practice sets display:flex to
    // center its hero, so a hidden #practice still held 411px above the login
    // screen on the live box. Any route toggle could hit the same slip.
    expect(html).toContain('[hidden] { display: none !important; }');
  });

  it('navigation is routes, not visibility toggles', () => {
    expect(html).toContain('href="#/" id="nav-home"');
    expect(html).toContain('href="#/plans" id="nav-plans"');
    expect(html).toContain('href="#/history" id="nav-history"');
    expect(js).toContain('function route()');
    expect(js).toContain("addEventListener('hashchange'");
    // The poll-stomps-navigation bug: visibility must never derive from
    // whether targets exist.
    expect(js).not.toContain("el('entry').hidden = hasTargets");
  });

  it('the intake IS the composer — the form is dead (Cowork grammar D1)', () => {
    // No labeled form fields: the first Send creates the target.
    for (const id of ['e-desc', 'e-date', 'e-company', 'e-link']) {
      expect(html).not.toContain(`label for="${id}"`);
    }
    expect(html).not.toContain('Build my plan');
    expect(js).toContain('Describe the interview — paste everything you have');
    expect(js).toContain('Correct me where I am wrong. What you saw yourself outranks anything I find.');
    expect(js).toContain('function planFirstSend');
    // The file input survives as the composer's Attach target.
    expect(html).toContain('id="e-file"');
    expect(js).toContain('plan-attach-btn');
    // Links keep an explicit, clearly-optional input (user call, 2026-08-07).
    expect(js).toContain('add a link (optional)');
    expect(js).toContain('plan-addlink');
    expect(html).not.toMatch(/how it works/i);
  });

  it('a long paste becomes a chip, never a wall (live-screenshot finding 2026-08-07)', () => {
    expect(js).toContain('PASTE_CHIP_CHARS');
    expect(js).toContain("addEventListener('paste'");
    expect(js).toContain('pastechip'); // replayed long kickoffs collapse too
  });

  it('adaptation is preview-then-apply — the model never writes unapproved', () => {
    expect(js).toContain("'/api/adapt'");
    expect(js).toContain("'/api/adapt/apply'");
    expect(js).toContain('add what you learned');
    expect(js).toContain('nothing to change');
  });

  it('the preview shows blueprint changes and apply ships the FULL material', () => {
    // Blueprints are the recipe half of a round; the raw note must reach
    // the server verbatim so learnings.md never loses what an LLM dropped.
    expect(js).toContain('blueprint ');
    expect(js).toContain("bp.action === 'new' ? 'created' : 'revised'");
    expect(js).toContain('material: material');
    expect(html).toContain('.bpview');
  });

  it('finished rows carry their judged feedback, re-readable from the plan', () => {
    // The session server that first rendered the card is torn down minutes
    // after grading — feedback nobody can re-read is feedback that never
    // happened. The plan page is where it lives.
    expect(js).toContain("'/api/feedback?session='");
    expect(js).toContain('fbtoggle');
    expect(js).toContain('function renderCardHtml');
    // The bug still shows only when solved (unspoiled re-runs).
    expect(js).toContain('card.bug && card.solved');
    // REVERSED (WU-C, multi-session build): the history card now OWNS the
    // "did this match?" control — the session-side copy dies with its tab
    // and with the 30-min ended-session reap. Confirms POST to the app.
    expect(js).toContain("'/api/card-feedback'");
    expect(js).toContain('fbconfirm');
    expect(html).toContain('.fbcard');
  });

  it('a stale ready problem is offered a rebuild, never silently swapped', () => {
    expect(js).toContain('button.rebuild');
    expect(js).toContain('built for the old round shape');
    expect(html).toContain('.adaptpanel');
  });

  it('the Gaps band leads the history page, fetched off the poll', () => {
    // Cross-session memory made visible: the band renders from /api/memory,
    // fetched once per history open — NEVER inside the 5s refresh loop —
    // and the cache drops when the route leaves history.
    expect(js).toContain("fetch('/api/memory')");
    expect(js).toContain('function renderGapsBand');
    expect(js).toContain("if (r.page !== 'history') memoryCache = null;");
    // Shape backs hue (DESIGN.md): the strip is glyphs, not color alone,
    // and it is decorative to a screen reader — the state line is the text.
    expect(js).toContain('aria-hidden="true"');
    expect(html).toContain('.gapsband');
    expect(html).toContain('.gapstrip');
  });

  it('season topics render on confirm (pre-freeze) and on the season page (post-deposit)', () => {
    expect(js).toContain('this season tests:');
    expect(js).toContain('topic_rollup');
    expect(js).toContain('not yet exercised');
    expect(html).toContain('.topicband');
  });

  it('no surface promises a user the CLI-only rejudge', () => {
    expect(js).not.toContain('recoverable via rejudge');
  });

  it('a running session can be ended from the masthead — discard, never grade (QA ISSUE-001/D1)', () => {
    expect(html).toContain('id="nav-kill"');
    expect(js).toContain("'/api/session-kill'");
    expect(js).toContain('End without grading?');
  });

  it('today\'s completions and season completion render — finishing never looks empty (QA ISSUE-002)', () => {
    expect(js).toContain("d.kind === 'done-today'");
    expect(js).toContain("d.kind === 'complete'");
    expect(js).toContain('season complete');
    expect(js).toContain("d.kind === 'quiet'");
  });

  it('generation progress is measured, not decorative (QA ISSUE-007/008)', () => {
    expect(js).toContain('genclock');
    expect(js).toContain('usually 5–8 min');
    expect(js).toContain('GEN_WALL_MS');
    // The lying static estimate is gone for good.
    expect(js).not.toContain('about 5 minutes');
    expect(js).not.toContain('takes a minute to boot');
  });

  it('Start speaks at the click point (QA ISSUE-006)', () => {
    expect(js).toContain("btn.textContent = 'Starting…'");
    expect(js).toContain('launchline');
    expect(js).toContain("couldn't start — is Docker running?");
  });

  it('research reads as prose with inline links — the trace widget is dead (D1)', () => {
    // CEO review 2026-08-02 (D9) cut preemptive research; D3 re-fenced it
    // inside the planner turn; D1 (2026-08-07) made its OUTPUT prose: the
    // model cites sources as markdown links in its own sentences.
    expect(js).not.toContain('runResearch');
    expect(js).not.toContain('/api/research');
    expect(js).not.toContain('Looked up');
    expect(js).not.toContain('renderTraceLine');
    expect(js).toContain('function linkify');
  });

  it('the chat is prose-only; ALL structure lives in the plan panel (D1)', () => {
    expect(js).toContain('Answer, correct me, or ask what a round shape is');
    expect(js).toContain('/api/plan/turn');
    expect(js).toContain('nothing is generated until you confirm');
    expect(html).toContain('#plan-panel');           // panel styles ship with the page
    expect(html).toContain('#plan-wrap');            // two-pane layout
    // Closed questions get Cowork-style tappable options (user call,
    // 2026-08-07): shortcuts to typing, only live on the latest turn.
    expect(js).toContain('.qopt');
    // The open question is PINNED to the composer, not left in the
    // transcript — a live control you must scroll back to find is not one.
    expect(js).toContain('function pendingAsk');
    expect(js).toContain('id="plan-ask"');
    expect(js).toContain('id="ask-dismiss"');
    expect(js).toContain('renderAskCard() + chips');
    expect(js).toContain('or just type your answer below');
    expect(html).toContain('#plan-ask');
    // A tool-only message carries no words — the panel is its feedback.
    // Rendering it painted an empty bubble on EVERY proposal turn (live
    // failure 2026-08-08).
    // Behavioural pin, not a source snapshot: a wordless assistant turn is
    // skipped, whatever else the condition grows to allow through.
    expect(js).toMatch(/if \(!\(t\.prose \|\| ''\)\.trim\(\)[\s\S]{0,160}?\) return;/);
    expect(html).toContain('.qopt');
    // The widgets the panel replaced must stay dead.
    expect(js).not.toContain('renderQuestionBlock');
    expect(js).not.toContain('renderConflict');
    expect(js).not.toContain('runClarify');
    expect(js).not.toContain('renderConfirm(');
  });

  it('the panel captures evidence_tier (free override) and the conversational pace', () => {
    expect(js).toContain("['firsthand', 'secondhand', 'public_prior']");
    expect(js).toContain('evidence_tier');
    expect(js).toContain('pace_per_week');
    expect(js).toContain('rounds/week');
    expect(html).toContain('.gaterow.flash');        // row-flash on proposal updates
    expect(html).toContain('prefers-reduced-motion');
  });

  it('a link the fetcher cannot read becomes a paste nudge, never silence', () => {
    // Many sites (reddit.com among them) are blocked at the tool layer, and
    // the candidate's OWN links are the ones that fail (2026-08-08).
    expect(js).toContain('t.unreadable');
    expect(js).toContain("Paste the text here instead");
    expect(html).toContain('.unread');
  });

  it('a missing API key never hides an existing conversation or its plan', () => {
    // Live failure 2026-08-08: no key threw away 11 turns and a complete
    // proposal, leaving a blank page. Replay + confirm survive; only
    // sending dies (accept-spec needs no key).
    expect(js).toContain('plan.readOnly');
    expect(js).toContain('your conversation and plan are intact');
    expect(js).toContain('(plan.busy || plan.readOnly ? \' disabled\' : \'\')');
  });

  it('an abandoned plan is resumable or deletable, never a dead end', () => {
    expect(js).toContain('resume planning');
    expect(js).toContain('/api/plan/conversation');
    expect(js).toContain('/api/target/delete');
  });

  it('desktop-only is stated, not broken (D7)', () => {
    expect(html).toContain('id="narrow"');
    expect(html).toMatch(/@media \(max-width: 700px\)/);
    expect(html).toContain('it lives on your laptop');
  });

  it('a11y: live banner, visible focus, no outline removal without replacement', () => {
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(':focus-visible');
    expect(html).not.toMatch(/outline:\s*none/);
  });

  it('the client renders the runway as an ordered list with aria-current on TODAY', () => {
    expect(js).toContain('aria-current="date"');
    expect(js).toContain('ol class="runway"');
  });

  it('the client never renders the label — round N string as a title', () => {
    // itemTitle falls through title → planned_title → label; the label is
    // last resort only, and nothing else may synthesize "round N" text.
    expect(js).toContain('item.title || item.planned_title || item.label');
    expect(js).not.toMatch(/— round ' \+/);
  });

  it('polling is focus-safe by construction', () => {
    expect(js).toContain('userIsTyping');
    expect(js).toContain('pendingState');
  });
});

describe('product identity', () => {
  const html = appPage();
  const js = clientScript('app.js') ?? '';

  it('ships a mark and a wordmark, not a bare micro-label', () => {
    expect(html).toContain('class="brand"');
    expect(html).toContain('class="word"');
    expect(html).toContain('>Zenkai<');
    expect(html).toContain('aria-label="Zenkai — home"');
    // The folded-Z mark: one ribbon split corner-to-corner across the
    // diagonal, each half carrying a lit face and the fold behind it.
    expect(html).toContain('class="plate-blue"');
    expect(html).toContain('class="plate-blue-fold"');
    expect(html).toContain('class="plate-red"');
    expect(html).toContain('class="plate-red-fold"');
    expect(html).toContain('class="seam"');
  });

  it('the mark is 180°-rotationally symmetric — red is blue turned over', () => {
    // Both halves trace the same outline, so a coordinate typo in one shows
    // up as an asymmetry here rather than as a lopsided logo in production.
    const d = (cls: string) =>
      html.match(new RegExp(`class="${cls}" d="([^"]+)"`))?.[1] ?? '';
    const pts = (path: string) =>
      [...path.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    // Rotate the blue half a half-turn about the mark's center (24, 24).
    // Round after rotating: 48 - 36.15 lands at 11.850000000000001 in binary
    // float, and the mark is authored to two decimals anyway.
    const turned = pts(d('plate-blue')).map(([x, y]) => [48 - x!, 48 - y!]);
    const red = pts(d('plate-red'));
    expect(red.length).toBe(6); // guard: a failed match makes the compare vacuous
    expect(red.length).toBe(turned.length);
    // Same cycle, different starting vertex: compare as sorted point sets.
    const key = (ps: number[][]) =>
      ps.map((p) => p.map((n) => n.toFixed(2)).join(',')).sort().join(' ');
    expect(key(red)).toBe(key(turned));
  });

  it('the tab is identifiable: favicon plus per-route titles', () => {
    expect(html).toContain('rel="icon"');
    expect(html).toMatch(/image\/svg\+xml/);
    expect(js).toContain('function setTitle');
    expect(js).toContain('document.title');
    // The countdown belongs in the tab for a season.
    expect(js).toContain("' days · '");
    expect(js).toContain('Zenkai');
  });

  it('first paint has shape — a skeleton, not a blank page', () => {
    expect(html).toContain('id="boot"');
    expect(html).toMatch(/class="sk"/);
    expect(js).toContain("el('boot')");
  });

  it('session status lives in the masthead; the banner is for errors only', () => {
    expect(html).toContain('id="nav-live"');
    expect(js).toContain("el('nav-live').classList.toggle('on'");
    expect(js).not.toContain('A session is running');
  });

  it('the scrollbar belongs to the instrument, not the OS', () => {
    expect(html).toContain('::-webkit-scrollbar');
    expect(html).toContain('scrollbar-color');
  });
});

describe('practice door — server wiring (pinned via source, app.test.ts never runs the server)', () => {
  const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');

  it('every practice endpoint exists', () => {
    for (const route of ['/api/practice/clarify', '/api/practice/launch', '/api/practice/retry']) {
      expect(appSource).toContain(`url === '${route}'`);
    }
    expect(appSource).toContain(`url === '/api/practice'`);
  });

  it('the sweep covers reps and failures speak with actionable copy', () => {
    expect(appSource).toContain('sweepReps(');
    expect(appSource).toContain('clarifyFailureMessage');
  });

  it('rep builds write the marker at request time via spawnRepBuild', () => {
    const spawnBlock = appSource.slice(appSource.indexOf('function spawnRepBuild'));
    expect(spawnBlock.indexOf('writeGeneratingMarker')).toBeGreaterThan(-1);
    expect(spawnBlock.indexOf('writeGeneratingMarker')).toBeLessThan(spawnBlock.indexOf('function sweepOrphanedGenerations'));
  });

  it("a rep-build close-handler never overwrites the CLI's draft-failure marker", () => {
    // The child writes .failed with the "draft: " prefix; overwriting it with
    // "exit 1" would erase the draft_failed phase.
    const spawnBlock = appSource.slice(
      appSource.indexOf('function spawnRepBuild'),
      appSource.indexOf('function sweepOrphanedGenerations'),
    );
    expect(spawnBlock).toContain("!existsSync(path.join(dir, '.failed'))");
  });

  it('/api/state carries reps with the save-if-changed discipline', () => {
    expect(appSource).toContain('repStateView(repoRoot, repsFresh)');
    expect(appSource).toMatch(/JSON\.stringify\(repsFresh\) !== JSON\.stringify\(repsStored\)/);
  });
});

describe('practice door — client surface', () => {
  const html = appPage();
  const js = clientScript('app.js') ?? '';

  it('the masthead is tabs with a steel you-are-here (composer-first, 2026-08-10)', () => {
    // Three tabs: practice (→ '#/', the generator — the wordmark alone was
    // an undiscoverable way back), plans, history. Active tab wears the
    // steel underline via aria-current — wayfinding and a11y as one
    // mechanism.
    expect(html).toContain('href="#/" id="nav-practice"');
    expect(html).not.toContain('id="nav-new"');
    expect(html).toMatch(/#nav-practice, #nav-plans, #nav-history \{ color: var\(--text-2\)/);
    expect(html).toMatch(/\.navright a\[aria-current="page"\]/);
    expect(html).toMatch(/text-decoration-color: var\(--steel\)/);
    expect(js).toContain("el('nav-practice').setAttribute('aria-current', 'page')");
    expect(html).toContain('<section id="practice" hidden>');
    // Plan creation moved to the plans page with the masthead slot.
    expect(js).toContain('class="addlink">+ new plan');
    // The primary button sells the outcome, not the mechanism (user call:
    // "Read my notes" signaled nothing about generation).
    expect(js).toContain('Generate my round →');
    expect(js).not.toContain('Read my notes');
  });

  it('the composer owns #/ and the tabs route; #/practice canonicalizes home', () => {
    // composer-first IA (2026-08-10): '#/' falls through to the practice
    // page; plans and history are their own routes.
    expect(js).toContain("h.startsWith('#/plans')");
    expect(js).toContain("h.startsWith('#/history')");
    expect(js).toContain("h.startsWith('#/practice')");
    expect(js).toContain("window.location.hash = '#/'");
    // The zero-plans redirect to #/new is DEAD — a new visitor's correct
    // page IS the composer. (Condition pin, not a hash pin: resumeIntake
    // legitimately sets '#/new'.)
    expect(js).not.toContain('!state.targets.length');
  });

  it('the confirm screen is gap-derived: model authors questions, client renders controls (4A)', () => {
    // Two columns; questions FIRST in the DOM (tab order follows the task),
    // rail placed left by the grid.
    expect(js).toContain('id="rep-confirm"');
    expect(js).toMatch(/id="rep-open"[\s\S]*id="rep-rail"/);
    expect(html).toMatch(/#rep-confirm \{[^}]*grid-template-columns: 220px minmax\(0, 1fr\)/s);
    // The grid breaks OUT of #practice-wrap's 62ch composer measure to the
    // 760px shell; inside 62ch the question column was 249px, half what
    // decision 5A sized it for (QA ISSUE-002). Narrow zeroes the breakout.
    expect(html).toMatch(/#rep-confirm \{[^}]*margin-inline: calc\(\(720px - 100%\) \/ -2\)/s);
    expect(html).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?#rep-confirm \{[^}]*margin-inline: 0/);
    // Everything keys on the gap's stable id, never an array index (T12).
    // (The planner's ask-card keeps its own data-q — this pins the DOOR.)
    expect(js).toContain('data-gap=');
    expect(js).toMatch(/class="qopt" data-gap=/);
    expect(js).toMatch(/answerGap\(g\.id, g\.options\[Number\(b\.dataset\.o\)\]\.label\)/);
    // Options are shortcuts, never a gate (rule 3): open gaps keep a real
    // text path beside the pills; the input renders only when !closed.
    expect(js).toContain('class="gapinput"');
    expect(js).toMatch(/g\.closed \? '' :/);
    // Shape answers re-infer, flavor answers settle locally (C2) — one path.
    expect(js).toMatch(/function answerGap[\s\S]*affects === 'shape'[\s\S]*practiceClarify\(rep\.answers, \{ snapshot \}\)/);
    // The spec ships verbatim; flavor gaps ride generically as context lines
    // (T3 — the hardcoded {language, difficulty} assembly is dead).
    expect(js).not.toContain('rep.overrides');
    expect(js).toMatch(/affects === 'flavor' && g\.value/);
  });

  it('every gap control has a real label and 44px height (design 3A / decision 1A)', () => {
    expect(js).toContain('for="gap-');
    expect(js).toContain('for="gapfree-');
    for (const id of ['rep-paste', 'rep-change']) expect(js).toContain('for="' + id + '"');
    expect(html).toMatch(/\.gapedit \{[^}]*min-height: 44px/s);
    expect(html).toMatch(/\.gapinput \{[^}]*min-height: 44px/s);
    // No affordance where there is no action: the rail's .tier is a
    // read-only span, unlike the planner's clickable .tier button (ISSUE-003).
    expect(html).toMatch(/#rep-rail \.tier \{ cursor: default/);
  });

  it('the brief, the honest decline, and the multi-draft disclosure render (3A/2B/T14)', () => {
    expect(js).toContain('id="rep-brief"');
    // Brief + decline + Start span BOTH columns: the brief is prose read
    // right before an irreversible build, and the rail is 220px (ISSUE-004).
    expect(js).toContain('id="rep-commit"');
    expect(js).toMatch(/id="rep-commit"[\s\S]*rep-brief[\s\S]*rep-start/);
    expect(html).toMatch(/#rep-commit \{[^}]*grid-column: 1 \/ -1/);
    // 2B: unsupported never blocks — the button relabels and the choice is
    // the user's; the server counts occurrences.
    expect(js).toContain('Build the closest version →');
    expect(js).toContain('can’t run this honestly');
    const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');
    expect(appSource).toContain('[practice] unsupported');
    // T14: a multi-round paste is disclosed, never silently truncated.
    expect(js).toContain('rounds — building');
    // 3A: no remaining-question counter — gaps are re-derived per turn and a
    // counter that grows is worse than none.
    expect(js).not.toMatch(/more after this/);
    // The degraded fallback names itself instead of impersonating confidence.
    expect(js).toContain('couldn’t get a full read');
  });

  it('the practice screen keeps the one-sticky rule by having NO sticky', () => {
    const practiceCss = html.slice(html.indexOf('the practice door'), html.indexOf('.rep-strip'));
    expect(practiceCss).not.toContain('position: sticky');
  });

  it('the wait state is honest and says leaving is safe (design 4A)', () => {
    expect(js).toContain('shaping the round');
    expect(js).toContain('You can close this.');
    // reuses the genclock machinery, no parallel timer
    expect(js).toMatch(/renderRepWait[\s\S]*genProgressLine/);
  });

  it('the return signal flips title and favicon, no notification prompt (design 2A)', () => {
    expect(js).toContain("'✓ Ready · Zenkai'");
    expect(js).toContain('(building) ');
    expect(js).toContain('FAVICON_READY');
    expect(js).not.toContain('Notification.requestPermission');
  });

  it('the history strip distinguishes failed from ready and has a real empty state', () => {
    expect(js).toContain('No practice yet');
    expect(js).toContain('repretry');
    // failed rows carry error copy and NO primary start button
    expect(js).toMatch(/draft_failed[\s\S]{0,200}couldn’t shape the round/);
  });

  it('rep launches share the boot poll with queue launches', () => {
    expect(js).toContain('function launchCommon');
    expect(js).toMatch(/launchCommon\('\/api\/launch'/);
    expect(js).toMatch(/launchCommon\('\/api\/practice\/launch'/);
  });
});

describe('practice door — re-infer interaction (decision 6A + T10, 2026-08-12)', () => {
  const html = appPage();
  const js = clientScript('app.js') ?? '';

  it('a shape answer keeps the confirm screen rendered through the round trip', () => {
    // busy, not a phase change: the poll guard keys on phase, and the
    // clarifying full-screen state is for the FIRST inference only.
    expect(js).toMatch(/if \(firstRun\) rep\.phase = 'clarifying'; else rep\.busy = true;/);
    expect(js).toContain('re-checking the shape…');
    // optimistic settle reverts on error — the snapshot restores pre-answer gaps
    expect(js).toMatch(/if \(snapshot\) \{ rep\.gaps = snapshot;/);
  });

  it('the task hypothesis rides to the build: POSTed, validated, stored, routed', () => {
    // Client sends the confirmed hypothesis; server re-proves enum membership
    // (recipe-side task is never trusted raw); rep-build routes the skeleton.
    expect(js).toContain('task: d.task || undefined');
    const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');
    expect(appSource).toMatch(/ROUND_TASKS as readonly string\[\]\)\.includes\(b\.task\)/);
    const cliSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'utf8');
    expect(cliSource).toMatch(/pickSkeletonFile\(\s*rep\.spec,/);
  });

  it('an answered gap is the CANDIDATE\'s data — it survives the model dropping it', () => {
    // Live 2026-08-12: answering seniority + part-scope, then re-inferring,
    // removed BOTH from the server response — so the rail lost them and
    // practiceStart (which builds context from rep.gaps) silently dropped
    // the answers from the round. The server is stateless per request; only
    // the client can hold this.
    expect(js).toContain('function mergeGaps');
    expect(js).toMatch(/rep\.gaps = mergeGaps\(oldGaps, s\.gaps \|\| \[\], rep\.answers\)/);
    // dropped-by-server answers are re-appended
    expect(js).toMatch(/for \(const g of mine\.values\(\)\) out\.push\(g\)/);
    // a renamed re-ask is caught on the normalized label, not the drifting id
    expect(js).toMatch(/myLabels\.has\(norm\(g\.label\)\)/);
  });

  it('the flash collapses past a threshold — a light show is not a signal', () => {
    // A correction re-runs inference over the WHOLE description, so six rows
    // can move at once; flashing all six reads as "the page redrew", which is
    // the sensation the flash exists to prevent (live report 2026-08-12).
    expect(js).toContain('const FLASH_MAX = 3');
    expect(js).toMatch(/collapsed \? \[\] : changed/);
    expect(js).toContain('facts updated — review the confirmed column');
    expect(js).toMatch(/rep\.flashIds = delta\.flash/);
  });

  it('a re-infer gets the same progress bar the first inference gets', () => {
    // The busy line renders at the TOP of the question column, but the
    // correction box is at the BOTTOM — measured off-screen at y=-123 when
    // triggered from there. Feedback must also live where the click happened.
    expect(js).toMatch(/re-checking the shape…<\/div>' \+\s*'<div class="progress">/);
    expect(js).toContain("(rep.busy ? 'applying…' : 'apply')");
    expect(js).toMatch(/id="rep-rechecks"[^']*'\s*\+ dis \+/);
  });

  it('one diff drives both the flash and the announcement (decision 6A)', () => {
    expect(js).toContain('function diffGaps');
    expect(js).toMatch(/diffGaps\(oldGaps, rep\.gaps\)/);
    expect(js).toMatch(/\.gaterow\[data-gap=/);
    // focus follows the task: next OPEN question after a re-infer
    expect(js).toMatch(/rep\.pendingFocus/);
  });

  it('the live region is a dedicated sibling, never the rebuilt container', () => {
    // renderPractice replaces #practice-flow's innerHTML on every shape
    // answer — a container live region would re-read the whole panel.
    expect(html).toContain('<div id="practice-flow"></div>');
    expect(html).toMatch(/<div id="rep-live" aria-live="polite"/);
    expect(js).toContain('function announce');
    // the wait-state transitions moved onto announce() in the same change
    expect(js).toContain("announce('Your round is ready')");
  });

  it('the co-authored session survives a refresh (T10)', () => {
    expect(js).toContain("'zenkai-rep-v1'");
    expect(js).toContain('function hydrateRep');
    expect(js).toContain('function saveRep');
    // in-flight states don't survive: clamp, never resume a dead fetch
    expect(js).toMatch(/rep\.phase = s\.phase === 'started' \? 'started'/);
  });
});

describe('practice door — the explicit link input (planner parity, user call 2026-08-07)', () => {
  const html = appPage();
  const js = clientScript('app.js') ?? '';

  it('carries the same clearly-optional link row the planner has', () => {
    expect(js).toContain('id="rep-link"');
    expect(js).toContain('rep-addlink');
    expect(js).toMatch(/rep-link[^>]*add a link \(optional\)/);
    expect(html).toContain('#practice-wrap .linkrow');
  });

  it('links ride along as text — the copy never promises fetching', () => {
    // The practice clarify is one forced tool call with no fetch path; a
    // "we'll read it" promise here would be the dead-link broken-promise
    // class the external-bridge review killed.
    expect(js).toContain('it rides along with your notes');
    const placeholder = js.match(/rep-link[^>]*placeholder="([^"]*)"/);
    expect(placeholder && placeholder[1]).not.toMatch(/\b(read|reads|fetch|look)\b/i);
  });
});

describe('composer-first landing — hero + status line (design round2-A-minimal)', () => {
  const html = appPage();
  const js = clientScript('app.js') ?? '';

  it('the hero is the label — heading semantics and a11y in one element', () => {
    expect(js).toContain('<h1 class="hero"><label for="rep-paste">What do you want to practice right now?</label></h1>');
    expect(html).toMatch(/#practice-wrap \.hero label \{[\s\S]{0,200}font-size: 38px/);
    // one instrument: frame holds textarea + footer; focus lifts the hairline
    expect(html).toMatch(/\.composer-frame:focus-within \{ border-color: var\(--steel\)/);
    expect(js).toContain('class="composer-frame"');
    // link input is progressive disclosure, not standing furniture
    expect(js).toContain('rep.linkOpen');
    expect(js).toContain('id="rep-linktoggle"');
  });

  it('one status line, repainted every poll, outside the typing guard', () => {
    expect(html).toContain('id="home-status"');
    // no aria-live: the genclock rewrites textContent every second
    expect(html).not.toMatch(/id="home-status"[^>]*aria-live/);
    expect(js).toContain('function renderHomeStatus');
    // fresh every poll: called AFTER the guarded renderPractice, unconditionally
    expect(js).toMatch(/renderPractice\(\);\s*\n\s*renderHomeStatus\(state\)/);
  });

  it('the readout feeds the generator: building / ready / recent formats + regenerate', () => {
    expect(js).toContain('building your round');
    expect(js).toContain("ready →");
    expect(js).toMatch(/href="#\/history"/);
    // Recent-formats rows: up to 3 distinct SHAPES (spec label + compressed
    // caps, deduped by spec.id so regenerate chains collapse), each one tap
    // from a fresh problem. Shapes, not titles — the user remembers the
    // format they confirmed, never the generated problem's name.
    expect(js).toContain('function specShapeShort');
    expect(js).toMatch(/seenShapes\.has\(x\.spec\.id\)/);
    expect(js).toMatch(/esc\(x\.spec\.label\) \+ ' — ' \+ specShapeShort/);
    expect(js).toContain('class="rep-regen"');
    expect(js).toContain("querySelectorAll('.rep-regen')");
    // one tap re-posts the same confirmed shape under a new id, with a
    // variation line naming the previous title so the generator can't
    // re-roll the same domain (never-a-copy, aimed inward)
    expect(js).toContain('function regenerateLike');
    expect(js).toContain('do not repeat the previous one');
    // seasons live in their own tab now; the readout doesn't point there
    expect(js).not.toContain('next planned: ');
  });

  it('the ready signal counts the landing as seen — the line shows it there', () => {
    expect(js).toContain("if (page === 'history' || page === 'practice') repReadyUnseen = false;");
  });
});

describe('launch origin — the falsifier is durable, not scrollback', () => {
  const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');
  const js = clientScript('app.js') ?? '';

  it('every call site names its origin; nothing defaults', () => {
    expect(js).toMatch(/origin: 'plans'/);
    expect(js).toMatch(/origin: 'practice'/);
    expect(js).toMatch(/origin: 'repeat'/);
  });

  it('all three handlers log to launches.jsonl with a sanitized origin', () => {
    expect(appSource).toContain('launches.jsonl');
    expect(appSource).toMatch(
      /origin === 'repeat' \|\| origin === 'plans' \|\| origin === 'practice' \? origin : 'unknown'/,
    );
    // one logLaunch per legacy handler (launch, queue-launch, repeat), after
    // the session id exists; the multi paths log via out.body.session_id
    expect(appSource.match(/logLaunch\(b\.origin, sessionId\)/g)).toHaveLength(3);
  });
});

describe('paywall gate — a real limit, and the ways it must not misfire', () => {
  const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');
  const html = appPage();
  const js = clientScript('app.js') ?? '';

  it('all four spend doors are gated', () => {
    // Rounds via three routes plus the plan guardrail. Missing one leaves a
    // hole the whole measurement leaks through.
    expect(appSource.match(/gateFor\('rounds'\)/g)).toHaveLength(9);
    expect(appSource.match(/gateFor\('plans'\)/g)).toHaveLength(1);
  });

  it('the gate fails OPEN — a broken counter never stops a round', () => {
    const start = appSource.indexOf('const gateFor =');
    const body = appSource.slice(start, appSource.indexOf('const refuse =', start));
    expect(body).toContain('catch {');
    // The catch returns null (= not gated), never a GateView.
    expect(body).toMatch(/catch \{\s*return null;\s*\}/);
  });

  it('the 402 carries an error string so un-updated callers degrade', () => {
    // Every existing client call site branches on s.error and none read
    // r.status (the 429 build-cap precedent). A body without `error` would
    // fall into the launch poll loop and hang for 180s.
    const start = appSource.indexOf('const refuse =');
    const body = appSource.slice(start, start + 1400);
    expect(body).toContain('code: 402');
    expect(body).toMatch(/error:/);
    expect(body).toContain('paywall: g');
  });

  it('being gated is itself recorded, so there is a denominator', () => {
    const start = appSource.indexOf('const refuse =');
    expect(appSource.slice(start, start + 800)).toContain("action: 'gated'");
  });

  it('the recorder refuses admins and a gate-off box', () => {
    expect(appSource).toMatch(/cfg\.pub\.paywall\.enabled && !user!\.admin/);
  });

  it('price and limits come from the server, never the request body', () => {
    expect(appSource).toContain('price_usd: cfg.pub.paywall.priceUsd');
    expect(appSource).toContain('free_rounds: cfg.pub.paywall.freeRounds');
  });

  it('the probe route answers 200 only, and reports whether a grant landed', () => {
    const start = appSource.indexOf("url === '/api/paywall/probe'");
    expect(start).toBeGreaterThan(0);
    const handler = appSource.slice(start, appSource.indexOf('if (url ===', start + 10));
    expect(handler).toContain('json(200, { ok: true, granted:');
    expect(handler).not.toMatch(/json\([45]\d\d/);
  });

  it('the advisory state key is absent unless the user is actually limited', () => {
    expect(appSource).toContain('...(allowance ? { paywall: allowance } : {})');
  });

  it('the /api/state advisory never contradicts what gateFor enforces', () => {
    // Both allowances have to follow the subscriber, not just rounds. gateFor
    // returns null for `plans` whenever `paid`, so a subscriber's plan
    // allowance is unlimited — reporting the free-tier number here would tell
    // a paying customer they were out of plans while the route made another.
    expect(appSource).toContain('free_rounds: paidNow ? pw.paidRounds : pw.freeRounds');
    expect(appSource).toContain('free_plans: paidNow ? null : pw.freePlans');
    // And the enforcement half of the same claim, so the two move together.
    expect(appSource).toContain("if (reason === 'plans' && paid) return null;");
  });

  it('the client reads r.status BEFORE the error branch', () => {
    // The whole 402 flow hinges on this ordering: launchCommon inspects no
    // status today, so a 402 read as a 200 hangs the button.
    const start = js.indexOf('async function launchCommon');
    const body = js.slice(start, js.indexOf('launchStatus(btn,', start));
    const statusAt = body.indexOf('r.status === 402');
    const errorAt = body.indexOf('if (s.error)');
    expect(statusAt).toBeGreaterThan(0);
    expect(errorAt).toBeGreaterThan(0);
    expect(statusAt).toBeLessThan(errorAt);
  });

  it('the pending action survives the Checkout redirect', () => {
    // THE failure this guards: both retry paths are in-memory closures, and
    // navigating to Stripe destroys them. Without a persisted intent a user
    // pays and lands back on a page with nothing happening.
    expect(js).toContain('savePendingIntent()');
    expect(js).toContain('sessionStorage');
    expect(js).toContain('async function resumeAfterCheckout');
    // Both gate entry points must record what to replay.
    expect(js).toContain("kind: 'launch'");
    expect(js).toContain("kind: 'plan'");
    // Saved BEFORE the navigation, not after.
    const yesAt = js.indexOf('savePendingIntent()');
    const navAt = js.indexOf('window.location = b.url');
    expect(yesAt).toBeGreaterThan(0);
    expect(yesAt).toBeLessThan(navAt);
  });

  it('the return path confirms server-side rather than trusting the URL', () => {
    // A success_url is just a link; it proves nothing. And confirming BEFORE
    // the replay is what stops the replay racing a webhook that has not
    // landed yet.
    const start = js.indexOf('async function resumeAfterCheckout');
    const body = js.slice(start, start + 1800);
    expect(body).toContain('/api/stripe/confirm');
    expect(body.indexOf('/api/stripe/confirm')).toBeLessThan(body.indexOf('launchCommon('));
    // The intent is consumed once — a refresh must not re-run a purchase flow.
    expect(js).toContain('removeItem(PENDING_INTENT_KEY)');
  });

  it('beacons still use keepalive, since the redirect cancels in-flight fetches', () => {
    expect(js).toContain('keepalive: true');
  });

  it('a gated plan restores the words the composer already cleared', () => {
    // wirePlan's send() empties the textarea before the request and there is
    // no draft persistence anywhere.
    const start = js.indexOf('async function planFirstSend');
    const body = js.slice(start, start + 2200);
    expect(body).toContain('r.status === 402');
    expect(body).toMatch(/box\.value = text/);
  });

  it('the retry cannot loop on the gate', () => {
    expect(js).toContain('idleLabel, true)');
    expect(js).toContain('!isRetry');
  });

  it('the host is outside every repainted region and has no elevation', () => {
    expect(html).toContain('id="paywall"');
    const block = html.slice(html.indexOf('#paywall {'), html.indexOf('#paywall .btnrow button'));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/box-shadow/); // DESIGN.md rule 1
  });

  it('the webhook sits ABOVE the auth gate', () => {
    // Stripe sends no JWT. Below `auth.resolve` this route would 401 forever
    // and every renewal, cancellation and failed payment would be lost in
    // silence — the class of bug you only find in a billing dispute.
    const hookAt = appSource.indexOf("url === '/api/stripe/webhook'");
    const gateAt = appSource.indexOf('const user = await auth.resolve(req);');
    expect(hookAt).toBeGreaterThan(0);
    expect(gateAt).toBeGreaterThan(0);
    expect(hookAt).toBeLessThan(gateAt);
  });

  it('the webhook verifies the signature before touching the payload', () => {
    const start = appSource.indexOf("url === '/api/stripe/webhook'");
    const body = appSource.slice(start, start + 2600);
    // constructEvent is the authentication for this route.
    expect(body).toContain('webhooks.constructEvent');
    // Raw bytes, not readBody's UTF-8-decoded string — a signature is over bytes.
    expect(body).toContain('readRawBody(req)');
    expect(body).not.toContain('readBody(req)');
    // Verify first: nothing may read event data before constructEvent runs.
    expect(body.indexOf('constructEvent')).toBeLessThan(body.indexOf('event.data.object'));
  });

  it('confirm-on-return checks the session belongs to the caller', () => {
    // A Checkout session id is not a secret. Without this, anyone holding one
    // could confirm someone else's purchase onto their own account.
    const start = appSource.indexOf("url.startsWith('/api/stripe/confirm')");
    const body = appSource.slice(start, start + 1800);
    expect(body).toContain('session.client_reference_id !== user!.id');
    expect(body).toContain('json(403');
  });

  it('checkout never hardcodes payment_method_types', () => {
    // Omitting it lets Stripe serve eligible methods per customer; hardcoding
    // ['card'] silently locks out everything else. Comments stripped first —
    // this asserts about code, and the code's own comment names the field.
    const code = appSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('payment_method_types');
  });

  it('the user id rides subscription metadata, not just the session', () => {
    // Lifecycle webhooks carry no client_reference_id — without metadata a
    // renewal or cancellation cannot be attributed to anyone.
    expect(appSource).toContain('subscription_data: { metadata: { user_id: user!.id } }');
  });

  it('no card fields anywhere in the flow', () => {
    // The hard rule. A form collecting payment credentials under false
    // pretenses is deceptive regardless of intent.
    const start = js.indexOf('function showPaywallGate');
    const gate = js.slice(start, js.indexOf('function launchStatusInGate', start));
    expect(gate).not.toMatch(/card number|cardnumber|cc-number|credit card|cvc|autocomplete="cc/i);
    expect(gate).not.toMatch(/type="password"/);
  });
});

describe('build logs — recoverable, never candidate-visible', () => {
  const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');

  it('both build spawns pipe to a sibling .build.log, truncated per attempt', () => {
    // BESIDE the problem dir (`dir + '.build.log'`), never inside it — the
    // dir reaches the candidate's IDE and the output discusses the planted
    // bug. 'w' so each attempt's log is the latest build's, not a mix.
    expect(appSource).toContain("openSync(dir + '.build.log', 'w')");
    expect(appSource.match(/stdio: \['ignore', logFd, logFd\]/g)).toHaveLength(2);
    // both .failed markers point at the log so a failure is diagnosable
    expect(appSource.match(/output in \$\{dir\}\.build\.log/g)).toHaveLength(2);
  });
});

describe('link-only input — "paste anything" includes just a link', () => {
  const js = clientScript('app.js') ?? '';
  it('an empty composer with attachments seeds the description instead of erroring', () => {
    expect(js).toMatch(/!rep\.description\.trim\(\) && attachments\.length/);
    expect(js).toContain("'see the attached material'");
  });
});

describe('beta auth — client wiring (WU4)', () => {
  const html = appPage();
  const js = clientScript('app.js') ?? '';
  it('the client acquires, persists, and hands off the JWT', () => {
    // Login flow exists and uses plain GoTrue REST (no SDK — no-bundler rule).
    expect(js).toContain("'/api/auth-config'");
    expect(js).toContain('/auth/v1/authorize?provider=google');
    expect(js).toContain("gotrue('signup'");
    expect(js).toContain("gotrue('token?grant_type=password'");
    // Cookie is what the servers read; session links carry the fragment
    // because the session origin cannot see the app origin's cookie.
    expect(js).toContain('ip_jwt=');
    expect(js).toContain('function sessionHref(');
    expect(js).toContain("'#token=' + encodeURIComponent(jwt())");
    // 401 clears the token instead of looping.
    expect(js).toContain('clearJwt(); renderLogin(');
  });
  it('login styles ship in the shell', () => {
    expect(html).toContain('.loginbox');
  });
});

describe('beta copy (WU9)', () => {
  const html = appPage();
  const js = clientScript('app.js') ?? '';
  it('masthead carries the beta tag; the LANDING carries no in-development copy', () => {
    expect(html).toContain('class="betatag"');
    // The landing must stay clean: "in development" before a round is a
    // reason not to start, and the beta measures session-1 demand.
    expect(js.indexOf('renderPractice')).toBeGreaterThan(-1);
    const practiceFn = js.slice(js.indexOf('function renderPractice'), js.indexOf('function renderRepWait'));
    expect(practiceFn).not.toContain('in development');
  });
  it('the history card carries the memory roadmap note', () => {
    expect(js).toContain('Deeper memory is in development');
  });
});

describe('app-side card confirms (WU-C)', () => {
  const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');
  it('the endpoint validates sid + dimension and scopes by owner', () => {
    expect(appSource).toContain("url === '/api/card-feedback' && req.method === 'POST'");
    expect(appSource).toContain('isDimensionKey(b.dimension)');
    // Legacy feedback files (no user_id) stay the founder's.
    expect(appSource).toContain("(fbOwner ?? cfg.userId) !== user!.id");
    expect(appSource).toContain('mergeConfirm(confirms, b.dimension');
  });
  it('GET /api/feedback hydrates confirm state', () => {
    expect(appSource).toContain('card: fb.card, confirms');
  });
});

describe('the memory read side (/api/memory + season topics)', () => {
  const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');
  it('enumerates with the one boundary regex: real sessions, no sidecars, no qa runs', () => {
    expect(appSource).toContain("url === '/api/memory' && req.method === 'GET'");
    expect(appSource).toContain('/^(sess-[\\w-]+)\\.json$/.exec(f)');
  });
  it('an unexpected reader failure degrades loudly, never as an empty state', () => {
    // Expected per-file skips are counted; only a thrown reader sets
    // `degraded` — a server bug must not read as "no rounds yet".
    expect(appSource).toContain("json(200, { degraded: String(e).slice(0, 200) })");
  });
  it('season topics freeze from the STORED proposal, once, at accept', () => {
    // Same server-side re-read as named_problems — never the client body —
    // and append-only after the first confirmation.
    expect(appSource).toContain('!t.topics?.length && prop?.topics?.length');
  });
  it('the state projection carries the frozen list and the rollup', () => {
    expect(appSource).toContain('topics: t.topics ?? null');
    expect(appSource).toContain('topic_rollup: topicRollup');
  });
});

describe('multi-session app branch (WU-D)', () => {
  const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');
  it('the multi branch never probes the router port and serializes launches', () => {
    expect(appSource).toContain('const multiLaunch = async');
    // Critical-section discipline: allocate → spawn → append+persist with no
    // awaits — the mutex is the launchChain promise.
    expect(appSource).toContain('launchChain = launchChain.then');
    expect(appSource).toContain("NEVER probe cfg.sessionPort here — that's the router");
  });
  it('session-live is sid-aware with a gone signal; state URL carries ?sid', () => {
    expect(appSource).toContain('{ live: false, gone: true }');
    expect(appSource).toContain("/session?sid=${encodeURIComponent(mine.sid)}");
  });
  it('launch 409 copy names the three multi verdicts', () => {
    expect(appSource).toContain('your session is live — finish or end it first');
    expect(appSource).toContain('interview rooms are busy');
    expect(appSource).toContain('that problem is already starting');
  });
});

describe('per-sid launch tick (WU-F)', () => {
  const js = clientScript('app.js') ?? '';
  it('polls its own sid and fails fast on gone', () => {
    expect(js).toContain("'/api/session-live' + sidQ");
    expect(js).toContain('if (r.gone)');
    // The global-boolean navigation bug must not come back.
    expect(js).not.toContain("(await (await fetch('/api/session-live')).json()).live");
  });
});
