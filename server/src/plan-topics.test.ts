/**
 * The topics gate is what stands between a cheap naming call and twelve
 * planned rounds with broken names on the season timeline. No model calls
 * here (repo convention) — the gate is pure.
 */
import { describe, expect, it } from 'vitest';
import { gateTopics } from './plan-topics.js';

const good = [
  'Rate limiter — sliding window',
  'Seat reservation — concurrent holds',
  'Elevator dispatch — request queue',
];

describe('gateTopics', () => {
  it('accepts distinct concrete titles', () => {
    expect(gateTopics(good, 3)).toEqual(good);
  });

  it('rejects the wrong count — a plan with unnamed tail rows is worse than quiet rows', () => {
    expect(() => gateTopics(good, 5)).toThrow(/expected 5, got 3/);
  });

  it('rejects duplicates case-insensitively', () => {
    expect(() => gateTopics([...good.slice(0, 2), 'RATE LIMITER — SLIDING WINDOW'], 3)).toThrow(/duplicate/);
  });

  it('rejects banned filler and trailing numbering', () => {
    expect(() => gateTopics(['Practice problem set one', ...good.slice(0, 2)], 3)).toThrow(/banned/);
    expect(() => gateTopics(['Booking ledger part 2', ...good.slice(0, 2)], 3)).toThrow(/banned/);
  });

  it('rejects vague one-worders and essays', () => {
    expect(() => gateTopics(['Graphs', ...good.slice(0, 2)], 3)).toThrow(/words/);
    expect(() =>
      gateTopics(['A very long meandering title that never commits to any specific system at all', ...good.slice(0, 2)], 3),
    ).toThrow(/words/);
  });

  it('rejects non-arrays instead of guessing', () => {
    expect(() => gateTopics('Rate limiter', 1)).toThrow(/not an array/);
  });
});
