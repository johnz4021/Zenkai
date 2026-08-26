/**
 * Session slot reaper decision (slot hygiene — abandoned tabs held a limited
 * session slot forever; a real sample session sat live 13h in prod). reapReason
 * is the pure core behind the 60s reaper interval in runSession. The load-
 * bearing case is the LAST one: an actively-polling reader is never reaped, so
 * the idle signal (the tab's 3s /api/status heartbeat) can't false-positive on
 * someone who is present but silent.
 */
import { describe, expect, it } from 'vitest';
import { reapReason } from './session.js';

const IDLE = 15 * 60_000;
const MAX = 90 * 60_000;
const cfg = { idleMs: IDLE, maxMs: MAX };
const NOW = 1_000_000_000_000;

describe('reapReason', () => {
  it('reaps on idle once activity is older than idleMs', () => {
    // born recently (young session), but no heartbeat for 16 min
    expect(reapReason(NOW, NOW - 16 * 60_000, NOW - 16 * 60_000, cfg)).toBe('idle');
  });

  it('reaps on absolute age past maxMs even with RECENT activity', () => {
    // someone left the tab open all day: heartbeating (not idle) but 91 min old
    expect(reapReason(NOW, NOW - 2_000, NOW - 91 * 60_000, cfg)).toBe('expired');
  });

  it('idle takes precedence when both fire', () => {
    expect(reapReason(NOW, NOW - 20 * 60_000, NOW - 100 * 60_000, cfg)).toBe('idle');
  });

  it('fires exactly AT the idle threshold (>=)', () => {
    expect(reapReason(NOW, NOW - IDLE, NOW - IDLE, cfg)).toBe('idle');
  });

  it('does NOT reap just under the idle threshold', () => {
    expect(reapReason(NOW, NOW - (IDLE - 1_000), NOW - (IDLE - 1_000), cfg)).toBe(null);
  });

  it('does NOT reap an actively-polling reader — the false-positive to prevent', () => {
    // present but silent: the tab polled /api/status 3s ago; young session.
    // Reading a hard problem for minutes still heartbeats, so must be kept.
    expect(reapReason(NOW, NOW - 3_000, NOW - 40 * 60_000, cfg)).toBe(null);
    // and a brand-new session with immediate activity
    expect(reapReason(NOW, NOW, NOW, cfg)).toBe(null);
  });
});
