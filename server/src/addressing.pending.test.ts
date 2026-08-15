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
import { PENDING_QUESTION_WINDOW_MS, isAnswerToPendingQuestion } from './addressing.js';

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
    const events = [
      ev('interviewer', 0, { text: "What's your leading theory?", kind: 'probe' }),
      ev('interviewer', 30_000, { text: 'Mm-hm.', kind: 'ack' }),
      ev('interviewer', 60_000, { text: '5 minutes remaining.', kind: 'time' }),
    ];
    expect(isAnswerToPendingQuestion('the eligibility filter is off by one', events, T0 + 90_000)).toBe(true);
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
