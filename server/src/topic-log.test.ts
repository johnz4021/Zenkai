import { mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gateConceptTopics } from './concept-topics.js';
import {
  emptyTopicLog, loadTopicLog, recordTopicLogRow, rollupTopics,
  saveTopicLog, upsertRow, validateTopicLog,
} from './topic-log.js';

let scratch: string | null = null;
const repo = (): string => {
  scratch = mkdtempSync(path.join(tmpdir(), 'topic-log-'));
  return scratch;
};
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

const row = (sid: string, ts: number, topics: string[], solved: boolean | null) =>
  ({ session_id: sid, ts, topics, solved });

describe('upsertRow', () => {
  it('replaces by session_id — rejudge is corrective, never inflationary', () => {
    let log = emptyTopicLog('t1');
    log = upsertRow(log, row('sess-1', 100, ['a_b_c'], false));
    log = upsertRow(log, row('sess-1', 200, ['a_b_c'], true));
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]!.solved).toBe(true);
  });

  it('does not mutate its input and keeps chronological order', () => {
    const log = emptyTopicLog('t1');
    const out = upsertRow(upsertRow(log, row('sess-2', 200, ['x_y_z'], null)), row('sess-1', 100, ['x_y_z'], false));
    expect(log.rows).toHaveLength(0);
    expect(out.rows.map((r) => r.session_id)).toEqual(['sess-1', 'sess-2']);
  });
});

describe('persistence', () => {
  it('round-trips atomically and leaves no tmp file behind', () => {
    const r = repo();
    const log = upsertRow(emptyTopicLog('t1'), row('sess-1', 100, ['a_b_c'], true));
    saveTopicLog(r, log);
    expect(loadTopicLog(r, 't1').rows).toHaveLength(1);
    const files = readdirSync(path.join(r, 'targets', 't1'));
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
  });

  it('missing file → empty log (a new plan, not an error)', () => {
    expect(loadTopicLog(repo(), 'nope').rows).toEqual([]);
  });

  it('corrupt JSON throws — returning empty would shadow-wipe history', () => {
    const r = repo();
    mkdirSync(path.join(r, 'targets', 't1'), { recursive: true });
    writeFileSync(path.join(r, 'targets', 't1', 'topic-log.json'), '{ torn');
    expect(() => loadTopicLog(r, 't1')).toThrow();
  });

  it('unknown schema_version throws with a migrate message', () => {
    const r = repo();
    mkdirSync(path.join(r, 'targets', 't1'), { recursive: true });
    writeFileSync(
      path.join(r, 'targets', 't1', 'topic-log.json'),
      JSON.stringify({ schema_version: 99, target_id: 't1', rows: [] }),
    );
    expect(() => loadTopicLog(r, 't1')).toThrow(/migrate/);
  });

  it('recordTopicLogRow skips empty-topic rows — no annotation, no outcome', () => {
    const r = repo();
    recordTopicLogRow(r, 't1', row('sess-1', 100, [], true));
    expect(existsSync(path.join(r, 'targets', 't1', 'topic-log.json'))).toBe(false);
  });
});

describe('validateTopicLog', () => {
  it('names each failure', () => {
    const fails = validateTopicLog({ schema_version: 1, target_id: 't1', rows: [{ session_id: '', ts: 'x', topics: null, solved: 7 }] });
    expect(fails.join('; ')).toMatch(/session_id/);
    expect(fails.join('; ')).toMatch(/ts missing/);
    expect(fails.join('; ')).toMatch(/topics missing/);
    expect(fails.join('; ')).toMatch(/solved/);
  });
});

describe('rollupTopics', () => {
  it('counts exercised and solved per frozen topic; unexercised stays zero', () => {
    const topics = gateConceptTopics(['hash_map_indexing', 'two_pointer_scans', 'api_error_contracts', 'graph_traversal']);
    let log = emptyTopicLog('t1');
    log = upsertRow(log, row('sess-1', 1, ['hash_map_indexing'], false));
    log = upsertRow(log, row('sess-2', 2, ['hash_map_indexing', 'two_pointer_scans'], true));
    const roll = rollupTopics(topics, log);
    expect(roll.find((t) => t.id === 'hash_map_indexing')).toMatchObject({ exercised: 2, solved: 1 });
    expect(roll.find((t) => t.id === 'two_pointer_scans')).toMatchObject({ exercised: 1, solved: 1 });
    expect(roll.find((t) => t.id === 'graph_traversal')).toMatchObject({ exercised: 0, solved: 0 });
  });
});
