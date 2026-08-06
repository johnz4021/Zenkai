/**
 * Acknowledgment turns — proof of a listener, with nothing else in them.
 *
 *   tick ──► decideAck(events, now) ──► "Mm-hm." | null
 *
 * Why (sess-1785962737985): the interviewer had exactly two states — full
 * turn or total silence — so the candidate manufactured evidence of a
 * listener by asking "can you hear me?" four times, and a third of all
 * interviewer output went to presence checks. Real interviewers emit
 * continuers; ours now does too.
 *
 * Design constraints, each load-bearing:
 * - CANNED, server-picked. A model-generated backchannel can leak; a canned
 *   one cannot say anything because it says nothing. (Vendors that shipped
 *   generated backchannels withdrew them; content-free is the entire point.)
 * - Deterministic rotation, no Math.random — replay-safe, testable.
 * - Never touches lastInterviewerTs: acks must not delay or replace
 *   substantive turns (the 'time'-turn precedent), and the pressure/stuck
 *   floor is unaffected.
 * - Stateless over the trace, like detectStuck: everything derives from
 *   events, so a restart forgets nothing.
 */

import type { TraceEvent } from '@interview-prep/shared';

export const ACK_POOL = [
  'Mm-hm.',
  "I'm with you.",
  'Keep going.',
  'Right.',
  'Following you.',
  'Still here.',
] as const;

/** Narrated utterances (with text) since the last interviewer output before
 *  an ack is warranted — fewer and it interrupts, not acknowledges. */
export const ACK_MIN_NARRATION = 3;
/** Floor between interviewer outputs of ANY kind before an ack. */
export const ACK_MIN_GAP_MS = 90_000;
/** A session is a conversation, not a metronome. */
export const ACK_SESSION_CAP = 8;

/**
 * The ack to emit right now, or null. Fires only when the candidate has
 * been narrating into silence: enough said, long enough since the
 * interviewer last made ANY sound (acks included), under the session cap,
 * and nothing already queued for a real reply.
 */
export function decideAck(
  events: TraceEvent[],
  nowMs: number,
  opts: { askPending: boolean },
): string | null {
  if (opts.askPending) return null;

  let lastInterviewerTs = -1;
  let acksSoFar = 0;
  let narratedSince = 0;
  for (const e of events) {
    if (e.type === 'interviewer') {
      lastInterviewerTs = e.ts;
      narratedSince = 0;
      if ((e.payload as { kind?: string })?.kind === 'ack') acksSoFar++;
      continue;
    }
    if (e.type === 'utterance') {
      const p = e.payload as { text?: string } | null;
      if (String(p?.text ?? '').trim()) narratedSince++;
    }
  }

  if (acksSoFar >= ACK_SESSION_CAP) return null;
  if (narratedSince < ACK_MIN_NARRATION) return null;
  if (lastInterviewerTs !== -1 && nowMs - lastInterviewerTs < ACK_MIN_GAP_MS) return null;
  return ACK_POOL[acksSoFar % ACK_POOL.length]!;
}
