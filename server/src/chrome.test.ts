import { describe, expect, it } from 'vitest';
import { sessionPage } from './chrome.js';

/**
 * The chrome's inline script has no build step and no module loader, so a
 * syntax error in it is invisible until a live session — where it silently
 * kills the notes panel, the status header, AND the End Session button at
 * once. Parsing it here is the only cheap guard against that.
 */
function inlineScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('session page has no inline script');
  return m[1] as string;
}

describe('session chrome', () => {
  const html = sessionPage('sess-test');

  it('has a parseable inline script', () => {
    expect(() => new Function(inlineScript(html))).not.toThrow();
  });

  it('polls the endpoints the session runtime actually serves', () => {
    const js = inlineScript(html);
    for (const route of ['/api/status', '/api/messages?since=', '/api/utterance', '/api/end']) {
      expect(js).toContain(route);
    }
  });

  it('tells the candidate what the interviewer will and will not answer', () => {
    expect(html).toContain('interviewer');
    expect(html).toContain("you won't");
  });

  it('renders contaminated findings as recorded-but-not-counted', () => {
    expect(inlineScript(html)).toContain('not counted toward your patterns');
  });
});
