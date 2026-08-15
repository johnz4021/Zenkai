/**
 * Entitlement truth table. Pure — no network, no Stripe keys, no model.
 *
 * The two that matter most: past_due stays entitled (a transient card decline
 * must not cut someone off mid-prep), and an empty or torn ledger entitles
 * nobody rather than throwing.
 */
import { describe, expect, it } from 'vitest';
import {
  isHandledEvent,
  latestRow,
  periodStart,
  rowFromSubscription,
  secondsToMs,
  subscribed,
} from './billing.js';
import type { SubscriptionRow } from './billing.js';

const row = (o: Partial<SubscriptionRow> & { user_id: string; status: string }): SubscriptionRow => ({
  ts: '2026-08-14T00:00:00.000Z',
  ...o,
});

describe('subscribed — who is entitled', () => {
  it('active and trialing entitle', () => {
    for (const status of ['active', 'trialing']) {
      expect(subscribed([row({ user_id: 'u2', status })], 'u2')).toBe(true);
    }
  });

  it('past_due STILL entitles — dunning grace', () => {
    // Stripe retries a failed card for days. Cutting someone off mid-prep over
    // a transient decline costs more than the rounds it saves.
    expect(subscribed([row({ user_id: 'u2', status: 'past_due' })], 'u2')).toBe(true);
  });

  it('canceled, unpaid and the incomplete states do not', () => {
    for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(subscribed([row({ user_id: 'u2', status })], 'u2')).toBe(false);
    }
  });

  it('an unrecognized status never silently grants', () => {
    expect(subscribed([row({ user_id: 'u2', status: 'something_new' })], 'u2')).toBe(false);
  });

  it('latest row wins — the ledger is append-only', () => {
    const rows = [
      row({ user_id: 'u2', status: 'active' }),
      row({ user_id: 'u2', status: 'canceled' }),
    ];
    expect(subscribed(rows, 'u2')).toBe(false);
    // …and resubscribing flips it back.
    expect(subscribed([...rows, row({ user_id: 'u2', status: 'active' })], 'u2')).toBe(true);
  });

  it("another user's subscription does not entitle you", () => {
    expect(subscribed([row({ user_id: 'other', status: 'active' })], 'u2')).toBe(false);
  });

  it('an empty ledger entitles nobody, and does not throw', () => {
    expect(subscribed([], 'u2')).toBe(false);
    expect(latestRow([], 'u2')).toBeNull();
  });
});

describe('periodStart — the window the round allowance resets on', () => {
  it('returns the period start for an entitled subscriber', () => {
    const rows = [row({ user_id: 'u2', status: 'active', current_period_start: 1_700_000_000_000 })];
    expect(periodStart(rows, 'u2')).toBe(1_700_000_000_000);
  });

  it('is null when not entitled — a canceled user falls back to the free tier', () => {
    const rows = [row({ user_id: 'u2', status: 'canceled', current_period_start: 1_700_000_000_000 })];
    expect(periodStart(rows, 'u2')).toBeNull();
  });

  it('is null when the row carries no period', () => {
    expect(periodStart([row({ user_id: 'u2', status: 'active' })], 'u2')).toBeNull();
  });
});

