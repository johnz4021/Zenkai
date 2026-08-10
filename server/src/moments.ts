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
import { assessAgenda } from './agenda.js';

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
      editWithoutTheory(events, fired, nowMs) ??
      firstFixRan(events, fired) ??
      passAfterStruggle(events, fired) ??
      reranWithoutChange(events, fired)
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

/** First edit landed with the agenda's `approach` still empty — they are
 *  changing code without ever having said what the change is meant to fix.
 *  Only before that edit's run: once a run completes, firstFixRan owns the
 *  beat and a stale "before you run that" would read as not watching. */
function editWithoutTheory(events: TraceEvent[], fired: ReadonlySet<string>, nowMs: number): Moment | null {
  if (fired.has('edit_without_theory')) return null;
  const firstEdit = events.find((e) => e.type === 'edit');
  if (!firstEdit) return null;
  if (events.some((e) => e.type === 'test_run' && e.ts > firstEdit.ts)) return null;
  if (assessAgenda(events, nowMs).approach !== 'none') return null;
  return {
    kind: 'edit_without_theory',
    observation:
      'They just started editing without having said what they think is wrong or what the change is meant to fix.',
  };
}

/** Two completed runs with nothing changed between them — re-running and
 *  hoping. The kickoff pair is exempt: re-running right after the autorun
 *  is just looking at the output again, not a debugging pattern. */
function reranWithoutChange(events: TraceEvent[], fired: ReadonlySet<string>): Moment | null {
  if (fired.has('reran_without_change')) return null;
  const completed = (e: TraceEvent) =>
    e.type === 'test_run' && (e.payload as TestRunPayload | null)?.exit_code != null;
  let prevRunIdx = -1;
  let runNumber = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (!completed(e)) continue;
    runNumber++;
    if (prevRunIdx !== -1 && runNumber > 2) {
      const between = events.slice(prevRunIdx + 1, i);
      if (!between.some((b) => b.type === 'edit' || b.type === 'file_save')) {
        return {
          kind: 'reran_without_change',
          observation:
            'They just re-ran the suite without changing anything since the previous run.',
        };
      }
    }
    prevRunIdx = i;
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
