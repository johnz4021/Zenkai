/**
 * Evaluation agenda — what the interviewer still needs to see.
 *
 *   trace ──► assessAgenda ──► per-dimension evidence status ──► {{AGENDA}}
 *                                                                (per-turn)
 *
 * Why (sess-1786220758002): the rubric sat in the prompt as advice ("aim
 * your probes") with nothing tracking which dimensions had produced
 * evidence. Each turn was a fresh render with no notion of what remained to
 * be evaluated — so the interviewer probed whatever was in front of it and
 * never noticed the candidate had gone a whole round without stating a
 * theory or reflecting on the fix. This module turns the judge's own six
 * dimensions (shared/src/dimensions.ts — the single spine the gap graph and
 * gauntlet count over) into a running to-do list.
 *
 * COARSE on purpose. These are mechanical presence-of-evidence signals, not
 * grades — grading is the judge's job, after the session, with the full
 * trace. A dimension marked 'some' here may still be judged weak; 'none'
 * only means the interviewer has not yet given the candidate a chance to
 * show it (or they haven't taken one). Three states:
 *   'none' — probeable now, no evidence yet → the interviewer's targets
 *   'some' — at least one qualifying event exists
 *   'na'   — not yet applicable (reflect before green, verify before any
 *            edit): listing these as gaps would push reflection questions
 *            into the middle of the work.
 *
 * Pure and stateless over the trace (detector convention): no I/O, no clock
 * reads, `nowMs` injected.
 */

import type { TraceEvent } from '@interview-prep/shared';
import { DIMENSIONS, isFailingRun, type DimensionKey } from '@interview-prep/shared';

export type AgendaStatus = 'none' | 'some' | 'na';

/** Words in a transcribed utterance before it counts as substantive —
 *  filters "Okay. Um..." without demanding a speech. */
const SUBSTANTIVE_WORDS = 8;
/** A stated-theory utterance is held to a slightly higher bar. */
const THEORY_WORDS = 12;

function textOf(e: TraceEvent): string {
  return String((e.payload as { text?: string })?.text ?? '').trim();
}

function wordCount(s: string): number {
  return s === '' ? 0 : s.split(/\s+/).length;
}

function isGreenRun(e: TraceEvent): boolean {
  return e.type === 'test_run' && (e.payload as { exit_code?: number | null })?.exit_code === 0;
}

export interface AgendaCaps {
  /** Can the candidate run the suite during the round at all? False only
   *  on can_run_tests:false rounds (one-shot rounds run freely since the
   *  2026-08-15 un-conflation) — where `verify` and `reflect`
   *  must be 'na', not 'none': the old always-runnable assumption printed
   *  "they have edited but not run the suite since" on EVERY turn of a
   *  round whose Run button does not exist, and the prompt told the
   *  interviewer to probe exactly that (QA 2026-08-14). */
  runnable: boolean;
}