describe('rowFromSubscription — flattening Stripe into the ledger', () => {
  it('carries identity, status, period and price', () => {
    const r = rowFromSubscription(
      'u2',
      {
        id: 'sub_123',
        customer: 'cus_456',
        status: 'active',
        current_period_start: 1_700_000_000,
        current_period_end: 1_702_592_000,
        items: { data: [{ price: { id: 'price_789' } }] },
      },
      1_700_000_500_000,
      'evt_1',
    );
    expect(r).toMatchObject({
      user_id: 'u2',
      subscription_id: 'sub_123',
      customer_id: 'cus_456',
      status: 'active',
      current_period_start: 1_700_000_000_000, // seconds → ms
      current_period_end: 1_702_592_000_000,
      price_id: 'price_789',
      event_id: 'evt_1',
    });
  });

  it('a status-less object is incomplete, never entitled', () => {
    const r = rowFromSubscription('u2', {}, 0);
    expect(r.status).toBe('incomplete');
    expect(subscribed([r], 'u2')).toBe(false);
  });

  it('an expanded customer object does not become a bogus customer_id', () => {
    // Stripe returns `customer` as either an id string or an expanded object.
    const r = rowFromSubscription('u2', { status: 'active', customer: { id: 'cus_9' } }, 0);
    expect(r.customer_id).toBeUndefined();
  });

  it('omits absent optional fields rather than writing nulls', () => {
    const r = rowFromSubscription('u2', { status: 'active' }, 0);
    expect(Object.keys(r).sort()).toEqual(['status', 'ts', 'user_id']);
  });

  describe('the billing period, wherever Stripe put it', () => {
    // Stripe moved current_period_* from the Subscription onto the Subscription
    // ITEM in 2025-03-31.basil. On 2026-07-29.dahlia (the pinned version) the
    // top-level fields are ABSENT — verified against a live test subscription
    // 2026-08-14. Reading only the old spot cost a paying customer their
    // monthly reset, silently.
    const item = (extra: Record<string, unknown> = {}) => ({
      status: 'active',
      items: {
        data: [
          {
            price: { id: 'price_789' },
            current_period_start: 1_786_771_422,
            current_period_end: 1_789_449_822,
            ...extra,
          },
        ],
      },
    });

    it('reads the period off the ITEM — the current shape', () => {
      const r = rowFromSubscription('u2', item(), 0);
      expect(r.current_period_start).toBe(1_786_771_422_000);
      expect(r.current_period_end).toBe(1_789_449_822_000);
      // The point of the whole exercise: a real window, not a lifetime.
      expect(periodStart([r], 'u2')).toBe(1_786_771_422_000);
    });

    it('still reads the SUBSCRIPTION — stored rows and older API versions', () => {
      const r = rowFromSubscription(
        'u2',
        { status: 'active', current_period_start: 1_700_000_000, current_period_end: 1_702_592_000 },
        0,
      );
      expect(r.current_period_start).toBe(1_700_000_000_000);
      expect(periodStart([r], 'u2')).toBe(1_700_000_000_000);
    });

    it('the item wins when a payload carries both', () => {
      const r = rowFromSubscription(
        'u2',
        { ...item(), current_period_start: 1_700_000_000, current_period_end: 1_702_592_000 },
        0,
      );
      expect(r.current_period_start).toBe(1_786_771_422_000);
    });

    it('neither location means NO window — and that must be visible, not silent', () => {
      // periodStart null makes gateFor count for a lifetime. That is the right
      // fallback (never wrongly gate a payer) but it is also the bug's
      // signature, so it is pinned deliberately rather than by accident.
      const r = rowFromSubscription('u2', { status: 'active', items: { data: [{ price: { id: 'p' } }] } }, 0);
      expect(r.current_period_start).toBeUndefined();
      expect(periodStart([r], 'u2')).toBeNull();
    });
  });
});

describe('secondsToMs', () => {
  it('converts Stripe seconds, and refuses anything else', () => {
    expect(secondsToMs(1_700_000_000)).toBe(1_700_000_000_000);
    for (const v of [undefined, null, 'x', NaN, Infinity, {}]) {
      expect(secondsToMs(v)).toBeUndefined();
    }
  });
});

describe('isHandledEvent', () => {
  it('accepts the lifecycle events we act on', () => {
    for (const t of [
      'checkout.session.completed',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.payment_failed',
    ]) {
      expect(isHandledEvent(t)).toBe(true);
    }
  });

  it('ignores everything else — an unfamiliar event must not error into retries', () => {
    for (const t of ['charge.succeeded', 'ping', '', undefined, 42, null]) {
      expect(isHandledEvent(t)).toBe(false);
    }
  });
});
