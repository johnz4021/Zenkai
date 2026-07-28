import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listReady, markUsed, pickProblem } from './pool.js';
import { buildTargetNote, emptyStore, recordSession, buildGraphView } from './gap-graph.js';
import type { SpecChangeLabel } from '@interview-prep/shared';

function makeProblem(root: string, name: string, mtimeOffset = 0): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'problem.json'),
    JSON.stringify({ round_type: 'debugging', repo_path: '.', model_paths: [], spec: 'x', mutations: [] }),
  );
  if (mtimeOffset) {
    const f = path.join(dir, 'problem.json');
    const t = new Date(Date.now() + mtimeOffset);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:fs').utimesSync(f, t, t);
  }
  return dir;
}

describe('problem pool', () => {
  it('picks the newest unused problem', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ip-pool-'));
    makeProblem(root, 'old', -60_000);
    const newer = makeProblem(root, 'new', 0);
    expect(pickProblem(root)?.dir).toBe(newer);
  });

  it('never re-serves a used problem', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ip-pool-'));
    const only = makeProblem(root, 'only');
    markUsed(only, 's1');
    expect(pickProblem(root)).toBeNull();
    expect(listReady(root)).toHaveLength(0);
  });

  it('skips a half-written problem from a generation still in flight', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ip-pool-'));
    mkdirSync(path.join(root, 'inflight'), { recursive: true });
    writeFileSync(path.join(root, 'inflight', 'problem.json'), '{ "round_ty');
    const good = makeProblem(root, 'good');
    expect(pickProblem(root)?.dir).toBe(good);
  });

  it('reports an empty pool rather than throwing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ip-pool-'));
    expect(pickProblem(root)).toBeNull();
  });
});

describe('buildTargetNote (the memory loop)', () => {
  const session = (id: string, labels: SpecChangeLabel[]) => ({
    session_id: id,
    ts: Date.now(),
    round_type: 'debugging',
    trigger_occurred: true,
    labels_fired: labels,
  });

  it('returns undefined when nothing has been learned yet', () => {
    expect(buildTargetNote(buildGraphView(emptyStore('u1')))).toBeUndefined();
  });

  it('names the focus gap so the generator can aim at it', () => {
    let s = emptyStore('u1');
    s = recordSession(s, session('s1', ['immediate_edit']), { immediate_edit: [] });
    const note = buildTargetNote(buildGraphView(s, 's1'))!;
    expect(note).toContain('Starts editing before reading the failure');
    expect(note).toContain('LIKELY TO BE TRIGGERED');
  });

  it('marks a single session as provisional, not an established pattern', () => {
    let s = emptyStore('u1');
    s = recordSession(s, session('s1', ['inactivity']), { inactivity: [] });
    expect(buildTargetNote(buildGraphView(s, 's1'))).toContain('provisional');
  });

  it('never leaks the measurement into the generated problem', () => {
    let s = emptyStore('u1');
    s = recordSession(s, session('s1', ['immediate_edit']), { immediate_edit: [] });
    expect(buildTargetNote(buildGraphView(s, 's1'))).toContain('Do NOT mention this note');
  });
});
