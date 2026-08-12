/**
 * LeetCode dataset layer — vendored corpus, never live scraping.
 *
 *   HuggingFace JSONL (pinned revision + sha256)
 *        │  cli.ts lc fetch   (one-time, idempotent, atomic)
 *        ▼
 *   datasets/leetcode/
 *     .version               {revision, files, fetched_at, count}
 *     index.json             LcIndexEntry[] — the only thing the app loads
 *     problems/<slug>.json   one normalized LcProblem per slug
 *        │
 *        ├── loadLcProblem(slug) ──► lc-convert.ts (test emission, source block)
 *        └── loadLcIndex() ───────► listing/eligibility (and later, selection)
 *
 * Why it exists: real OAs and interviewer rounds use real LeetCode problems.
 * The product decision (2026-08-12) is to source them from the Apache-2.0
 * LeetCodeDataset snapshot only — verified canonical solutions and 100+
 * verified I/O cases per problem are the asset; the copyrighted statement
 * text stays PRIVATE generator context unless verbatim mode is explicitly
 * allowed. No code in this repo talks to leetcode.com.
 *
 * The dataset is ~100MB and gitignored; the pins below are the integrity
 * record. `assertLcRecord` is the ingest gate — the upstream `input_output`
 * encoding is the one external this repo cannot type-check, so a dataset
 * revision that drifts fails the fetch loudly instead of corrupting builds.
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { TopicTag } from '@interview-prep/shared';
import { normalizeTopicTags } from '@interview-prep/shared';

/** Pinned upstream revision. Bump deliberately; `lc fetch` re-verifies. */
export const LC_DATASET_PINS = {
  repo: 'newfacade/LeetCodeDataset',
  revision: '215604aeed660029df7de2fea5a4d7b6ed476a08',
  files: [
    {
      name: 'LeetCodeDataset-train.jsonl',
      sha256: 'ef7d64d34b092859607c1010bdd23540860a8cfff2ed7aeb0fe82e0ad524919b',
    },
    {
      name: 'LeetCodeDataset-test.jsonl',
      sha256: 'aec951945feb555b4c72783519452a7a0437ca8c6e5624a83d0ae888718fa4ed',
    },
  ],
} as const;

/** Minimum verified I/O cases for a problem to be sourceable at all. */
export const MIN_CASES_FOR_SOURCING = 12;

export type LcDifficulty = 'easy' | 'medium' | 'hard';
export type LcStructure = 'tree' | 'linked_list' | 'plain';

/** One normalized problem, on disk as problems/<slug>.json. */
export interface LcProblem {
  slug: string;
  /** LeetCode question number ("LC 146"-style references resolve on this). */
  id: number;
  title: string;
  difficulty: LcDifficulty;
  tags: TopicTag[];
  /** Verbatim problem statement (already plaintext upstream). PRIVATE in
   *  skinned mode — reaches only the generator, never a candidate file. */
  statement: string;
  starter_code: string;
  /** "Solution().methodName" — audited to match this shape corpus-wide. */
  entry_point: string;
  /** Method name extracted from entry_point. */
  method: string;
  /** Canonical solution, verified 100% AC upstream. The private oracle. */
  solution: string;
  /** Raw kwarg-expression cases ("n = 7, queries = [[0,5]]" → "[2, 2, 2]").
   *  Deliberately NOT parsed in TS: the emitted Python harness evals them,
   *  which is also what makes skinned parameter renames safe (positional
   *  call from kwarg order). */
  cases: { input: string; output: string }[];
  structures: LcStructure[];
  stdlib_only: boolean;
  estimated_date?: string;
}

/** Index row — the only shape the long-lived app ever loads. */
export interface LcIndexEntry {
  slug: string;
  id: number;
  title: string;
  difficulty: LcDifficulty;
  tags: TopicTag[];
  n_cases: number;
  structures: LcStructure[];
  stdlib_only: boolean;
  estimated_date?: string;
}

export interface LcVersion {
  revision: string;
  files: { name: string; sha256: string }[];
  fetched_at: string;
  count: number;
}

