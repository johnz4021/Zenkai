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

import type { SpecChangeLabel } from './labels.js';
import type { TraceEventType } from './trace.js';

export type RoundType = 'dsa' | 'lld' | 'debugging' | 'decomp';

/** What event opens a measurement window. */
export interface RubricTrigger {
  event: TraceEventType;
  /** e.g. test_run with exit_code !== 0 for debugging's "first failure". */
  predicate?: 'first_occurrence' | 'first_failure';
}

export interface RubricWindow {
  /** Fixed duration, or open until a closing event type fires. */
  duration_ms?: number;
  until?: TraceEventType;
}

export interface Rubric {
  round_type: RoundType;
  trigger: RubricTrigger;
  window: RubricWindow;
  /** v1: the spec-change label set. Future round types may extend this. */
  labels: readonly SpecChangeLabel[];
  /** Human-readable: what a strong candidate does in this window. */
  expectation: string;
}

export interface GeneratedProblem {
  round_type: RoundType;
  /** Repo files are written by the generator agent, which self-validates. */
  repo_path: string;
  /** Declared model paths for `is_model_path` on file_save events. */
  model_paths: string[];
  /** Debugging rounds: where the planted bug lives (ground truth, free). */
  planted_bug?: { file: string; line: number; description: string };
  spec: string;
  /** Scripted mutation schedule — deterministic, never LLM-timed. */
  mutations: { offset_ms: number; new_spec: string }[];
  rubric: Rubric;
}
