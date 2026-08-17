/**
 * The wrap trigger decides when the interviewer stops evaluating work and
 * starts evaluating the CANDIDATE — firing mid-work turns the round into an
 * exit interview, so the silences are pinned as hard as the firings.
 * Pure, frozen clock (repo convention).
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import {
  CLOSING_TOPIC,
  WRAP_GREEN_DELAY_MS,
  WRAP_UP_QUESTIONS,
  countsAsWrapQuestion,
  WRAP_FINALIZE_QUIET_MS,
  shouldAutoFinalize,
  detectWrapSignal,
  isDonePhrase,
  renderWrapState,
  selectWrapTopic,
} from './wrapup.js';
import type { AgendaStatus } from './agenda.js';
import type { DimensionKey } from '@interview-prep/shared';

const T0 = 1_700_000_000_000;

class T {
  private events: TraceEvent[] = [];
  private seq = 0;
  private push(type: TraceEvent['type'], min: number, payload: unknown): this {
    this.events.push({
      session_id: 'fixture', user_id: 'u1', source: 'chrome',
      seq: this.seq++, ts: T0 + min * 60_000, type, payload,
    });
    return this;
  }
  fail(min: number) { return this.push('test_run', min, { via: 'task', exit_code: 1, duration_ms: 90 }); }
  pass(min: number) { return this.push('test_run', min, { via: 'task', exit_code: 0, duration_ms: 9 }); }
  crashed(min: number) { return this.push('test_run', min, { via: 'task', exit_code: null, duration_ms: 5 }); }
  say(min: number, text: string) { return this.push('utterance', min, { text, via: 'voice' }); }
  build() { return [...this.events]; }
}

const at = (min: number) => T0 + min * 60_000;

describe('detectWrapSignal — green path', () => {
  it('fires once the latest run is green after a failure and has stood 60s', () => {
    const ev = new T().fail(1).pass(20).build();
    expect(detectWrapSignal(ev, at(20) + WRAP_GREEN_DELAY_MS - 1_000)).toBeNull();
    expect(detectWrapSignal(ev, at(20) + WRAP_GREEN_DELAY_MS + 1_000)).not.toBeNull();
  });

  it('a round that started green never wraps on green — nothing was fixed', () => {
    expect(detectWrapSignal(new T().pass(1).build(), at(10))).toBeNull();
  });

  it('a failing run AFTER the green un-fires it — latest run rules', () => {
    const ev = new T().fail(1).pass(15).fail(20).build();
    expect(detectWrapSignal(ev, at(25))).toBeNull();
  });

  it('a crashed run does not count as the latest completed run', () => {
    const ev = new T().fail(1).pass(15).crashed(16).build();
    expect(detectWrapSignal(ev, at(20))).not.toBeNull();
  });
});

describe('detectWrapSignal — done-phrase path', () => {
  it.each([
    'So, any other questions?',
    "I'm done here.",
    "that's it, I think",
    "we're good",
  ])('fires on "%s" even while the suite is red', (phrase) => {
    const ev = new T().fail(1).say(10, phrase).build();
    expect(detectWrapSignal(ev, at(10.1))).not.toBeNull();
  });

  it('ignores done-phrases before the first completed run (mic checks)', () => {
    const ev = new T().say(0.5, 'we good?').fail(1).build();
    expect(detectWrapSignal(ev, at(2))).toBeNull();
  });

  it('mid-work narration does not fire it', () => {
    const ev = new T().fail(1).say(5, 'okay let me look at the dispatch loop here').build();
    expect(detectWrapSignal(ev, at(6))).toBeNull();
  });
});

describe('selectWrapTopic — works down the agenda gaps', () => {
  const status = (over: Partial<Record<DimensionKey, AgendaStatus>>): Record<DimensionKey, AgendaStatus> => ({
    clarify: 'some', approach: 'some', communicate: 'some',
    implement: 'some', verify: 'some', reflect: 'some', ...over,
  });

  it('reflect outranks approach outranks clarify', () => {
    expect(selectWrapTopic(status({ reflect: 'none', approach: 'none' }), 0)).toContain('WHY it works');
    expect(selectWrapTopic(status({ approach: 'none' }), 0)).toContain('mental model');
    expect(selectWrapTopic(status({ clarify: 'none' }), 0)).toContain('WOULD have asked');
  });

  it('self-advances: a gap that got covered drops out', () => {
    // After the reflect question is answered, reflect flips to 'some' and
    // the next call must pick the next gap, not repeat.
    expect(selectWrapTopic(status({ approach: 'none' }), 1)).toContain('mental model');
  });

  it('no gaps left → depth questions, different each time', () => {
    const a = selectWrapTopic(status({}), 0);
    const b = selectWrapTopic(status({}), 1);
    expect(a).not.toBe(b);
  });

  it('past the budget → the closing', () => {
    expect(selectWrapTopic(status({ reflect: 'none' }), WRAP_UP_QUESTIONS)).toBe(CLOSING_TOPIC);
  });
});

describe('renderWrapState', () => {
  it('numbers the question and carries the topic', () => {
    const out = renderWrapState(1, 'ask about X');
    expect(out).toContain(`Question 2 of ${WRAP_UP_QUESTIONS}`);
    expect(out).toContain('ask about X');
  });

  it('the closing renders as a closing, not a numbered question', () => {
    const out = renderWrapState(3, CLOSING_TOPIC);
    expect(out).toContain('closing');
    expect(out).not.toContain('Question 4');
  });
});

describe('isDonePhrase — the short "anything else?" tail (sess-1786861469215)', () => {
  it('matches the phrasing an actual candidate used', () => {
    expect(isDonePhrase('Okay. Uh, anything else?')).toBe(true);
    expect(isDonePhrase('anything else?')).toBe(true);
    expect(isDonePhrase('Is there anything else?')).toBe(true);
  });

  it('never matches a working-phase question that happens to contain it', () => {
    expect(isDonePhrase('is there anything else that touches this cache?')).toBe(false);
    expect(isDonePhrase('let me check if anything else writes to the ledger here')).toBe(false);
  });

  it('the done path in detectWrapSignal accepts the tail phrase after work started', () => {
    const ev = new T().fail(1).say(15, 'Okay. Uh, anything else?').build();
    expect(detectWrapSignal(ev, at(15) + 1_000)).toBe(at(15));
  });
});

describe('reply-carried wrap questions (the lane paces on silence; replies carry the phase)', () => {
  it('viaReply instructs answer-then-ask and keeps the question number', () => {
    const s = renderWrapState(1, 'ask why the fix works', { viaReply: true });
    expect(s).toContain('REPLY');
    expect(s).toContain(`Question 2 of ${WRAP_UP_QUESTIONS}`);
    expect(s).toContain('answer what they said first');
  });

  it('without viaReply the lane wording is unchanged', () => {
    const s = renderWrapState(0, 'ask why the fix works');
    expect(s).toContain('One question per turn');
    expect(s).not.toContain('REPLY');
  });

  it('countsAsWrapQuestion is mechanical: the turn must actually ask', () => {
    expect(countsAsWrapQuestion('Good — why did that pass?')).toBe(true);
    expect(countsAsWrapQuestion('Understood, that matches what I saw.')).toBe(false);
  });
});

describe('shouldAutoFinalize — the interviewer owns the ending (owner call 2026-08-17)', () => {
  const C = T0; // closing spoke here
  it('fires only after the full quiet window past ALL activity', () => {
    expect(shouldAutoFinalize(C, C, 0, C + WRAP_FINALIZE_QUIET_MS - 1_000)).toBe(false);
    expect(shouldAutoFinalize(C, C, 0, C + WRAP_FINALIZE_QUIET_MS)).toBe(true);
  });

  it('any candidate speech resets the grace — even untranscribed sound counts', () => {
    const spoke = C + 20_000;
    expect(shouldAutoFinalize(C, C, spoke, C + WRAP_FINALIZE_QUIET_MS + 5_000)).toBe(false);
    expect(shouldAutoFinalize(C, C, spoke, spoke + WRAP_FINALIZE_QUIET_MS)).toBe(true);
  });

  it('a post-closing answer resets it too — the question gets its reply first', () => {
    const replied = C + 30_000;
    expect(shouldAutoFinalize(C, replied, C + 25_000, C + WRAP_FINALIZE_QUIET_MS + 10_000)).toBe(false);
    expect(shouldAutoFinalize(C, replied, C + 25_000, replied + WRAP_FINALIZE_QUIET_MS)).toBe(true);
  });
});
