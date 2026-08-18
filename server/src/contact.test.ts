import { describe, expect, it } from 'vitest';
import {
  CONTACT_EMAIL,
  CONTACT_KINDS,
  MAX_NOTE,
  contactKind,
  gateContactNote,
} from './contact.js';

describe('gateContactNote — the input gate', () => {
  it('takes a message and defaults the kind', () => {
    expect(gateContactNote({ message: 'the run button did nothing' })).toEqual({
      kind: 'other',
      message: 'the run button did nothing',
    });
  });

  it('trims, because a box full of whitespace is an empty box', () => {
    expect(gateContactNote({ message: '  spaced  ', kind: 'bug' }).message).toBe('spaced');
    for (const empty of ['', '   ', '\n\t']) {
      expect(() => gateContactNote({ message: empty })).toThrow(/write a line or two/);
    }
    expect(() => gateContactNote({})).toThrow(/write a line or two/);
    expect(() => gateContactNote({ message: 42 })).toThrow(/write a line or two/);
  });

  it('bounds the note — readBody has no cap, so this is the real one', () => {
    const ok = 'x'.repeat(MAX_NOTE);
    expect(gateContactNote({ message: ok }).message).toHaveLength(MAX_NOTE);
    expect(() => gateContactNote({ message: 'x'.repeat(MAX_NOTE + 1) })).toThrow(/trim it/);
    // The refusal names the other door rather than dead-ending.
    expect(() => gateContactNote({ message: 'x'.repeat(MAX_NOTE + 1) })).toThrow(/email it instead/);
  });

  it('keeps every kind in the closed vocabulary, and degrades the rest', () => {
    for (const k of CONTACT_KINDS) expect(gateContactNote({ message: 'hi', kind: k }).kind).toBe(k);
    // A stale tab's vocabulary must never cost a real report — degrade, never 400.
    for (const junk of ['feature', '', null, undefined, 7, {}]) {
      expect(contactKind(junk)).toBe('other');
      expect(gateContactNote({ message: 'hi', kind: junk }).kind).toBe('other');
    }
  });

  it('carries an optional reply address, and omits the key when absent', () => {
    expect(gateContactNote({ message: 'hi', reply_to: ' me@x.com ' }).reply_to).toBe('me@x.com');
    expect(gateContactNote({ message: 'hi' })).not.toHaveProperty('reply_to');
    expect(gateContactNote({ message: 'hi', reply_to: '   ' })).not.toHaveProperty('reply_to');
  });

  it('refuses a reply address carrying newlines — header injection, if this ever feeds a mailer', () => {
    expect(() => gateContactNote({ message: 'hi', reply_to: 'a@b.com\nBcc: c@d.com' })).toThrow(
      /does not look right/,
    );
    expect(() => gateContactNote({ message: 'hi', reply_to: 'a@b.com\r\nBcc: c@d' })).toThrow();
    expect(() => gateContactNote({ message: 'hi', reply_to: 'x'.repeat(300) })).toThrow();
  });

  it('does NOT otherwise validate the address — a rejected valid one costs a conversation', () => {
    // Nothing here sends mail; a human reads the row and can see a typo.
    for (const addr of ['just-my-name', 'a@b', "o'brien+tag@sub.domain.museum"]) {
      expect(gateContactNote({ message: 'hi', reply_to: addr }).reply_to).toBe(addr);
    }
  });
});

describe('the address', () => {
  it('is the one the founder actually reads', () => {
    expect(CONTACT_EMAIL).toBe('johnzz@uchicago.edu');
  });

  it('lives here alone — the client renders it from served state, never markup', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const js = readFileSync(path.join(dir, 'client/app.js'), 'utf8');
    expect(js).not.toContain(CONTACT_EMAIL);
    const appSource = readFileSync(path.join(dir, 'app.ts'), 'utf8');
    // app.ts may only reference the constant, never the literal.
    expect(appSource).not.toContain('johnzz@');
    expect(appSource).toContain('contact_email: CONTACT_EMAIL');
  });
});
