/**
 * The dimension spine — single source of truth (CEO review 2026-07-30).
 *
 * Six UNIVERSAL dimensions, authored once, never changing. They are what the
 * memory layer counts, so they must be stable across every session and every
 * round type — a per-round-type vocabulary would fragment a thin history
 * (~15 sessions / 3 round types = 5 each, under the 3-session pattern
 * threshold). Industry rubrics converge on this set; what differs per round
 * is the EVIDENCE bar, which the generator writes per problem
 * (rubric.dimensions) and the judge applies.
 *
 * Same discipline labels.ts had: if these drift into two definitions, the
 * eval gauntlet silently measures nothing. The judge prompt, the gap graph,
 * the feedback card, and the gauntlet all import from here.
 */

export const DIMENSIONS = [
  'clarify',
  'approach',
  'communicate',
  'implement',
  'verify',
  'reflect',
] as const;

export type DimensionKey = (typeof DIMENSIONS)[number];

export function isDimensionKey(v: string): v is DimensionKey {
  return (DIMENSIONS as readonly string[]).includes(v);
}

/**
 * Verdict scale. Graph semantics (locked in review):
 *   weak         → fires a gap instance
 *   adequate     → counts toward a remediation streak
 *   strong       → streak + surfaced as positive credit on the card
 *   unassessable → the session gave this dimension nothing to observe;
 *                  neither advances nor resets a streak. NEVER a punishment.
 */
export const VERDICTS = ['strong', 'adequate', 'weak', 'unassessable'] as const;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(v: string): v is Verdict {
  return (VERDICTS as readonly string[]).includes(v);
}

export interface DimensionDef {
  key: DimensionKey;
  /** What the dimension asks, in one line. */
  question: string;
  /** Scoring anchors — codex's "vague buckets" mitigation. Generic; the
   *  per-problem bar comes from rubric.dimensions. */
  strong: string;
  weak: string;
  /** When to mark unassessable rather than guessing. */
  unassessable_when: string;
}

export const DIMENSION_DEFS: Record<DimensionKey, DimensionDef> = {
  clarify: {
    key: 'clarify',
    question: 'Did they resolve ambiguity before committing to a direction?',
    strong:
      'Read the available material (failure output, spec, tests) and asked questions that resolve genuine ambiguity — referencing specific entities or behaviors — before acting on assumptions.',
    weak:
      'Acted on an unstated assumption that the available material contradicted or left open, or asked nothing while visibly guessing.',
    unassessable_when:
      'The problem presented no real ambiguity, or the session ended before any direction was committed to.',
  },
  approach: {
    key: 'approach',
    question: 'Did they state a plan, hypothesis, or tradeoff before executing it?',
    strong:
      'Named a MECHANISM or plan specific enough to be wrong — "the sweep releases the original count, not the remaining" — before touching code.',
    weak:
      'Jumped to execution with no stated plan, or named only a LOCATION ("something in the expiry file") or a vague intent ("let me poke around").',
    unassessable_when: 'The session ended before any non-trivial decision point was reached.',
  },
  communicate: {
    key: 'communicate',
    question: 'Could an interviewer follow their thinking as it happened?',
    strong:
      'Narrated reasoning while working — what they were reading, suspecting, trying — such that the transcript alone explains their path.',
    weak:
      'Long working stretches with no narration; the interviewer would have had to interrupt to know where they were.',
    unassessable_when:
      'Speech evidence was unreliable for most of the session (see reliability annotations) — absence of narration proves nothing then.',
  },
  implement: {
    key: 'implement',
    question: 'Did the execution match the stated approach, competently?',
    strong:
      'Changes were coherent with the stated plan, appropriately scoped, and adjusted sensibly when reality pushed back.',
    weak:
      'Thrashing: scattered edits unconnected to any stated idea, repeated undo/redo of the same ground, or changes that contradict their own plan without comment.',
    unassessable_when: 'They never reached implementation.',
  },
  verify: {
    key: 'verify',
    question: 'Did they check their work before trusting it?',
    strong:
      'Re-ran tests / traced the fix against the failing case / checked edge cases BEFORE declaring or moving on; treated a green run as the finish line, not the fix itself.',
    weak: 'Declared success or stopped after changing code without any verification step.',
    unassessable_when:
      'The session ended mid-implementation, before there was anything to verify.',
  },
  reflect: {
    key: 'reflect',
    question: 'Could they explain what they did and why it worked (or did not)?',
    strong:
      'Articulated the root cause and why the fix addresses it — not just "the test passes now".',
    weak:
      'Could not or did not connect the fix to the failure mechanism; treated the outcome as magic.',
    unassessable_when: 'No resolution point was reached and nobody asked.',
  },
};

