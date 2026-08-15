/**
 * Subscription entitlement — the paid half of the paywall gate.
 *
 *   Stripe Checkout ──► confirm-on-return ──┐
 *                                            ├──► subscriptions.jsonl ──► subscribed()
 *   Stripe webhook ──► entitlementFromEvent ─┘                                │
 *                                                                    gateFor (app.ts)
 *
 * Why it exists: the gate (paywall.ts) already refuses past a free allowance
 * and lets a user through on a recorded grant. This module is where that grant
 * can come from a real subscription instead of a fake button. It changes one
 * thing about the gate — the source of `granted` — and nothing else.
 *
 * DISK IS AUTHORITATIVE, as everywhere else here (CLAUDE.md). Subscription
 * state is an append-only `subscriptions.jsonl` at the repo root, latest row
 * per user wins, read with the same torn-tail tolerance as readRuns
 * (artifact.ts) and readPaywallRows (app.ts). It deliberately does NOT live in
 * the Postgres `users` table: db.ts is a fire-and-forget mirror with no read
 * path at all (db.ts:8-13, "the durable RECORD, never the runtime") and it
 * no-ops entirely without Supabase. The mirror can follow; it cannot lead.
 *
 * TWO WRITERS, deliberately. Confirm-on-return writes the row the moment the
 * user comes back from Checkout, so the first charge never waits on webhook
 * timing — "I paid and it didn't work" is the worst first impression a paid
 * product can make. The webhook is the durable backstop for everything after:
 * renewals, cancellations, failed cards, plan changes. Rows are append-only
 * and latest-wins, so a webhook retry (Stripe retries) is harmless.
 *
 * Pure over pre-loaded input (detector convention — stuck.ts lineage): no I/O,
 * no clock reads, `nowMs` injected. The caller owns file reading and every
 * Stripe call, so this module is unit-testable with no network and no keys.
 */

/** Stripe subscription statuses we act on. Anything unrecognized is treated
 *  as not-entitled: an unknown status must never silently grant access. */
export type SubStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

/**
 * Statuses that still entitle.
 *
 * `past_due` is IN, deliberately. Stripe retries a failed card for days before
 * giving up, and cutting someone off mid-prep over a transient decline costs
 * far more than the rounds it saves — they paid, their card hiccuped, and the
 * product should not punish them for it. `unpaid` is where dunning has already
 * given up, so that one is out.
 *
 * A cancellation scheduled for period end arrives as `active` with
 * cancel_at_period_end — still entitled until it actually ends, which is what
 * the customer paid for.
 */
const ENTITLING: readonly string[] = ['active', 'trialing', 'past_due'];

/** One append-only line of subscriptions.jsonl. */
export interface SubscriptionRow {
  ts: string;
  user_id: string;
  /** Stripe subscription id — the identity, for reconciling against Stripe. */
  subscription_id?: string;
  customer_id?: string;
  status: string;
  /** Epoch ms. The window start for the per-period round allowance. */
  current_period_start?: number;
  current_period_end?: number;
  price_id?: string;
  /** Stripe event id, so a duplicate delivery is identifiable in the log. */
  event_id?: string;
}

/** The current row for a user: last one wins, because the ledger is append-only
 *  and ordered by write. */
export function latestRow(rows: SubscriptionRow[], userId: string): SubscriptionRow | null {
  let out: SubscriptionRow | null = null;
  for (const r of rows) if (r.user_id === userId) out = r;
  return out;
}

/** Is this user entitled by subscription right now? */
export function subscribed(rows: SubscriptionRow[], userId: string): boolean {
  const r = latestRow(rows, userId);
  return r !== null && ENTITLING.includes(r.status);
}

/**
 * Start of the current billing period, as epoch ms — the window the per-period
 * round allowance is counted over. Null when the user is not subscribed or the
 * row carries no period (which the free tier does not need: a trial has no
 * period to reset, so it keeps the lifetime count).
 */
export function periodStart(rows: SubscriptionRow[], userId: string): number | null {
  const r = latestRow(rows, userId);
  if (!r || !ENTITLING.includes(r.status)) return null;
  return typeof r.current_period_start === 'number' ? r.current_period_start : null;
}

/** Seconds (Stripe's unit) → epoch ms, tolerant of absent values. */
export function secondsToMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v * 1000) : undefined;
}

/**
 * Flatten a Stripe subscription object into a ledger row.
 *
 * Takes an already-parsed object rather than a Stripe SDK type so this module
 * stays pure and dependency-free — the caller does the SDK work. `userId` comes
 * from the Checkout Session's client_reference_id (which we set to our own user
 * id), never from anything the customer can influence.
 */
export function rowFromSubscription(
  userId: string,
  sub: {
    id?: string;
    customer?: unknown;
    status?: string;
    current_period_start?: number;
    current_period_end?: number;
    items?: { data?: { price?: { id?: string } }[] };
  },
  nowMs: number,
  eventId?: string,
): SubscriptionRow {
  const priceId = sub.items?.data?.[0]?.price?.id;
  return {
    ts: new Date(nowMs).toISOString(),
    user_id: userId,
    ...(sub.id ? { subscription_id: sub.id } : {}),
    ...(typeof sub.customer === 'string' ? { customer_id: sub.customer } : {}),
    status: typeof sub.status === 'string' ? sub.status : 'incomplete',
    ...(secondsToMs(sub.current_period_start) !== undefined
      ? { current_period_start: secondsToMs(sub.current_period_start) }
      : {}),
    ...(secondsToMs(sub.current_period_end) !== undefined
      ? { current_period_end: secondsToMs(sub.current_period_end) }
      : {}),
    ...(priceId ? { price_id: priceId } : {}),
    ...(eventId ? { event_id: eventId } : {}),
  };
}

/** Webhook event types worth acting on. Anything else is acknowledged with a
 *  200 and ignored — Stripe sends a great many events, and a handler that
 *  errors on the unfamiliar ones just generates retries. */
export const HANDLED_EVENTS: readonly string[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
];

export function isHandledEvent(type: unknown): boolean {
  return typeof type === 'string' && HANDLED_EVENTS.includes(type);
}
