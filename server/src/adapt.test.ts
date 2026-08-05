/**
 * The adapt gate + planner stand between one reasoning call and the
 * candidate's live season plan. The rules under test are the review's
 * decisions: append-only specs (D6), pending re-shapes / ready flags /
 * done-generating frozen (D2), apply drops what moved since preview (D4),
 * and the record repairs a half-applied write (D3). No model calls (repo
 * convention) — the gate and planner are pure.
 */
import { describe, expect, it } from 'vitest';
import type { RoundSpec } from '@interview-prep/shared';
import {
  applyAdaptation,
  excerptOf,
  gateAdapt,
  planAdaptation,
  reconcileAdaptation,
  type AdaptDraft,
} from './adapt.js';
import type { Target } from './intake.js';
import type { Queue, QueueItem } from './queue.js';

const NOW = Date.parse('2026-08-02T12:00:00');

const spec = (id: string, label = id.toUpperCase()): RoundSpec => ({
  id,
  label,
  capabilities: { interviewer: false, can_run_tests: true, time_limit_ms: 90 * 60_000, starts_from: 'blank', submit: 'one_shot' },
  check: { kind: 'all_failing' },
  memory_tags: ['from_scratch', 'time_boxed', 'autograded'],
});

const target = (over: Partial<Target> = {}): Target => ({
  id: 't1',
  label: 'T1',
  description: 'an OA',
  specs: [spec('oa')],
  created: '2026-08-01',
  ...over,
});

const item = (id: string, spec_id: string, status: QueueItem['status'], over: Partial<QueueItem> = {}): QueueItem => ({
  id,
  label: `${spec_id} — round 1`,
  spec_id,
  status,
  ...over,
});

const queue = (items: QueueItem[]): Queue => ({ target_id: 't1', items, pace: { per_week: 3 }, created: '2026-08-01' });

/** A gate-passing blueprint fixture: all seven headings, > 600 chars. */
const BP = [
  '# Blueprint: test round',
  '## What this round is', 'A class-design implementation round against a visible failing suite, judged on modeling.',
  '## Environment', 'Python, panes surface, timed, one-shot submit; the suite runs once at the end.',
  '## Repo shape', 'One scaffold file with stubbed classes and one test file defining the whole contract.',
  '## What the candidate does', 'Reads the suite, implements the stubs in dependency order, dry-runs mentally, submits once.',
  '## Difficulty calibration', 'Completable by a strong new grad inside the cap with the last tests needing genuine care.',
  '## Topic guidance', 'Bounded stateful components: booking systems, caches, rate limiters, order books.',
  '## Learnings log', '',
].join('\n\n');

// A raw round as the model emits it (the flat tool shape + supersedes).
const rawRound = (over: Record<string, unknown> = {}) => ({
  id: 'lld-round',
  label: 'Palantir LLD',
  interviewer: false,
  can_run_tests: true,
  time_limit_minutes: 90,
  starts_from: 'blank',
  submit: 'one_shot',
  check_kind: 'all_failing',
  emphasis: '',
  rationale: 'The HackerRank preview shows class design, not SQL.',
  unsupported: '',
  supersedes: 'oa',
  blueprint: BP,
  ...over,
});

const draftOf = (over: Record<string, unknown> = {}): AdaptDraft =>
  gateAdapt({ rounds: [rawRound(over)] }, [spec('oa'), spec('onsite')]).drafts[0]!;

