/**
 * Round spec — capabilities, not categories (CEO review 2026-07-31, decision 2).
 *
 * "Palantir learning round" and "Node HackerRank task" are not entries on a
 * format menu; they are points in a small capability space. The session
 * runner, validator, and generator all read THIS shape — the free-form label
 * is display only. The answer to "do you support format X" is a property of
 * this vocabulary, not a roadmap item.
 *
 * The fixed-ruler rule (decision 3) governs what lives here: everything in
 * this file is CLOSED vocabulary, because memory has to count over it and
 * the validator has to dispatch on it. The open-vocabulary parts of a round
 * (its label, its emphasis, its expectations) are generated per problem and
 * deliberately NOT enumerated here.
 *
 * Spec inference (an LLM drafting a RoundSpec from a candidate's description)
 * is gated by validateRoundSpec() — mechanical, in-vocabulary, no model call.
 * A draft that fails the gate is an inference failure, never a session.
 */

export interface RoundCapabilities {
  /** false = OA: nobody replies; the mic stays on (think-aloud is still judge signal). */
  interviewer: boolean;
  /** false = no-run round: the Run Tests affordance is absent entirely. */
  can_run_tests: boolean;
  /** Non-null = timed: countdown in the chrome, auto-finalize at the cap. */
  time_limit_ms: number | null;
  /** What the candidate opens to: an existing codebase, a scaffold, or a change to review. */
  starts_from: 'repo' | 'blank' | 'diff';
  /** one_shot = graded once at submit; the suite is not an iteration tool. */
  submit: 'iterate' | 'one_shot';
  /**
   * Which renderer the session page mounts — presentation, not round
   * semantics. 'panes' is the HackerRank-classic layout (statement, Monaco,
   * test panel); 'ide' is the nested VS Code workbench. Optional on purpose:
   * absent means resolveSurface() derives it from starts_from, which is
   * right for every spec written before this field existed.
   */
  surface?: 'ide' | 'panes';
}

/**
 * The mechanical passing criterion for a generated problem. The generator
 * NEVER writes its own passing criteria (decision 4) — it declares which
 * kind applies and the validator proves it. Adding a kind here means
 * teaching checkManifest to prove it; that coupling is the point.
 */
export interface CheckSpec {
  kind: 'one_failing_test' | 'all_failing' | 'all_passing' | 'diff_present';
  /** all_failing / all_passing: minimum suite size for the round to be substantive. */
  min_tests?: number;
  /** Cap on candidate-facing source files (tests excluded) — the validator
   *  counts them. The one enforceable size knob: "a single ~200-line file"
   *  is max_source_files: 1 plus blueprint prose, not prose alone. */
  max_source_files?: number;
  /** diff_present: the changed files the candidate is asked to review. */
  files_changed?: string[];
}

/**
 * What memory counts over. round labels are free-form and would fragment a
 * thin history into buckets of one; tags are the closed vocabulary that lets
 * "is my verify gap specific to timed rounds?" be a countable question.
 */
export const MEMORY_TAGS = [
  'has_existing_code',
  'from_scratch',
  'time_boxed',
  'autograded',
  'live_interviewer',
  'review',
] as const;

export type MemoryTag = (typeof MEMORY_TAGS)[number];

export interface RoundSpec {
  /** Free-form slug, display + file naming only ("palantir-learning-round"). */
  id: string;
  /** Free-form human label ("Palantir learning round"). */
  label: string;
  capabilities: RoundCapabilities;
  check: CheckSpec;
  memory_tags: MemoryTag[];
  /** Open-vocabulary generation emphasis ("likely concurrency"). */
  emphasis?: string;
  /** ISO date (YYYY-MM-DD) THIS round happens, when known. One loop's
   *  rounds fall on different days (an OA this week, the onsite in three);
   *  the queue paces each round's practice against its own date. Absent =
   *  confirmed but unscheduled — paced against the loop end, never guessed. */
  date?: string;
}

/** What every manifest written before round_spec existed resolves to. */
export const DEFAULT_DEBUGGING_SPEC: RoundSpec = {
  id: 'debugging-default',
  label: 'Debugging round',
  capabilities: {
    interviewer: true,
    can_run_tests: true,
    time_limit_ms: null,
    starts_from: 'repo',
    submit: 'iterate',
  },
  check: { kind: 'one_failing_test' },
  memory_tags: ['has_existing_code', 'live_interviewer'],
};

/**
 * Tags are DERIVED, never authored — by code from capabilities, not by the
 * inference model. One less thing an LLM can get wrong, and the tag
 * semantics stay stable no matter who wrote the spec.
 */
export function deriveMemoryTags(caps: RoundCapabilities): MemoryTag[] {
  const tags: MemoryTag[] = [];
  if (caps.starts_from === 'repo') tags.push('has_existing_code');
  if (caps.starts_from === 'blank') tags.push('from_scratch');
  if (caps.starts_from === 'diff') tags.push('review');
  if (caps.time_limit_ms !== null) tags.push('time_boxed');
  if (caps.submit === 'one_shot') tags.push('autograded');
  if (caps.interviewer) tags.push('live_interviewer');
  return tags;
}

