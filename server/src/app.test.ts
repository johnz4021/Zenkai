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
    // Read-only on purpose: no confirm buttons (the endpoint died with the
    // session), and the bug shows only when solved (unspoiled re-runs).
    expect(js).toContain('card.bug && card.solved');
    expect(js).not.toContain("'/api/card-feedback'");
    expect(html).toContain('.fbcard');
  });

  it('a stale ready problem is offered a rebuild, never silently swapped', () => {
    expect(js).toContain('button.rebuild');
    expect(js).toContain('built for the old round shape');
    expect(html).toContain('.adaptpanel');
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
    // The daily action IS the page under the wordmark; plans and history are
    // secondary tabs. Active tab wears the steel underline via aria-current —
    // wayfinding and a11y as one mechanism. The landing marks no tab active.
    expect(html).not.toContain('id="nav-practice"');
    expect(html).not.toContain('id="nav-new"');
    expect(html).toMatch(/#nav-plans, #nav-history \{ color: var\(--text-2\)/);
    expect(html).toMatch(/\.navright a\[aria-current="page"\]/);
    expect(html).toMatch(/text-decoration-color: var\(--steel\)/);
    expect(js).toContain("setAttribute('aria-current', 'page')");
    expect(html).toContain('<section id="practice" hidden>');
    // Plan creation moved to the plans page with the masthead slot.
    expect(js).toContain('class="addlink">+ new plan');
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

  it('the readback is a menu ONLY where the vocabulary is closed (design D4)', () => {
    // one select for check.kind; language/size/difficulty are inputs
    expect(js).toContain("id=\"rep-kind\"");
    for (const id of ['rep-lang', 'rep-size', 'rep-diff']) expect(js).toContain('id="' + id + '"');
    // a kind flip re-infers rather than editing the spec client-side
    expect(js).toContain('Which round shape should this practice be?');
  });

  it('every shape control has a real label and 44px height (design 3A)', () => {
    for (const id of ['rep-kind', 'rep-lang', 'rep-size', 'rep-diff', 'rep-paste', 'rep-change']) {
      expect(js).toContain('for="' + id + '"');
    }
    expect(html).toMatch(/\.rep-shape select \{[^}]*min-height: 44px/);
    expect(html).toMatch(/\.rep-shape input \{[^}]*min-height: 44px/);
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
    expect(js).toContain('<h1 class="hero"><label for="rep-paste">What are you preparing for?</label></h1>');
    expect(html).toMatch(/#practice-wrap \.hero label \{[\s\S]{0,200}font-size: 26px/);
  });

  it('one status line, repainted every poll, outside the typing guard', () => {
    expect(html).toContain('id="home-status"');
    // no aria-live: the genclock rewrites textContent every second
    expect(html).not.toMatch(/id="home-status"[^>]*aria-live/);
    expect(js).toContain('function renderHomeStatus');
    // fresh every poll: called AFTER the guarded renderPractice, unconditionally
    expect(js).toMatch(/renderPractice\(\);\s*\n\s*renderHomeStatus\(state\)/);
  });

  it('the segments speak only when true and route to their tabs', () => {
    expect(js).toContain('building your round');
    expect(js).toContain("ready →");
    expect(js).toContain('next planned: ');
    expect(js).toMatch(/href="#\/history"/);
    // countdown reuses roundDates + daysUntil, steel-TEXT tier for contrast
    expect(js).toMatch(/renderHomeStatus[\s\S]*roundDates\(row\.target\)/);
    expect(html).toMatch(/#home-status \.in-days \{ color: var\(--steel-text\)/);
  });

  it('the ready signal counts the landing as seen — the line shows it there', () => {
    expect(js).toContain("if (page === 'history' || page === 'practice') repReadyUnseen = false;");
  });
});
