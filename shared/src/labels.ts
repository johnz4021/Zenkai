/**
 * Single source of truth for classifier label strings (eng review T13 / CQ1).
 *
 * The classifier, the labeling UI, and label storage all import from here.
 * If these drift into two definitions, the eval harness silently measures
 * nothing — that is the failure this file exists to prevent.
 *
 * v1 labels are the spec-change response set (multi-label over the window
 * that a rubric's trigger opens). They deliberately measure a NARROW proxy:
 * reaction to a change event — not scoping, prioritization, or tradeoff
 * reasoning (eng review T17 documents the limit).
 */
export const SPEC_CHANGE_LABELS = [
  /** Candidate asked an interrogative referencing a spec entity. */
  'clarifying_question',
  /** Candidate edited a notes/README/comment block stating new assumptions. */
  'assumption_update',
  /** A code edit landed before any clarifying question or assumption update. */
  'immediate_edit',
  /** Candidate ran the test suite inside the window. */
  'test_run',
  /** A pause of >= INACTIVITY_THRESHOLD_MS occurred inside the window. */
  'inactivity',
] as const;

export type SpecChangeLabel = (typeof SPEC_CHANGE_LABELS)[number];

export function isSpecChangeLabel(value: string): value is SpecChangeLabel {
  return (SPEC_CHANGE_LABELS as readonly string[]).includes(value);
}

/** A `pause` event is emitted after this much silence (operational definition). */
export const INACTIVITY_THRESHOLD_MS = 20_000;
