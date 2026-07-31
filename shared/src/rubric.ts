/**
 * Rubric-as-data (eng review decision 8 + the RoundType collapse).
 *
 *   generate(round_type, user_context, gap_graph)
 *     └─► { repo, tests, planted_bug_location, rubric }
 *
 * The generator emits the rubric WITH the problem — it is never authored
 * by hand as a schema. One generic classifier reads it:
 *
 *   classify(trace, rubric) ─► gap instances
 *
 * What varies per round type (dsa | lld | debugging | decomp) is data,
 * not code. System design is out of scope: not IDE-native.
 */

import type { TraceEventType } from './trace.js';
import { DEFAULT_DEBUGGING_SPEC } from './round-spec.js';

export type RoundType = 'dsa' | 'lld' | 'debugging' | 'decomp';

/** What event opens a measurement window. */
export interface RubricTrigger {
  event: TraceEventType;
  /** e.g. test_run with exit_code !== 0 for debugging's "first failure". */
  predicate?: 'first_occurrence' | 'first_failure';
}

/**
 * A measurement window opens at the trigger and closes on whichever comes
 * first: the `until` event (not before `min_duration_ms`) or `duration_ms`.
 *
 * Why not a plain duration: a fixed 90s window was measured live to capture
 * only the candidate's REFLEX. A real clarifying question arrived at +272s
 * and was invisible, so the tool could not observe the behavior it exists to
 * reward. Closing on the next test run instead means the window is one
 * DEBUGGING CYCLE — failure to next attempt — which is semantically real
 * rather than an arbitrary number.
 *
 * `min_duration_ms` guards the degenerate case where someone re-runs the
 * suite seconds later just to re-read the output, which would otherwise slam
 * the window shut before anything happened.
 */
export interface RubricWindow {
  /** Hard cap. Window closes here regardless. */
  duration_ms?: number;
  /** Window will not close on `until` before this much time has passed. */
  min_duration_ms?: number;
  /** Closing event type (e.g. the next test_run = next attempt). */
  until?: TraceEventType;
}

export interface Rubric {
  round_type: RoundType;
  /** v1 fields (trigger/window/labels/expectation) — superseded by the
   *  judge design but kept optional so pre-v2 manifests still parse. */
  trigger?: RubricTrigger;
  window?: RubricWindow;
  labels?: readonly string[];
  expectation?: string;
  /**
   * v2 (judge design): per-problem expectations for the universal dimension
   * spine. Written by the GENERATOR — this is what "good" looks like on THIS
   * problem, e.g. approach: "names the stale-entry mechanism, not just 'the
   * expiry index'". Missing keys (or a missing map, for pre-v2 manifests)
   * fall back to DEFAULT_EXPECTATIONS via resolveExpectations().
   */
  dimensions?: Partial<Record<import('./dimensions.js').DimensionKey, string>>;
}

export interface GeneratedProblem {
  /**
   * v1/v2 category — superseded by `round_spec` (capabilities, not
   * categories) but kept required so every pre-spec manifest still parses
   * and memory's legacy `round_type_at` keeps its meaning.
   */
  round_type: RoundType;
  /**
   * v3 (season program): the capability-based round shape. Absent on every
   * manifest generated before it existed — resolveRoundSpec() falls back to
   * DEFAULT_DEBUGGING_SPEC, which describes exactly what those rounds were.
   */
  round_spec?: import('./round-spec.js').RoundSpec;
  /**
   * Language runtime the problem's tests need. The IDE image ships node;
   * anything else is installed into the container at session start.
   * Absent = 'node' (every problem generated before this existed).
   */
  runtime?: 'node' | 'python';
  /**
   * Command the extension's Run Tests button spawns, relative to the
   * problem root. Absent = the vitest default, so pre-existing manifests
   * keep working. A failing exit code is the round's trigger, so this
   * command MUST exit non-zero when the planted bug is present.
   */
  test_command?: string;
  /** Repo files are written by the generator agent, which self-validates. */
  repo_path: string;
  /** Declared model paths for `is_model_path` on file_save events. */
  model_paths: string[];
  /** Debugging rounds: where the planted bug lives (ground truth, free). */
  planted_bug?: {
    file: string;
    line: number;
    description: string;
    /** Exact full name of the one test the bug breaks — validator asserts it. */
    failing_test: string;
  };
  spec: string;
  /** Scripted mutation schedule — deterministic, never LLM-timed. */
  mutations: { offset_ms: number; new_spec: string }[];
  rubric: Rubric;
}

/**
 * The one way to read a problem's round shape. Session runner, validator,
 * and generator all resolve through here so a pre-spec manifest and a v3
 * manifest are indistinguishable downstream.
 */
export function resolveRoundSpec(
  problem: Pick<GeneratedProblem, 'round_spec'>,
): import('./round-spec.js').RoundSpec {
  return problem.round_spec ?? DEFAULT_DEBUGGING_SPEC;
}
