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
  // Language/library validity checks (sess-1786072934316). The candidate
  // asked eight variants of "is this valid syntax" over fourteen minutes;
  // the three shapes below all MISSED the fast path and paid a full haiku
  // round trip each, and the gate then had to decide whether a question
  // about the code in front of them was narration — exactly the call it is
  // worst at. They are now unambiguous asks, which they always were.
  /\bis (?:this|that|it) (?:valid|allowed|legal|fine|ok|okay)\b/i,
  /\b(?:valid|correct) syntax\b/i,
  /\bdo (?:i|we) (?:need|have to|still need)\b/i,
  /\b(?:just )?to clarify\b/i,
  /\bare you (?:allowed|able) to\b/i,
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

/** How long an interviewer question or directive stays "pending" — the
 *  candidate's first words inside this window are a reply, not narration.
 *  60s, down from 120s (sess-1786924315899): the incident this detector
 *  serves was a 26-second gap; a two-minute window mostly caught unrelated
 *  thinking-aloud. */
export const PENDING_QUESTION_WINDOW_MS = 60_000;

/** The fast path claims an utterance ONLY at this length or above. A pure
 *  word COUNT on purpose — no filler lexicon: a vocabulary list inside a
 *  model-bypassing detector fails OPEN for every speaker whose habits it
 *  didn't anticipate (owner decision, 2026-08-17). Shorter responses fall
 *  to the LLM gate, which sees the pending question in its context window
 *  and judges "No." vs "Um..." per speaker, not per lexicon. */
export const MIN_ANSWER_WORDS = 8;

/**
 * The candidate's FIRST utterance after an interviewer turn that asked for
 * something is addressed by construction — you do not narrate INTO a
 * question someone just asked you. Same shape as isCorrectionFollowUp, one
 * detector over.
 *
 * Why (sess-qa814-leak, +379s→+405s): the interviewer ended a turn with
 * "…go check whether the on-shift check you've been reading agrees with the
 * half-open rule I just gave you", and the candidate's next utterance was
 * the complete root cause, 26s later. A long declarative statement:
 * isExplicitAsk missed it, the LLM gate read it as narration, and the
 * diagnosis sat unanswered for 190s until the unprompted pressure lane
 * finally spoke past it.
 *
 * "Asked for something" is: kind probe/pressure (interrogative by
 * construction), a literal "?", or nudge:true — the motivating turn was a
 * DIRECTIVE (kind "answer", no question mark, nudge true), and a directive
 * invites a report-back exactly like a question. Server-emitted acks and
 * time announcements are skipped: content-free by design, they neither ask
 * nor cancel a pending question. A false positive costs one interviewer
 * call that may choose silence — the same cost model as the other two
 * detectors. Pure, clock injected.
 *
 * THE SUBSTANCE FLOOR (sess-1786924315899): this detector was dead code
 * until the skip-self fix below, so its breadth was never load-tested.
 * Live, "first words after a question" degenerated into "nearly every
 * utterance": the interviewer ends most turns with a question, each reply
 * re-armed the window, and every VAD breath — "Um...", "Oh my God.",
 * "Uh, taking modulo." — fast-pathed into a spoken reply. 26 turns, gaps
 * down to 1 second, a round-long interruption loop. The fast path now
 * claims only responses of MIN_ANSWER_WORDS or more — the guaranteed
 * class (the qa814 diagnosis was ~25 words) with fragments structurally
 * ineligible; everything shorter is the LLM gate's call, made with the
 * pending question in view.
 */
export function isAnswerToPendingQuestion(
  text: string,
  events: TraceEvent[],
  nowMs: number,
): boolean {
  if (!text.trim()) return false;
  if (text.trim().split(/\s+/).length < MIN_ANSWER_WORDS) return false;
  // The live wiring appends the utterance to the store BEFORE routing it
  // (session.ts emitUtterance), so the backward walk meets the utterance
  // under classification first. Skip it ONCE by text equality — without
  // this the detector returns false on every real utterance and the fast
  // path is dead code, which is exactly how sess-1786861469215's direct
  // answer to "walk me through why…" fell to the gate and read as
  // narration. Skipped once only: an identical OLDER utterance is still a
  // prior word since the question and correctly falls to the gate.
  let skippedSelf = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'utterance' && String((e.payload as { text?: string })?.text ?? '').trim()) {
      if (!skippedSelf && String((e.payload as { text?: string })?.text) === text) {
        skippedSelf = true;
        continue;
      }
      return false; // not the FIRST words since the question — the gate decides
    }
    if (e.type !== 'interviewer') continue;
    const p = e.payload as {
      kind?: string;
      text?: string;
      nudge?: boolean;
      governed?: boolean;
    } | null;
    if (p?.kind === 'ack' || p?.kind === 'time') continue;
    // A governed turn leaked its '?' past the question-budget order — it
    // must not open a pending window, or one leak restarts the
    // interrogation loop the governor exists to stop (2026-08-17 review).
    if (p?.governed === true) return false;
    const asked =
      p?.kind === 'probe' ||
      p?.kind === 'pressure' ||
      p?.nudge === true ||
      String(p?.text ?? '').includes('?');
    return asked && nowMs - e.ts <= PENDING_QUESTION_WINDOW_MS;
  }
  return false;
}
