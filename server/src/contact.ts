/**
 * Contact + feedback — the way out of the product and into the founder's inbox.
 *
 *   #/contact ──► POST /api/contact ──► gateContactNote ──► contact.jsonl
 *          └────► mailto:CONTACT_EMAIL (the escape hatch that needs no server)
 *
 * Why it exists (owner request 2026-08-16): every feedback surface in here was
 * something the app ASKED for at a moment of its own choosing — the judged
 * card's per-dimension confirms, the paywall's two questions. All of them are
 * reactive, all of them are attached to a round, and none of them exist when a
 * beta user simply wants to say "this broke" or "add Rust". That user's only
 * option was to already know the founder's email.
 *
 * TWO doors on purpose, and the mailto is not a fallback:
 *   - The form is lower friction and lands the note on the box with the
 *     sender's identity already attached, so it needs no reply address typed.
 *   - The mailto costs the user nothing to trust and works when the app is
 *     the thing that is broken — which is exactly when the most valuable
 *     feedback gets written. A form that is down eats the report; an address
 *     does not.
 *
 * Same disciplines as the rest of the tree: a pure exported gate that throws
 * on bad input (reps.ts gateRepInput lineage), a closed vocabulary for the
 * one categorical field, and append-only JSONL on disk with a torn-tail-
 * tolerant reader (paywall.ts / artifact.ts readRuns).
 *
 * NO free text on the analytics wire. The paywall's `expect`/`value`/`improve`
 * are JSONL-only by an explicit decision (2026-08-15) — user-authored prose
 * has no business in a third party when the authoritative row already holds
 * it. A contact note is MORE personal than any of those, so the same rule
 * applies and the route mirrors only the kind.
 */

/** Where a note goes when the form is not the right door. Single source of
 *  truth — the client renders the mailto from the served config, so this
 *  address is never duplicated into markup. */
export const CONTACT_EMAIL = 'johnzz@uchicago.edu';

/**
 * What kind of note this is. Closed, and deliberately short: a taxonomy the
 * sender has to think about is a taxonomy that costs a send. Every value is
 * something that routes differently in the founder's head — a bug gets
 * reproduced, an idea gets filed, a question gets answered.
 */
export const CONTACT_KINDS = ['bug', 'idea', 'question', 'other'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** Unrecognized kinds degrade rather than 400: the field is a convenience for
 *  triage, and losing a real report to a stale tab's vocabulary would be a
 *  bad trade. */
export function contactKind(raw: unknown): ContactKind {
  return CONTACT_KINDS.includes(raw as ContactKind) ? (raw as ContactKind) : 'other';
}

/** The body reader has no size cap (readBody, app.ts), so the bound lives
 *  here beside the vocabulary — the same reasoning as paywall.ts FEEDBACK_MAX,
 *  wider because this is the only place someone can write at length. */
export const MAX_NOTE = 4000;
/** A reply-to is optional and only ever an address; anything longer than this
 *  is not one. */
export const MAX_REPLY_TO = 254;

export interface ContactNote {
  kind: ContactKind;
  message: string;
  /** Optional. The account email already rides on the row server-side, so
   *  this exists only for "reply to me somewhere else". */
  reply_to?: string;
}

/**
 * The gate. Throws with a sentence the client can show verbatim.
 *
 * Deliberately NOT validating the reply address beyond shape and length: a
 * regex that rejects a valid-but-unusual address costs a real conversation,
 * and nothing here sends mail — the value is read by a human who can see a
 * typo for what it is. The one real check is that it cannot be a header
 * injection vector if this ever does feed a mailer, hence no newlines.
 */
export function gateContactNote(input: {
  kind?: unknown;
  message?: unknown;
  reply_to?: unknown;
}): ContactNote {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) throw new Error('write a line or two first — anything at all');
  if (message.length > MAX_NOTE) {
    throw new Error(`that is longer than this box takes — trim it to ${MAX_NOTE} characters, or email it instead`);
  }
  const replyRaw = typeof input.reply_to === 'string' ? input.reply_to.trim() : '';
  if (replyRaw.length > MAX_REPLY_TO || /[\r\n]/.test(replyRaw)) {
    throw new Error('that reply address does not look right');
  }
  return {
    kind: contactKind(input.kind),
    message,
    ...(replyRaw ? { reply_to: replyRaw } : {}),
  };
}
