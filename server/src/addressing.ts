/**
 * Deterministic addressing — the fast path in front of the LLM intent gate.
 *
 *   utterance ──► isExplicitAsk / isCorrectionFollowUp ──► queue immediately
 *                        │ (no match — the ambiguous middle)
 *                        ▼
 *                  LLM intent gate (unchanged)
 *
 * Why it exists (sess-1785962737985): three unambiguous asks — "can you give
 * me a hand?", "this is what i have why is it wrong", "do you know if you
 * can use…" — were classified as narration and silently dropped; a
 * correction ("no i mean to pair the task with the result") arrived seconds
 * after a wrong answer and got four minutes of silence. The gate's cost
 * model ("a missed question costs a rephrase") is wrong for explicit asks:
 * a miss cost minutes and a channel switch to typing.
 *
 * These matchers are deliberately narrow: second-person request forms and
 * post-answer corrections only. A false positive costs one interviewer call
 * that may choose silence anyway; a false negative here falls through to
 * the LLM gate, not to the floor. Pure, no clock reads.
 */

import type { TraceEvent } from '@interview-prep/shared';

/** Unambiguous second-person requests. Anchored to request verbs so
 *  rhetorical self-questions ("why is this null?") never match. */
const ASK_PATTERNS: RegExp[] = [
  /\b(?:can|could|would|will) you\b/i,
  /\bgive me (?:a )?(?:hint|hand|second opinion|pointer)\b/i,
  /\bhelp me\b/i,
  /(?:^|[.!?]\s+)help\b/i,
  /\bhow (?:do|would|should|can) (?:i|we|you)\b/i,
  /\bwhy is (?:it|this|that|my code) (?:wrong|failing|broken)\b/i,
  /\bis (?:that|this) (?:right|correct|clear|okay|ok)\b/i,
  /\bam i (?:right|correct|on the right track|close)\b/i,
  /\bwhat(?:'s| is) the (?:right|correct) (?:way|command|approach)\b/i,
  /\bdo you know\b/i,
  /\bhow(?:'s| does) that sound\b/i,
  /\b(?:can|do) you hear me\b/i,
];

export function isExplicitAsk(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return ASK_PATTERNS.some((re) => re.test(t));
}

/** How long after an interviewer turn a correction still reads as one. */
export const CORRECTION_WINDOW_MS = 45_000;

const CORRECTION_OPENER = /^(?:no|nah|nope|not that|i mean[t]?|that's not)\b/i;

/**
 * "no i mean to pair the task with the result", seconds after the
 * interviewer answered the wrong stacked question — addressed by
 * construction: you do not correct someone who was not talking to you.
 */
export function isCorrectionFollowUp(text: string, events: TraceEvent[], nowMs: number): boolean {
  if (!CORRECTION_OPENER.test(text.trim())) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'interviewer') continue;
    return nowMs - e.ts <= CORRECTION_WINDOW_MS;
  }
  return false;
}
