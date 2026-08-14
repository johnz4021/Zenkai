/**
 * The reap matrix. The rows that matter most are the NEVERs: unconsumed work
 * is never age-reaped (TODOS #27), and an ungraded round is never touched —
 * a crashed session's problem dir must stay runnable and rejudgeable.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyReaping, gatherRepDiskFacts, planReaping, type RepDiskFacts } from './retention.js';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const POLICY = { days: 14, reapNodeModules: true };

const fact = (over: Partial<RepDiskFacts>): RepDiskFacts => ({
  id: 'rep-a',
  dir: '/x/reps/rep-a/problem',
  usedMtimeMs: T0 - DAY,
  graded: true,
  hasNodeModules: true,
  slimmed: false,
  ...over,
});

describe('planReaping', () => {
  it('never touches unconsumed or ungraded reps, at any age', () => {
    expect(planReaping([fact({ usedMtimeMs: null })], T0, POLICY)).toEqual([]);
    expect(planReaping([fact({ usedMtimeMs: T0 - 100 * DAY, graded: false })], T0, POLICY)).toEqual([]);
  });

  it('reaps node_modules of a graded rep; skips when already gone', () => {
    expect(planReaping([fact({})], T0, POLICY)).toEqual([
      { kind: 'node_modules', id: 'rep-a', dir: '/x/reps/rep-a/problem' },
    ]);
    expect(planReaping([fact({ hasNodeModules: false })], T0, POLICY)).toEqual([]);
  });

  it('slims past the age gate (which subsumes node_modules); respects the boundary', () => {
    expect(planReaping([fact({ usedMtimeMs: T0 - 15 * DAY })], T0, POLICY)).toEqual([
      { kind: 'slim', id: 'rep-a', dir: '/x/reps/rep-a/problem' },
    ]);
    // exactly at the gate: not yet
    expect(planReaping([fact({ usedMtimeMs: T0 - 14 * DAY })], T0, POLICY)).toEqual([
      { kind: 'node_modules', id: 'rep-a', dir: '/x/reps/rep-a/problem' },
    ]);
    // Already slimmed (which on real disk implies node_modules is gone): inert.
    expect(
      planReaping([fact({ usedMtimeMs: T0 - 15 * DAY, slimmed: true, hasNodeModules: false })], T0, POLICY),
    ).toEqual([]);
  });

  it('policy off = reaper fully inert', () => {
    const old = fact({ usedMtimeMs: T0 - 100 * DAY });
    expect(planReaping([old], T0, { days: null, reapNodeModules: false })).toEqual([]);
  });
});

describe('gather + apply against a real temp dir', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The REAL on-disk shape: `.used` is two lines, `sid\nISO\n` (pool.ts:56-58). */
  const USED = (sid: string) => `${sid}\n2026-08-14T12:00:00.000Z\n`;

  it('facts reflect disk; slim keeps exactly the survivors', () => {
    root = mkdtempSync(path.join(tmpdir(), 'retention-'));
    const dir = path.join(root, 'reps', 'rep-x', 'problem');
    mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'problem.json'), '{}');
    writeFileSync(path.join(dir, '.validated'), '');
    writeFileSync(path.join(dir, '.used'), USED('sess-123'));
    writeFileSync(path.join(dir, '.runs.jsonl'), '{"session_id":"sess-123"}\n');
    // Pristine archive: a SIBLING of the problem dir, outside everything slim touches.
    const pristine = path.join(root, 'reps', 'rep-x', 'problem.pristine.tar.gz');
    writeFileSync(pristine, 'not-really-a-tarball');
    mkdirSync(path.join(root, 'assessments'), { recursive: true });
    mkdirSync(path.join(root, 'feedback'), { recursive: true });
    writeFileSync(path.join(root, 'assessments', 'sess-123.json'), '{}');
    writeFileSync(path.join(root, 'feedback', 'sess-123.json'), '{}');

    const facts = gatherRepDiskFacts(root);
    expect(facts).toHaveLength(1);
    // REGRESSION: `.trim()` left the ISO line attached, so this was ALWAYS
    // false and neither reap pass had ever fired in production.
    expect(facts[0]).toMatchObject({ id: 'rep-x', graded: true, hasNodeModules: true, slimmed: false });

    applyReaping([{ kind: 'slim', id: 'rep-x', dir }]);
    const after = gatherRepDiskFacts(root)[0]!;
    expect(after.hasNodeModules).toBe(false);
    expect(after.slimmed).toBe(true); // only problem.json + markers left
    // The ledger is a marker: history of every run survives the slim.
    expect(readdirSync(dir).sort()).toEqual(['.runs.jsonl', '.used', '.validated', 'problem.json']);
    // And repeatability survives: slim only deletes INSIDE problem/.
    expect(existsSync(pristine)).toBe(true);
  });

  it('an unjudged .used session reads as ungraded', () => {
    root = mkdtempSync(path.join(tmpdir(), 'retention-'));
    const dir = path.join(root, 'reps', 'rep-y', 'problem');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.used'), USED('sess-crashed'));
    expect(gatherRepDiskFacts(root)[0]!.graded).toBe(false);
  });
});
