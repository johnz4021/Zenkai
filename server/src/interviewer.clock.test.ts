/**
 * The clock — an untimed round has no deadline to fabricate.
 *
 * sess-qa813-panesint-b +13s: "…and you've got 45 minutes" on a round whose
 * spec says time_limit_ms: null (the DEFAULT_SPEC shape). The session
 * substituted a nominal 45 minutes and the number rode into the prompt as
 * fact, while the candidate's own header clock counted UP with no deadline.
 * These pin the whole path: remainingMsFor never invents a horizon, render
 * states the absence positively (never 0 — "Remaining: 0 min" reads as
 * "time is up"), and the timed/untimed rules land in the CACHED half without
 * breaking its byte-identity as the clock ticks.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, renderSplit, type InterviewerContext } from './interviewer.js';
import { remainingMsFor } from './session.js';

const REPO = path.resolve(__dirname, '..', '..');
const template = () => readFileSync(path.join(REPO, 'prompts/interviewer.md'), 'utf8');

const base: InterviewerContext = {
  spec: 'THE SPEC',
  bug: 'THE BUG',
  bugFile: 'src/x.ts',
  elapsedMs: 12 * 60_000,
  remainingMs: 33 * 60_000,
  recentActivity: 'ACT',
  transcript: [],
  candidateMessage: 'how long do I have?',
};

describe('remainingMsFor — no nominal deadline is ever invented', () => {
  it('a timed round counts down from its own cap', () => {
    expect(remainingMsFor(20 * 60_000, 5 * 60_000)).toBe(15 * 60_000);
  });

  it('an untimed round hands the interviewer null — not 45 minutes and not 0', () => {
    expect(remainingMsFor(null, 5 * 60_000)).toBeNull();
    expect(remainingMsFor(null, 0)).toBeNull();
  });
});

describe('the clock in the rendered prompt', () => {
  it('a timed round still renders real minutes', () => {
    expect(render(template(), base)).toContain('Elapsed: 12 min. Remaining: 33 min.');
  });

  it('an untimed round states the absence — never a number, and never zero', () => {
    const out = render(template(), { ...base, remainingMs: null });
    expect(out).toContain('Elapsed: 12 min.');
    expect(out).toMatch(/Remaining: UNTIMED/);
    expect(out).not.toMatch(/Remaining: \d+ min/);
  });

  it('the untimed rules land in the CACHED half; the fact stays per-turn', () => {
    const { system, turn } = renderSplit(template(), { ...base, remainingMs: null });
    expect(system).toMatch(/This round is UNTIMED/);
    expect(system).toMatch(/Never name a length/);
    expect(system).toMatch(/NOT one of your moves here/); // no time-check pressure
    expect(system).toMatch(/Only the WRAP-UP state/); // no clock-triggered CLOSING
    expect(turn).toMatch(/Remaining: UNTIMED/);
  });

  it('the timed round keeps the opening framing and the time-check move', () => {
    const { system } = renderSplit(template(), base);
    expect(system).toMatch(/This round is TIMED/);
    expect(system).toContain('You have about 12 minutes');
    expect(system).toContain('on a TIMED round, when Remaining is under ~5 minutes');
  });

  it('timedness is session-constant, so the cached half survives the clock ticking', () => {
    const a = renderSplit(template(), { ...base, remainingMs: null }).system;
    const b = renderSplit(template(), {
      ...base,
      remainingMs: null,
      elapsedMs: 55 * 60_000,
      candidateMessage: 'another question',
    }).system;
    expect(a).toBe(b);
    expect(renderSplit(template(), { ...base, remainingMs: 5 * 60_000 }).system).not.toBe(a);
  });

  it.each([33 * 60_000, null])('leaves no unfilled slots (remainingMs=%s)', (remainingMs) => {
    expect(render(template(), { ...base, remainingMs })).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
