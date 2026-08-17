/**
 * Endpointing — the property under test is patience: the buffer must not
 * release a turn while the human is still talking, and must release
 * exactly one merged turn when they stop. Frozen clock, pure module.
 */
import { describe, expect, it } from 'vitest';
import { SPEECH_SETTLE_MS, STALE_OPEN_MS, SpeechTurnBuffer } from './endpoint.js';

const T0 = 1_700_000_000_000;

describe('SpeechTurnBuffer', () => {
  it('merges a slow speaker\'s clause-sized segments into one turn, in order', () => {
    // The sess-1786948725100 shape: one thought, three VAD segments.
    const b = new SpeechTurnBuffer();
    b.speechStarted(T0);
    b.push('I guess I\'ll just assume it\'s inclusive for now.', T0 + 2_000);
    b.speechStarted(T0 + 3_000);
    b.push('Probably in the for loop when I\'m counting the items.', T0 + 5_000);
    b.speechStarted(T0 + 6_500);
    b.push('That fall under the given window.', T0 + 8_000);
    expect(b.shouldFlush(T0 + 8_000 + SPEECH_SETTLE_MS - 100)).toBe(false);
    expect(b.shouldFlush(T0 + 8_000 + SPEECH_SETTLE_MS)).toBe(true);
    expect(b.flush()).toBe(
      'I guess I\'ll just assume it\'s inclusive for now. ' +
        'Probably in the for loop when I\'m counting the items. ' +
        'That fall under the given window.',
    );
    expect(b.pending).toBe(false);
  });

  it('an open segment holds the flush — they are still talking', () => {
    const b = new SpeechTurnBuffer();
    b.speechStarted(T0);
    b.push('first clause here', T0 + 1_000);
    b.speechStarted(T0 + 1_500); // mouth open again
    // Way past the settle window, but the segment never closed.
    expect(b.shouldFlush(T0 + 1_500 + SPEECH_SETTLE_MS + 5_000)).toBe(false);
    b.push('second clause lands', T0 + 9_000);
    expect(b.shouldFlush(T0 + 9_000 + SPEECH_SETTLE_MS)).toBe(true);
  });

  it('untranscribed segments close their slot without contributing text', () => {
    const b = new SpeechTurnBuffer();
    b.speechStarted(T0);
    b.push('', T0 + 1_000); // sound, no words
    expect(b.shouldFlush(T0 + 1_000 + SPEECH_SETTLE_MS)).toBe(false); // nothing to route
    b.speechStarted(T0 + 2_000);
    b.push('real words now', T0 + 3_000);
    expect(b.shouldFlush(T0 + 3_000 + SPEECH_SETTLE_MS)).toBe(true);
    expect(b.flush()).toBe('real words now');
  });

  it('a transcript landing after a flush starts the NEXT turn', () => {
    const b = new SpeechTurnBuffer();
    b.speechStarted(T0);
    b.push('turn one', T0 + 1_000);
    expect(b.shouldFlush(T0 + 1_000 + SPEECH_SETTLE_MS)).toBe(true);
    expect(b.flush()).toBe('turn one');
    b.speechStarted(T0 + 10_000);
    b.push('turn two', T0 + 11_000);
    expect(b.flush()).toBe('turn two');
  });

  it('a dangling segment stops holding after STALE_OPEN_MS — a corpse must not strand buffered words', () => {
    const b = new SpeechTurnBuffer();
    b.speechStarted(T0);
    b.push('these words made it', T0 + 1_000);
    b.speechStarted(T0 + 2_000); // browser dies here: no push ever comes
    expect(b.shouldFlush(T0 + 2_000 + STALE_OPEN_MS - 1_000)).toBe(false);
    expect(b.shouldFlush(T0 + 2_000 + STALE_OPEN_MS)).toBe(true);
    expect(b.flush()).toBe('these words made it');
  });

  it('a push with no matching start never wedges the counter', () => {
    const b = new SpeechTurnBuffer();
    b.push('relay-side flush from before', T0); // openSegments would go negative
    b.speechStarted(T0 + 1_000);
    b.push('normal segment', T0 + 2_000);
    expect(b.shouldFlush(T0 + 2_000 + SPEECH_SETTLE_MS)).toBe(true);
  });

  it('never flushes empty', () => {
    const b = new SpeechTurnBuffer();
    expect(b.shouldFlush(T0 + 60_000)).toBe(false);
    b.speechStarted(T0);
    b.push('', T0 + 500);
    expect(b.shouldFlush(T0 + 60_000)).toBe(false);
  });
});

describe('boundary-driven mode — the silence clock ignores transcript arrival (sess-1786984222355)', () => {
  it('the STT round trip burns down inside the window, not on top of it', () => {
    const b = new SpeechTurnBuffer();
    b.speechStarted(T0);
    b.speechEnded(T0 + 3_000); // mouth closed here
    b.push('the whole clause as one segment right here', T0 + 4_800); // transcript 1.8s later
    // Settle counts from speech END: ready at end+2s, not arrival+2s.
    expect(b.shouldFlush(T0 + 3_000 + SPEECH_SETTLE_MS)).toBe(true);
  });

  it('a noise segment resolving empty does NOT restart the wait — the 15-37s lag killer', () => {
    const b = new SpeechTurnBuffer();
    b.speechStarted(T0);
    b.speechEnded(T0 + 2_000);
    b.push('am I good to start implementing here or what', T0 + 3_000);
    // Keyboard noise: segment opens and closes fast...
    b.speechStarted(T0 + 3_500);
    b.speechEnded(T0 + 4_000);
    // ...and while its transcript is outstanding, the open slot holds.
    expect(b.shouldFlush(T0 + 4_000 + SPEECH_SETTLE_MS)).toBe(false);
    // The empty transcript arrives WAY later. Arrival must not move the
    // clock: the wait anchored at the noise's END (4s), so the flush is
    // due the moment the slot closes — no fresh settle window.
    b.push('', T0 + 9_000);
    expect(b.shouldFlush(T0 + 9_100)).toBe(true);
    expect(b.flush()).toBe('am I good to start implementing here or what');
  });

  it('a late TRANSCRIBED segment still cannot flush before its own boundary settles', () => {
    const b = new SpeechTurnBuffer();
    b.speechStarted(T0);
    b.speechEnded(T0 + 1_000);
    b.push('first thought lands', T0 + 2_000);
    b.speechStarted(T0 + 2_500); // talking again
    expect(b.shouldFlush(T0 + 2_500 + SPEECH_SETTLE_MS + 5_000)).toBe(false); // open segment holds
    b.speechEnded(T0 + 6_000);
    b.push('second thought lands', T0 + 7_500);
    expect(b.shouldFlush(T0 + 6_000 + SPEECH_SETTLE_MS - 100)).toBe(false);
    expect(b.shouldFlush(T0 + 6_000 + SPEECH_SETTLE_MS)).toBe(true);
  });
});