export function assessAgenda(
  events: TraceEvent[],
  nowMs: number,
  caps: AgendaCaps = { runnable: true },
): Record<DimensionKey, AgendaStatus> {
  const utterances = events.filter((e) => e.type === 'utterance');
  const substantive = utterances.filter((e) => wordCount(textOf(e)) >= SUBSTANTIVE_WORDS);

  const firstFail = events.find(isFailingRun) ?? null;
  const firstEdit = events.find((e) => e.type === 'edit') ?? null;
  const firstGreen = events.find(isGreenRun) ?? null;
  const anyEdit = firstEdit !== null || events.some((e) => e.type === 'file_save');

  // clarify: a prompted `answer` turn means they asked the interviewer
  // something real (the opening is kind 'answer' too, but unprompted).
  // Engagement turns are excluded: they are prompted by NARRATION the
  // intent gate flagged, not by a question — counting one as clarify
  // evidence would credit the candidate with asking when they never did.
  const clarified = events.some(
    (e) =>
      e.type === 'interviewer' &&
      (e.payload as { kind?: string })?.kind === 'answer' &&
      (e.payload as { unprompted?: boolean })?.unprompted !== true &&
      (e.payload as { engage?: boolean })?.engage !== true,
  );

  // approach: a theory-sized utterance before the first edit — the "state
  // the mechanism before touching code" habit the rubric rewards. On a
  // runnable round the window opens at the first FAILURE (the thing a theory
  // is about); on a no-run round no failure can ever exist, so the window
  // opens at the start — the old firstFail key left `approach` permanently
  // 'na' on exactly the rounds where thinking aloud is the only signal.
  const approachStartTs = caps.runnable ? firstFail?.ts : events[0]?.ts;
  const approachShown =
    approachStartTs !== undefined &&
    utterances.some(
      (e) =>
        e.ts >= approachStartTs &&
        (firstEdit === null || e.ts < firstEdit.ts) &&
        wordCount(textOf(e)) >= THEORY_WORDS,
    );

  // communicate: sustained narration, scaled to elapsed time — 154
  // transcribed lines in 26 minutes clears any bar; near-silence does not.
  const elapsedMin = Math.max(1, (nowMs - (events[0]?.ts ?? nowMs)) / 60_000);
  const communicated = substantive.length >= Math.max(4, Math.floor(elapsedMin / 3));

  // verify: they ran the suite AFTER changing something.
  const verified =
    firstEdit !== null &&
    events.some((e) => e.type === 'test_run' && e.ts > firstEdit.ts &&
      (e.payload as { exit_code?: number | null })?.exit_code != null);

  // reflect: said something substantive after the suite went green.
  const reflected =
    firstGreen !== null && substantive.some((e) => e.ts > firstGreen.ts);

  const status: Record<DimensionKey, AgendaStatus> = {
    clarify: clarified ? 'some' : 'none',
    approach:
      (caps.runnable ? firstFail === null : events.length === 0)
        ? 'na'
        : approachShown
          ? 'some'
          : 'none',
    communicate: communicated ? 'some' : 'none',
    implement: anyEdit ? 'some' : 'none',
    // Nothing can run mid-round on a no-run round: verify and reflect are
    // not-applicable, never open gaps to nag about.
    verify: !caps.runnable || firstEdit === null ? 'na' : verified ? 'some' : 'none',
    reflect: !caps.runnable || firstGreen === null ? 'na' : reflected ? 'some' : 'none',
  };
  return status;
}

/** What each open gap means, in probe-able terms — never dimension names
 *  alone, because the render is the interviewer's working material. */
const GAP_HINTS: Record<DimensionKey, string> = {
  clarify: 'they have not asked a single question about the problem or its spec',
  approach: 'they have not stated a theory or mechanism out loud before editing',
  communicate: 'long silent stretches — very little narration of what they are doing',
  implement: 'they have not changed any code yet',
  verify: 'they have edited but not run the suite since',
  reflect: 'the suite is green but they have not explained why the fix works',
};

/**
 * The per-turn prompt block. Deliberately in the SESSION STATE half — it
 * changes as evidence accumulates, and caching the stable half depends on
 * per-turn material staying below the marker.
 */
export function renderAgenda(status: Record<DimensionKey, AgendaStatus>): string {
  const gaps = DIMENSIONS.filter((k) => status[k] === 'none');
  const covered = DIMENSIONS.filter((k) => status[k] === 'some');
  if (gaps.length === 0) {
    return 'They have shown something on every dimension you evaluate. Probe depth where it was thin.';
  }
  const gapLines = gaps.map((k) => `  - ${k}: ${GAP_HINTS[k]}`).join('\n');
  return (
    `Still NO evidence on (aim unprompted probes here — give them a chance to show it):\n${gapLines}` +
    (covered.length > 0 ? `\nAlready shown: ${covered.join(', ')}.` : '')
  );
}