describe('gateAdapt', () => {
  it('a coherent round with a real supersedes passes; tags derive in code', () => {
    const { drafts } = gateAdapt({ rounds: [rawRound()] }, [spec('oa')]);
    expect(drafts[0]!.supersedes).toBe('oa');
    expect(drafts[0]!.spec.memory_tags).toContain('autograded');
    expect(drafts[0]!.blueprint).toBe(BP);
  });

  it('zero rounds and zero edits is a valid "nothing changed" answer, not an error', () => {
    expect(gateAdapt({ rounds: [] }, [spec('oa')])).toEqual({ drafts: [], blueprint_edits: [] });
  });

  it('a new round without a gate-passing blueprint is dropped — a form arrives with its recipe', () => {
    const outcome = gateAdapt(
      { rounds: [rawRound(), rawRound({ id: 'thin', supersedes: null, blueprint: 'too short' })] },
      [spec('oa')],
    );
    expect(outcome.drafts.map((d) => d.spec.id)).toEqual(['lld-round']);
  });

  it('blueprint edits: active ids pass, retired/unknown/superseded-this-adapt drop', () => {
    const outcome = gateAdapt(
      {
        rounds: [rawRound()], // supersedes 'oa'
        blueprint_edits: [
          { id: 'onsite', blueprint: BP }, // active → kept
          { id: 'ghost', blueprint: BP }, // unknown → dropped
          { id: 'oa', blueprint: BP }, // superseded by this very adapt → dropped
          { id: 'onsite', blueprint: 'thin' }, // gate fails → dropped
        ],
      },
      [spec('oa'), spec('onsite')],
    );
    expect(outcome.blueprint_edits).toEqual([{ id: 'onsite', blueprint: BP }]);
  });

  it('edits-only material (zero rounds, one edit) is a usable outcome', () => {
    const outcome = gateAdapt(
      { rounds: [], blueprint_edits: [{ id: 'oa', blueprint: BP }] },
      [spec('oa')],
    );
    expect(outcome.drafts).toEqual([]);
    expect(outcome.blueprint_edits).toHaveLength(1);
  });

  it('supersedes must name a real spec — a guess dies at the gate', () => {
    expect(() => gateAdapt({ rounds: [rawRound({ supersedes: 'sql-round' })] }, [spec('oa')]))
      .toThrow(/every draft failed.*unknown spec/);
  });

  it('reusing an existing spec id dies — specs are append-only (D6)', () => {
    expect(() => gateAdapt({ rounds: [rawRound({ id: 'oa', supersedes: null })] }, [spec('oa')]))
      .toThrow(/append-only/);
  });

  it('a RETIRED id can never be reused, and a retired spec cannot be superseded', () => {
    // Active universe: onsite. Collision universe includes the retired oa.
    const active = [spec('onsite')];
    const allIds = ['oa', 'onsite'];
    expect(() => gateAdapt({ rounds: [rawRound({ id: 'oa', supersedes: null })] }, active, allIds))
      .toThrow(/append-only/);
    expect(() => gateAdapt({ rounds: [rawRound({ supersedes: 'oa' })] }, active, allIds))
      .toThrow(/unknown spec/);
  });

  it('one incoherent draft is dropped; its coherent sibling survives', () => {
    const { drafts } = gateAdapt(
      { rounds: [rawRound(), rawRound({ id: 'broken', can_run_tests: false, supersedes: null })] },
      [spec('oa')],
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.spec.id).toBe('lld-round');
  });

  it('normalizes a stringified rounds array (the judge lesson)', () => {
    expect(gateAdapt({ rounds: JSON.stringify([rawRound()]) }, [spec('oa')]).drafts).toHaveLength(1);
  });
});

