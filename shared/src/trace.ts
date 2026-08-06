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
  | 'pause'         // LEGACY: extension-emitted verdict; readable, ignored
  | 'sensor'        // voice sensor state change (see SensorPayload)
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
  /** 'task' = extension-owned task (reliable). 'terminal' = best-effort.
   *  'panes' = the panes surface's server-side run route. 'submit' = the
   *  one-shot grading run in finalize() — emitted untyped since one-shot
   *  shipped; declared here so readers stop learning about it by surprise. */
  via: 'task' | 'terminal' | 'panes' | 'submit';
  exit_code: number | null; // null = never completed
  duration_ms: number | null;
  /** One line of the run's tail ("Tests 1 failed | 15 passed", or python's
   *  "Ran 15 tests — FAILED (failures=1)"). The extension has always emitted
   *  it; declaring it lets the stuck detector read outcomes without casting.
   *  Per-test NAMES are not available — only this summary line. */
  summary?: string;
  /** Present instead of a summary when the runner failed to spawn. */
  error?: string;
}

export interface FileSavePayload {
  path: string;
  /** True when the path matches the problem's declared model paths. */
  is_model_path: boolean;
}

/** Emitted per document on a 1s coalescing window (extension.ts). */
export interface EditPayload {
  path: string;
  changes: number;
}

export interface FileOpenPayload {
  path: string;
}

export interface SpecMutationPayload {
  /** Offset from session start at which the scripted mutation fired. */
  offset_ms: number;
  diff_summary: string;
}

export interface UtterancePayload {
  text: string;
  /** How the words arrived. Absent = typed (pre-voice traces). */
  via?: 'text' | 'voice';
  /**
   * Voice only: when the SPEECH began, not when the transcript arrived.
   * The event's `ts` is set to this. A transcript lands seconds after the
   * words were spoken; stamping at arrival would shift every utterance by
   * the STT round trip and corrupt gap arithmetic in a system whose central
   * label is a 20s gap threshold (outside-voice finding, eng review).
   */
  speech_start_ts?: number;
}

/**
 * Voice sensor state change, emitted by the server into the trace.
 *
 * TWO sensors, deliberately independent (eng review tension 1):
 *   - `presence`: browser-local energy gate. Knows THAT you were speaking.
 *   - `stt`: the paid transcription path. Knows WHAT you said.
 *
 * The split is what keeps a dead transcript from excusing genuine silence:
 * presence-alive + stt-dead still disproves "went quiet", so inactivity
 * stays trustworthy while content labels (clarifying_question, ...) are
 * marked contaminated. Presence-dead contaminates both.
 */
export interface SensorPayload {
  /** 'terminal' reports whether shell-integration observation is available
   *  in this runtime — emitted once at activation when it is not. */
  sensor: 'presence' | 'stt' | 'terminal';
  state: 'up' | 'down';
  reason: string;
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
  /** 'ack' = canned server-emitted continuer ("Mm-hm.") — content-free by
   *  construction, filtered out of the judge timeline. 'time' = the
   *  server's countdown/cap announcements (emitted untyped since timed
   *  rounds shipped; legalized here). Everything else is the model. */
  kind: 'answer' | 'pressure' | 'probe' | 'decline' | 'silent' | 'ack' | 'time';
  nudge: boolean;
  /** True when the turn was unprompted (a pressure beat, not a reply). */
  unprompted: boolean;
}

/**
 * The debugging trigger predicate, defined ONCE. session.ts (trigger-armed
 * status) and the classifier (findTrigger) both consumed their own copy of
 * this until they drifted into review as a DRY finding. A null exit_code
 * means the run never completed — that is "unknown", not "failed".
 */
export function isFailingRun(e: TraceEvent): boolean {
  if (e.type !== 'test_run') return false;
  const code = (e.payload as TestRunPayload | null)?.exit_code;
  return code !== 0 && code != null;
}

/**
 * Event types that count as CANDIDATE activity for inactivity computation.
 * The interviewer speaking is not the candidate doing something; neither are
 * scripted mutations or session bookkeeping. `pause` is deliberately absent:
 * it was the extension's own silence VERDICT (keystrokes-only, so narrating
 * out loud — and even typing into the chat panel — scored as inactivity).
 * The server now derives silence from gaps in THIS list across all sources;
 * old traces containing `pause` events remain readable and simply ignored.
 */
export const CANDIDATE_ACTIVITY_TYPES: readonly TraceEventType[] = [
  'edit',
  'file_open',
  'file_save',
  'command',
  'test_run',
  'utterance',
];

export function isCandidateActivity(e: TraceEvent): boolean {
  return (CANDIDATE_ACTIVITY_TYPES as readonly string[]).includes(e.type);
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
