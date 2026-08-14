/**
 * Regression: QA 2026-08-14 (sess-1786690563027) — a judge failure writes an
 * `unassessed` stub into assessments/, and reconcileWithDisk flipped the
 * queue item to done off mere file existence. An unassessed round was never
 * judged; the item must stay ready so it can be re-run or rejudged.
 * Report: .gstack/qa-reports/qa-report-interview-prep-2026-08-14.md
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Target } from './intake.js';
import { proposeQueue, reconcileWithDisk } from './queue.js';

const NOW = Date.parse('2026-08-10T12:00:00');
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const scratch = () => {
  const r = mkdtempSync(path.join(tmpdir(), 'queue-unassessed-'));
  roots.push(r);
  return r;
};

const target = (): Target =>
  ({
    id: 't1',
    label: 'T1',
    description: '',
    interview_date: '2026-08-15',
    created: new Date(NOW).toISOString(),
    specs: [
      {
        id: 's1',
        label: 'S1',
        capabilities: { interviewer: true, can_run_tests: true, time_limit_ms: null, starts_from: 'repo', submit: 'iterate' },
      },
    ],
  } as unknown as Target);

describe('reconcileWithDisk — unassessed stubs never complete an item', () => {
  it('keeps the item ready when the assessment says unassessed, done once assessed', () => {
    const root = scratch();
    const pdir = path.join(root, 'targets', 't1', 'problems', 'item-1');
    mkdirSync(pdir, { recursive: true });
    mkdirSync(path.join(root, 'assessments'), { recursive: true });

    let q = proposeQueue(target(), NOW);
    q.items[0]!.status = 'generating';
    q.items[0]!.problem_dir = pdir;
    writeFileSync(path.join(pdir, '.validated'), 'now');
    writeFileSync(path.join(pdir, '.used'), 'sess-stub\n2026-08-14');

    writeFileSync(
      path.join(root, 'assessments', 'sess-stub.json'),
      JSON.stringify({ session_id: 'sess-stub', status: 'unassessed', reason: 'judge call failed: 401' }),
    );
    q = reconcileWithDisk(root, q);
    expect(q.items[0]!.session_id).toBe('sess-stub');
    expect(q.items[0]!.status).toBe('ready');

    writeFileSync(
      path.join(root, 'assessments', 'sess-stub.json'),
      JSON.stringify({ session_id: 'sess-stub', status: 'assessed' }),
    );
    expect(reconcileWithDisk(root, q).items[0]!.status).toBe('done');
  });

  it('an unreadable assessment file proves nothing', () => {
    const root = scratch();
    const pdir = path.join(root, 'targets', 't1', 'problems', 'item-1');
    mkdirSync(pdir, { recursive: true });
    mkdirSync(path.join(root, 'assessments'), { recursive: true });

    let q = proposeQueue(target(), NOW);
    q.items[0]!.status = 'generating';
    q.items[0]!.problem_dir = pdir;
    writeFileSync(path.join(pdir, '.validated'), 'now');
    writeFileSync(path.join(pdir, '.used'), 'sess-corrupt\n2026-08-14');
    writeFileSync(path.join(root, 'assessments', 'sess-corrupt.json'), 'not-json{');

    expect(reconcileWithDisk(root, q).items[0]!.status).toBe('ready');
  });
});
