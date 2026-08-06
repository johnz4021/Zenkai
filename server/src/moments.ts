/**
 * Moments — the trace points where a real interviewer would lean in.
 *
 *   tick ──► detectMoment(events, checkKind, fired) ──► one probe, once
 *
 * Why (the arc redesign, sess-1785962737985): the interviewer's only
 * unprompted behaviors were clock-driven pressure and stuck scaffolding —
 * it never probed the moments that carry the round: the first read of a
 * failure, the first fix attempt, the pass after a struggle. Every
 * production system that publishes anything conditions engagement on the
 * segment of the interview; this is that idea grounded in the trace.
 *
 * Mechanical, trace-derivable ONLY — utterance-content moments ("they just
 * stated a hypothesis") stay the model's job in replies. Each moment kind
 * fires at most once per session (the caller's fired set). Which moments
 * exist comes from check.kind — the same closed-vocabulary dispatch as
 * checkRequirements(). stuck.ts lineage: pure forward scan, injected clock,
 * observation strings with no paths (the workspace view carries specifics).
 */

import type { RoundSpec, TraceEvent, TestRunPayload } from '@interview-prep/shared';
import { isFailingRun } from '@interview-prep/shared';

export interface Moment {
  kind: string;
  /** Prompt text: what just happened, in identity terms. */
  observation: string;
}

/** Reading time after a failure before the read is worth probing. */
export const FIRST_READ_MS = 45_000;

function isPassingRun(e: TraceEvent): boolean {
  return e.type === 'test_run' && (e.payload as TestRunPayload | null)?.exit_code === 0;
}

export function detectMoment(
  events: TraceEvent[],
  checkKind: RoundSpec['check']['kind'],
  fired: ReadonlySet<string>,
  nowMs: number,
): Moment | null {
  if (checkKind === 'one_failing_test') {
    return (
      firstFailureRead(events, fired, nowMs) ??
      firstFixRan(events, fired) ??
      passAfterStruggle(events, fired)
    );
  }
  if (checkKind === 'all_failing') {
    return firstRun(events, fired) ?? firstPass(events, fired);
  }
  // all_passing / diff_present: no mechanical moments in v1.
  return null;
}

/** First failing run, followed by sustained reading (opens allowed, no
 *  edits) — the moment a methodical candidate has just absorbed the
 *  failure and a probe lands on fresh ground. */
function firstFailureRead(events: TraceEvent[], fired: ReadonlySet<string>, nowMs: number): Moment | null {
  if (fired.has('first_failure_read')) return null;
  const firstFail = events.find(isFailingRun);
  if (!firstFail) return null;
  if (nowMs - firstFail.ts < FIRST_READ_MS) return null;
  const after = events.filter((e) => e.ts > firstFail.ts);
  if (after.some((e) => e.type === 'edit')) return null; // they moved past reading
  return {
    kind: 'first_failure_read',
    observation:
      'They have had the first failing run in front of them for a while and have been reading without editing.',
  };
}

/** The first run after at least one edit following the first failure —
 *  their first real fix attempt just produced a result. */
function firstFixRan(events: TraceEvent[], fired: ReadonlySet<string>): Moment | null {
  if (fired.has('first_fix_ran')) return null;
  const firstFailIdx = events.findIndex(isFailingRun);
  if (firstFailIdx === -1) return null;
  let edited = false;
  for (let i = firstFailIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'edit') edited = true;
    else if (e.type === 'test_run' && edited) {
      const passed = isPassingRun(e);
      return {
        kind: 'first_fix_ran',
        observation: `Their first edit-and-run attempt just completed and the suite ${passed ? 'PASSED' : 'still fails'}.`,
      };
    }
  }
  return null;
}

/** A passing run after two or more failures — the win worth interrogating
 *  before it is celebrated. */
function passAfterStruggle(events: TraceEvent[], fired: ReadonlySet<string>): Moment | null {
  if (fired.has('pass_after_struggle')) return null;
  let failures = 0;
  for (const e of events) {
    if (isFailingRun(e)) failures++;
    else if (isPassingRun(e) && failures >= 2) {
      return {
        kind: 'pass_after_struggle',
        observation: `The suite just passed after ${failures} failing runs.`,
      };
    }
  }
  return null;
}

/** all_failing: the suite's very first run — they have just seen the
 *  contract they are building against. */
function firstRun(events: TraceEvent[], fired: ReadonlySet<string>): Moment | null {
  if (fired.has('first_run')) return null;
  const run = events.find((e) => e.type === 'test_run' && (e.payload as TestRunPayload | null)?.exit_code !== null);
  if (!run) return null;
  return {
    kind: 'first_run',
    observation: 'They just ran the suite for the first time and have seen the full set of failing behaviors.',
  };
}

/** all_failing: first fully green run after at least one failing one. */
function firstPass(events: TraceEvent[], fired: ReadonlySet<string>): Moment | null {
  if (fired.has('first_pass')) return null;
  let failed = false;
  for (const e of events) {
    if (isFailingRun(e)) failed = true;
    else if (isPassingRun(e) && failed) {
      return {
        kind: 'first_pass',
        observation: 'The whole suite just went green for the first time.',
      };
    }
  }
  return null;
}
