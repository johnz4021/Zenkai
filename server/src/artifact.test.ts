/**
 * Artifact durability, proven against real files (tar is the implementation,
 * so a mocked fs would prove nothing). The rows that matter: a restore must
 * return the tree byte-for-byte while leaving the run history (`.used`,
 * `.runs.jsonl`, `.validated`, `.failed`) untouched — the rep-set67388
 * incident (TODOS #48) was exactly a re-run inheriting a dirty workspace —
 * and archiving must REFUSE on a consumed dir, because freezing a
 * candidate's edits as "pristine" is unrecoverable.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendRun,
  backfillRunFromUsed,
  dirRanSession,
  hasUsableSnapshot,
  makePristineArchive,
  preserveRunTree,
  pristineArchivePath,
  readRuns,
  restorability,
  restoreFromSnapshot,
  restorePristine,
  runsDirPath,
} from './artifact.js';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'ip-artifact-'));
  roots.push(d);
  return d;
};

const SOLUTION = 'def solve(xs):\n    return sorted(xs)[0]  # planted: should be max\n';
const TEST_X = 'from solution import solve\n\ndef test_solve():\n    assert solve([1, 9]) == 9\n';
const PROBLEM_JSON = `${JSON.stringify({ id: 'rep-x', title: 'Smallest wins', bug: 'sorted()[0]' }, null, 2)}\n`;
const PROBLEM_MD = '# Smallest wins\n\nFix the planted bug.\n';

/** A validated-looking problem dir: source, a test, the manifest, the brief. */
function makeProblemDir(root: string, name = 'problem'): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  writeFileSync(path.join(dir, 'solution.py'), SOLUTION);
  writeFileSync(path.join(dir, 'tests', 'test_x.py'), TEST_X);
  writeFileSync(path.join(dir, 'problem.json'), PROBLEM_JSON);
  writeFileSync(path.join(dir, 'PROBLEM.md'), PROBLEM_MD);
  return dir;
}

const USED_TWO_LINE = 'sess-a1b2\n2026-01-01T00:00:00Z\n';

/** The four survivors, written exactly as the runtime writes them. */
function writeMarkers(dir: string, used = USED_TWO_LINE): void {
  writeFileSync(path.join(dir, '.used'), used);
  writeFileSync(path.join(dir, '.validated'), '');
  writeFileSync(path.join(dir, '.failed'), 'stale failure note\n');
  writeFileSync(
    path.join(dir, '.runs.jsonl'),
    `${JSON.stringify({ session_id: 'sess-a1b2', user_id: 'u1', at: '2026-01-01T00:00:00Z' })}\n`,
  );
}

const read = (...p: string[]): string => readFileSync(path.join(...p), 'utf8');

