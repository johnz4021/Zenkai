/**
 * classify(trace, rubric) → labels + evidence   (eng review T2, decision 8)
 *
 *   trace ──► findTrigger ──► extractWindow ──► mechanical labels
 *                                          └──► LLM pass (utterances only)
 *                                                    └──► combined labels
 *
 * Split deliberately:
 *   - test_run / inactivity / immediate_edit derive MECHANICALLY from event
 *     ordering — deterministic, unit-tested, no model in the loop.
 *   - clarifying_question / assumption_update need judgment about utterance
 *     text — that's the LLM pass, injectable so tests never call a model.
 *
 * Runs OFF the session's critical path (decision 1A). The caller enforces
 * any live deadline; post-session classification has none.
 */

import type { Rubric, SpecChangeLabel, TraceEvent } from '@interview-prep/shared';
import { INACTIVITY_THRESHOLD_MS, isCandidateActivity, isFailingRun } from '@interview-prep/shared';

export interface UtteranceJudgment {
  seq: number;
  clarifying_question: boolean;
  assumption_update: boolean;
}

export type UtteranceJudge = (
  utterances: { seq: number; text: string }[],
  spec: string,
) => Promise<UtteranceJudgment[]>;

export interface LabelEvidence {
  label: SpecChangeLabel;
  /** (source, seq) refs into the trace — the two-line citation's raw material. */
  evidence: { source: string; seq: number; ts: number; note: string }[];
  /**
   * True when every piece of evidence landed in the shadow of an interviewer
   * nudge. The behavior was PROMPTED, so it says nothing about what the
   * candidate does on their own — it is reported but never counted.
   */
  contaminated?: boolean;
}

/**
 * How long a nudge's influence lasts.
 *
 * Long enough to cover read → think → act after the interviewer narrowed the
 * search space; short enough that one nudge does not swallow a whole ten
 * minute debugging cycle and blank the session.
 */
export const NUDGE_CONTAMINATION_MS = 120_000;

/** Interviewer turns that narrowed the search space, in ts order. */
export function nudgeTimes(windowEvents: TraceEvent[]): number[] {
  return windowEvents
    .filter((e) => e.type === 'interviewer' && (e.payload as { nudge?: boolean })?.nudge === true)
    .map((e) => e.ts)
    .sort((a, b) => a - b);
}

/**
 * Mark labels whose evidence is entirely downstream of a nudge.
 *
 * ALL evidence must be contaminated, not just some: if the candidate asked a
 * clarifying question on their own AND another after a nudge, the label stands
 * on the clean one.
 */
export function markContamination(
  labels: LabelEvidence[],
  windowEvents: TraceEvent[],
): LabelEvidence[] {
  const nudges = nudgeTimes(windowEvents);
  if (nudges.length === 0) return labels;
  const inShadow = (ts: number) =>
    nudges.some((n) => ts >= n && ts - n <= NUDGE_CONTAMINATION_MS);
  return labels.map((l) =>
    l.evidence.length > 0 && l.evidence.every((e) => inShadow(e.ts))
      ? { ...l, contaminated: true }
      : l,
  );
}

export interface Classification {
  trigger: TraceEvent | null;
  windowEvents: TraceEvent[];
  labels: LabelEvidence[];
  /** True when the trigger condition occurred at all — gap-graph remediation
   * MUST check this (eng review T11: no trigger, no remediation credit). */
  trigger_occurred: boolean;
}

export function findTrigger(events: TraceEvent[], rubric: Rubric): TraceEvent | null {
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  for (const ev of ordered) {
    if (ev.type !== rubric.trigger.event) continue;
    if (rubric.trigger.predicate === 'first_failure') {
      if (isFailingRun(ev)) return ev;
    } else {
      return ev;
    }
  }
  return null;
}

export function extractWindow(
  events: TraceEvent[],
  rubric: Rubric,
  trigger: TraceEvent,
): TraceEvent[] {
  const start = trigger.ts;
  const hardEnd = rubric.window.duration_ms
    ? start + rubric.window.duration_ms
    : Number.POSITIVE_INFINITY;
  // Do not let `until` slam the window shut immediately (e.g. an instant
  // re-run just to re-read the failure output).
  const earliestClose = start + (rubric.window.min_duration_ms ?? 0);

  const inRange = events
    .filter((e) => e.ts > start && e.ts <= hardEnd)
    .sort((a, b) => a.ts - b.ts);

  const until = rubric.window.until;
  if (!until) return inRange;
  const stopIdx = inRange.findIndex((e) => e.type === until && e.ts >= earliestClose);
  return stopIdx === -1 ? inRange : inRange.slice(0, stopIdx + 1);
}

const ref = (e: TraceEvent, note: string) => ({
  source: e.source,
  seq: e.seq,
  ts: e.ts,
  note,
});

/**
 * Inactivity, computed by the SERVER over the merged trace.
 *
 *   trigger ──act──act────────────────act──█ window close
 *              │    └──── gap ≥ 20s ────┘
 *              └ any source: edit, save, test run, chat, (soon) speech
 *
 * This replaces the extension's `pause` event, which was a keystrokes-only
 * VERDICT: narrating out loud — and even typing a clarifying question into
 * the chat panel — scored as silence, because chat is chrome-sourced and
 * never reached the extension's activity clock. Only the server sees every
 * source, so only the server may define silence. The extension now reports
 * facts; this function interprets them.
 *
 * Boundaries count: the stretch from the trigger to the first activity, and
 * from the last activity to the window close, are gaps like any other.
 */
