/**
 * roundUnderway — the initiative gate, generalized past debugging.
 *
 * QA 2026-08-14: gating every unprompted lane on `hasFailingRun` silenced
 * the interviewer for entire one-shot and green-start rounds (6 of 8 shipped
 * problems) — no pressure, no moments, no stuck/adrift, no wrap-up, no acks;
 * opening turn and replies only, for 45-90 minutes. A one-shot round cannot
 * produce a test_run during the session by construction.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { UNDERWAY_FLOOR_MS, roundUnderway } from './session.js';

const T0 = 1_700_000_000_000;
const ev = (type: TraceEvent['type'], atMs: number, payload: unknown = {}): TraceEvent =>
  ({ session_id: 's', user_id: 'u1', source: 'chrome', seq: 0, ts: T0 + atMs, type, payload }) as TraceEvent;

describe('roundUnderway — a failing run, a first edit, or the floor', () => {
  it('a failing run makes the round underway immediately (the debugging trigger, unchanged)', () => {
    const events = [ev('session_start', 0), ev('test_run', 5_000, { exit_code: 1 })];
    expect(roundUnderway(events, T0 + 6_000, T0)).toBe(true);
  });

  it('an edit makes a one-shot round underway — no run will ever exist', () => {
    const events = [ev('session_start', 0), ev('edit', 30_000, { path: 'solution.py' })];
    expect(roundUnderway(events, T0 + 31_000, T0)).toBe(true);
  });

  it('a save counts the same as an edit', () => {
    const events = [ev('session_start', 0), ev('file_save', 30_000, { path: 'solution.py' })];
    expect(roundUnderway(events, T0 + 31_000, T0)).toBe(true);
  });

  it('pure reading is not underway before the floor…', () => {
    const events = [ev('session_start', 0), ev('file_open', 20_000, { path: 'README.md' })];
    expect(roundUnderway(events, T0 + UNDERWAY_FLOOR_MS - 1_000, T0)).toBe(false);
  });

  it('…and is underway once the floor elapses — reading IS the work on review rounds', () => {
    const events = [ev('session_start', 0), ev('file_open', 20_000, { path: 'CHANGE.diff' })];
    expect(roundUnderway(events, T0 + UNDERWAY_FLOOR_MS, T0)).toBe(true);
  });

  it('a green run alone does not make an all_passing round underway before the floor', () => {
    // The suite starting green is the round's resting state, not activity.
    const events = [ev('session_start', 0), ev('test_run', 10_000, { exit_code: 0 })];
    expect(roundUnderway(events, T0 + 60_000, T0)).toBe(false);
  });
});
