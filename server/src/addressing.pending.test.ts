/**
 * isAnswerToPendingQuestion — you do not narrate INTO a question someone
 * just asked you.
 *
 * Fixtures are the real sess-qa814-leak sequence: at +379s the interviewer
 * said "No — at the handover minute only the incoming agent is on shift.
 * Given that, go check whether the on-shift check you've been reading
 * agrees with the half-open rule I just gave you." (kind "answer", no
 * question mark, nudge TRUE — a directive). At +405s the candidate
 * delivered the complete root cause; the gate read it as narration and the
 * diagnosis sat unanswered for 190 seconds.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { MIN_ANSWER_WORDS, PENDING_QUESTION_WINDOW_MS, isAnswerToPendingQuestion } from './addressing.js';

const T0 = 1_700_000_000_000;
const ev = (type: TraceEvent['type'], atMs: number, payload: unknown = {}): TraceEvent =>
  ({ session_id: 's', user_id: 'u1', source: 'chrome', seq: 0, ts: T0 + atMs, type, payload }) as TraceEvent;

const DIAGNOSIS =
  'Here is my read: the on-shift check computes span and offset modulo the day and accepts offset <= span, which is inclusive of the end minute.';

describe('isAnswerToPendingQuestion', () => {
  it('the +405s case: first words after a nudge directive are addressed', () => {
    const events = [
      ev('utterance', 375_000, { text: 'at a handover minute, is the outgoing agent still eligible?' }),
      ev('interviewer', 379_000, {
        text: 'No — at the handover minute only the incoming agent is on shift. Given that, go check whether the on-shift check agrees.',
        kind: 'answer',
        nudge: true,
      }),
    ];
    expect(isAnswerToPendingQuestion(DIAGNOSIS, events, T0 + 405_000)).toBe(true);
  });

  it('a probe with a question mark is pending too', () => {
    const events = [ev('interviewer', 0, { text: "What's your leading theory?", kind: 'probe', nudge: false })];
    expect(isAnswerToPendingQuestion('the filter is too permissive at the boundary', events, T0 + 20_000)).toBe(true);
  });

  it('a second utterance after the question falls to the gate — only the FIRST is addressed by construction', () => {
    const events = [
      ev('interviewer', 0, { text: "What's your leading theory?", kind: 'probe' }),
      ev('utterance', 10_000, { text: 'let me look at the roster first' }),
    ];
    expect(isAnswerToPendingQuestion('okay the roster looks fine', events, T0 + 30_000)).toBe(false);
  });

  it('a plain statement with no question, no nudge, and no interrogative kind pends nothing', () => {
    const events = [ev('interviewer', 0, { text: 'Right — all three futures are already finished.', kind: 'answer', nudge: false })];
    expect(isAnswerToPendingQuestion('now checking the executor', events, T0 + 20_000)).toBe(false);
  });

  it('acks and time announcements neither ask nor cancel the pending question', () => {
    // Times sit inside the 60s window — the pin here is the SKIP rule for
    // content-free turns, not the window length.
    const events = [
      ev('interviewer', 0, { text: "What's your leading theory?", kind: 'probe' }),
      ev('interviewer', 15_000, { text: 'Mm-hm.', kind: 'ack' }),
      ev('interviewer', 25_000, { text: '5 minutes remaining.', kind: 'time' }),
    ];
    expect(
      isAnswerToPendingQuestion('the eligibility filter is off by one at the boundary', events, T0 + 40_000),
    ).toBe(true);
  });

  it('an expired window is narration again', () => {
    const events = [ev('interviewer', 0, { text: "What's your leading theory?", kind: 'probe' })];
    expect(
      isAnswerToPendingQuestion('the filter is off', events, T0 + PENDING_QUESTION_WINDOW_MS + 1_000),
    ).toBe(false);
  });

  it('no interviewer turn at all is narration', () => {
    expect(isAnswerToPendingQuestion('thinking out loud here', [ev('utterance', 0, { text: 'hi' })], T0 + 10_000)).toBe(false);
  });
});

describe('live wiring: the store already holds the utterance being classified', () => {
  // session.ts emits the utterance to the trace BEFORE routeUtterance runs,
  // so the detector's backward walk meets the utterance under judgement
  // first. Before the skip-self fix this made the fast path DEAD CODE in
  // production — every fixture above passes events WITHOUT the routed
  // utterance, which is exactly how the bug survived this suite
  // (sess-1786861469215: a direct answer to "walk me through why…" fell to
  // the gate and read as narration).
  it('still addressed when the routed utterance is already the tail event', () => {
    const events = [
      ev('interviewer', 0, { text: "What's your leading theory?", kind: 'probe' }),
      ev('utterance', 20_000, { text: DIAGNOSIS }),
    ];
    expect(isAnswerToPendingQuestion(DIAGNOSIS, events, T0 + 20_000)).toBe(true);
  });

  it('an identical OLDER utterance is still prior words — the gate decides', () => {
    // Long enough to clear the substance floor, so the false here pins the
    // skip-once rule and nothing else.
    const said = 'the eligibility filter is off by one at the boundary';
    const events = [
      ev('interviewer', 0, { text: "What's your leading theory?", kind: 'probe' }),
      ev('utterance', 10_000, { text: said }),
      ev('utterance', 20_000, { text: said }),
    ];
    expect(isAnswerToPendingQuestion(said, events, T0 + 20_000)).toBe(false);
  });

  it('untranscribed segments between question and answer do not break it', () => {
    const events = [
      ev('interviewer', 0, { text: "What's your leading theory?", kind: 'probe' }),
      ev('utterance', 8_000, { text: '' }),
      ev('utterance', 20_000, { text: DIAGNOSIS }),
    ];
    expect(isAnswerToPendingQuestion(DIAGNOSIS, events, T0 + 20_000)).toBe(true);
  });
});

describe('the substance floor — fragments never fast-path (sess-1786924315899)', () => {
  // The live loop: the interviewer ends most turns with a question, each
  // reply re-armed the window, and every VAD breath became its "answer" —
  // 26 spoken turns, gaps down to 1 second, a round-long interruption
  // loop. These are the actual utterances that fast-pathed that round.
  const probe = () => [
    ev('interviewer', 0, { text: 'What makes you say that?', kind: 'probe' }),
  ];

  it.each([
    'Um...',
    'Oh my God.',
    'Uh, taking modulo.',
    'Um, okay. Anyways, um...',
    'Yeah, the divisors of the items, so...',
  ])('"%s" falls to the gate', (frag) => {
    expect(isAnswerToPendingQuestion(frag, probe(), T0 + 10_000)).toBe(false);
  });

  it('the accepted tradeoff: a filler-heavy sentence over the floor still fast-paths', () => {
    // 9 words by pure count — a lexicon would call it filler, and a lexicon
    // is exactly what was rejected (it fails open for every speaker it
    // didn't anticipate). One reply that may choose silence is the cost.
    expect(isAnswerToPendingQuestion('I just need to find a way, I guess.', probe(), T0 + 10_000)).toBe(true);
  });

  it('a substantive first response still fast-paths — the qa814 guarantee survives', () => {
    expect(isAnswerToPendingQuestion(DIAGNOSIS, probe(), T0 + 10_000)).toBe(true);
    expect(
      isAnswerToPendingQuestion('I think the check compares raw strings instead of path segments here', probe(), T0 + 10_000),
    ).toBe(true);
  });

  it('the floor is MIN_ANSWER_WORDS by pure count — no lexicon (owner decision 2026-08-17)', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');
    expect(isAnswerToPendingQuestion(words(MIN_ANSWER_WORDS), probe(), T0 + 10_000)).toBe(true);
    expect(isAnswerToPendingQuestion(words(MIN_ANSWER_WORDS - 1), probe(), T0 + 10_000)).toBe(false);
  });

  it('the window is 60s — the incident this detector serves was a 26s gap', () => {
    expect(PENDING_QUESTION_WINDOW_MS).toBe(60_000);
  });
});