export interface WindowBounds {
  start_ts: number;
  end_ts: number;
}

export function computeInactivity(
  windowEvents: TraceEvent[],
  bounds: WindowBounds,
): LabelEvidence['evidence'] {
  const activity = windowEvents
    .filter(isCandidateActivity)
    .map((e) => e.ts)
    .sort((a, b) => a - b);

  const gaps: LabelEvidence['evidence'] = [];
  let prev = bounds.start_ts;
  for (const ts of [...activity, bounds.end_ts]) {
    const gap = ts - prev;
    if (gap >= INACTIVITY_THRESHOLD_MS) {
      gaps.push({
        source: 'server',
        seq: -1, // derived, not a stored event
        ts: prev,
        note: `went silent for ${Math.round(gap / 1000)}s (no edits, saves, runs, or utterances from any source)`,
      });
    }
    prev = Math.max(prev, ts);
  }
  return gaps;
}

/**
 * Where the measurement window actually ends on the clock. The `until`
 * close is the last window event; a capped/open window ends at the hard cap
 * or the session end, whichever came first. Without this, an empty window
 * (failing run, then nothing) would have no second timestamp to measure a
 * gap against — and that exact case is the genuine-silence positive control.
 */
export function windowBounds(
  allEvents: TraceEvent[],
  rubric: Rubric,
  trigger: TraceEvent,
  windowEvents: TraceEvent[],
): WindowBounds {
  const hardEnd = rubric.window.duration_ms
    ? trigger.ts + rubric.window.duration_ms
    : Number.POSITIVE_INFINITY;
  const last = windowEvents[windowEvents.length - 1];
  const closedByUntil =
    rubric.window.until !== undefined && last !== undefined && last.type === rubric.window.until;
  if (closedByUntil) return { start_ts: trigger.ts, end_ts: last.ts };

  // The hard cap is only a real boundary once we KNOW the clock passed it —
  // i.e. the session ended. Without a session_end, treating the cap as the
  // window edge would invent minutes of "silence" that have not happened yet;
  // the last observed event is the honest end of what we can measure.
  const sessionEnd = allEvents.find((e) => e.type === 'session_end');
  const end = sessionEnd ? Math.min(hardEnd, sessionEnd.ts) : (last?.ts ?? trigger.ts);
  return { start_ts: trigger.ts, end_ts: Math.max(end, trigger.ts) };
}

export function mechanicalLabels(
  windowEvents: TraceEvent[],
  judgments: UtteranceJudgment[],
  bounds?: WindowBounds,
): LabelEvidence[] {
  const labels: LabelEvidence[] = [];
  const judged = new Map(judgments.map((j) => [j.seq, j]));

  const clarifying = windowEvents.filter(
    (e) => e.type === 'utterance' && judged.get(e.seq)?.clarifying_question,
  );
  const assumptions = windowEvents.filter(
    (e) =>
      (e.type === 'utterance' && judged.get(e.seq)?.assumption_update) ||
      (e.type === 'file_save' &&
        /readme|notes|assumptions/i.test(String((e.payload as { path?: string })?.path ?? ''))),
  );
  const edits = windowEvents.filter((e) => e.type === 'edit');
  const reruns = windowEvents.filter((e) => e.type === 'test_run');

  if (clarifying.length > 0) {
    labels.push({
      label: 'clarifying_question',
      evidence: clarifying.map((e) => ref(e, 'asked a clarifying question')),
    });
  }
  if (assumptions.length > 0) {
    labels.push({
      label: 'assumption_update',
      evidence: assumptions.map((e) => ref(e, 'recorded an assumption')),
    });
  }
  // immediate_edit: a code edit BEFORE any clarifying question or assumption
  // update in the window. Ordering is by ts (2A: same-session, ~1s precision).
  const firstEdit = edits[0];
  if (firstEdit) {
    const firstThought = [...clarifying, ...assumptions].sort((a, b) => a.ts - b.ts)[0];
    if (!firstThought || firstEdit.ts < firstThought.ts) {
      labels.push({
        label: 'immediate_edit',
        evidence: [ref(firstEdit, 'edited before asking or recording assumptions')],
      });
    }
  }
  if (reruns.length > 0) {
    labels.push({
      label: 'test_run',
      evidence: reruns.map((e) => ref(e, 'ran the tests inside the window')),
    });
  }
  // Inactivity is server-derived from gaps in the merged trace, never from
  // extension `pause` events (see computeInactivity). No bounds, no verdict.
  if (bounds) {
    const gaps = computeInactivity(windowEvents, bounds);
    if (gaps.length > 0) {
      labels.push({ label: 'inactivity', evidence: gaps });
    }
  }
  return labels;
}

export async function classify(
  events: TraceEvent[],
  rubric: Rubric,
  spec: string,
  judge: UtteranceJudge,
): Promise<Classification> {
  const trigger = findTrigger(events, rubric);
  if (!trigger) {
    return { trigger: null, windowEvents: [], labels: [], trigger_occurred: false };
  }
  const windowEvents = extractWindow(events, rubric, trigger);
  const utterances = windowEvents
    .filter((e) => e.type === 'utterance')
    .map((e) => ({ seq: e.seq, text: String((e.payload as { text?: string })?.text ?? '') }));
  const judgments = utterances.length > 0 ? await judge(utterances, spec) : [];
  const bounds = windowBounds(events, rubric, trigger, windowEvents);
  return {
    trigger,
    windowEvents,
    labels: markContamination(mechanicalLabels(windowEvents, judgments, bounds), windowEvents),
    trigger_occurred: true,
  };
}