describe('planAdaptation', () => {
  it('pending items re-point round-robin across the active spec set; labels follow', () => {
    const q = queue([item('i1', 'oa', 'pending'), item('i2', 'oa', 'pending'), item('i3', 'oa', 'pending')]);
    const diff = planAdaptation(target(), q, [draftOf()]);
    // oa is fully superseded → every pending item moves to the new spec.
    expect(diff.repointed.map((r) => r.item_id)).toEqual(['i1', 'i2', 'i3']);
    expect(new Set(diff.repointed.map((r) => r.to_spec_id))).toEqual(new Set(['lld-round']));
    expect(diff.repointed[1]!.new_label).toBe('Palantir LLD — round 2');
  });

  it('an additional round (supersedes null) shares the pending budget', () => {
    const q = queue([item('i1', 'oa', 'pending'), item('i2', 'oa', 'pending'), item('i3', 'oa', 'pending'), item('i4', 'oa', 'pending')]);
    const diff = planAdaptation(target(), q, [draftOf({ supersedes: null })]);
    // Round-robin over [oa, lld-round]: i2 and i4 move, i1 and i3 stay.
    expect(diff.repointed.map((r) => r.item_id)).toEqual(['i2', 'i4']);
    expect(diff.new_specs.map((s) => s.id)).toEqual(['lld-round']);
  });

  it('done and generating are untouchable; ready under a superseded spec re-points AND flags', () => {
    // The old flag-only behavior is the pinned regression: rebuild
    // regenerated the superseded Palantir spec (2026-08-05) because
    // item.spec_id never changed.
    const q = queue([
      item('i1', 'oa', 'done'),
      item('i2', 'oa', 'generating'),
      item('i3', 'oa', 'ready'),
      item('i4', 'oa', 'pending'),
    ]);
    const diff = planAdaptation(target(), q, [draftOf()]);
    expect(diff.repointed.map((r) => r.item_id)).toEqual(['i4', 'i3']);
    expect(diff.repointed[1]!.to_spec_id).toBe('lld-round');
    expect(diff.flagged).toEqual(['i3']);
  });

  it('failed re-points like pending — there is no validated problem to protect', () => {
    const q = queue([item('i1', 'oa', 'failed')]);
    const diff = planAdaptation(target(), q, [draftOf()]);
    expect(diff.repointed.map((r) => r.item_id)).toEqual(['i1']);
  });

  it('a later adapt never resurrects a spec an earlier one retired (live bug)', () => {
    // Adapt 1: lld-round superseded oa. Adapt 2 adds a new round without
    // mentioning oa — oa must STAY retired, not rejoin the round-robin.
    const q1 = queue([item('i1', 'oa', 'pending'), item('i2', 'oa', 'pending')]);
    const first = applyAdaptation(target(), q1, planAdaptation(target(), q1, [draftOf()]), 'n', NOW);
    const second = planAdaptation(first.target, first.queue, [
      gateAdapt({ rounds: [rawRound({ id: 'sql-round', label: 'SQL round', supersedes: null })] }, first.target.specs).drafts[0]!,
    ]);
    const landed = new Set([
      ...first.queue.items.map((i) => i.spec_id),
      ...second.repointed.map((r) => r.to_spec_id),
    ]);
    expect(second.superseded).toEqual([]);
    expect(landed.has('oa')).toBe(false); // retired stays retired
  });

  it('zero drafts → empty diff — a no-op paste never re-balances the queue', () => {
    const q = queue([item('i1', 'oa', 'pending'), item('i2', 'onsite', 'pending')]);
    const diff = planAdaptation(target({ specs: [spec('oa'), spec('onsite')] }), q, []);
    expect(diff.repointed).toEqual([]);
    expect(diff.summary).toMatch(/already matches/);
  });

  it('recipe-only edits change files, never the queue', () => {
    const q = queue([item('i1', 'oa', 'pending'), item('i2', 'onsite', 'pending')]);
    const diff = planAdaptation(target({ specs: [spec('oa'), spec('onsite')] }), q, [], [
      { id: 'oa', blueprint: BP },
    ]);
    expect(diff.repointed).toEqual([]);
    expect(diff.new_specs).toEqual([]);
    expect(diff.blueprints).toEqual([{ spec_id: 'oa', action: 'revised', markdown: BP }]);
    expect(diff.summary).toMatch(/1 blueprint refined — rounds unchanged/);
  });

  it('new rounds carry their blueprint into the diff for apply to write', () => {
    const q = queue([item('i1', 'oa', 'pending')]);
    const diff = planAdaptation(target(), q, [draftOf()]);
    expect(diff.blueprints).toEqual([{ spec_id: 'lld-round', action: 'new', markdown: BP }]);
    expect(diff.summary).toMatch(/new: Palantir LLD/);
  });
});

