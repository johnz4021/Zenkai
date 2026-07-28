/**
 * Durable trace emitter (eng review T4 / decision 2A).
 *
 *   emit() ──► append-only JSONL on local disk  (the durable write)
 *          └─► WebSocket ship ──► server ack ──► cursor file advances
 *
 * On disconnect, events keep landing in the file. On (re)connect we replay
 * everything after the acked cursor. Container death loses at most the
 * unflushed tail — acceptable at classifier grade (2A), stated rather than
 * pretended away.
 *
 * vscode-free on purpose: the replay/cursor logic is unit-testable.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { TraceEvent, TraceEventType, TraceSource } from '@interview-prep/shared';

/** Pure: which logged lines still need shipping, given the acked cursor. */
export function pendingAfter(lines: string[], ackedSeq: number): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as TraceEvent;
      if (ev.seq > ackedSeq) out.push(ev);
    } catch {
      // A torn tail line (crash mid-write) is expected; skip it.
    }
  }
  return out;
}

export interface EmitterOptions {
  dir: string;
  sessionId: string;
  userId: string;
  source: TraceSource;
  wsUrl: string;
  reconnectMs?: number;
}

export class DurableEmitter {
  private seq = 0;
  private acked = -1;
  private ws: WebSocket | null = null;
  private closed = false;
  private readonly logFile: string;
  private readonly cursorFile: string;

  constructor(private readonly opts: EmitterOptions) {
    mkdirSync(opts.dir, { recursive: true });
    this.logFile = path.join(opts.dir, `${opts.sessionId}.${opts.source}.jsonl`);
    this.cursorFile = this.logFile + '.cursor';
    if (existsSync(this.cursorFile)) {
      this.acked = Number(readFileSync(this.cursorFile, 'utf8')) || -1;
    }
    if (existsSync(this.logFile)) {
      // Resume seq numbering after a restart mid-session.
      const lines = readFileSync(this.logFile, 'utf8').split('\n');
      for (const ev of pendingAfter(lines, -1)) this.seq = Math.max(this.seq, ev.seq + 1);
    }
    this.connect();
  }

  emit(type: TraceEventType, payload: unknown): TraceEvent {
    const ev: TraceEvent = {
      session_id: this.opts.sessionId,
      user_id: this.opts.userId,
      source: this.opts.source,
      seq: this.seq++,
      ts: Date.now(),
      type,
      payload,
    };
    // Durable write FIRST; transport is best-effort on top.
    appendFileSync(this.logFile, JSON.stringify(ev) + '\n');
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(ev));
    }
    return ev;
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.opts.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      // Replay everything the server hasn't acked.
      const lines = existsSync(this.logFile)
        ? readFileSync(this.logFile, 'utf8').split('\n')
        : [];
      for (const ev of pendingAfter(lines, this.acked)) ws.send(JSON.stringify(ev));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { ack?: { seq: number } };
        if (msg.ack && msg.ack.seq > this.acked) {
          this.acked = msg.ack.seq;
          writeFileSync(this.cursorFile, String(this.acked));
        }
      } catch {
        /* ignore malformed acks */
      }
    });
    const retry = () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), this.opts.reconnectMs ?? 2000);
    };
    ws.on('close', retry);
    ws.on('error', () => ws.close());
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
