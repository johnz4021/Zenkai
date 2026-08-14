/**
 * The workspace view is per-turn FRESH prompt input, so the caps are as
 * load-bearing as the content: a view that can grow unbounded is a cost
 * and latency bug, and a mega-diff is worse for the interviewer than the
 * honest "heavily rewritten" line. Pinned failure: the interviewer's only
 * view of real work was "edit file A / test run FAILED" (sess-1785962737985).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TraceEvent } from '@interview-prep/shared';
import {
  FILE_DIFF_CAP,
  SNAPSHOT_DIR,
  VIEW_CAP,
  assembleView,
  diffLines,
  latestRunView,
  renderWorkspaceView,
  selectRecentlyEdited,
  snapshotWorkspace,
} from './workspace-view.js';

const T0 = 1_700_000_000_000;
const ev = (type: TraceEvent['type'], atSec: number, payload: unknown = {}): TraceEvent => ({
  session_id: 's', user_id: 'u1', source: 'extension', seq: 0, ts: T0 + atSec * 1000, type, payload,
});

describe('diffLines', () => {
  it('a localized change renders a compact anchored hunk', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nb\nCHANGED\nd\ne';
    expect(diffLines(before, after)).toBe('@ line 3\n- c\n+ CHANGED');
  });

  it('insertions and deletions render without noise from the anchors', () => {
    expect(diffLines('a\nb\nc', 'a\nx\ny\nb\nc')).toBe('@ line 2\n+ x\n+ y');
    expect(diffLines('a\nx\nb', 'a\nb')).toBe('@ line 2\n- x');
  });

  it('identical content is an empty diff', () => {
    expect(diffLines('same\nlines', 'same\nlines')).toBe('');
  });

  it('a heavy rewrite degrades to a count line, never a mega-diff', () => {
    const before = Array.from({ length: 200 }, (_, i) => `old line ${i}`).join('\n');
    const after = Array.from({ length: 220 }, (_, i) => `new line ${i}`).join('\n');
    const d = diffLines(before, after);
    expect(d).toContain('heavily rewritten: -200/+220 lines');
    expect(d.length).toBeLessThan(FILE_DIFF_CAP);
  });
});

describe('selectRecentlyEdited', () => {
  it('most recent first, deduped, capped, saves count as edits', () => {
    const events = [
      ev('edit', 10, { path: '/p/a.py' }),
      ev('edit', 20, { path: '/p/b.py' }),
      ev('file_save', 30, { path: '/p/a.py' }),
      ev('edit', 40, { path: '/p/c.py' }),
      ev('edit', 50, { path: '/p/d.py' }),
      ev('file_open', 60, { path: '/p/e.py' }), // opens are reading, not editing
    ];
    expect(selectRecentlyEdited(events)).toEqual(['/p/d.py', '/p/c.py', '/p/a.py']);
  });
});

describe('latestRunView', () => {
  it('returns the newest COMPLETED run with its tail, skipping crashed runs', () => {
    const events = [
      ev('test_run', 10, { via: 'task', exit_code: 1, summary: 'old', output_tail: 'old tail' }),
      ev('test_run', 20, { via: 'task', exit_code: 1, summary: 'FAILED (failures=1)', output_tail: 'AssertionError: 28 != 11' }),
      ev('test_run', 30, { via: 'task', exit_code: null }),
    ];
    const run = latestRunView(events)!;
    expect(run.summary).toBe('FAILED (failures=1)');
    expect(run.tail).toContain('AssertionError');
  });

  it('null when no run has completed', () => {
    expect(latestRunView([ev('edit', 1, { path: 'x' })])).toBeNull();
  });
});

describe('assembleView', () => {
  it('renders diffs with real paths, new files as counts, plus the run', () => {
    const out = assembleView(
      [
        { relPath: 'engine.py', before: 'a\nb', after: 'a\nB' },
        { relPath: 'helper.py', before: null, after: 'x\ny\nz' },
      ],
      { summary: 'FAILED (failures=1)', tail: 'AssertionError: order mismatch' },
    );
    expect(out).toContain('── engine.py (their changes this session)');
    expect(out).toContain('+ B');
    expect(out).toContain('── helper.py (NEW this session, 3 lines)');
    expect(out).toContain('latest test run: FAILED');
    expect(out).toContain('AssertionError: order mismatch');
  });

  it('no edits and no run is said plainly', () => {
    expect(assembleView([], null)).toBe('(no edits yet this session)');
  });

  it('the total view is capped', () => {
    // Each per-file diff stays under FILE_DIFF_CAP (so it renders fully),
    // but six of them sum past the total budget.
    const base = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const changed = (n: number) =>
      Array.from({ length: 20 }, (_, i) => (i < 10 ? `edit ${n} ${'y'.repeat(40)} ${i}` : `line ${i}`)).join('\n');
    const parts = Array.from({ length: 6 }, (_, i) => ({
      relPath: `f${i}.py`, before: base, after: changed(i),
    }));
    const out = assembleView(parts, null);
    expect(out.length).toBeLessThanOrEqual(VIEW_CAP + 30);
    expect(out).toContain('…(view truncated)');
  });
});

describe('snapshot + renderWorkspaceView (fs shell)', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('diffs current files against the session-start snapshot with container paths mapped', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'wv-'));
    writeFileSync(path.join(dir, 'engine.py'), 'a\nb\nc\n');
    snapshotWorkspace(dir);
    expect(readFileSync(path.join(dir, SNAPSHOT_DIR, 'engine.py'), 'utf8')).toBe('a\nb\nc\n');
    // Candidate edits the file after the snapshot.
    writeFileSync(path.join(dir, 'engine.py'), 'a\nEDITED\nc\n');
    const events = [
      ev('edit', 10, { path: '/home/workspace/p-sess-1/engine.py' }),
      ev('test_run', 20, { via: 'task', exit_code: 1, summary: 'FAILED', output_tail: 'boom' }),
    ];
    const view = renderWorkspaceView(dir, events);
    expect(view).toContain('── engine.py');
    expect(view).toContain('- b');
    expect(view).toContain('+ EDITED');
    expect(view).toContain('latest test run: FAILED');
  });

  it('re-snapshotting overwrites — a rebuilt problem never diffs a stale baseline', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'wv-'));
    writeFileSync(path.join(dir, 'engine.py'), 'v1\n');
    snapshotWorkspace(dir);
    writeFileSync(path.join(dir, 'engine.py'), 'v2\n');
    snapshotWorkspace(dir);
    expect(readFileSync(path.join(dir, SNAPSHOT_DIR, 'engine.py'), 'utf8')).toBe('v2\n');
  });
});
