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

import type { Rubric, SpecChangeLabel, TestRunPayload, TraceEvent } from '@interview-prep/shared';

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
      const p = ev.payload as TestRunPayload | null;
      if (p && p.exit_code !== 0 && p.exit_code !== null) return ev;
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

export function mechanicalLabels(
  windowEvents: TraceEvent[],
  judgments: UtteranceJudgment[],
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
  const pauses = windowEvents.filter((e) => e.type === 'pause');

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
  if (pauses.length > 0) {
    labels.push({
      label: 'inactivity',
      evidence: pauses.map((e) => ref(e, `went silent ≥20s`)),
    });
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
  return {
    trigger,
    windowEvents,
    labels: markContamination(mechanicalLabels(windowEvents, judgments), windowEvents),
    trigger_occurred: true,
  };
}