describe('pristine archive → dirty tree → restore', () => {
  it('restores byte-equal sources and drops session leftovers, keeping every marker', () => {
    const dir = makeProblemDir(scratch());

    expect(makePristineArchive(dir)).toEqual({ ok: true });
    expect(existsSync(`${dir}.pristine.tar.gz`)).toBe(true);
    expect(pristineArchivePath(dir)).toBe(`${dir}.pristine.tar.gz`);

    // A session happens: edits, a deliverable, tampering, caches, markers.
    writeFileSync(path.join(dir, 'solution.py'), 'def solve(xs):\n    return max(xs)\n');
    writeFileSync(path.join(dir, 'REVIEW.md'), '# my review\n');
    writeFileSync(path.join(dir, 'problem.json'), '{"id":"rep-x","bug":"none lol"}\n');
    mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n');
    writeFileSync(path.join(dir, '.linux-deps-ok'), '');
    writeMarkers(dir);

    restorePristine(dir);

    expect(read(dir, 'solution.py')).toBe(SOLUTION);
    expect(read(dir, 'problem.json')).toBe(PROBLEM_JSON);
    expect(read(dir, 'tests', 'test_x.py')).toBe(TEST_X);
    expect(read(dir, 'PROBLEM.md')).toBe(PROBLEM_MD);

    expect(existsSync(path.join(dir, 'REVIEW.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(dir, '.linux-deps-ok'))).toBe(false);

    // History is not the problem: it survives verbatim.
    expect(read(dir, '.used')).toBe(USED_TWO_LINE);
    expect(read(dir, '.validated')).toBe('');
    expect(read(dir, '.failed')).toBe('stale failure note\n');
    expect(readRuns(dir).map((r) => r.session_id)).toEqual(['sess-a1b2']);
  });

  it('throws rather than launching on a half-wiped tree when the archive is missing', () => {
    const dir = makeProblemDir(scratch());
    expect(() => restorePristine(dir)).toThrow(/no pristine archive/);
    expect(read(dir, 'solution.py')).toBe(SOLUTION); // nothing was wiped
  });
});

describe('makePristineArchive refusals', () => {
  it('refuses a consumed dir — freezing candidate edits as pristine is unrecoverable', () => {
    const dir = makeProblemDir(scratch());
    writeFileSync(path.join(dir, '.used'), USED_TWO_LINE);

    const r = makePristineArchive(dir);
    expect(r.ok).toBe(false);
    expect(r.skipped).toContain('consumed');
    expect(existsSync(pristineArchivePath(dir))).toBe(false);
  });

  it('refuses when the archive already exists (re-validation is idempotent)', () => {
    const dir = makeProblemDir(scratch());
    expect(makePristineArchive(dir).ok).toBe(true);

    const r = makePristineArchive(dir);
    expect(r.ok).toBe(false);
    expect(r.skipped).toContain('already exists');
  });

  it('force overrides both refusals (the snapshot self-heal path)', () => {
    const consumed = makeProblemDir(scratch(), 'consumed');
    writeFileSync(path.join(consumed, '.used'), USED_TWO_LINE);
    expect(makePristineArchive(consumed, { force: true })).toEqual({ ok: true });
    expect(existsSync(pristineArchivePath(consumed))).toBe(true);

    const existing = makeProblemDir(scratch(), 'existing');
    expect(makePristineArchive(existing).ok).toBe(true);
    expect(makePristineArchive(existing, { force: true })).toEqual({ ok: true });
  });
});

describe('the run ledger', () => {
  const entry = (session_id: string, at: string) => ({ session_id, user_id: 'u1', at });

  it('roundtrips entries in append order', () => {
    const dir = makeProblemDir(scratch());
    appendRun(dir, entry('sess-one', '2026-01-01T00:00:00Z'));
    appendRun(dir, entry('sess-two', '2026-02-02T00:00:00Z'));

    expect(readRuns(dir)).toEqual([
      entry('sess-one', '2026-01-01T00:00:00Z'),
      entry('sess-two', '2026-02-02T00:00:00Z'),
    ]);
  });

  it('reads a missing ledger as empty, not an error', () => {
    expect(readRuns(makeProblemDir(scratch()))).toEqual([]);
  });

  it('skips a torn last line and keeps the rows that parsed', () => {
    const dir = makeProblemDir(scratch());
    appendRun(dir, entry('sess-one', '2026-01-01T00:00:00Z'));
    writeFileSync(path.join(dir, '.runs.jsonl'), '{"session_id":"sess-torn"', { flag: 'a' });

    expect(readRuns(dir).map((r) => r.session_id)).toEqual(['sess-one']);
  });
});

describe('dirRanSession — rejudge resolving a dir', () => {
  it('matches the .used first line of the two-line marker', () => {
    const dir = makeProblemDir(scratch());
    writeFileSync(path.join(dir, '.used'), USED_TWO_LINE);
    expect(dirRanSession(dir, 'sess-a1b2')).toBe(true);
  });

  it('still finds an earlier session after .used was overwritten by a repeat', () => {
    const dir = makeProblemDir(scratch());
    appendRun(dir, { session_id: 'sess-first', user_id: 'u1', at: '2026-01-01T00:00:00Z' });
    appendRun(dir, { session_id: 'sess-second', user_id: 'u1', at: '2026-02-02T00:00:00Z' });
    writeFileSync(path.join(dir, '.used'), 'sess-second\n2026-02-02T00:00:00Z\n');

    expect(dirRanSession(dir, 'sess-second')).toBe(true);
    expect(dirRanSession(dir, 'sess-first')).toBe(true); // ledger-only, the whole point
    expect(dirRanSession(dir, 'sess-never')).toBe(false);
  });

  it('tolerates the lc-verify sentinel in .used', () => {
    const dir = makeProblemDir(scratch());
    writeFileSync(path.join(dir, '.used'), 'lc-verify\n');
    expect(dirRanSession(dir, 'sess-real')).toBe(false);
    expect(dirRanSession(dir, 'lc-verify')).toBe(true);
  });
});

describe('restoreFromSnapshot — the pre-archive fallback', () => {
  it('restores snapshot bytes, keeps problem.json + markers, and self-heals the archive', () => {
    const dir = makeProblemDir(scratch());
    rmSync(path.join(dir, 'tests'), { recursive: true, force: true });

    // The snapshot machinery captures workspace files only: no dotfiles, no problem.json.
    const snap = path.join(dir, '.session-snapshot');
    mkdirSync(snap, { recursive: true });
    writeFileSync(path.join(snap, 'solution.py'), SOLUTION);
    writeFileSync(path.join(snap, 'PROBLEM.md'), PROBLEM_MD);

    // Working tree as a finished session left it.
    const TAMPERED = '{"id":"rep-x","bug":"none lol"}\n';
    writeFileSync(path.join(dir, 'solution.py'), 'def solve(xs):\n    return max(xs)\n');
    writeFileSync(path.join(dir, 'extra.py'), 'scratch = 1\n');
    writeFileSync(path.join(dir, 'problem.json'), TAMPERED);
    writeFileSync(path.join(dir, '.used'), USED_TWO_LINE);

    restoreFromSnapshot(dir);

    expect(read(dir, 'solution.py')).toBe(SOLUTION);
    expect(read(dir, 'PROBLEM.md')).toBe(PROBLEM_MD);
    expect(existsSync(path.join(dir, 'extra.py'))).toBe(false);
    // problem.json comes from the working tree — this path cannot repair tampering.
    expect(read(dir, 'problem.json')).toBe(TAMPERED);
    expect(existsSync(path.join(dir, '.session-snapshot'))).toBe(false);
    expect(read(dir, '.used')).toBe(USED_TWO_LINE);
    expect(existsSync(pristineArchivePath(dir))).toBe(true); // next repeat takes the fast path
  });

  it('throws when there is no snapshot to fall back to', () => {
    const dir = makeProblemDir(scratch());
    expect(() => restoreFromSnapshot(dir)).toThrow(/session-snapshot/);
  });
});

describe('restorability', () => {
  it('prefers pristine, falls back to snapshot, else null', () => {
    expect(restorability({ hasPristine: true, hasSnapshot: true })).toBe('pristine');
    expect(restorability({ hasPristine: true, hasSnapshot: false })).toBe('pristine');
    expect(restorability({ hasPristine: false, hasSnapshot: true })).toBe('snapshot');
    expect(restorability({ hasPristine: false, hasSnapshot: false })).toBe(null);
  });
});

describe('preserveRunTree', () => {
  it('tars the working tree to the sibling runs dir, without node_modules', () => {
    const dir = makeProblemDir(scratch());
    writeFileSync(path.join(dir, 'REVIEW.md'), '# my review\n');
    writeMarkers(dir);
    mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n');

    expect(preserveRunTree(dir, 'sess-a1b2')).toEqual({ ok: true });

    const tarball = path.join(runsDirPath(dir), 'sess-a1b2.tar.gz');
    expect(runsDirPath(dir)).toBe(`${dir}.runs`);
    expect(existsSync(tarball)).toBe(true);

    const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    expect(listed.status).toBe(0);
    const names = listed.stdout.split('\n').filter(Boolean).map((n) => n.replace(/^\.\//, ''));
    expect(names).toContain('REVIEW.md');
    expect(names).toContain('solution.py');
    expect(names).toContain('.used'); // the candidate's run, provenance included
    expect(names.some((n) => n.startsWith('node_modules'))).toBe(false);
  });
});

describe('backfillRunFromUsed — a pre-ledger session keeps its provenance', () => {
  // Regression: QA 2026-08-14 repeated rep-e2e52324 (consumed long before the
  // ledger existed) and `rejudge sess-qa813-lc1` then reported "no problem
  // found" — the repeat overwrote the ONLY record binding that session to its
  // dir, which is exactly the loss TODOS #48 was closed to prevent.
  it('banks the outgoing sid before .used is overwritten', () => {
    const dir = makeProblemDir(scratch());
    writeFileSync(path.join(dir, '.used'), 'sess-original\n2026-08-13T04:05:06.000Z\n');

    backfillRunFromUsed(dir); // what onReady now does before markUsed
    writeFileSync(path.join(dir, '.used'), 'sess-repeat\n2026-08-14T00:00:00.000Z\n');
    appendRun(dir, { session_id: 'sess-repeat', user_id: 'u1', at: '2026-08-14T00:00:00.000Z' });

    expect(dirRanSession(dir, 'sess-original')).toBe(true);
    expect(dirRanSession(dir, 'sess-repeat')).toBe(true);
    const banked = readRuns(dir).find((r) => r.session_id === 'sess-original');
    // The marker never recorded an owner; 'unknown' beats inventing one in
    // the file that IS the provenance record.
    expect(banked).toEqual({
      session_id: 'sess-original',
      user_id: 'unknown',
      at: '2026-08-13T04:05:06.000Z',
    });
  });

  it('is idempotent, and ignores non-session markers and virgin dirs', () => {
    const dir = makeProblemDir(scratch());
    backfillRunFromUsed(dir); // no .used at all
    expect(readRuns(dir)).toEqual([]);

    // `cli.ts lc verify` pre-burns dirs with a non-session sentinel.
    writeFileSync(path.join(dir, '.used'), 'lc-verify\n2026-08-01T00:00:00Z\n');
    backfillRunFromUsed(dir);
    expect(readRuns(dir)).toEqual([]);

    writeFileSync(path.join(dir, '.used'), 'sess-once\n2026-08-02T00:00:00Z\n');
    backfillRunFromUsed(dir);
    backfillRunFromUsed(dir);
    backfillRunFromUsed(dir);
    expect(readRuns(dir).filter((r) => r.session_id === 'sess-once')).toHaveLength(1);
  });

  it('falls back to the marker mtime when .used has no timestamp line', () => {
    const dir = makeProblemDir(scratch());
    writeFileSync(path.join(dir, '.used'), 'sess-bare'); // legacy single-line
    backfillRunFromUsed(dir);
    const rows = readRuns(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe('sess-bare');
    expect(Number.isNaN(Date.parse(rows[0]!.at))).toBe(false);
  });
});

describe('destructive paths refuse before they wipe (QA 2026-08-14)', () => {
  it('a corrupt pristine archive throws with the tree still intact', () => {
    const dir = makeProblemDir(scratch());
    expect(makePristineArchive(dir).ok).toBe(true);
    writeFileSync(pristineArchivePath(dir), 'not a gzip stream at all');

    expect(() => restorePristine(dir)).toThrow(/unreadable/);
    // The wipe is the point of no return: it must not have happened.
    expect(read(dir, 'solution.py')).toBe(SOLUTION);
    expect(read(dir, 'problem.json')).toBe(PROBLEM_JSON);
    expect(existsSync(path.join(dir, 'tests', 'test_x.py'))).toBe(true);
  });

  it('an EMPTY snapshot never wipes the tree and never mints a pristine archive', () => {
    // snapshotWorkspace rm -rf's then re-copies, so a killed session leaves an
    // empty dir behind. The old code wiped, copied nothing, then force-archived
    // the wreckage — making every later repeat succeed into an empty workspace.
    const dir = makeProblemDir(scratch());
    writeFileSync(path.join(dir, '.used'), USED_TWO_LINE);
    mkdirSync(path.join(dir, '.session-snapshot'), { recursive: true });

    expect(() => restoreFromSnapshot(dir)).toThrow(/no usable/);
    expect(read(dir, 'solution.py')).toBe(SOLUTION);
    expect(read(dir, 'tests', 'test_x.py')).toBe(TEST_X);
    expect(existsSync(pristineArchivePath(dir))).toBe(false);
  });

  it('a .session-snapshot that is a FILE is refused, not half-applied', () => {
    const dir = makeProblemDir(scratch());
    writeFileSync(path.join(dir, '.session-snapshot'), 'not a directory');

    expect(() => restoreFromSnapshot(dir)).toThrow(/no usable/);
    expect(read(dir, 'solution.py')).toBe(SOLUTION);
  });

  it('hasUsableSnapshot distinguishes present from usable', () => {
    const dir = makeProblemDir(scratch());
    expect(hasUsableSnapshot(dir)).toBe(false); // absent
    mkdirSync(path.join(dir, '.session-snapshot'), { recursive: true });
    expect(hasUsableSnapshot(dir)).toBe(false); // present but empty
    writeFileSync(path.join(dir, '.session-snapshot', 'solution.py'), SOLUTION);
    expect(hasUsableSnapshot(dir)).toBe(true);
  });

  it('refuses to archive a dir holding nothing but markers', () => {
    const bare = path.join(scratch(), 'bare');
    mkdirSync(bare, { recursive: true });
    writeFileSync(path.join(bare, '.used'), USED_TWO_LINE);

    const r = makePristineArchive(bare, { force: true });
    expect(r.ok).toBe(false);
    expect(r.skipped).toContain('nothing to archive');
    expect(existsSync(pristineArchivePath(bare))).toBe(false);
  });
});

describe('the ledger heals a torn tail instead of swallowing the next row', () => {
  it('keeps the new row resolvable after a crash mid-append', () => {
    const dir = makeProblemDir(scratch());
    appendRun(dir, { session_id: 'sess-one', user_id: 'u1', at: '2026-01-01T00:00:00Z' });
    // A process killed mid-write leaves an unterminated line.
    writeFileSync(path.join(dir, '.runs.jsonl'), '{"session_id":"sess-torn","user_i', { flag: 'a' });

    appendRun(dir, { session_id: 'sess-after', user_id: 'u1', at: '2026-01-02T00:00:00Z' });

    // The torn row is unrecoverable, but the NEW one must survive — rejudge
    // resolves a dir through exactly this.
    expect(readRuns(dir).map((r) => r.session_id)).toEqual(['sess-one', 'sess-after']);
    expect(dirRanSession(dir, 'sess-after')).toBe(true);
  });
});
