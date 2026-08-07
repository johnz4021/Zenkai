/**
 * Adrift detection — when is the candidate READING the wrong thing?
 *
 *   trace ──► detectAdrift ──► AdriftState | null ──► the unprompted turn
 *                                                      closes a dead end
 *
 * The sibling stuck.ts deliberately does not have. `detectStuck` counts
 * edit→failing-run cycles, and its doc comment states outright that reading
 * "must never trip it" — correct, because interrupting a productive read
 * punishes the exact behavior the gap vocabulary rewards.
 *
 * But sess-1786072934316 found the hole that rule leaves. The candidate spent
 * fourteen minutes reading `hydrate`'s executor block while the fault sat in
 * a different function; they said "I quit" and "just give me a fucking hint";
 * and `detectStuck` fired ZERO times in thirty-five minutes, because a reader
 * never completes a cycle. Their own words afterward: "I really felt like I
 * was on the right track... the interviewer was a mix of not giving me any
 * feedback or rarely making me feel like I was on to something."
 *
 * So: adrift is grinding measured in ATTENTION rather than in edits. It is
 * the first consumer of `view_range` — the scroll sensor's whole payoff. The
 * signal is deliberately conservative, because the failure mode is severe
 * (see suppression below) and one false redirect costs more than ten missed
 * ones.
 *
 * SUPPRESSION IS PART OF THE FEATURE, not a safety bolt-on. If the region
 * they have been reading CONTAINS the answer, they are not adrift — they are
 * close, and telling them the door is shut would push them off it. The caller
 * checks `regionContains(state, bugLine)` and converts the redirect into
 * encouragement. That inversion is the direct answer to "rarely making me
 * feel like I was on to something": when they ARE on to something, the system
 * now knows.
 *
 * Pure — no I/O, no clock reads; `nowMs` and `sessionStartedAt` injected, as
 * in stuck.ts.
 */

import type { TraceEvent, ViewRangePayload } from '@interview-prep/shared';
import { isFailingRun } from '@interview-prep/shared';

/** No redirect before this much elapsed session — later than STUCK_FLOOR_MS
 *  (6 min), because reading early is exactly what a strong candidate does. */
export const ADRIFT_FLOOR_MS = 8 * 60_000;
/** The trailing window examined for confinement. */
export const ADRIFT_WINDOW_MS = 6 * 60_000;
/** They must actually be present — narrating, not away from the desk. */
export const ADRIFT_MIN_UTTERANCES = 3;

export interface AdriftState {
  /** The single file their attention was confined to (raw trace path). */
  file: string;
  /** The line span their scrolling covered, 1-indexed inclusive. Both null
   *  when the round produced no view_range events (panes surface, or a
   *  runtime without the scroll sensor) — the file alone still stands. */
  lineLow: number | null;
  lineHigh: number | null;
  /** When the confined stretch began (ms epoch). */
  since_ms: number;
  /** Transcribed utterances inside the window — the "still engaged" proof. */
  utterances: number;
}

const ATTENTION_TYPES = new Set(['file_open', 'view_range']);

function pathOf(e: TraceEvent): string | null {
  const p = e.payload as { path?: unknown } | null;
  return typeof p?.path === 'string' && p.path ? p.path : null;
}

function isPassingRun(e: TraceEvent): boolean {
  return e.type === 'test_run' && (e.payload as { exit_code?: number | null })?.exit_code === 0;
}

/**
 * Confined-and-unmoving, or null.
 *
 * Every clause is a way OUT of the state — the default is "not adrift":
 *   - before the floor
 *   - attention spread across more than one file (they are cross-referencing)
 *   - any file opened for the first time in the window (exploring)
 *   - any edit in the window (that is stuck.ts's territory, not this)
 *   - a passing run, or failing runs whose summaries differ (something moved)
 *   - fewer than ADRIFT_MIN_UTTERANCES (silent: could be reading hard, could
 *     be away — either way this is not the moment to interrupt)
 */