/**
 * The single derivation point for which renderer a round gets. Explicit
 * surface wins; otherwise repo rounds get the IDE (you cannot navigate a
 * codebase in a pane editor) and blank/diff rounds get panes (a scaffold or
 * a review does not need a workbench, and the OA rounds this defaults for
 * are pane layouts in real life). Deliberately NOT a memory tag: tags count
 * practice conditions exercised, and the renderer changes presentation, not
 * what skill was drilled.
 */
export function resolveSurface(caps: RoundCapabilities): 'ide' | 'panes' {
  return caps.surface ?? (caps.starts_from === 'repo' ? 'ide' : 'panes');
}

const CHECK_KINDS = new Set(['one_failing_test', 'all_failing', 'all_passing', 'diff_present']);
const STARTS_FROM = new Set(['repo', 'blank', 'diff']);
const SUBMITS = new Set(['iterate', 'one_shot']);
const SURFACES = new Set(['ide', 'panes']);
const TAGS = new Set<string>(MEMORY_TAGS);

/**
 * Mechanical in-vocabulary gate. Runs on inference output AND on manifests,
 * so a spec that reaches a session is in-vocabulary no matter who wrote it.
 * Returns human-readable failures; empty = valid.
 */
export function validateRoundSpec(spec: unknown): string[] {
  const failures: string[] = [];
  const s = spec as Partial<RoundSpec> | null | undefined;
  if (!s || typeof s !== 'object') return ['round_spec is not an object'];

  if (typeof s.id !== 'string' || s.id.trim() === '') failures.push('id missing');
  if (typeof s.label !== 'string' || s.label.trim() === '') failures.push('label missing');

  const c = s.capabilities as Partial<RoundCapabilities> | undefined;
  if (!c || typeof c !== 'object') {
    failures.push('capabilities missing');
  } else {
    if (typeof c.interviewer !== 'boolean') failures.push('capabilities.interviewer must be boolean');
    if (typeof c.can_run_tests !== 'boolean') failures.push('capabilities.can_run_tests must be boolean');
    if (c.time_limit_ms !== null && (typeof c.time_limit_ms !== 'number' || c.time_limit_ms <= 0)) {
      failures.push('capabilities.time_limit_ms must be null or a positive number');
    }
    if (typeof c.starts_from !== 'string' || !STARTS_FROM.has(c.starts_from)) {
      failures.push(`capabilities.starts_from out of vocabulary: ${String(c.starts_from)}`);
    }
    if (typeof c.submit !== 'string' || !SUBMITS.has(c.submit)) {
      failures.push(`capabilities.submit out of vocabulary: ${String(c.submit)}`);
    }
    if (c.surface !== undefined && (typeof c.surface !== 'string' || !SURFACES.has(c.surface))) {
      failures.push(`capabilities.surface out of vocabulary: ${String(c.surface)}`);
    }
  }

  const k = s.check as Partial<CheckSpec> | undefined;
  if (!k || typeof k !== 'object') {
    failures.push('check missing');
  } else {
    if (typeof k.kind !== 'string' || !CHECK_KINDS.has(k.kind)) {
      failures.push(`check.kind out of vocabulary: ${String(k.kind)}`);
    }
    if (k.kind === 'diff_present' && (!Array.isArray(k.files_changed) || k.files_changed.length === 0)) {
      failures.push('check.kind diff_present requires non-empty files_changed');
    }
    if (k.min_tests !== undefined && (typeof k.min_tests !== 'number' || k.min_tests < 1)) {
      failures.push('check.min_tests must be a positive number when present');
    }
    if (
      k.max_source_files !== undefined &&
      (typeof k.max_source_files !== 'number' || !Number.isInteger(k.max_source_files) || k.max_source_files < 1)
    ) {
      failures.push('check.max_source_files must be a positive integer when present');
    }
  }

  if (
    s.date !== undefined &&
    (typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || Number.isNaN(Date.parse(`${s.date}T00:00:00`)))
  ) {
    failures.push(`date must be YYYY-MM-DD when present: ${String(s.date)}`);
  }

  if (!Array.isArray(s.memory_tags)) {
    failures.push('memory_tags missing');
  } else {
    for (const t of s.memory_tags) {
      if (typeof t !== 'string' || !TAGS.has(t)) failures.push(`memory_tag out of vocabulary: ${String(t)}`);
    }
  }

  // Cross-field coherence: an un-runnable suite cannot be the passing criterion.
  if (c && k && c.can_run_tests === false && (k.kind === 'one_failing_test' || k.kind === 'all_failing' || k.kind === 'all_passing')) {
    failures.push(`can_run_tests=false is incoherent with check.kind=${String(k.kind)}`);
  }
  return failures;
}
