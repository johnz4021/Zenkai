/**
 * The agenda drives where unprompted probes aim, so a wrong 'none' nags the
 * candidate about something they already did, and a wrong 'some' lets a
 * whole dimension go unevaluated. Signals are coarse by design — these pin
 * the on/off edges. Pure, frozen clock (repo convention).
 */
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '@interview-prep/shared';
import { assessAgenda, renderAgenda } from './agenda.js';

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
  start(min = 0) { return this.push('session_start', min, {}); }
  fail(min: number) { return this.push('test_run', min, { via: 'task', exit_code: 1, duration_ms: 90, summary: 'FAILED (failures=1)' }); }
  pass(min: number) { return this.push('test_run', min, { via: 'task', exit_code: 0, duration_ms: 9, summary: 'OK' }); }
  edit(min: number) { return this.push('edit', min, { path: 'a.py', changes: 3 }); }
  say(min: number, text: string) { return this.push('utterance', min, { text, via: 'voice' }); }
  answer(min: number, unprompted = false) {
    return this.push('interviewer', min, { text: 'Yes.', kind: 'answer', nudge: false, unprompted });
  }
  probe(min: number) { return this.push('interviewer', min, { text: 'Why?', kind: 'probe', nudge: false, unprompted: true }); }
  build() { return [...this.events]; }
}

const at = (min: number) => T0 + min * 60_000;
const THEORY = 'I think the retry loop is dropping the record because the index never resets there';

describe('assessAgenda — per-dimension evidence', () => {
  it('clarify: a prompted answer counts; the unprompted opening does not', () => {
    const opening = new T().start().answer(0, true).fail(1).build();
    expect(assessAgenda(opening, at(5)).clarify).toBe('none');
    const asked = new T().start().answer(0, true).fail(1).answer(3, false).build();
    expect(assessAgenda(asked, at(5)).clarify).toBe('some');
  });

  it('clarify: an engagement turn is prompted by narration, not a question — no credit', () => {
    const engaged = new T().start().answer(0, true).fail(1).build();
    engaged.push({
      session_id: 'fixture', user_id: 'u1', source: 'chrome', seq: 99, ts: at(3),
      type: 'interviewer',
      payload: { text: 'Green — what convinced you?', kind: 'answer', nudge: false, unprompted: false, engage: true },
    } as TraceEvent);
    expect(assessAgenda(engaged, at(5)).clarify).toBe('none');
  });

  it('approach: a theory-sized utterance between first failure and first edit', () => {
    const silentEditor = new T().start().fail(1).edit(5).build();
    expect(assessAgenda(silentEditor, at(6)).approach).toBe('none');
    const theorist = new T().start().fail(1).say(3, THEORY).edit(5).build();
    expect(assessAgenda(theorist, at(6)).approach).toBe('some');
    // Stated AFTER editing does not rescue it — the habit being measured is
    // theory BEFORE touching code.
    const late = new T().start().fail(1).edit(3).say(5, THEORY).build();
    expect(assessAgenda(late, at(6)).approach).toBe('none');
  });

  it('approach is not-applicable before the first failing run', () => {
    expect(assessAgenda(new T().start().build(), at(2)).approach).toBe('na');
  });

  it('communicate: sustained narration clears it; near-silence does not', () => {
    let talker = new T().start().fail(1);
    for (let i = 0; i < 10; i++) talker = talker.say(2 + i, THEORY);
    expect(assessAgenda(talker.build(), at(15)).communicate).toBe('some');
    const quiet = new T().start().fail(1).say(3, 'hmm').build();
    expect(assessAgenda(quiet, at(15)).communicate).toBe('none');
  });

  it('implement and verify: verify needs a completed run AFTER an edit', () => {
    const s = assessAgenda(new T().start().fail(1).build(), at(5));
    expect(s.implement).toBe('none');
    expect(s.verify).toBe('na'); // nothing to verify yet
    const edited = assessAgenda(new T().start().fail(1).edit(3).build(), at(5));
    expect(edited.implement).toBe('some');
    expect(edited.verify).toBe('none');
    const verified = assessAgenda(new T().start().fail(1).edit(3).fail(4).build(), at(5));
    expect(verified.verify).toBe('some');
  });

  it('reflect: not-applicable before green; substantive speech after green counts', () => {
    const working = new T().start().fail(1).edit(3).fail(4).build();
    expect(assessAgenda(working, at(5)).reflect).toBe('na');
    const greenSilent = new T().start().fail(1).edit(3).pass(4).build();
    expect(assessAgenda(greenSilent, at(6)).reflect).toBe('none');
    const explained = new T().start().fail(1).edit(3).pass(4).say(5, THEORY).build();
    expect(assessAgenda(explained, at(6)).reflect).toBe('some');
  });
});

describe('renderAgenda', () => {
  it('lists gaps with probe-able hints and names covered dimensions', () => {
    const out = renderAgenda(
      assessAgenda(new T().start().fail(1).edit(3).fail(4).build(), at(6)),
    );
    expect(out).toContain('Still NO evidence');
    expect(out).toContain('approach:');
    expect(out).toContain('theory or mechanism');
    expect(out).toContain('implement');
  });

  it('never lists a not-applicable dimension as a gap', () => {
    // reflect before green would push reflection questions mid-work.
    const out = renderAgenda(assessAgenda(new T().start().fail(1).build(), at(3)));
    expect(out).not.toContain('reflect:');
    expect(out).not.toContain('verify:');
  });

  it('everything covered → probe depth, not coverage', () => {
    let t = new T().start().fail(1).answer(2).say(2.5, THEORY);
    for (let i = 0; i < 8; i++) t = t.say(3 + i * 0.5, THEORY);
    t = t.edit(7).fail(8).edit(9).pass(10).say(11, THEORY);
    const out = renderAgenda(assessAgenda(t.build(), at(12)));
    expect(out).toContain('every dimension');
  });
});
