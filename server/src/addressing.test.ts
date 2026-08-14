/**
 * Every "must match" fixture below is a REAL utterance from
 * sess-1785962737985 that the LLM gate dropped or nearly dropped, pinned
 * with its session timestamp. The non-matches are the same session's
 * narration — the rhetorical middle the fast path must leave to the gate.
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { CORRECTION_WINDOW_MS, isCorrectionFollowUp, isExplicitAsk } from './addressing.js';

describe('isExplicitAsk — the asks that were dropped must never drop again', () => {
  const mustMatch = [
    // +13:25 — no reply; the candidate typed "give me a hint" 107s later
    "Um, here in outcome, we're assigning it into the results. Um, yeah, uh, I'm kind of stuck here. Uh, can you give me a hand?",
    // +26:49 — typed right after pasting code; no reply
    'this is what i have why is it wrong',
    // +19:28 — the round's central question; nearly dropped
    "Um, I'm honestly not sure what the mechanism is here. Um, how do you pair finished results with that given task?",
    // +21:57 — no reply
    'Well, also, I was like, do you know if you can use former national office?',
    // +15:12 / +32:08 — typed escalations that should never need typing
    'give me a hint',
    'how do I run that?',
    // +16:19 — "grade my theory"
    "It seems like we're just zipping wave in its original sequence with the outcome as they come in, uh, which could be in any order. So that seems like the error here. How's that sound on your end?",
    // +31:42
    'is that clear?',
    // presence checks — cheap to answer, brutal to ignore
    'Can you hear me? Okay.',
    'Okay. Uh, can you hear me? Hello? Can you hear me?',
    // sess-1786072934316 — the language-validity loop. Eight variants over
    // fourteen minutes; these three MISSED the fast path, paid a haiku round
    // trip each, and left the gate deciding whether a question about the code
    // in front of them was narration. They were always unambiguous asks.
    'Is this valid syntax though, like for a dictionary?',
    'is this valid syntax between pool.submits and running spec for spec and wanted here?',
    'Do I need an await?',
    'Just to clarify here, what is, um...',
    'Can you tell me if you are allowed to set a future object as a key in a dictionary?',
  ];
  for (const text of mustMatch) {
    it(`matches: "${text.slice(0, 60)}…"`, () => {
      expect(isExplicitAsk(text)).toBe(true);
    });
  }

  const mustNotMatch = [
    // Rhetorical self-questions and narration from the same session.
    'why is this null?',
    "So, I kinda wanna see what report dot values is downstream of here. Um, report dot values.",
    "That's completed.",
    'Um...',
    "So, looks like run is here in async, uh, definition, um, in the run reports.",
    "We set self dot underscore star that equals true. We validate the graph.",
    'Maybe we just don\'t use "as completed."',
    'wait, did I miss something?',
  ];
  for (const text of mustNotMatch) {
    it(`leaves to the gate: "${text.slice(0, 50)}…"`, () => {
      expect(isExplicitAsk(text)).toBe(false);
    });
  }
});

describe('isCorrectionFollowUp — you do not correct someone who was not talking to you', () => {
  const T0 = 1_700_000_000_000;
  const ev = (type: TraceEvent['type'], atMs: number, payload: unknown = {}): TraceEvent => ({
    session_id: 's', user_id: 'u1', source: 'chrome', seq: 0, ts: T0 + atMs, type, payload,
  });

  it('the +20:35 case: "no i mean…" seconds after an interviewer answer is addressed', () => {
    const events = [ev('utterance', 0), ev('interviewer', 10_000, { text: 'the unittest command' })];
    expect(isCorrectionFollowUp('no i mean to pair the task with the result', events, T0 + 25_000)).toBe(true);
  });

  it('a correction opener with no recent interviewer turn is just self-talk', () => {
    const events = [ev('utterance', 0), ev('interviewer', 10_000)];
    expect(
      isCorrectionFollowUp('no i mean the other loop', events, T0 + 10_000 + CORRECTION_WINDOW_MS + 1),
    ).toBe(false);
    expect(isCorrectionFollowUp('no i mean the other loop', [ev('utterance', 0)], T0 + 5_000)).toBe(false);
  });

  it('non-correction openers never trigger it', () => {
    const events = [ev('interviewer', 0)];
    expect(isCorrectionFollowUp('so the results are flipped', events, T0 + 5_000)).toBe(false);
  });
});