export function detectAdrift(
  events: TraceEvent[],
  nowMs: number,
  sessionStartedAt: number | null,
  opts: { floorMs?: number; windowMs?: number; minUtterances?: number } = {},
): AdriftState | null {
  const floorMs = opts.floorMs ?? ADRIFT_FLOOR_MS;
  const windowMs = opts.windowMs ?? ADRIFT_WINDOW_MS;
  const minUtterances = opts.minUtterances ?? ADRIFT_MIN_UTTERANCES;
  if (sessionStartedAt === null || nowMs - sessionStartedAt < floorMs) return null;

  const windowStart = nowMs - windowMs;
  // Paths seen BEFORE the window: anything outside this set that appears
  // inside it is a first open, i.e. exploration.
  const seenBefore = new Set<string>();
  for (const e of events) {
    if (e.ts >= windowStart) break;
    if (!ATTENTION_TYPES.has(e.type) && e.type !== 'file_save' && e.type !== 'edit') continue;
    const p = pathOf(e);
    if (p) seenBefore.add(p);
  }

  const window = events.filter((e) => e.ts >= windowStart);
  const files = new Set<string>();
  let lineLow: number | null = null;
  let lineHigh: number | null = null;
  let since: number | null = null;
  let utterances = 0;
  const failureSummaries = new Set<string>();

  for (const e of window) {
    if (e.type === 'edit' || e.type === 'file_save') return null; // stuck's job
    if (isPassingRun(e)) return null; // green is unambiguous progress
    if (isFailingRun(e)) {
      failureSummaries.add(String((e.payload as { summary?: unknown })?.summary ?? ''));
      continue;
    }
    if (e.type === 'utterance') {
      if (String((e.payload as { text?: string })?.text ?? '').trim()) utterances++;
      continue;
    }
    if (!ATTENTION_TYPES.has(e.type)) continue;
    const p = pathOf(e);
    if (!p) continue;
    if (!seenBefore.has(p) && !files.has(p)) {
      // First sight of this file inside the window. One such file is the
      // normal case (they moved here and settled); a second means they are
      // ranging, and the very first attention event of the session would
      // otherwise read as exploration forever.
      if (files.size > 0) return null;
    }
    files.add(p);
    if (files.size > 1) return null; // cross-referencing, not circling
    if (since === null) since = e.ts;
    if (e.type === 'view_range') {
      const vr = e.payload as ViewRangePayload | null;
      if (typeof vr?.start === 'number' && typeof vr?.end === 'number') {
        lineLow = lineLow === null ? vr.start : Math.min(lineLow, vr.start);
        lineHigh = lineHigh === null ? vr.end : Math.max(lineHigh, vr.end);
      }
    }
  }

  if (files.size !== 1 || since === null) return null;
  if (utterances < minUtterances) return null;
  // More than one DISTINCT failure summary means the suite's story changed
  // under them — something is moving even if they have not edited.
  if (failureSummaries.size > 1) return null;

  const file = [...files][0]!;
  return { file, lineLow, lineHigh, since_ms: since, utterances };
}

/**
 * Was the answer ever ON THEIR SCREEN?
 *
 * The suppression check. `bugFile`/`bugLine` come from the manifest;
 * `state.file` is a raw trace path (container-absolute or relative), so the
 * comparison is by basename — the same looseness `candidateVisitedBugFile`
 * uses, and for the same reason.
 *
 * `pad` defaults to 0 on purpose, and the reason is worth stating because it
 * cuts against the usual instinct. The scroll sensor coalesces at 25 lines
 * (extension.ts), so a recorded span understates the viewport by up to ~25
 * lines, and a "safe" pad is tempting. But replaying sess-1786072934316
 * showed what that buys: the candidate's span was 273-300 with the fault at
 * 310, and ANY pad ≥ 10 flips the verdict to warm — which would have told
 * them to keep working the very region that cost them fourteen minutes. The
 * padded version does not merely miss the redirect; it actively endorses the
 * dead end. Strict containment answers the question actually being asked.
 *
 * Still fails toward warm where we are genuinely blind: no line bounds (panes
 * surface, or a runtime without the scroll sensor) or no bug line. There, we
 * know nothing, and knowing nothing must not become a confident redirect.
 */
export function regionContainsAnswer(
  state: AdriftState,
  bugFile: string,
  bugLine: number | null | undefined,
  pad = 0,
): boolean {
  if (!bugFile) return false;
  const base = bugFile.split('/').pop() ?? bugFile;
  const theirs = state.file.split('/').pop() ?? state.file;
  if (theirs !== base) return false; // different file entirely — safe to close
  if (state.lineLow === null || state.lineHigh === null) return true; // blind: assume close
  if (typeof bugLine !== 'number') return true; // no line to compare: assume close
  return bugLine >= state.lineLow - pad && bugLine <= state.lineHigh + pad;
}

/**
 * The observation handed to the prompt.
 *
 * Names NO file and NO line numbers — describeStuck's rule, for describeStuck's
 * reason (raw paths get parroted back). The interviewer already has the focus
 * view and the candidate's own words for naming the region; what it needs from
 * here is the VERDICT that the region is spent.
 */
export function describeAdrift(s: AdriftState, nowMs: number): string {
  const mins = Math.max(1, Math.round((nowMs - s.since_ms) / 60_000));
  const span =
    s.lineLow !== null && s.lineHigh !== null && s.lineHigh - s.lineLow < 120
      ? 'one stretch of one file'
      : 'a single file';
  return (
    `They have spent the last ${mins} minute${mins === 1 ? '' : 's'} reading ${span}, ` +
    `talking as they go but changing nothing, opening nothing new, and the suite has not ` +
    `moved. That region is not where the answer is.`
  );
}

/**
 * The inverse: they are confined AND the answer is in there with them.
 *
 * Not a redirect — the opposite. Real interviewers say "keep pulling on that"
 * and it is the single most motivating thing they do.
 */
export function describeWarm(s: AdriftState, nowMs: number): string {
  const mins = Math.max(1, Math.round((nowMs - s.since_ms) / 60_000));
  return (
    `They have been reading one stretch of one file for ${mins} minute${mins === 1 ? '' : 's'} ` +
    `without changing anything, and they are in the right neighbourhood — the thing they are ` +
    `looking for is in what is on their screen. Do NOT tell them that, and do NOT point at it. ` +
    `Encourage them to keep working this region and ask what they have established here so far.`
  );
}
