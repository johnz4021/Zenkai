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

  constructor(dir: string, private readonly sessionId: string, private readonly userId: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${sessionId}.jsonl`);
    for (const ev of this.readAll()) {
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
    return true;
  }

  /** The server is the emitter for chrome-originated events (backend-driven). */
  emitChrome(type: TraceEvent['type'], payload: unknown): TraceEvent {
    const ev: TraceEvent = {
      session_id: this.sessionId,
      user_id: this.userId,
      source: 'chrome',
      seq: this.chromeSeq++,
      ts: Date.now(),
      type,
      payload,
    };
    this.ingest(ev);
    return ev;
  }

  readAll(): TraceEvent[] {
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