describe('applyAdaptation', () => {
  const diffFor = (q: Queue, t = target()) => planAdaptation(t, q, [draftOf()]);

  it('applies to a fresh queue; ready items re-point AND stale; the record carries it all', () => {
    const q = queue([item('i1', 'oa', 'pending'), item('i2', 'oa', 'ready')]);
    const out = applyAdaptation(target(), q, diffFor(q), 'Erik says the OA is LLD', NOW);
    expect(out.queue.items[0]!.spec_id).toBe('lld-round');
    // The pinned regression: a ready item keeping its superseded spec_id is
    // exactly how rebuild regenerated the retired Palantir spec.
    expect(out.queue.items[1]!.spec_id).toBe('lld-round');
    expect(out.queue.items[1]!.stale).toBe(true);
    expect(out.target.specs.map((s) => s.id)).toEqual(['oa', 'lld-round']);
    const rec = out.target.adaptations![0]!;
    expect(rec.repointed).toEqual([
      { item_id: 'i1', from: 'oa', to: 'lld-round' },
      { item_id: 'i2', from: 'oa', to: 'lld-round' },
    ]);
    expect(rec.flagged).toEqual(['i2']);
    expect(rec.blueprints_updated).toEqual(['lld-round']);
    expect(rec.at).toBe(new Date(NOW).toISOString());
  });

  it('an old-shape diff (no blueprints field) still applies — rollout skew tolerated', () => {
    const q = queue([item('i1', 'oa', 'pending')]);
    const diff = diffFor(q);
    const legacy = { ...diff };
    delete (legacy as Partial<typeof diff>).blueprints;
    const out = applyAdaptation(target(), q, legacy as typeof diff, 'notes', NOW);
    expect(out.queue.items[0]!.spec_id).toBe('lld-round');
    expect(out.target.adaptations![0]!.blueprints_updated).toBeUndefined();
  });

  it('an item that moved on since preview is skipped, not overwritten (the race, D4)', () => {
    const previewQ = queue([item('i1', 'oa', 'pending')]);
    const diff = diffFor(previewQ);
    // Between preview and apply the user hit generate.
    const freshQ = queue([item('i1', 'oa', 'generating', { problem_dir: 'targets/t1/problems/i1' })]);
    const out = applyAdaptation(target(), freshQ, diff, 'notes', NOW);
    expect(out.queue.items[0]!.status).toBe('generating');
    expect(out.queue.items[0]!.spec_id).toBe('oa');
    expect(out.target.adaptations![0]!.skipped).toEqual([{ item_id: 'i1', reason: 'now generating' }]);
  });

  it('never mutates its inputs, and existing spec objects survive byte-identical (D6)', () => {
    const t = target();
    const q = queue([item('i1', 'oa', 'pending')]);
    const tSnap = JSON.stringify(t);
    const qSnap = JSON.stringify(q);
    const out = applyAdaptation(t, q, diffFor(q, t), 'notes', NOW);
    expect(JSON.stringify(t)).toBe(tSnap);
    expect(JSON.stringify(q)).toBe(qSnap);
    expect(out.target.specs[0]).toEqual(t.specs[0]);
  });

  it('re-applying the same diff is idempotent on specs (reconcile depends on it)', () => {
    const q = queue([item('i1', 'oa', 'pending')]);
    const diff = diffFor(q);
    const once = applyAdaptation(target(), q, diff, 'notes', NOW);
    const twice = applyAdaptation(once.target, once.queue, diff, 'notes', NOW);
    expect(twice.target.specs.map((s) => s.id)).toEqual(['oa', 'lld-round']);
  });

  it('the stored excerpt is capped — the plan is not an archive of someone\'s messages', () => {
    expect(excerptOf('x'.repeat(1000))).toHaveLength(280);
    expect(excerptOf('  a\n\nb  ')).toBe('a b');
  });
});

describe('reconcileAdaptation (crash repair, D3)', () => {
  it('re-applies a recorded re-point the queue does not reflect', () => {
    const q = queue([item('i1', 'oa', 'pending')]);
    const applied = applyAdaptation(target(), q, planAdaptation(target(), q, [draftOf()]), 'notes', NOW);
    // Crash between the writes: target landed, queue did not.
    const repaired = reconcileAdaptation(applied.target, q);
    expect(repaired).not.toBeNull();
    expect(repaired!.items[0]!.spec_id).toBe('lld-round');
  });

  it('a consistent pair needs no repair', () => {
    const q = queue([item('i1', 'oa', 'pending')]);
    const applied = applyAdaptation(target(), q, planAdaptation(target(), q, [draftOf()]), 'notes', NOW);
    expect(reconcileAdaptation(applied.target, applied.queue)).toBeNull();
  });

  it('an item that moved on since the record is left alone', () => {
    const q = queue([item('i1', 'oa', 'pending')]);
    const applied = applyAdaptation(target(), q, planAdaptation(target(), q, [draftOf()]), 'notes', NOW);
    const moved = queue([item('i1', 'oa', 'done')]);
    expect(reconcileAdaptation(applied.target, moved)).toBeNull();
  });

  it('no adaptations → nothing to do', () => {
    expect(reconcileAdaptation(target(), queue([item('i1', 'oa', 'pending')]))).toBeNull();
  });

  it('a record carrying blueprints_updated still repairs re-points (forward compat)', () => {
    const q = queue([item('i1', 'oa', 'pending')]);
    const applied = applyAdaptation(target(), q, planAdaptation(target(), q, [draftOf()]), 'n', NOW);
    expect(applied.target.adaptations![0]!.blueprints_updated).toEqual(['lld-round']);
    const repaired = reconcileAdaptation(applied.target, q);
    expect(repaired!.items[0]!.spec_id).toBe('lld-round');
  });
});
