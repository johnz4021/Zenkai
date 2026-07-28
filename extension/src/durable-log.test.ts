import { describe, expect, it } from 'vitest';
import { pendingAfter } from './durable-log.js';
import type { TraceEvent } from '@interview-prep/shared';

const line = (seq: number): string =>
  JSON.stringify({
    session_id: 's',
    user_id: 'u',
    source: 'extension',
    seq,
    ts: seq,
    type: 'edit',
    payload: null,
  } satisfies TraceEvent);

describe('pendingAfter', () => {
  it('replays only events after the acked cursor', () => {
    const lines = [line(0), line(1), line(2), line(3)];
    expect(pendingAfter(lines, 1).map((e) => e.seq)).toEqual([2, 3]);
  });

  it('replays everything when nothing was acked', () => {
    expect(pendingAfter([line(0), line(1)], -1)).toHaveLength(2);
  });

  it('survives a torn tail line from a crash mid-write', () => {
    const lines = [line(0), '{"session_id":"s","seq":1,"ty'];
    expect(pendingAfter(lines, -1).map((e) => e.seq)).toEqual([0]);
  });

  it('ignores blank lines', () => {
    expect(pendingAfter([line(0), '', line(1), ''], -1)).toHaveLength(2);
  });
});
