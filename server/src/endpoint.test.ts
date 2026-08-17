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
