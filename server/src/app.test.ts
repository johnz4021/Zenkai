/**
 * The home app page ships with no build step, so a syntax error in app.js
 * silently kills the entire surface — same guard as chrome.test.ts. The
 * markup assertions pin the design review's hard-rule fixes: real labels
 * (placeholder-as-label was a violation on all four fields), the stated
 * desktop-only notice, and the a11y landmarks the timeline relies on.
 */
import { describe, expect, it } from 'vitest';
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
    expect(html).toContain('id="timeline"');
  });

  it('navigation is routes, not visibility toggles', () => {
    expect(html).toContain('href="#/" id="nav-home"');
    expect(html).toContain('href="#/new" id="nav-new"');
    expect(js).toContain('function route()');
    expect(js).toContain("addEventListener('hashchange'");
    // The poll-stomps-navigation bug: visibility must never derive from
    // whether targets exist.
    expect(js).not.toContain("el('entry').hidden = hasTargets");
  });

  it('every intake field has a real label — placeholder-as-label is dead', () => {
    for (const id of ['e-desc', 'e-date', 'e-company', 'e-link']) {
      expect(html).toContain(`label for="${id}"`);
    }
  });

  it('reference material is a labeled region, not a text link', () => {
    expect(html).toContain('Reference material');
    expect(html).toContain('id="e-browse"');
    expect(html).toContain('id="e-attachlist"');
  });

  it('one violet primary action and the muted closing line — no numbered steps', () => {
    expect(html).toContain('Build my plan');
    expect(html).toContain('you confirm every round before anything gets built');
    // The rejected slop pattern must not creep back in.
    expect(html).not.toMatch(/how it works/i);
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

  it('research returned DELIBERATELY — inside a planner turn, never standalone (D9 → D3 amendment)', () => {
    // CEO review 2026-08-02 (D9) cut preemptive research on evidence; the
    // D3 amendment re-fenced it: retrieval lives INSIDE the planner
    // conversation under the evidence hierarchy, with an audit trace and
    // conflict deference. The standalone endpoint stays dead.
    expect(js).not.toContain('runResearch');
    expect(js).not.toContain('/api/research');
    expect(js).toContain('Looked up · ');            // the audit trace line
    expect(js).toContain('keeping your version');    // conflicts defer to the candidate
  });

  it('the planner is a conversation: composer teaches push-back, gate confirms before generation', () => {
    expect(js).toContain('Answer, correct me, or ask what a round shape is');
    expect(js).toContain('/api/plan/turn');
    expect(js).toContain('nothing is generated until you confirm');
    expect(html).toContain('#plan-gate');            // gate styles ship with the page
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
    expect(html).toContain('aria-label="Zenkai — all plans"');
    // The identity sheet's ascent ring: two plates out of register, a
    // vector escaping through the break in the ring.
    expect(html).toContain('class="plate-mag"');
    expect(html).toContain('class="plate-cyan"');
    expect(html).toContain('class="vector"');
    expect(html).toContain('stroke-dasharray="118 33"');
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
