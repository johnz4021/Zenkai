/**
 * The SMTP config gate. Port choice is the load-bearing part: Hetzner blocks
 * outbound 465, so a hardcoded 465 passes on a laptop and hangs forever on
 * the box. No network — createTransport is never called here.
 */
import { describe, expect, it } from 'vitest';
import { readSmtpConfig } from './mailer.js';

describe('readSmtpConfig', () => {
  it('is null unless both halves are present', () => {
    expect(readSmtpConfig({})).toBeNull();
    expect(readSmtpConfig({ IP_GMAIL_USER: 'a@b.c' })).toBeNull();
    expect(readSmtpConfig({ IP_GMAIL_APP_PASSWORD: 'x' })).toBeNull();
  });

  it('strips the spaces Google prints app passwords with', () => {
    const cfg = readSmtpConfig({ IP_GMAIL_USER: 'a@b.c', IP_GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' });
    expect(cfg!.appPassword).toBe('abcdefghijklmnop');
  });

  it('defaults to 587, the port Hetzner leaves open', () => {
    expect(readSmtpConfig({ IP_GMAIL_USER: 'a@b.c', IP_GMAIL_APP_PASSWORD: 'x' })!.port).toBe(587);
  });

  it('honours an explicit port, and ignores junk', () => {
    const base = { IP_GMAIL_USER: 'a@b.c', IP_GMAIL_APP_PASSWORD: 'x' };
    expect(readSmtpConfig({ ...base, IP_SMTP_PORT: '465' })!.port).toBe(465);
    expect(readSmtpConfig({ ...base, IP_SMTP_PORT: 'nonsense' })!.port).toBe(587);
  });

  it('carries the optional From and Reply-To through', () => {
    const cfg = readSmtpConfig({
      IP_GMAIL_USER: 'a@b.c',
      IP_GMAIL_APP_PASSWORD: 'x',
      IP_WELCOME_FROM: 'John <a@b.c>',
      IP_WELCOME_REPLY_TO: 'reply@b.c',
    });
    expect(cfg!.from).toBe('John <a@b.c>');
    expect(cfg!.replyTo).toBe('reply@b.c');
  });
});
