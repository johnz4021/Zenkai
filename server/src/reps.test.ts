/**
 * The reps module is the pre-session home for target-less rounds: the
 * lock, the caps, the phase derivation, and the sweep. Everything here is
 * pure or tmpdir-fs — no model calls, no HTTP (app.test.ts never runs the
 * server, so the endpoint failure paths are proven HERE, gate by gate).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_DEBUGGING_SPEC } from '@interview-prep/shared';
import { writeGeneratingMarker } from './generation-state.js';
import {
  DRAFT_FAILURE_PREFIX,
  MAX_REP_CONTEXT,
  MAX_REP_DESCRIPTION,
  REPS_TARGET_ID,
  acquireRepLock,
  assertRepId,
  createRepRecord,
  derivePhase,
  gateRepInput,
  launchVerdict,
  loadReps,
  repBlueprintPath,
  repProblemDir,
  repStateView,
  retryVerdict,
  saveReps,
  sweepReps,
  type Rep,
  type RepsFile,
} from './reps.js';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

const freshRoot = () => (root = mkdtempSync(path.join(tmpdir(), 'reps-')));

const rep = (over: Partial<Rep> = {}): Rep => ({
  ...createRepRecord({
    id: 'rep-abc123',
    spec: DEFAULT_DEBUGGING_SPEC,
    description: 'a debugging round like the Palantir email',
    now: Date.parse('2026-08-08T12:00:00Z'),
  }),
  ...over,
});

const repsFile = (...items: Rep[]): RepsFile => ({
  target_id: REPS_TARGET_ID,
  items,
  pace: { per_week: 0 },
  created: '2026-08-08T12:00:00Z',
});

describe('record shape', () => {
  it('round-trips through disk and starts life generating', () => {
    freshRoot();
    const file = repsFile(rep());
    saveReps(root, file);
    const loaded = loadReps(root);
    expect(loaded).toEqual(file);
    expect(loaded.items[0]!.status).toBe('generating');
    expect(loaded.items[0]!.problem_dir).toBe(path.join('reps', 'rep-abc123', 'problem'));
  });

  it('missing file loads as an empty shell, never throws', () => {
    freshRoot();
    expect(loadReps(root)).toEqual({
      target_id: REPS_TARGET_ID,
      items: [],
      pace: { per_week: 0 },
      created: '',
    });
  });
});

describe('assertRepId — validated before any path join', () => {
  it.each(['rep-abc', 'rep-m9x_2-Z'])('accepts %s', (id) => {
    expect(() => assertRepId(id)).not.toThrow();
  });
  it.each([
    'rep-../../etc',
    'rep-a/b',
    'rep-',
    'target-abc',
    '',
    'rep-a b',
    '../rep-a',
    42,
    null,
  ])('rejects %j', (id) => {
    expect(() => assertRepId(id)).toThrow('bad rep id');
  });
});

describe('gateRepInput — the server cap is the real gate', () => {
  it('trims and passes sane input', () => {
    expect(gateRepInput({ description: '  a node OA  ', context: 'pasted' })).toEqual({
      description: 'a node OA',
      context: 'pasted',
    });
  });
  it('empty description gets actionable copy, not a stack trace', () => {
    expect(() => gateRepInput({ description: '   ' })).toThrow('describe the round');
  });
  it('oversized description names the fix', () => {
    expect(() => gateRepInput({ description: 'x'.repeat(MAX_REP_DESCRIPTION + 1) })).toThrow(
      'trim it',
    );
  });
  it('oversized context names the fix', () => {
    expect(() =>
      gateRepInput({ description: 'ok', context: 'x'.repeat(MAX_REP_CONTEXT + 1) }),
    ).toThrow('too large');
  });
});

describe('acquireRepLock — the double-click guard', () => {
  it('first acquire wins, second throws the 409 message', () => {
    freshRoot();
    acquireRepLock(root, 'rep-abc123');
    expect(() => acquireRepLock(root, 'rep-abc123')).toThrow('already building');
  });
  it('different ids do not contend', () => {
    freshRoot();
    acquireRepLock(root, 'rep-a');
    expect(() => acquireRepLock(root, 'rep-b')).not.toThrow();
  });
});

describe('derivePhase — drafting/draft_failed never leave this function', () => {
  it.each([
    ['generating', false, null, 'drafting'],
    ['generating', true, null, 'generating'],
    ['failed', false, `${DRAFT_FAILURE_PREFIX}gate said no`, 'draft_failed'],
    ['failed', true, 'exit 1 at 2026-08-08', 'failed'],
    ['ready', true, null, 'ready'],
    ['done', true, null, 'done'],
  ] as const)('status=%s hasBlueprint=%s failed=%j → %s', (status, hasBlueprint, failedText, want) => {
    expect(derivePhase(rep({ status }), { hasBlueprint, failedText })).toBe(want);
  });
});

describe('reconcileWithDisk on a RepsFile — the literal-reuse proof', () => {
  it('derives ready → launched → done from the same markers as queues', () => {
    freshRoot();
    const r = rep();
    const dir = repProblemDir(root, r.id);
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(root, 'assessments'), { recursive: true });

    // .validated flips generating → ready
    writeFileSync(path.join(dir, '.validated'), '2026-08-08');
    let view = repStateView(root, repsFile(r));
    expect(view[0]!.status).toBe('ready');
    expect(view[0]!.phase).toBe('ready');

    // .used records the session id (launched-twice guard reads this)
    writeFileSync(path.join(dir, '.used'), 'sess-777\n2026-08-08\n');
    view = repStateView(root, repsFile(r));
    expect(view[0]!.session_id).toBe('sess-777');

    // an assessment lands → done
    writeFileSync(path.join(root, 'assessments', 'sess-777.json'), '{}');
    view = repStateView(root, repsFile(r));
    expect(view[0]!.status).toBe('done');
    expect(view[0]!.done_at).toBeTruthy();
  });

  it('a "draft: " .failed reconciles to failed and derives draft_failed', () => {
    freshRoot();
    const r = rep();
    const dir = repProblemDir(root, r.id);
    mkdirSync(path.dirname(repBlueprintPath(root, r.id)), { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.failed'), `${DRAFT_FAILURE_PREFIX}blueprint gate: too short`);
    const view = repStateView(root, repsFile(r));
    expect(view[0]!.status).toBe('failed');
    expect(view[0]!.phase).toBe('draft_failed');
  });
});

describe('marker at request time — honest drafting elapsed', () => {
  it('a marker with no blueprint yet reads as drafting, with since set', () => {
    freshRoot();
    const r = rep();
    const dir = repProblemDir(root, r.id);
    mkdirSync(dir, { recursive: true });
    writeGeneratingMarker(dir, 4242, Date.parse('2026-08-08T12:00:05Z'));
    const view = repStateView(root, repsFile(r));
    expect(view[0]!.phase).toBe('drafting');
    expect(view[0]!.generating?.since).toBe('2026-08-08T12:00:05.000Z');
  });

  it('blueprint present flips the phase to generating, same marker', () => {
    freshRoot();
    const r = rep();
    mkdirSync(repProblemDir(root, r.id), { recursive: true });
    writeGeneratingMarker(repProblemDir(root, r.id), 4242);
    writeFileSync(repBlueprintPath(root, r.id), '# blueprint');
    const view = repStateView(root, repsFile(r));
    expect(view[0]!.phase).toBe('generating');
  });
});

describe('launchVerdict', () => {
  it.each([
    ['generating', false, false, 'not-ready'],
    ['failed', false, false, 'not-ready'],
    ['ready', true, false, 'already-used'],
    ['ready', false, true, 'session-live'],
    ['ready', false, false, 'ok'],
  ] as const)('status=%s used=%s live=%s → %s', (status, usedExists, sessionLive, want) => {
    expect(launchVerdict(rep({ status }), { usedExists, sessionLive })).toBe(want);
  });
});

describe('retryVerdict — the ISSUE-003 double-agent guard', () => {
  it.each([
    ['ready', false, 'not-failed'],
    ['generating', false, 'not-failed'],
    ['failed', true, 'still-running'],
    ['failed', false, 'ok'],
  ] as const)('status=%s markerAlive=%s → %s', (status, markerAlive, want) => {
    expect(retryVerdict(rep({ status }), { markerAlive })).toBe(want);
  });
});

describe('repStateView', () => {
  it('newest first, spec label until the manifest names the problem', () => {
    freshRoot();
    const a = rep({ id: 'rep-a' });
    const b = rep({ id: 'rep-b' });
    mkdirSync(repProblemDir(root, 'rep-b'), { recursive: true });
    writeFileSync(
      path.join(repProblemDir(root, 'rep-b'), 'problem.json'),
      JSON.stringify({ title: 'Inventory reservations gone wrong' }),
    );
    const view = repStateView(root, repsFile(a, b));
    expect(view.map((v) => v.id)).toEqual(['rep-b', 'rep-a']);
    expect(view[0]!.title).toBe('Inventory reservations gone wrong');
    expect(view[1]!.title).toBe(DEFAULT_DEBUGGING_SPEC.label);
  });
});

describe('sweepReps — the reps half of the orphan sweep', () => {
  it('dead pid → .failed on disk + a rep-shaped log line; file untouched', () => {
    freshRoot();
    const r = rep();
    const dir = repProblemDir(root, r.id);
    mkdirSync(dir, { recursive: true });
    writeGeneratingMarker(dir, 999999);
    const log = sweepReps(root, repsFile(r), () => false);
    expect(log).toEqual(['[app] rep rep-abc123 orphaned by restart — marked failed (retryable)']);
    expect(readFileSync(path.join(dir, '.failed'), 'utf8')).toContain('orphaned by app restart');
    expect(existsSync(path.join(dir, '.generating'))).toBe(false);
  });

  it('live pid → left alone, marker kept', () => {
    freshRoot();
    const r = rep();
    const dir = repProblemDir(root, r.id);
    mkdirSync(dir, { recursive: true });
    writeGeneratingMarker(dir, 4242);
    const log = sweepReps(root, repsFile(r), () => true);
    expect(log).toEqual(['[app] rep rep-abc123 still building (pid 4242 alive) — left alone']);
    expect(existsSync(path.join(dir, '.generating'))).toBe(true);
    expect(existsSync(path.join(dir, '.failed'))).toBe(false);
  });

  it('terminal marker present → stale .generating cleared quietly', () => {
    freshRoot();
    const r = rep();
    const dir = repProblemDir(root, r.id);
    mkdirSync(dir, { recursive: true });
    writeGeneratingMarker(dir, 999999);
    writeFileSync(path.join(dir, '.validated'), '2026-08-08');
    const log = sweepReps(root, repsFile(r), () => false);
    expect(log).toEqual([]);
    expect(existsSync(path.join(dir, '.generating'))).toBe(false);
    expect(existsSync(path.join(dir, '.failed'))).toBe(false);
  });

  it('dirs owned by this process (liveGenerations) are skipped', () => {
    freshRoot();
    const r = rep();
    const dir = repProblemDir(root, r.id);
    mkdirSync(dir, { recursive: true });
    writeGeneratingMarker(dir, 999999);
    const log = sweepReps(root, repsFile(r), () => false, new Set([dir]));
    expect(log).toEqual([]);
    expect(existsSync(path.join(dir, '.failed'))).toBe(false);
  });
});
