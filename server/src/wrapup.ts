/**
 * Wrap-up — the round gets an ending.
 *
 *   trace ──► detectWrapSignal ──► wrapUpAt set ──► wrap lane asks up to
 *             (green+60s, or a       (session.ts)    3 evaluation questions,
 *              done-signal phrase)                   then closes the room
 *
 * Why (sess-1786220758002): the only closing rule keyed on `Remaining <
 * 5 min` of a 45-minute clock; the candidate finished at 22:28, delivered a
 * complete correct explanation of the mechanism, asked "Any other
 * questions?" twice, got silence twice, and the round just stopped. The
 * wrap-up is where a real interview actually evaluates — and it did not
 * exist.
 *
 * The ending is verbal only (decided): the interviewer signs off and tells
 * the candidate to end the session whenever they're ready. The End button
 * stays the one graded path; nothing here touches /api/end.
 *
 * Pure and stateless over the trace (detector convention).
 */

import type { TraceEvent } from '@interview-prep/shared';
import { isFailingRun, type DimensionKey } from '@interview-prep/shared';
import type { AgendaStatus } from './agenda.js';

/** Don't step on the victory lap: green must stand this long first. */
export const WRAP_GREEN_DELAY_MS = 60_000;
/** Evaluation questions before the sign-off. */
export const WRAP_UP_QUESTIONS = 3;

/** "I'm finished" in the candidate's own words. Matched over the trace here
 *  — deliberately NOT added to the addressing fast path (deferred with I4):
 *  the phrase starts the wrap-up phase whether or not the utterance itself
 *  got routed as addressed. */
const DONE_RE =
  /(any (other|more) questions|i'?m done|that'?s (it|all|everything)|we('re| are) (good|done))/i;

function isGreenRun(e: TraceEvent): boolean {
  return e.type === 'test_run' && (e.payload as { exit_code?: number | null })?.exit_code === 0;
}

/**
 * Is the working phase over? Non-null = yes, with the ts the signal fired.
 *
 * Two ways in:
 *  - the suite's LATEST completed run is green, a failing run preceded it
 *    (so this is a fix, not a round that started green), and it has stood
 *    for WRAP_GREEN_DELAY_MS;
 *  - the candidate said a done-phrase (after at least one completed run —
 *    "we good?" in minute one is a mic check, not a surrender).
 */
export function detectWrapSignal(events: TraceEvent[], nowMs: number): number | null {
  const runs = events.filter(
    (e) => e.type === 'test_run' && (e.payload as { exit_code?: number | null })?.exit_code != null,
  );
  const latest = runs[runs.length - 1];
  const hadFailure = events.some(isFailingRun);

  if (latest && isGreenRun(latest) && hadFailure && nowMs - latest.ts >= WRAP_GREEN_DELAY_MS) {
    return latest.ts + WRAP_GREEN_DELAY_MS;
  }
  if (runs.length > 0) {
    const firstRunTs = runs[0]!.ts;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type !== 'utterance' || e.ts <= firstRunTs) continue;
      const text = String((e.payload as { text?: string })?.text ?? '');
      if (DONE_RE.test(text)) return e.ts;
    }
  }
  return null;
}

/**
 * What the next wrap-up turn should ask about, from the agenda's gaps.
 * Priority reflects what an ending is FOR: reflect (why did the fix work,
 * why was the bug hidden) is the heart of the evaluation; approach recovers
 * a theory they never voiced; the clarify inverse ("what would you have
 * asked at the start, knowing what you know now?") is the classic closer.
 * With no gaps left, go deeper on the work itself.
 */
export function selectWrapTopic(
  status: Record<DimensionKey, AgendaStatus>,
  questionsAsked: number,
): string {
  if (questionsAsked >= WRAP_UP_QUESTIONS) return CLOSING_TOPIC;
  const order: { key: DimensionKey; topic: string }[] = [
    {
      key: 'reflect',
      topic:
        'they have not explained the fix — ask WHY it works, and why the defect stayed invisible until this test',
    },
    {
      key: 'approach',
      topic:
        'they never stated their theory during the work — ask what their mental model of the failure was and when it clicked',
    },
    {
      key: 'clarify',
      topic:
        'they never asked a question all round — ask what they WOULD have asked at the start, knowing what they know now',
    },
    {
      key: 'verify',
      topic:
        'ask how confident they are the fix is complete — what else would they check before shipping it',
    },
  ];
  // Always the highest-priority gap still open: answering a wrap question
  // flips its dimension to 'some', so the list self-advances between turns.
  const open = order.find((o) => status[o.key] === 'none');
  if (open) return open.topic;
  // Nothing uncovered: evaluate depth instead of coverage.
  const depth = [
    'ask what the riskiest assumption in their fix is',
    'ask what they would refactor here if they owned this code',
    'ask what almost sent them down the wrong path, and what pulled them back',
  ];
  return depth[Math.min(questionsAsked, depth.length - 1)]!;
}

export const CLOSING_TOPIC =
  'CLOSING — acknowledge the round in one sentence (specific, not flattery), then tell them: that is everything from you, and they can end the session whenever they are ready. Nothing after this.';

/** The {{WRAPUP}} slot value while the phase is active. */
export function renderWrapState(questionsAsked: number, topic: string): string {
  if (topic === CLOSING_TOPIC) {
    return `WRAP-UP, closing. ${topic}`;
  }
  return (
    `WRAP-UP phase (the working part of the round is over; this conversation IS the round now). ` +
    `Question ${questionsAsked + 1} of ${WRAP_UP_QUESTIONS}. Next: ${topic} ` +
    `One question per turn; follow up once if their answer is thin, then move on.`
  );
}
