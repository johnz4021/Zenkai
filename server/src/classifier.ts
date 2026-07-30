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
  // v1-rubric path only (deleted in the judge migration); v2 manifests
  // without trigger/window never reach the classifier.
  if (!rubric.trigger) return null;
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  for (const ev of ordered) {
    if (ev.type !== rubric.trigger!.event) continue;
    if (rubric.trigger!.predicate === 'first_failure') {
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
  const w = rubric.window ?? {};
  const start = trigger.ts;
  const hardEnd = w.duration_ms ? start + w.duration_ms : Number.POSITIVE_INFINITY;
  // Do not let `until` slam the window shut immediately (e.g. an instant
  // re-run just to re-read the failure output).
  const earliestClose = start + (w.min_duration_ms ?? 0);

  const inRange = events
    .filter((e) => e.ts > start && e.ts <= hardEnd)
    .sort((a, b) => a.ts - b.ts);

  const until = w.until;
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
  /** What closed the window — decides whether the trailing gap is evidence. */
  end_reason: 'until' | 'session_end' | 'cap' | 'last_event';
}

export function computeInactivity(
  windowEvents: TraceEvent[],
  bounds: WindowBounds,
): LabelEvidence['evidence'] {
  const activity = windowEvents
    .filter(isCandidateActivity)
    .map((e) => e.ts)
    .sort((a, b) => a - b);

  // The TRAILING gap — last activity to window close — is evidence only when
  // the window closed on the clock (hard cap): the candidate was still in
  // the session and genuinely silent. A gap that ends at session_end is the
  // WRAP-UP TAIL — measured live: a candidate finished their sentence,
  // spent 22s winding down, clicked "End Session", and was scored "goes
  // quiet when something breaks". They weren't quiet; they were done. Same
  // exclusion for last_event (mid-session classification: no way to know
  // what follows). An `until` close ends AT a test_run, which is activity,
  // so its trailing gap is zero by construction either way.
  const trailingCounts = bounds.end_reason === 'cap';
  const points = trailingCounts ? [...activity, bounds.end_ts] : activity;

  const gaps: LabelEvidence['evidence'] = [];
  let prev = bounds.start_ts;
  for (const ts of points) {
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
  const w = rubric.window ?? {};
  const hardEnd = w.duration_ms ? trigger.ts + w.duration_ms : Number.POSITIVE_INFINITY;
  const last = windowEvents[windowEvents.length - 1];
  const closedByUntil =
    w.until !== undefined && last !== undefined && last.type === w.until;
  if (closedByUntil) return { start_ts: trigger.ts, end_ts: last.ts, end_reason: 'until' };

  // The hard cap is only a real boundary once we KNOW the clock passed it —
  // i.e. the session ended. Without a session_end, treating the cap as the
  // window edge would invent minutes of "silence" that have not happened yet;
  // the last observed event is the honest end of what we can measure.
  const sessionEnd = allEvents.find((e) => e.type === 'session_end');
  if (!sessionEnd) {
    return { start_ts: trigger.ts, end_ts: last?.ts ?? trigger.ts, end_reason: 'last_event' };
  }
  const capped = sessionEnd.ts > hardEnd;
  return {
    start_ts: trigger.ts,
    end_ts: Math.max(capped ? hardEnd : sessionEnd.ts, trigger.ts),
    end_reason: capped ? 'cap' : 'session_end',
  };
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

/**
 * Sensor-degradation contamination (eng review D4 + tension 1).
 *
 * Sensor failure creates the OPPOSITE problem from nudges: not "this fired
 * because we prompted it" but "this fired because data went missing". So it
 * marks exactly the labels whose FIRING could be an artifact of blindness:
 *
 *   presence dead  → we know nothing about speech
 *                    · inactivity contaminated (the "gap" may have been talk)
 *                    · immediate_edit contaminated (a spoken thought before
 *                      the edit would be invisible)
 *   stt dead, presence alive → we know THAT they spoke, not WHAT
 *                    · inactivity stays TRUSTWORTHY — presence-only speech
 *                      still lands in the trace as untranscribed utterances,
 *                      so real silence is still real
 *                    · immediate_edit contaminated (the lost words might have
 *                      been the clarifying question)
 *
 * Content labels that FIRED are never contaminated by sensors — their
 * evidence exists. Pre-voice traces carry no sensor events and pass through
 * untouched.
 */
export function sensorDownIntervals(
  events: TraceEvent[],
  sensor: 'presence' | 'stt',
): { start: number; end: number }[] {
  const changes = events
    .filter((e) => e.type === 'sensor' && (e.payload as { sensor?: string })?.sensor === sensor)
    .sort((a, b) => a.ts - b.ts);
  if (changes.length === 0) return [];
  const out: { start: number; end: number }[] = [];
  let downSince: number | null = null;
  for (const ev of changes) {
    const state = (ev.payload as { state?: string }).state;
    if (state === 'down' && downSince === null) downSince = ev.ts;
    if (state === 'up' && downSince !== null) {
      out.push({ start: downSince, end: ev.ts });
      downSince = null;
    }
  }
  if (downSince !== null) out.push({ start: downSince, end: Number.POSITIVE_INFINITY });
  return out;
}

const overlaps = (a: { start: number; end: number }, s: number, e: number) =>
  a.start < e && a.end > s;

export function markSensorContamination(
  labels: LabelEvidence[],
  allEvents: TraceEvent[],
  bounds: WindowBounds,
): LabelEvidence[] {
  const voiceWasActive = allEvents.some((e) => e.type === 'sensor');
  if (!voiceWasActive) return labels;

  const presenceDown = sensorDownIntervals(allEvents, 'presence');
  const sttDown = sensorDownIntervals(allEvents, 'stt');
  const inWindow = (iv: { start: number; end: number }) => overlaps(iv, bounds.start_ts, bounds.end_ts);

  return labels.map((l) => {
    if (l.contaminated) return l;
    if (l.label === 'inactivity') {
      // Contaminate only if presence was down during one of the actual gaps.
      const gapHit = l.evidence.some((g) =>
        presenceDown.some((iv) => overlaps(iv, g.ts, bounds.end_ts)),
      );
      return gapHit ? { ...l, contaminated: true } : l;
    }
    if (l.label === 'immediate_edit') {
      const firstEditTs = l.evidence[0]?.ts ?? bounds.end_ts;
      const blind = [...presenceDown, ...sttDown].some((iv) =>
        overlaps(iv, bounds.start_ts, firstEditTs),
      );
      return blind ? { ...l, contaminated: true } : l;
    }
    return l; // content labels that fired have real evidence
  });
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
    .map((e) => ({ seq: e.seq, text: String((e.payload as { text?: string })?.text ?? '') }))
    // Untranscribed voice segments (presence heard sound, STT produced no
    // words) count as activity but carry nothing to judge.
    .filter((u) => u.text.trim().length > 0);
  const judgments = utterances.length > 0 ? await judge(utterances, spec) : [];
  const bounds = windowBounds(events, rubric, trigger, windowEvents);
  const labels = markSensorContamination(
    markContamination(mechanicalLabels(windowEvents, judgments, bounds), windowEvents),
    events,
    bounds,
  );
  return {
    trigger,
    windowEvents,
    labels,
    trigger_occurred: true,
  };
}
