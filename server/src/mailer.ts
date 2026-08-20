/**
 * Gmail SMTP sender for the welcome sweep (welcome.ts).
 *
 *   IP_GMAIL_USER + IP_GMAIL_APP_PASSWORD ──► pickSender() ──► SendMail | null
 *                                                   │
 *                                  nodemailer ──► smtp.gmail.com:465 (TLS)
 *
 * Why a real mailbox and not a transactional provider: this email's entire
 * job is to read as a person who noticed a signup. It sends from the founder's
 * own address, so replies land in the inbox that can actually answer them and
 * Gmail files the message in Sent — the thread is a normal conversation from
 * the first message, not a no-reply@ with a forwarding rule bolted on.
 *
 * Why an app password and not OAuth: the account already has 2FA, an app
 * password is one env var against a Google Cloud project plus a consent
 * screen plus a refresh token to keep alive, and the failure mode is
 * identical (a 535 on a revoked credential). Revisit if this ever needs to
 * send as more than one address.
 *
 * PLAIN TEXT ONLY, deliberately. An HTML welcome mail with a wrapper table
 * is a newsletter; a text/plain one from a Gmail account is a note. It is
 * also the version that reliably clears the Promotions tab.
 *
 * pickSender() returns null when unconfigured — the sweep then reports that
 * it sent nothing rather than crashing a systemd timer every 5 minutes.
 *
 * PORT 587 + STARTTLS, not 465 implicit TLS. Hetzner blocks outbound 25 and
 * 465 as anti-spam policy — the first draft used 465, which worked from a
 * laptop and hung forever on the box, the single most misleading way this
 * could have failed (`--check` passes in dev, the timer silently times out in
 * prod). 587 is open there and works everywhere else too. requireTLS is not
 * optional: without it nodemailer will fall back to sending the app password
 * in the clear if STARTTLS is ever stripped.
 */

import type { SendMail } from './welcome.js';

export interface SmtpConfig {
  user: string;
  appPassword: string;
  /** Default 587 (STARTTLS). Override only if a host blocks it too. */
  port?: number;
  /** RFC 5322 From. Defaults to the authenticating account. Gmail rewrites
   *  anything that is not the account or a verified alias, so this is a
   *  display-name knob, not a spoofing one. */
  from?: string;
  replyTo?: string;
}

export function readSmtpConfig(env: Record<string, string | undefined>): SmtpConfig | null {
  const user = env.IP_GMAIL_USER?.trim();
  // Google prints app passwords in four spaced groups; pasting them verbatim
  // is the obvious thing to do and authenticates with a 535 otherwise.
  const appPassword = env.IP_GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  if (!user || !appPassword) return null;
  const port = Number(env.IP_SMTP_PORT ?? '') || 587;
  return {
    user,
    appPassword,
    port,
    ...(env.IP_WELCOME_FROM?.trim() ? { from: env.IP_WELCOME_FROM.trim() } : {}),
    ...(env.IP_WELCOME_REPLY_TO?.trim() ? { replyTo: env.IP_WELCOME_REPLY_TO.trim() } : {}),
  };
}

async function createTransport(cfg: SmtpConfig) {
  const { default: nodemailer } = await import('nodemailer');
  const port = cfg.port ?? 587;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port,
    secure: port === 465, // implicit TLS only on 465; 587 upgrades via STARTTLS
    requireTLS: true,
    auth: { user: cfg.user, pass: cfg.appPassword },
    // A blocked port must fail fast and say so, not hang a systemd timer.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
}

export async function makeSender(cfg: SmtpConfig): Promise<SendMail> {
  const transport = await createTransport(cfg);
  return async ({ to, subject, text }) => {
    await transport.sendMail({
      from: cfg.from ?? cfg.user,
      to,
      subject,
      text,
      ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}),
    });
  };
}

/** Verify credentials without sending anything (`--check`). */
export async function verifySender(cfg: SmtpConfig): Promise<void> {
  const transport = await createTransport(cfg);
  await transport.verify();
}
