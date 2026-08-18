/**
 * The topics gate is what stands between a cheap naming call and twelve
 * planned rounds with broken names on the season timeline. No model calls
 * here (repo convention) — the gate is pure.
 */
import { describe, expect, it } from 'vitest';
import { gateTopics, stripDefectTail } from './plan-topics.js';

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
    expect(() => gateTopics(['Timed coding practice', ...good.slice(0, 2)], 3)).toThrow(/banned/);
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

describe('banned-filler is terminal, not vocabulary (live false positive)', () => {
  it('domain terms containing the words pass', () => {
    const ok = [
      'Session cache — concurrent key invalidation',
      'Problem report ingester — dedup pipeline',
      'Round-robin scheduler — fair task rotation',
    ];
    expect(gateTopics(ok, 3)).toEqual(ok);
  });
  it('terminal filler still dies', () => {
    expect(() => gateTopics(['Async practice session', ...good.slice(0, 2)], 3)).toThrow(/banned/);
    expect(() => gateTopics(['Debugging drill 3', ...good.slice(0, 2)], 3)).toThrow(/banned/);
  });
});

describe('stripDefectTail — the title never names the answer (Google plan leak, 2026-08-16)', () => {
  it('cuts every defect tail the live plan actually shipped', () => {
    // The five titles verbatim from targets/google-technical-interview-*:
    // each named the planted defect on the rail the night before the round.
    expect(stripDefectTail('User login streak counter — off-by-one bug')).toBe('User login streak counter');
    expect(stripDefectTail('E-commerce cart total calculation — decimal precision error')).toBe('E-commerce cart total calculation');
    expect(stripDefectTail('File permission inheritance — recursive logic flaw')).toBe('File permission inheritance');
    expect(stripDefectTail('API rate limiter — timestamp boundary condition')).toBe('API rate limiter');
    expect(stripDefectTail('Database query result deduplication — set membership logic')).toBe('Database query result deduplication');
  });

  it('always-mode (planted-bug rounds) cuts ANY tail — the tail is the diagnosis by construction', () => {
    expect(stripDefectTail('Message thread aggregation — stale reply counts', { always: true })).toBe('Message thread aggregation');
    // No separator and the title IS defect vocabulary: nothing safe remains.
    expect(stripDefectTail('Off-by-one bug in streaks', { always: true })).toBeUndefined();
    // No separator, clean surface: kept whole.
    expect(stripDefectTail('Warehouse pallet pairing', { always: true })).toBe('Warehouse pallet pairing');
  });

  it('leaves non-defect tails alone outside always-mode', () => {
    expect(stripDefectTail('Seat reservation — concurrent holds')).toBe('Seat reservation — concurrent holds');
    expect(stripDefectTail('Delivery window overlap report')).toBe('Delivery window overlap report');
  });

  it('degrades to undefined rather than shipping an empty title', () => {
    expect(stripDefectTail('')).toBeUndefined();
    expect(stripDefectTail('— off-by-one bug')).toBeUndefined();
  });
});
