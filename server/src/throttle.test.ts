/**
 * Per-user daily throttle counter (finding #4: the planner-chat and clarify
 * doors mint no rep row and were globally uncapped). countDailyRows is the
 * pure core behind /api/plan/turn and /api/practice/clarify — same shape as
 * the proven sample throttle, so this pins the count/day/user/torn-tail rules.
 */
import { describe, expect, it } from 'vitest';
import { countDailyRows } from './app.js';

const T = (day: string) => `${day}T12:00:00.000Z`;
const NOW = Date.parse('2026-08-20T18:00:00.000Z'); // UTC day 2026-08-20

describe('countDailyRows', () => {
  const rows = [
    { user_id: 'u1', ts: T('2026-08-20') },
    { user_id: 'u1', ts: T('2026-08-20') },
    { user_id: 'u1', ts: T('2026-08-19') }, // yesterday — excluded
    { user_id: 'u2', ts: T('2026-08-20') }, // other user — excluded
  ].map((r) => JSON.stringify(r)).join('\n');

  it('counts only this user, only today (UTC)', () => {
    expect(countDailyRows(rows, 'u1', NOW)).toBe(2);
    expect(countDailyRows(rows, 'u2', NOW)).toBe(1);
    expect(countDailyRows(rows, 'nobody', NOW)).toBe(0);
  });

  it('rolls over at the UTC day boundary', () => {
    const nextDay = Date.parse('2026-08-21T00:30:00.000Z');
    expect(countDailyRows(rows, 'u1', nextDay)).toBe(0);
  });

  it('tolerates a torn tail and blank lines (append-only, never locked)', () => {
    const torn = rows + '\n{"user_id":"u1","ts":"' + T('2026-08-20') + '"}\n{"user_id":"u1","ts":"2026-08-2'; // half-written last line
    expect(countDailyRows(torn, 'u1', NOW)).toBe(3); // 2 clean today + 1 more clean; torn line skipped
  });

  it('empty ledger is zero, not a throw', () => {
    expect(countDailyRows('', 'u1', NOW)).toBe(0);
    expect(countDailyRows('\n\n', 'u1', NOW)).toBe(0);
  });
});