/**
 * Round-type DEFAULT expectations — the backward-compat fallback for
 * manifests that predate rubric v2 (the two pooled problems), and the
 * baseline the generator specializes from. Per-problem expectations from
 * the generator ALWAYS win; these are the floor, not the bar.
 */
export const DEFAULT_EXPECTATIONS: Record<string, Partial<Record<DimensionKey, string>>> = {
  debugging: {
    clarify:
      'Reads the failing test output and the failing test body before editing source; asks about intended behavior where the spec is ambiguous.',
    approach:
      'States a hypothesis about the MECHANISM of the failure (what the code does wrong, not merely which file) before changing code.',
    communicate:
      'Narrates the investigation: what the failure says, what is suspected, what each change is meant to prove.',
    implement:
      'Makes targeted changes that test the stated hypothesis; instruments (prints/reads state) rather than guessing when stuck.',
    verify: 'Re-runs the suite after the fix and confirms the previously-failing test passes and nothing else broke.',
    reflect: 'Explains the root cause and why the fix addresses it.',
  },
  dsa: {
    clarify: 'Establishes input constraints, edge cases, and expected complexity before designing.',
    approach:
      'States the algorithmic approach and its complexity BEFORE writing code, including why it beats the naive alternative.',
    communicate: 'Talks through the algorithm while implementing it.',
    implement: 'Implementation follows the stated algorithm; deviations are called out.',
    verify: 'Dry-runs the solution on an example and at least one edge case before declaring done.',
    reflect: 'Can restate the complexity and where the approach would break.',
  },
  lld: {
    clarify: 'Surfaces requirements and constraints that change the design before committing to interfaces.',
    approach: 'Names the tradeoff being accepted (and what was given up) when choosing a structure.',
    communicate: 'Explains interface and structure decisions as they are made.',
    implement: 'Code structure matches the stated design.',
    verify: 'Walks a concrete usage scenario through the design before declaring it complete.',
    reflect: 'Can defend the design against an alternative.',
  },
  decomp: {
    clarify: 'Interrogates the problem statement for hidden requirements before decomposing.',
    approach: 'Decomposes into parts with explicit interfaces and an explicit sequencing rationale.',
    communicate: 'The decomposition is narrated, not silently drawn.',
    implement: 'Work proceeds along the stated decomposition.',
    verify: 'Checks the decomposition against at least one awkward requirement.',
    reflect: 'Can explain which piece is riskiest and why.',
  },
};

/**
 * Resolve the expectations the judge will apply: per-problem (generator)
 * where present, round-type defaults for anything missing.
 */
export function resolveExpectations(
  roundType: string,
  fromManifest?: Partial<Record<DimensionKey, string>>,
): Record<DimensionKey, string> {
  const defaults = DEFAULT_EXPECTATIONS[roundType] ?? DEFAULT_EXPECTATIONS['debugging']!;
  const out = {} as Record<DimensionKey, string>;
  for (const key of DIMENSIONS) {
    out[key] =
      fromManifest?.[key] ??
      defaults[key] ??
      DIMENSION_DEFS[key].strong; // last-resort generic anchor
  }
  return out;
}
