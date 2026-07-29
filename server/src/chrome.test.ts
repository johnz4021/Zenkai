import { describe, expect, it } from 'vitest';
import { clientScript, sessionPage } from './chrome.js';

/**
 * The client script has no build step and no module loader, so a syntax
 * error in it is invisible until a live session — where it silently kills
 * the notes panel, the status header, AND the End Session button at once.
 * Parsing it here is the only cheap guard against that. Now that the script
 * is a real file (client/session.js) rather than an inline template literal,
 * this also proves the page actually references it.
 */
describe('session chrome', () => {
  const html = sessionPage('sess-test');
  const js = clientScript();

  it('has a parseable client script', () => {
    expect(() => new Function(js)).not.toThrow();
  });

  it('the page loads the extracted client script', () => {
    expect(html).toContain('<script src="/client/session.js"></script>');
  });

  it('polls the endpoints the session runtime actually serves', () => {
    for (const route of ['/api/status', '/api/messages?since=', '/api/utterance', '/api/end']) {
      expect(js).toContain(route);
    }
  });

  it('tells the candidate what the interviewer will and will not answer', () => {
    expect(html).toContain('interviewer');
    expect(html).toContain("you won't");
  });

  it('tells the candidate the operational definition of going quiet', () => {
    // The observed-panel copy must match what the server actually computes:
    // silence is derived from ALL sources, not keystrokes.
    expect(html).toContain('no activity anywhere');
  });

  it('renders contaminated findings as recorded-but-not-counted', () => {
    expect(js).toContain('not counted toward your patterns');
  });
});
