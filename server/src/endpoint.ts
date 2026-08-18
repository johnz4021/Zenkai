/**
 * Speech endpointing — one routed turn per human turn, not per VAD breath.
 *
 *   voice hook: speechStarted(ts) ──► buffer (segment open: HOLD)
 *   voice hook: speechEnded(ts)   ──► buffer (silence clock anchors here)
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

/** Silence after the last VAD BOUNDARY before the turn is finished. The
 *  clock anchors on speech_start/speech_end arrival (server clock), never
 *  on transcript arrival — anchoring on transcripts stacked the STT round
 *  trip onto every wait, and let each background-noise segment restart
 *  the window at resolve time: measured live (sess-1786984222355),
 *  replies lagged 15-37s behind the candidate's words with 1-2 noise
 *  segments compounding in every gap. The browser VAD already holds ~1s
 *  before emitting speech_end, so real felt silence is about 1s more
 *  than this number. Tuned 2500 → 2000 with the anchor fix (2026-08-17). */
export const SPEECH_SETTLE_MS = 2_000;

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
  /** True once speechEnded has ever fired — the wiring provides VAD
   *  boundaries, so transcript arrival stops driving the clock. */
  private boundaryDriven = false;

  /** A VAD segment opened — the candidate is talking. Holds the flush. */
  speechStarted(ts: number): void {
    this.openSegments += 1;
    this.lastOpenTs = Math.max(this.lastOpenTs, ts);
    this.lastActivity = Math.max(this.lastActivity, ts);
  }

  /** The VAD segment closed — sound just stopped. THIS is the silence
   *  anchor: the settle window counts from here, so the STT round trip
   *  burns down inside the window instead of stacking on top of it. */
  speechEnded(ts: number): void {
    this.boundaryDriven = true;
    this.lastActivity = Math.max(this.lastActivity, ts);
  }

  /** An utterance event landed for a segment ('' = untranscribed — it
   *  closes its segment and contributes nothing to the text). A push with
   *  no matching speechStarted (e.g. a relay-side untranscribed flush
   *  after reconnect) never drives openSegments negative.
   *
   *  In boundary-driven wiring, arrival does NOT touch the clock: a noise
   *  segment resolving empty two seconds later must not restart the wait
   *  — that restart, compounded per noise burst, was the 15-37s reply lag
   *  measured live. Without boundaries (legacy/tests), arrival is the
   *  only clock there is. */
  push(text: string, ts: number): void {
    this.openSegments = Math.max(0, this.openSegments - 1);
    if (!this.boundaryDriven) this.lastActivity = Math.max(this.lastActivity, ts);
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
