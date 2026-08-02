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

  it('research is gone from the product (CEO review 2026-08-02, D9)', () => {
    // The cut is a decision, not an accident — pin it so it can only be
    // reversed deliberately.
    expect(js).not.toContain('runResearch');
    expect(js).not.toContain('/api/research');
    expect(html).not.toMatch(/look(ing)? up/i);
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
