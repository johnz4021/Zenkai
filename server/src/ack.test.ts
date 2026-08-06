/**
 * Acks exist because a real candidate asked "can you hear me?" four times at
 * a working microphone — the interviewer's only states were full turn and
 * total silence. These tests pin the restraint as hard as the firing: an
 * over-eager ack channel is exactly the over-speaking failure the research
 * (Koala, IUI 2025) measured people resenting.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { ACK_MIN_GAP_MS, ACK_MIN_NARRATION, ACK_POOL, ACK_SESSION_CAP, decideAck } from './ack.js';

const T0 = 1_700_000_000_000;
const ev = (type: TraceEvent['type'], atSec: number, payload: unknown = {}): TraceEvent => ({
  session_id: 's', user_id: 'u1', source: 'chrome', seq: 0, ts: T0 + atSec * 1000, type, payload,
});
const said = (atSec: number, text = 'narrating the wave loop here') =>
  ev('utterance', atSec, { text, via: 'voice' });
const ack = (atSec: number) => ev('interviewer', atSec, { text: 'Mm-hm.', kind: 'ack', nudge: false });
const turn = (atSec: number) => ev('interviewer', atSec, { text: 'What is your theory?', kind: 'probe', nudge: false });

const NOW = T0 + 300_000; // +5:00

describe('decideAck', () => {
  it('fires after sustained narration into silence', () => {
    const events = [turn(10), said(120), said(150), said(180)];
    expect(decideAck(events, NOW, { askPending: false })).toBe(ACK_POOL[0]);
  });

  it('stays quiet below the narration floor — two remarks are not a monologue', () => {
    const events = [turn(10), said(120), said(150)];
    expect(decideAck(events, NOW, { askPending: false })).toBeNull();
  });

  it('respects the gap floor after ANY interviewer output, acks included', () => {
    const recentTurn = [turn(280), said(285), said(290), said(295)];
    expect(decideAck(recentTurn, NOW, { askPending: false })).toBeNull();
    const recentAck = [ack(280), said(285), said(290), said(295)];
    expect(decideAck(recentAck, NOW, { askPending: false })).toBeNull();
    // ...and the same shape past the floor fires.
    const past = [turn(10), said(150), said(200), said(250)];
    expect(NOW - (T0 + 10_000)).toBeGreaterThan(ACK_MIN_GAP_MS);
    expect(decideAck(past, NOW, { askPending: false })).not.toBeNull();
  });

  it('an interviewer turn resets the narration count', () => {
    // 3 utterances, then a turn, then 2 — only the 2 after the turn count.
    const events = [said(20), said(30), said(40), turn(60), said(150), said(160)];
    expect(decideAck(events, NOW, { askPending: false })).toBeNull();
  });

  it('a pending ask suppresses acks — a real answer is coming', () => {
    const events = [turn(10), said(120), said(150), said(180)];
    expect(decideAck(events, NOW, { askPending: true })).toBeNull();
  });

  it('caps at the session limit and rotates deterministically until then', () => {
    const events: TraceEvent[] = [];
    let t = 10;
    for (let i = 0; i < ACK_SESSION_CAP; i++) {
      events.push(said(t), said(t + 5), said(t + 10));
      // Verify rotation before appending the ack the server would emit.
      const now = T0 + (t + 20) * 1000 + ACK_MIN_GAP_MS + 600_000;
      expect(decideAck(events, now, { askPending: false })).toBe(ACK_POOL[i % ACK_POOL.length]);
      events.push(ack(t + 15));
      t += 200;
    }
    events.push(said(t), said(t + 5), said(t + 10));
    expect(decideAck(events, T0 + (t + 500) * 1000, { askPending: false })).toBeNull();
  });

  it('never fires on an empty or untranscribed-only stretch', () => {
    const events = [
      turn(10),
      ev('utterance', 120, { text: '', via: 'voice', untranscribed: true }),
      ev('utterance', 150, { text: '', via: 'voice', untranscribed: true }),
      ev('utterance', 180, { text: '', via: 'voice', untranscribed: true }),
    ];
    expect(decideAck(events, NOW, { askPending: false })).toBeNull();
  });

  it('the pool is content-free: no problem vocabulary can possibly leak', () => {
    for (const line of ACK_POOL) {
      expect(line.split(/\s+/).length).toBeLessThanOrEqual(3);
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });
});
