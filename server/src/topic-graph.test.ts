/**
 * The topic ledger's three structural promises get pinned: upsert can never
 * double-count a session (#34's class), a corrupt store throws instead of
 * shadow-wiping history (#18's class), and saves are atomic (#17's class).
 * The score/decay math is pure with an injected clock.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GeneratedProblem, RoundSpec, TraceEvent } from '@interview-prep/shared';
import type { Assessment } from './judge.js';
import {
  TOPIC_SCHEMA_VERSION, attemptsFromSession, attemptScore, buildTopicView,
  emptyTopicStore, loadTopicStore, saveTopicStore, upsertAttempt, upsertSessionAttempts, validateTopicStore,
  type TopicAttempt,
} from './topic-graph.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-12T12:00:00Z');

const attempt = (over: Partial<TopicAttempt> = {}): TopicAttempt => ({
  session_id: 'sess-1',
  ts: NOW - DAY,
  slug: 'two-sum',
  difficulty: 'medium',
  tags: ['array', 'hash_table'],
  solved: true,
  origin: 'session',
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ip-topics-'));
  dirs.push(d);
  return d;
};

describe('upsertAttempt — idempotent by session_id', () => {
  it('replaces, never appends, for the same session (rejudge is corrective)', () => {
    let store = emptyTopicStore('u1');
    store = upsertAttempt(store, attempt({ solved: false }));
    store = upsertAttempt(store, attempt({ solved: true, origin: 'rejudge' }));
    expect(store.attempts).toHaveLength(1);
    expect(store.attempts[0]!.solved).toBe(true);
    expect(store.attempts[0]!.origin).toBe('rejudge');
  });

  it('keeps attempts ordered by ts and does not mutate its input', () => {
    const base = emptyTopicStore('u1');
    const s1 = upsertAttempt(base, attempt({ session_id: 'b', ts: NOW }));
    const s2 = upsertAttempt(s1, attempt({ session_id: 'a', ts: NOW - 2 * DAY }));
    expect(s2.attempts.map((a) => a.session_id)).toEqual(['a', 'b']);
    expect(base.attempts).toHaveLength(0);
    expect(s1.attempts).toHaveLength(1);
  });
});

describe('persistence — atomic save, validated load', () => {
  it('round-trips through disk; missing file is a cold start, not an error', () => {
    const dir = scratch();
    expect(loadTopicStore(dir, 'u1').attempts).toEqual([]);
    saveTopicStore(dir, upsertAttempt(emptyTopicStore('u1'), attempt()));
    const back = loadTopicStore(dir, 'u1');
    expect(back.attempts).toHaveLength(1);
    // No tmp file left behind.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('corrupt JSON throws — an unreadable history must never read as empty', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'u1.json'), '{ torn');
    expect(() => loadTopicStore(dir, 'u1')).toThrow();
  });

  it('unknown schema_version throws with a migrate message', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'u1.json'), JSON.stringify({ schema_version: 99, user_id: 'u1', attempts: [] }));
    expect(() => loadTopicStore(dir, 'u1')).toThrow(/migrate/);
  });

  it('a tag later removed from the vocabulary drops at read, file intact', () => {
    const dir = scratch();
    const store = upsertAttempt(emptyTopicStore('u1'), attempt({ tags: ['array', 'not_a_tag' as never] }));
    writeFileSync(path.join(dir, 'u1.json'), JSON.stringify(store));
    expect(loadTopicStore(dir, 'u1').attempts[0]!.tags).toEqual(['array']);
  });

  it('validateTopicStore names what drifted', () => {
    expect(validateTopicStore(null)).toContain('store is not an object');
    expect(validateTopicStore({ schema_version: TOPIC_SCHEMA_VERSION, user_id: 'u1', attempts: [{ session_id: 's', ts: 1, difficulty: 'impossible', solved: true, tags: [] }] }).join(' ')).toContain('difficulty');
  });
});

describe('attemptScore — difficulty at the score level', () => {
  it('solved and unsolved bases scale with difficulty', () => {
    expect(attemptScore({ difficulty: 'easy', solved: true })).toBe(0.6);
    expect(attemptScore({ difficulty: 'hard', solved: true })).toBe(1.0);
    expect(attemptScore({ difficulty: 'easy', solved: false })).toBe(0.0);
    expect(attemptScore({ difficulty: 'hard', solved: false })).toBe(0.3);
  });

  it('partial credit interpolates on the submit pass ratio', () => {
    const s = attemptScore({ difficulty: 'medium', solved: false, tests: { passed: 8, total: 16 } });
    expect(s).toBeCloseTo(0.15 + 0.5 * (0.8 - 0.15), 5);
  });

  it('running over the time cap halves the solved margin', () => {
    const late = attemptScore({
      difficulty: 'medium', solved: true, duration_ms: 90 * 60_000, time_limit_ms: 60 * 60_000,
    });
    expect(late).toBeCloseTo(0.15 + (0.8 - 0.15) / 2, 5);
  });
});

describe('buildTopicView — derived, clock injected', () => {
  it('aggregates per tag with recency decay and weak-dimension texture', () => {
    let store = emptyTopicStore('u1');
    store = upsertAttempt(store, attempt({
      session_id: 's1', ts: NOW - DAY, tags: ['graph'], solved: false, difficulty: 'medium',
      verdicts: { verify: 'weak', approach: 'adequate' },
    }));
    store = upsertAttempt(store, attempt({
      session_id: 's2', ts: NOW - 2 * DAY, tags: ['graph'], solved: false, difficulty: 'medium',
      verdicts: { verify: 'weak' },
    }));
    const view = buildTopicView(store, NOW);
    const graph = view.topics.find((t) => t.tag === 'graph')!;
    expect(graph.attempts).toBe(2);
    expect(graph.solved).toBe(0);
    expect(graph.state).toBe('weak'); // two recent unsolved mediums, confident
    expect(graph.weak_dimensions).toEqual({ verify: 2 });
    expect(view.attempted_slugs).toEqual(['two-sum']);
  });

  it('one lone attempt is a lead, not a pattern (confidence gate)', () => {
    // 22 days old → weight ≈ 0.48 < TOPIC_CONFIDENCE_MIN → stays developing.
    const store = upsertAttempt(emptyTopicStore('u1'), attempt({ ts: NOW - 22 * DAY, tags: ['trie'], solved: false }));
    const view = buildTopicView(store, NOW);
    expect(view.topics.find((t) => t.tag === 'trie')!.state).toBe('developing');
  });

  it('a strong topic goes stale after the spacing window', () => {
    let store = emptyTopicStore('u1');
    for (const [sid, days] of [['a', 15], ['b', 16], ['c', 17]] as const) {
      store = upsertAttempt(store, attempt({
        session_id: sid, ts: NOW - days * DAY, tags: ['stack'], solved: true, difficulty: 'hard',
      }));
    }
    const view = buildTopicView(store, NOW);
    expect(view.topics.find((t) => t.tag === 'stack')!.state).toBe('stale');
  });
});

describe('attemptsFromSession — mechanical extraction, LC-only', () => {
  const spec: RoundSpec = {
    id: 'oa', label: 'OA', capabilities: {
      interviewer: false, can_run_tests: true, time_limit_ms: 3_600_000,
      starts_from: 'blank', submit: 'one_shot', surface: 'panes',
    },
    check: { kind: 'all_failing' }, memory_tags: ['from_scratch', 'time_boxed', 'autograded'],
  };
  const assessment = {
    session_id: 'sess-9', status: 'assessed', judged_at: NOW, model: 'm', prompt_hash: 'h',
    schema_version: 1, renderer_version: 3, expectations_used: {}, solved: false,
    summary: 's',
    dimensions: [
      { dimension: 'verify', verdict: 'weak', analysis: 'x', evidence: [] },
      { dimension: 'approach', verdict: 'strong', analysis: 'x', evidence: [] },
    ],
  } as unknown as Assessment;
  const problem = {
    round_type: 'debugging', repo_path: '.', model_paths: [], spec: 'x'.repeat(120), mutations: [],
    rubric: { round_type: 'debugging' },
    source: { kind: 'leetcode', slug: 'two-sum', title: 'Two Sum', difficulty: 'easy', tags: ['Array', 'Hash Table'], mode: 'skinned' },
  } as GeneratedProblem;
  const events = [
    { session_id: 's', user_id: 'u', source: 'chrome', seq: 0, ts: NOW - 30 * 60_000, type: 'session_start', payload: {} },
    { session_id: 's', user_id: 'u', source: 'chrome', seq: 1, ts: NOW - 60_000, type: 'test_run', payload: { via: 'submit', exit_code: 1, passed: 11, total: 16 } },
    { session_id: 's', user_id: 'u', source: 'chrome', seq: 2, ts: NOW - 50_000, type: 'session_end', payload: {} },
  ] as TraceEvent[];

  it('builds the full row from manifest + assessment + spec + events', () => {
    const a = attemptsFromSession({ assessment, problem, spec, events, origin: 'session' })[0]!;
    expect(a.session_id).toBe('sess-9');
    expect(a.slug).toBe('two-sum');
    expect(a.tags).toEqual(['array', 'hash_table']); // normalized
    expect(a.tests).toEqual({ passed: 11, total: 16 });
    expect(a.verdicts).toEqual({ verify: 'weak', approach: 'strong' });
    expect(a.duration_ms).toBe(30 * 60_000 - 50_000);
    expect(a.time_limit_ms).toBe(3_600_000);
    expect(a.memory_tags).toEqual(['from_scratch', 'time_boxed', 'autograded']);
  });

  it('returns null for non-LC rounds — their topical identity is model prose', () => {
    const { source, ...rest } = problem;
    expect(attemptsFromSession({ assessment, problem: rest as GeneratedProblem, spec, events, origin: 'session' })).toEqual([]);
  });
});

describe('multi-part sets in the ledger (plural sources, 2026-08-13)', () => {
  const spec: RoundSpec = {
    id: 'oa', label: 'OA', capabilities: {
      interviewer: false, can_run_tests: true, time_limit_ms: 3_600_000,
      starts_from: 'blank', submit: 'one_shot', surface: 'panes',
    },
    check: { kind: 'all_failing' }, memory_tags: ['from_scratch'],
  };
  const assessment = {
    session_id: 'sess-set', status: 'assessed', judged_at: NOW, model: 'm', prompt_hash: 'h',
    schema_version: 1, renderer_version: 3, expectations_used: {}, solved: true, summary: 's',
    dimensions: [],
  } as unknown as import('./judge.js').Assessment;
  const problem = {
    round_type: 'debugging', repo_path: '.', model_paths: [], spec: 'x'.repeat(120), mutations: [],
    rubric: { round_type: 'debugging' },
    source: {
      kind: 'leetcode', slug: 'a-easy', title: 'A', difficulty: 'easy', tags: ['Array'], mode: 'skinned',
      parts: [
        { slug: 'a-easy', title: 'A', difficulty: 'easy', tags: ['Array'] },
        { slug: 'b-med', title: 'B', difficulty: 'medium', tags: ['Graph'] },
        { slug: 'c-med', title: 'C', difficulty: 'medium', tags: ['Dynamic Programming'] },
      ],
    },
  } as never;
  const events = [
    { session_id: 's', user_id: 'u', source: 'chrome', seq: 0, ts: NOW - 60_000, type: 'session_start', payload: {} },
    { session_id: 's', user_id: 'u', source: 'chrome', seq: 1, ts: NOW - 1_000, type: 'test_run', payload: { via: 'submit', exit_code: 0, passed: 36, total: 36 } },
  ] as never;

  it('one row per part, each with its own slug/tags/difficulty; whole-suite counts NOT fabricated per part', () => {
    const rows = attemptsFromSession({ assessment, problem, spec, events, origin: 'session' });
    expect(rows.map((r) => r.slug)).toEqual(['a-easy', 'b-med', 'c-med']);
    expect(rows.map((r) => r.tags[0])).toEqual(['array', 'graph', 'dynamic_programming']);
    expect(rows.every((r) => r.solved)).toBe(true);
    expect(rows.every((r) => r.tests === undefined)).toBe(true); // set → no per-part counts
  });

  it('rejudge replaces the whole session set, even when the part count changes', () => {
    const rows = attemptsFromSession({ assessment, problem, spec, events, origin: 'session' });
    let store = upsertSessionAttempts(emptyTopicStore('u1'), rows);
    expect(store.attempts).toHaveLength(3);
    // Rejudge with a corrected 2-part manifest: exactly 2 rows remain.
    store = upsertSessionAttempts(store, rows.slice(0, 2).map((r) => ({ ...r, origin: 'rejudge' as const })));
    expect(store.attempts).toHaveLength(2);
    expect(store.attempts.every((a) => a.origin === 'rejudge')).toBe(true);
  });

  it('mixed session ids in one call throw — the replace key is the session', () => {
    const rows = attemptsFromSession({ assessment, problem, spec, events, origin: 'session' });
    expect(() => upsertSessionAttempts(emptyTopicStore('u1'), [rows[0]!, { ...rows[1]!, session_id: 'other' }]))
      .toThrow(/mixed session/);
  });
});
