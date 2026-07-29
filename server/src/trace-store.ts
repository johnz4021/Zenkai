/**
 * Server-side trace store: append-only JSONL per session with
 * (source, seq) dedupe — the replay from a reconnecting emitter must be
 * idempotent (T4/T6 lineage).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TraceEvent } from '@interview-prep/shared';

export class TraceStore {
  private seen = new Set<string>();
  private chromeSeq = 0;
  private readonly file: string;
  /**
   * Parsed trace, held in memory. This store is the ONLY writer (ingest is
   * the single append path; emitChrome routes through it), so the cache
   * cannot go stale. Before this, four pollers re-read and re-parsed the
   * whole file ~1.5x/second on the same event loop that proxies the IDE —
   * invisible at a few hundred events, not with a mic emitting one per
   * spoken phrase. The file stays the durable record; crash recovery is
   * unchanged (constructor replays it).
   */
  private cache: TraceEvent[] = [];

  constructor(dir: string, private readonly sessionId: string, private readonly userId: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${sessionId}.jsonl`);
    this.cache = this.readFromDisk();
    for (const ev of this.cache) {
      this.seen.add(`${ev.source}:${ev.seq}`);
      if (ev.source === 'chrome') this.chromeSeq = Math.max(this.chromeSeq, ev.seq + 1);
    }
  }

  /** Ingest an emitter event. Returns false on duplicate (already acked). */
  ingest(ev: TraceEvent): boolean {
    const key = `${ev.source}:${ev.seq}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    appendFileSync(this.file, JSON.stringify(ev) + '\n');
    this.cache.push(ev);
    return true;
  }

  /** The server is the emitter for chrome-originated events (backend-driven).
   *  `ts` override exists for voice: an utterance is stamped at SPEECH START,
   *  not at transcript arrival (the STT round trip is seconds). */
  emitChrome(type: TraceEvent['type'], payload: unknown, ts?: number): TraceEvent {
    const ev: TraceEvent = {
      session_id: this.sessionId,
      user_id: this.userId,
      source: 'chrome',
      seq: this.chromeSeq++,
      ts: ts ?? Date.now(),
      type,
      payload,
    };
    this.ingest(ev);
    return ev;
  }

  readAll(): TraceEvent[] {
    return this.cache;
  }

  private readFromDisk(): TraceEvent[] {
    if (!existsSync(this.file)) return [];
    const out: TraceEvent[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TraceEvent);
      } catch {
        /* torn tail */
      }
    }
    return out;
  }
}
