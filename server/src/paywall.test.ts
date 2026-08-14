/**
 * The gate's truth table. Pure — no I/O, no model, no network.
 *
 * The exemption cases and the never-decrements case are the two that matter:
 * the first is why the founder and a probe-off box are untouched, the second
 * is why a repeat cannot walk someone back under the limit and re-open the
 * gate they already answered.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_MAX,
  countBuilds,
  countPlans,
  countRoundsRun,
  roundsUsed,
  expectedText,
  gateVerdict,
  grantsAccess,
  hasGrant,
  probeAction,
} from './paywall.js';

const run = (user_id: string, session_id = 'sess-x') => ({ session_id, user_id, at: '2026-08-14T00:00:00Z' });
const base = { enabled: true, admin: false, granted: false, reason: 'rounds' as const, used: 9, free: 3, priceUsd: 39 };

describe('gateVerdict — the three exemptions come first', () => {
  it('an admin is never gated, at any usage', () => {
    // The founder in production (auth.ts:245,248). NOT what protects local
    // dev — see the paywall.ts header; the config flag does that.
    expect(gateVerdict({ ...base, admin: true })).toBeNull();
    expect(gateVerdict({ ...base, admin: true, used: 99999 })).toBeNull();
  });

  it('a disabled gate never gates — the kill switch and the dev default', () => {
    expect(gateVerdict({ ...base, enabled: false })).toBeNull();
    expect(gateVerdict({ ...base, enabled: false, used: 99999 })).toBeNull();
  });

  it('a granted user is never gated again', () => {
    expect(gateVerdict({ ...base, granted: true })).toBeNull();
    expect(gateVerdict({ ...base, granted: true, used: 99999 })).toBeNull();
  });

  it('under the limit passes; at or over it gates', () => {
    expect(gateVerdict({ ...base, used: 0, free: 3 })).toBeNull();
    expect(gateVerdict({ ...base, used: 2, free: 3 })).toBeNull();
    expect(gateVerdict({ ...base, used: 3, free: 3 })).toEqual({
      price_usd: 39,
      reason: 'rounds',
      used: 3,
      free: 3,
    });
  });

  it('a free allowance of zero gates immediately', () => {
    // zeroOr exists so this is reachable from config at all.
    expect(gateVerdict({ ...base, used: 0, free: 0 })?.reason).toBe('rounds');
  });

  it('carries the reason so the copy can name the right limit', () => {
    expect(gateVerdict({ ...base, reason: 'plans', used: 3, free: 3 })?.reason).toBe('plans');
  });

  it("the price is the server's integer, never a caller-supplied string", () => {
    const v = gateVerdict({ ...base, priceUsd: 19 });
    expect(v?.price_usd).toBe(19);
    expect(typeof v?.price_usd).toBe('number');
  });
});

describe('countRoundsRun — rounds STARTED, from the append-only ledger', () => {
  it('counts one per run entry owned by the user', () => {
    expect(countRoundsRun([{ runs: [run('u2'), run('u2')] }], [], 'u2', 'u1')).toBe(2);
  });

  it('a repeat counts twice and never decrements', () => {
    // The regression against queue.ts:235-245, which demotes done -> ready on
    // a repeat. If the count could fall, a user could drop back under the
    // limit by repeating a round — the gate would leak, and someone who
    // already answered would be asked again.
    const oneRepTwoRuns = [{ session_id: 'sess-b', runs: [run('u2', 'sess-a'), run('u2', 'sess-b')] }];
    expect(countRoundsRun(oneRepTwoRuns, [], 'u2', 'u1')).toBe(2);
  });

  it('falls back to session_id for pre-ledger reps', () => {
    expect(countRoundsRun([{ session_id: 'sess-old' }], [], 'u1', 'u1')).toBe(1);
    expect(countRoundsRun([{ session_id: 'sess-old', runs: [] }], [], 'u1', 'u1')).toBe(1);
  });

  it('an unstarted rep counts zero', () => {
    expect(countRoundsRun([{}], [], 'u1', 'u1')).toBe(0);
    expect(countRoundsRun([{ runs: [] }], [], 'u1', 'u1')).toBe(0);
  });

  it("another user's runs are excluded", () => {
    expect(countRoundsRun([{ runs: [run('u2'), run('someone-else')] }], [], 'u2', 'u1')).toBe(1);
  });

  it('an ownerless run belongs to the legacy owner (the house rule)', () => {
    const ownerless = [{ runs: [{ session_id: 's', user_id: '', at: 'x' }] }];
    expect(countRoundsRun(ownerless, [], 'u1', 'u1')).toBe(1);
    expect(countRoundsRun(ownerless, [], 'u2', 'u1')).toBe(0);
  });

  it('sums reps and plan-queue items that have a session', () => {
    expect(countRoundsRun([{ runs: [run('u2')] }], [{ session_id: 'sess-q' }, {}], 'u2', 'u1')).toBe(2);
  });
});

describe('countBuilds / roundsUsed — the money is spent at BUILD time', () => {
  it('counts a build the moment it is kicked, not when it finishes', () => {
    // A failed or abandoned build spent the same opus run as a good one.
    for (const status of ['generating', 'ready', 'done', 'failed']) {
      expect(countBuilds([{ status }], [], 'u2', 'u1')).toBe(1);
    }
    expect(countBuilds([{ status: 'pending' }], [], 'u2', 'u1')).toBe(0);
    expect(countBuilds([{}], [], 'u2', 'u1')).toBe(0);
  });

  it('counts plan-queue builds too', () => {
    expect(countBuilds([], [{ status: 'ready' }, { status: 'pending' }], 'u2', 'u1')).toBe(1);
  });

  it('build-and-never-run is caught — the leak that made this necessary', () => {
    // Three builds, zero launches. Counting runs alone said 0 and let them
    // queue opus runs forever; the expensive half was ungated.
    const built = [{ status: 'ready' }, { status: 'ready' }, { status: 'ready' }];
    expect(countRoundsRun(built, [], 'u2', 'u1')).toBe(0);
    expect(roundsUsed(built, [], 'u2', 'u1')).toBe(3);
  });

  it('a build the user then runs is ONE round, not two', () => {
    // max(), not a sum — summing would halve the allowance for normal use.
    const ran = [{ status: 'done', session_id: 'sess-a', runs: [run('u2', 'sess-a')] }];
    expect(roundsUsed(ran, [], 'u2', 'u1')).toBe(1);
  });

  it('repeats still count, so the run side keeps its job', () => {
    const repeated = [{ status: 'done', session_id: 'sess-b', runs: [run('u2', 'sess-a'), run('u2', 'sess-b')] }];
    expect(countBuilds(repeated, [], 'u2', 'u1')).toBe(1);
    expect(roundsUsed(repeated, [], 'u2', 'u1')).toBe(2); // the run side wins
  });
});

describe('countPlans — the guardrail', () => {
  it('counts targets the user owns, ownerless ones going to the legacy owner', () => {
    const targets = [{ user_id: 'u2' }, { user_id: 'u2' }, { user_id: 'other' }, {}];
    expect(countPlans(targets, 'u2', 'u1')).toBe(2);
    expect(countPlans(targets, 'u1', 'u1')).toBe(1); // the ownerless one
    expect(countPlans([], 'u2', 'u1')).toBe(0);
  });
});

describe('hasGrant — derived from the event log, not stored', () => {
  it('a would_pay row from this user grants', () => {
    expect(hasGrant([{ user_id: 'u2', action: 'would_pay' }], 'u2')).toBe(true);
  });

  it('would_pay_confirmed also grants', () => {
    expect(hasGrant([{ user_id: 'u2', action: 'would_pay_confirmed' }], 'u2')).toBe(true);
  });

  it('someone else pressing Subscribe does not grant', () => {
    expect(hasGrant([{ user_id: 'other', action: 'would_pay' }], 'u2')).toBe(false);
  });

  it('being shown the gate, or declining it, does not grant', () => {
    expect(hasGrant([{ user_id: 'u2', action: 'gated' }], 'u2')).toBe(false);
    expect(hasGrant([{ user_id: 'u2', action: 'not_yet' }], 'u2')).toBe(false);
    expect(hasGrant([{ user_id: 'u2', action: 'notify_declined' }], 'u2')).toBe(false);
  });

  it('an empty log grants nobody — a lost file re-gates rather than crashing', () => {
    // Recoverable-closed, not fail-open: they press Subscribe again, and
    // dedup-by-user_id at read time absorbs the duplicate row.
    expect(hasGrant([], 'u2')).toBe(false);
  });

  it('malformed rows are simply not grants', () => {
    expect(hasGrant([{}, { action: 'would_pay' }, { user_id: 'u2' }], 'u2')).toBe(false);
  });
});

describe('probeAction / grantsAccess — the closed vocabulary', () => {
  it('passes the five known actions', () => {
    for (const a of ['gated', 'would_pay', 'not_yet', 'would_pay_confirmed', 'notify_declined']) {
      expect(probeAction(a)).toBe(a);
    }
  });

  it('anything else is recorded as unknown, never passed through', () => {
    for (const junk of ['', 'shown', 'DROP TABLE', 42, null, undefined, {}, ['gated']]) {
      expect(probeAction(junk)).toBe('unknown');
    }
  });

  it('only the two paying actions grant access', () => {
    expect(grantsAccess('would_pay')).toBe(true);
    expect(grantsAccess('would_pay_confirmed')).toBe(true);
    for (const a of ['gated', 'not_yet', 'notify_declined', 'unknown'] as const) {
      expect(grantsAccess(a)).toBe(false);
    }
  });
});

describe('expectedText — bounded free text', () => {
  it('trims and keeps real answers', () => {
    expect(expectedText('  maybe 15-20 a month ')).toBe('maybe 15-20 a month');
  });

  it('caps length — the route has no body cap of its own', () => {
    expect(expectedText('x'.repeat(5000))).toHaveLength(EXPECTED_MAX);
  });

  it('empty and non-strings are undefined, so the row omits the key', () => {
    for (const v of ['', '   ', null, undefined, 42, {}]) expect(expectedText(v)).toBeUndefined();
  });
});
