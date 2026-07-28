/**
 * Classifier-grade trace envelope (eng review decision 2A + T4, T12/A5).
 *
 *   emitter (extension | chrome) ──► append-only store ──► classify(trace, rubric)
 *
 * DELIBERATELY NOT replay-grade. There is no server-side sequence, no
 * clock-offset correction, and no sub-second ambiguity handling — all of
 * that was cut in 2A when the replay UI was cut. Ordering guarantees:
 *
 *   - `seq` is monotonic PER (session_id, source). Intra-source order is exact.
 *   - Cross-source ordering uses `ts` and is treated as ~1s precision, which
 *     is sufficient for 90-second classification windows.
 *
 * `user_id` is present from day one (A5) so the append-only store never
 * needs a tenancy migration. v1 hardcodes it to a single value.
 */

export type TraceSource = 'extension' | 'chrome' | 'server';

export type TraceEventType =
  | 'edit'          // a text-document change landed (batched; order preserved)
  | 'file_open'
  | 'file_save'     // payload carries path + a model-path match flag
  | 'command'       // terminal/task command observed
  | 'test_run'      // extension-owned task: start/exit with exit code
  | 'utterance'     // typed chat message from the candidate
  | 'interviewer'   // message from the interviewer agent
  | 'spec_mutation' // scripted spec swap fired by the chrome (never LLM-timed)
  | 'pause'         // >= INACTIVITY_THRESHOLD_MS of silence (see labels.ts)
  | 'session_start'
  | 'session_end';

export interface TraceEvent<P = unknown> {
  session_id: string;
  /** Hardcoded to a single value in v1 (A5); schema-present from day one. */
  user_id: string;
  source: TraceSource;
  /** Monotonic per (session_id, source). Assigned by the emitter. */
  seq: number;
  /** Emitter wall-clock, ms epoch. Cross-source comparisons: ~1s precision. */
  ts: number;
  type: TraceEventType;
  payload: P;
}

// ---- payloads for the events the v1 classifier reads ----

export interface TestRunPayload {
  /** 'task' = extension-owned task (reliable). 'terminal' = best-effort. */
  via: 'task' | 'terminal';
  exit_code: number | null; // null = never completed
  duration_ms: number | null;
}

export interface FileSavePayload {
  path: string;
  /** True when the path matches the problem's declared model paths. */
  is_model_path: boolean;
}

export interface SpecMutationPayload {
  /** Offset from session start at which the scripted mutation fired. */
  offset_ms: number;
  diff_summary: string;
}

export interface UtterancePayload {
  text: string;
}

/**
 * A turn from the interviewer agent.
 *
 * `nudge` is the load-bearing field: true when the turn narrowed the search
 * space for the candidate. Anything the candidate does shortly after a nudge
 * was PROMPTED, not self-directed, so the classifier marks those labels
 * contaminated instead of counting them for or against them.
 */
export interface InterviewerPayload {
  text: string;
  kind: 'answer' | 'pressure' | 'probe' | 'decline' | 'silent';
  nudge: boolean;
  /** True when the turn was unprompted (a pressure beat, not a reply). */
  unprompted: boolean;
}

/**
 * Ordering helper: total order for classification. Same-source pairs use
 * exact `seq`; cross-source pairs fall back to `ts`. Cross-source events
 * within CROSS_SOURCE_AMBIGUITY_MS are "ambiguous" — callers must not
 * build an ordering claim on them (the classifier reports such pairs as
 * unordered rather than guessing; eng review 2A).
 */
export const CROSS_SOURCE_AMBIGUITY_MS = 1_000;

export type Ordering = 'before' | 'after' | 'ambiguous';

export function compareEvents(a: TraceEvent, b: TraceEvent): Ordering {
  if (a.session_id === b.session_id && a.source === b.source) {
    return a.seq < b.seq ? 'before' : 'after';
  }
  const dt = a.ts - b.ts;
  if (Math.abs(dt) < CROSS_SOURCE_AMBIGUITY_MS) return 'ambiguous';
  return dt < 0 ? 'before' : 'after';
}