export function lcRoot(repoRoot: string): string {
  return path.join(repoRoot, 'datasets', 'leetcode');
}

const THIRD_PARTY_IMPORT =
  /(^|\n)\s*(?:from|import)\s+(sortedcontainers|numpy|pandas|scipy|sympy)\b/;
/** Some canonical solutions use sortedcontainers types BARE, with no import
 *  line at all (the upstream eval env auto-imports them) — the import regex
 *  alone misses those (sum-of-imbalance-numbers case, first corpus sweep). */
const THIRD_PARTY_BARE_USE = /\b(?:SortedList|SortedDict|SortedSet|SortedKeyList)\s*\(/;

/** "two-sum-ii" → "Two Sum II" (pure; exported for tests). */
export function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => (/^[ivxl]+$/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Tree/linked-list problems need serialization the v1 converter does not
 *  emit; detection is over the dataset's own harness usage. */
export function detectStructures(rec: { test?: string; starter_code?: string }): LcStructure[] {
  const hay = `${rec.test ?? ''}\n${rec.starter_code ?? ''}`;
  const out: LcStructure[] = [];
  if (/tree_node\(|TreeNode/.test(hay)) out.push('tree');
  if (/list_node\(|ListNode/.test(hay)) out.push('linked_list');
  return out.length ? out : ['plain'];
}

export function detectStdlibOnly(rec: { completion?: string; starter_code?: string }): boolean {
  const hay = `${rec.completion ?? ''}\n${rec.starter_code ?? ''}`;
  return !THIRD_PARTY_IMPORT.test(hay) && !THIRD_PARTY_BARE_USE.test(hay);
}

/** Raw upstream record fields this pipeline depends on. */
interface RawRecord {
  task_id: string;
  question_id: number;
  difficulty: string;
  tags: string[];
  problem_description: string;
  starter_code: string;
  completion: string;
  entry_point: string;
  input_output: { input: string; output: string | null }[];
  test?: string;
  estimated_date?: string;
}

/**
 * The ingest gate: throws with the slug and the reason on any record whose
 * shape drifted from the audited encoding. Exported for tests.
 */
export function assertLcRecord(raw: unknown): RawRecord {
  const r = raw as Partial<RawRecord> | null;
  const fail = (why: string): never => {
    throw new Error(`lc record ${String(r?.task_id ?? '<no slug>')}: ${why}`);
  };
  if (!r || typeof r !== 'object') fail('not an object');
  if (typeof r!.task_id !== 'string' || !r!.task_id.trim()) fail('task_id missing');
  if (typeof r!.question_id !== 'number') fail('question_id missing');
  if (r!.difficulty !== 'Easy' && r!.difficulty !== 'Medium' && r!.difficulty !== 'Hard') {
    fail(`difficulty out of vocabulary: ${String(r!.difficulty)}`);
  }
  if (!Array.isArray(r!.tags)) fail('tags missing');
  if (typeof r!.problem_description !== 'string' || r!.problem_description.length < 40) {
    fail('problem_description missing or implausibly short');
  }
  if (typeof r!.starter_code !== 'string' || !r!.starter_code.includes('class Solution')) {
    fail('starter_code missing or not Solution-shaped');
  }
  if (typeof r!.completion !== 'string' || !r!.completion.trim()) fail('completion missing');
  if (typeof r!.entry_point !== 'string' || !/^Solution\(\)\.\w+$/.test(r!.entry_point)) {
    fail(`entry_point not Solution().method: ${String(r!.entry_point)}`);
  }
  if (!Array.isArray(r!.input_output) || r!.input_output.length === 0) {
    fail('input_output missing or empty');
  }
  for (const c of r!.input_output!) {
    // output: JSON null occurs on a handful of cases corpus-wide (upstream
    // case generation gaps) — tolerated here, dropped in normalizeRecord.
    if (typeof c?.input !== 'string' || (typeof c?.output !== 'string' && c?.output !== null)) {
      fail('input_output entry is not {input: string, output: string|null}');
    }
  }
  return r as RawRecord;
}

/**
 * Raw record → normalized LcProblem. Throws on out-of-vocabulary tags —
 * the zero-drop assertion that keeps shared/topics.ts honest against the
 * corpus. Exported for tests.
 */
export function normalizeRecord(raw: unknown): LcProblem {
  const r = assertLcRecord(raw);
  const { tags, dropped } = normalizeTopicTags(r.tags);
  if (dropped.length) {
    throw new Error(
      `lc record ${r.task_id}: tags out of vocabulary: ${dropped.join(', ')} — extend shared/src/topics.ts deliberately`,
    );
  }
  return {
    slug: r.task_id,
    id: r.question_id,
    title: titleFromSlug(r.task_id),
    difficulty: r.difficulty.toLowerCase() as LcDifficulty,
    tags,
    statement: r.problem_description.trim(),
    starter_code: r.starter_code,
    entry_point: r.entry_point,
    method: r.entry_point.replace(/^Solution\(\)\./, ''),
    solution: r.completion,
    cases: r.input_output
      .filter((c) => typeof c.output === 'string')
      .map((c) => ({ input: c.input, output: c.output as string })),
    structures: detectStructures(r),
    stdlib_only: detectStdlibOnly(r),
    ...(r.estimated_date ? { estimated_date: r.estimated_date } : {}),
  };
}

export function indexEntryOf(p: LcProblem): LcIndexEntry {
  return {
    slug: p.slug,
    id: p.id,
    title: p.title,
    difficulty: p.difficulty,
    tags: p.tags,
    n_cases: p.cases.length,
    structures: p.structures,
    stdlib_only: p.stdlib_only,
    ...(p.estimated_date ? { estimated_date: p.estimated_date } : {}),
  };
}

/** V1 sourcing bar: plain-structure, stdlib-only, enough verified cases.
 *  (2,613 of 2,869 problems at the pinned revision.) */
export function eligibleForSourcing(e: Pick<LcIndexEntry, 'structures' | 'stdlib_only' | 'n_cases'>): boolean {
  return (
    e.structures.length === 1 &&
    e.structures[0] === 'plain' &&
    e.stdlib_only &&
    e.n_cases >= MIN_CASES_FOR_SOURCING
  );
}

// ── fetch ──────────────────────────────────────────────────────────────────

function hfUrl(file: string): string {
  return `https://huggingface.co/datasets/${LC_DATASET_PINS.repo}/resolve/${LC_DATASET_PINS.revision}/${file}`;
}

async function fetchOrReadPinned(name: string, expectedSha: string, fromDir?: string): Promise<Buffer> {
  let buf: Buffer;
  if (fromDir) {
    buf = readFileSync(path.join(fromDir, name));
  } else {
    const res = await fetch(hfUrl(name));
    if (!res.ok) throw new Error(`fetch ${name}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== expectedSha) {
    throw new Error(`${name}: sha256 mismatch (got ${sha}, pinned ${expectedSha}) — refusing to ingest`);
  }
  return buf;
}

/**
 * Download (or read from --from dir), verify, normalize, write atomically.
 * Idempotent: an existing .version at the pinned revision is terminal.
 * Returns a one-line summary for the CLI.
 */
export async function fetchLcDataset(repoRoot: string, opts?: { fromDir?: string; force?: boolean }): Promise<string> {
  const root = lcRoot(repoRoot);
  const existing = readLcVersion(repoRoot);
  if (existing && existing.revision === LC_DATASET_PINS.revision && !opts?.force) {
    return `already at ${existing.revision.slice(0, 8)} (${existing.count} problems) — nothing to do`;
  }

  const bySlug = new Map<string, LcProblem>();
  for (const f of LC_DATASET_PINS.files) {
    const buf = await fetchOrReadPinned(f.name, f.sha256, opts?.fromDir);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const p = normalizeRecord(JSON.parse(line));
      // Later files win on slug collisions (test split carries the newest
      // problems upstream); at the pinned revision there are zero.
      bySlug.set(p.slug, p);
    }
  }

  // Atomic-ish publish: build aside, swap directories, drop the old one.
  const tmp = `${root}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(path.join(tmp, 'problems'), { recursive: true });
  const index: LcIndexEntry[] = [];
  for (const p of bySlug.values()) {
    index.push(indexEntryOf(p));
    writeFileSync(path.join(tmp, 'problems', `${p.slug}.json`), JSON.stringify(p));
  }
  index.sort((a, b) => a.slug.localeCompare(b.slug));
  writeFileSync(path.join(tmp, 'index.json'), JSON.stringify(index));
  const version: LcVersion = {
    revision: LC_DATASET_PINS.revision,
    files: [...LC_DATASET_PINS.files],
    fetched_at: new Date().toISOString(),
    count: index.length,
  };
  writeFileSync(path.join(tmp, '.version'), JSON.stringify(version, null, 2));

  const old = `${root}.old-${process.pid}`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(root)) renameSync(root, old);
  renameSync(tmp, root);
  rmSync(old, { recursive: true, force: true });

  const eligible = index.filter(eligibleForSourcing).length;
  return `ingested ${index.length} problems (${eligible} sourceable) at ${version.revision.slice(0, 8)}`;
}

// ── load API ───────────────────────────────────────────────────────────────

export function readLcVersion(repoRoot: string): LcVersion | null {
  try {
    const v = JSON.parse(readFileSync(path.join(lcRoot(repoRoot), '.version'), 'utf8')) as LcVersion;
    return typeof v?.revision === 'string' && typeof v?.count === 'number' ? v : null;
  } catch {
    return null;
  }
}

export function lcReady(repoRoot: string): { ok: true; version: LcVersion } | { ok: false; reason: string } {
  const v = readLcVersion(repoRoot);
  if (!v) return { ok: false, reason: 'dataset not fetched — run: npx tsx server/src/cli.ts lc fetch' };
  if (v.revision !== LC_DATASET_PINS.revision) {
    return { ok: false, reason: `dataset at ${v.revision.slice(0, 8)}, pins expect ${LC_DATASET_PINS.revision.slice(0, 8)} — rerun lc fetch` };
  }
  return { ok: true, version: v };
}

let indexCache: { mtimeMs: number; entries: LcIndexEntry[] } | null = null;

/** Index rows, mtime-memoized — the app calls this per request safely. */
export function loadLcIndex(repoRoot: string): LcIndexEntry[] {
  const file = path.join(lcRoot(repoRoot), 'index.json');
  const mtimeMs = statSync(file).mtimeMs;
  if (indexCache && indexCache.mtimeMs === mtimeMs) return indexCache.entries;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('lc index.json is not an array — rerun lc fetch');
  const entries = parsed as LcIndexEntry[];
  indexCache = { mtimeMs, entries };
  return entries;
}

export function loadLcProblem(repoRoot: string, slug: string): LcProblem | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null; // slugs are path segments — gate them
  try {
    const p = JSON.parse(
      readFileSync(path.join(lcRoot(repoRoot), 'problems', `${slug}.json`), 'utf8'),
    ) as LcProblem;
    return typeof p?.slug === 'string' && typeof p?.entry_point === 'string' ? p : null;
  } catch {
    return null;
  }
}

/** Debug affordance: how many problem files exist on disk (lc list uses the
 *  index; this catches a half-published dir). */
export function countProblemFiles(repoRoot: string): number {
  try {
    return readdirSync(path.join(lcRoot(repoRoot), 'problems')).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/**
 * Slugs the full `lc verify --all-eligible` sweep proved un-convertible
 * (oracle disagreements, upstream data defects). Written by the sweep,
 * consulted by source binding — an eligible-by-metadata slug that failed
 * the mechanical proof must never reach a build. Absent file = no check
 * (the sweep is an ops step, not a hard install dependency).
 */
export function isBlocklisted(repoRoot: string, slug: string): boolean {
  try {
    const list = JSON.parse(
      readFileSync(path.join(lcRoot(repoRoot), 'blocklist.json'), 'utf8'),
    ) as { slugs?: string[] };
    return Array.isArray(list.slugs) && list.slugs.includes(slug);
  } catch {
    return false;
  }
}
