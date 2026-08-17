/**
 * Speech endpointing — one routed turn per human turn, not per VAD breath.
 *
 *   voice hook: speechStarted(ts) ──► buffer (segment open: HOLD)
 *   voice hook: push(text, ts)    ──► buffer (segment closed; text kept)
 *   session 500ms check ──► shouldFlush(now) ──► flush() ──► routeUtterance
 *
 * Why it exists (sess-1786948725100, and the 2026-08-17 architecture
 * review): routing fired per browser VAD segment, so a slow speaker's
 * clause-sized fragments each got classified — and often answered —
 * separately. Twelve interviewer turns in 5.4 minutes, ten ending in
 * questions, and the candidate quit without ever running the suite. Every
 * routing-level fix was whack-a-mole because the missing primitive was
 * turn-taking: the interviewer must speak when the human is DONE, and
 * "done" is a property of speech signals, not of transcript arrival.
 *
 * The buffer holds while any segment is open (speechStarted without its
 * matching push — every segment eventually produces exactly one utterance,
 * transcript or '' untranscribed; the relay watchdog guarantees it) and
 * flushes only after SPEECH_SETTLE_MS of full silence. Routing then sees
 * the candidate's complete thought: one intent-gate call per human turn,
 * fast paths judging whole statements, engage verdicts on finished claims.
 *
 * TRACE FIDELITY IS UNTOUCHED: utterance events still land in the trace
 * per segment, stamped at speech start, exactly as before. This module
 * only decides when ROUTING happens and what text it sees.
 *
 * Pure over injected time (detector convention — stuck.ts lineage): no
 * timers, no clock reads. The session owns the 500ms check loop.
 */

/** Silence after the last speech signal before the turn is considered
 *  finished. Tuned for a slow deliberate speaker's inter-clause pauses
 *  (~1.5-3s observed live); the cost of being generous is reply latency,
 *  the cost of being tight is barging mid-thought — and barging is the
 *  failure this module exists to kill. */
export const SPEECH_SETTLE_MS = 2_500;

/** An open segment older than this is presumed dead (browser gone
 *  mid-segment: no speech_end, no commit, no watchdog) and stops holding
 *  the flush. Generous on purpose — a single VAD segment under continuous
 *  speech rarely exceeds ~15s before a pause breaks it, and releasing a
 *  live speaker's buffer early is the barging this module kills. */
export const STALE_OPEN_MS = 30_000;

export class SpeechTurnBuffer {
  private segments: string[] = [];
  private openSegments = 0;
  private lastActivity = 0;
  private lastOpenTs = 0;

  /** A VAD segment opened — the candidate is talking. Holds the flush. */
  speechStarted(ts: number): void {
    this.openSegments += 1;
    this.lastOpenTs = Math.max(this.lastOpenTs, ts);
    this.lastActivity = Math.max(this.lastActivity, ts);
  }

  /** An utterance event landed for a segment ('' = untranscribed — it
   *  closes its segment and contributes nothing to the text). A push with
   *  no matching speechStarted (e.g. a relay-side untranscribed flush
   *  after reconnect) never drives openSegments negative. */
  push(text: string, ts: number): void {
    this.openSegments = Math.max(0, this.openSegments - 1);
    this.lastActivity = Math.max(this.lastActivity, ts);
    const t = text.trim();
    if (t) this.segments.push(t);
  }

  /** Anything worth routing at all? (Untranscribed-only turns flush to
   *  nothing and just reset.) */
  get pending(): boolean {
    return this.segments.length > 0;
  }

  shouldFlush(nowMs: number): boolean {
    if (this.segments.length === 0) return false;
    // Still talking — unless the open segment is stale enough to be a
    // corpse (see STALE_OPEN_MS).
    if (this.openSegments > 0 && nowMs - this.lastOpenTs < STALE_OPEN_MS) return false;
    return nowMs - this.lastActivity >= SPEECH_SETTLE_MS;
  }

  /** The completed human turn, segments joined in arrival order. Resets —
   *  a transcript landing after this starts the NEXT turn. */
  flush(): string {
    const turn = this.segments.join(' ');
    this.segments = [];
    return turn;
  }
}
