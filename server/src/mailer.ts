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
 */

import type { SendMail } from './welcome.js';

export interface SmtpConfig {
  user: string;
  appPassword: string;
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
  return {
    user,
    appPassword,
    ...(env.IP_WELCOME_FROM?.trim() ? { from: env.IP_WELCOME_FROM.trim() } : {}),
    ...(env.IP_WELCOME_REPLY_TO?.trim() ? { replyTo: env.IP_WELCOME_REPLY_TO.trim() } : {}),
  };
}

export async function makeSender(cfg: SmtpConfig): Promise<SendMail> {
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: cfg.user, pass: cfg.appPassword },
  });
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
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: cfg.user, pass: cfg.appPassword },
  });
  await transport.verify();
}
