/**
 * Off-box backup of the data that cannot be regenerated.
 *
 *   gaps/ topics/ traces/ feedback/ targets/ assessments/ reps.json reps/
 *        │  tar -czf (excludes node_modules, __pycache__, snapshots)
 *        ▼
 *   Supabase Storage: zenkai-backups/zenkai-<ISO>.tar.gz
 *        │  planRetention keeps the newest N, deletes the rest
 *        ▼
 *   one line of output naming the object and the prune
 *
 * Why it exists: everything else on the box is reproducible. The dataset is
 * a pinned download (`lc fetch`, ~2 min), problems are regenerable, the code
 * is in git. These directories are NOT — a gap graph is months of judged
 * sessions, the topic ledger is every LC attempt, traces are the raw record
 * both are derived from. db.ts mirrors reps/targets/sessions to Postgres but
 * NOT gaps or topics (verified 2026-08-13), and ops/ had no backup at all,
 * so a single disk failure on the CPX31 erased every user's memory layer
 * permanently.
 *
 * Deliberately a CLI subcommand rather than a shell script: cli.ts already
 * loads .env through process.loadEnvFile, which strips the trailing comments
 * that make `grep KEY .env | cut -d= -f2-` hand curl a 271-character
 * "key" — the exact trap docs/beta-runbook.md records costing an hour during
 * launch pre-flight, and the one this file's first draft fell into.
 *
 * Secrets are never included: .env is not in the list and never should be.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Irreplaceable, in the order a human would want them restored. */
export const BACKUP_PATHS = [
  'gaps',        // behavioral memory, per user
  'topics',      // LC attempt ledger, per user
  'traces',      // the raw record both graphs derive from
  'feedback',    // rendered cards (carry user_id ownership)
  'assessments', // git-tracked too, but cheap and keeps a restore self-contained
  'targets',     // plans, queues, blueprints, learnings.md
  'reps.json',   // the practice-door index
  'reps',        // consumed artifacts are irreplaceable (generation is nondeterministic); pristine tarballs + run-tree archives live here
] as const;

/** Bulk that is regenerable or machine-local — never worth the bytes. */
const TAR_EXCLUDES = [
  'node_modules', '__pycache__', '.session-snapshot', '.ide-data',
  '*.pyc', '.vitest-report.json', '.linux-deps-ok',
];

export const DEFAULT_BUCKET = 'zenkai-backups';
export const DEFAULT_KEEP = 14;

/** UTC, filename-safe, lexically sortable — the sort IS the retention order. */
export function backupName(now: number): string {
  return `zenkai-${new Date(now).toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}.tar.gz`;
}

/**
 * Which objects to delete so `keep` newest survive. Pure and total: names
 * that do not match the backup pattern are IGNORED, never deleted — a
 * shared bucket must not lose unrelated objects to a retention sweep.
 */
export function planRetention(names: string[], keep: number): string[] {
  const mine = names.filter((n) => /^zenkai-.*\.tar\.gz$/.test(n)).sort();
  return keep <= 0 ? [] : mine.slice(0, Math.max(0, mine.length - keep));
}

export interface BackupConfig {
  supabaseUrl: string;
  serviceKey: string;
  bucket?: string;
  keep?: number;
}

async function sb(cfg: BackupConfig, method: string, apiPath: string, body?: BodyInit, extra?: Record<string, string>) {
  const res = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, '')}${apiPath}`, {
    method,
    headers: {
      apikey: cfg.serviceKey,
      authorization: `Bearer ${cfg.serviceKey}`,
      ...(extra ?? {}),
    },
    ...(body ? { body } : {}),
  });
  return res;
}

/** Create the bucket when absent. Private: these are user transcripts. */
async function ensureBucket(cfg: BackupConfig, bucket: string): Promise<void> {
  const list = await sb(cfg, 'GET', '/storage/v1/bucket');
  if (list.ok) {
    const buckets = (await list.json()) as { name?: string }[];
    if (buckets.some((b) => b.name === bucket)) return;
  }
  const made = await sb(cfg, 'POST', '/storage/v1/bucket', JSON.stringify({ name: bucket, public: false }), {
    'content-type': 'application/json',
  });
  if (!made.ok && made.status !== 409) {
    throw new Error(`could not create bucket "${bucket}": ${made.status} ${(await made.text()).slice(0, 200)}`);
  }
}

/**
 * Tar the irreplaceable dirs, upload, prune. Returns a one-line summary.
 * Throws on any failure — a backup that half-worked must exit non-zero so
 * the timer surfaces it rather than reporting success.
 */
export async function runBackup(
  repoRoot: string,
  cfg: BackupConfig,
  now: number = Date.now(),
): Promise<string> {
  const bucket = cfg.bucket ?? DEFAULT_BUCKET;
  const keep = cfg.keep ?? DEFAULT_KEEP;
  const present = BACKUP_PATHS.filter((p) => existsSync(path.join(repoRoot, p)));
  if (present.length === 0) throw new Error('nothing to back up — no data directories present');

  const work = mkdtempSync(path.join(tmpdir(), 'zenkai-backup-'));
  const name = backupName(now);
  const archive = path.join(work, name);
  try {
    const tar = spawnSync(
      'tar',
      ['-czf', archive, ...TAR_EXCLUDES.flatMap((e) => ['--exclude', e]), '-C', repoRoot, ...present],
      { encoding: 'utf8', timeout: 10 * 60_000 },
    );
    if (tar.status !== 0) throw new Error(`tar failed: ${(tar.stderr ?? '').slice(0, 300)}`);
    const bytes = statSync(archive).size;

    await ensureBucket(cfg, bucket);
    const up = await sb(cfg, 'POST', `/storage/v1/object/${bucket}/${name}`, readFileSync(archive), {
      'content-type': 'application/gzip',
      'cache-control': '3600',
    });
    if (!up.ok) throw new Error(`upload failed: ${up.status} ${(await up.text()).slice(0, 200)}`);

    // Prune oldest beyond `keep`. A failure here is logged, not fatal: the
    // backup already landed, which is the point of the run.
    let pruned = 0;
    try {
      const listed = await sb(cfg, 'POST', `/storage/v1/object/list/${bucket}`, JSON.stringify({ limit: 1000, prefix: '' }), {
        'content-type': 'application/json',
      });
      if (listed.ok) {
        const objects = (await listed.json()) as { name: string }[];
        const doomed = planRetention(objects.map((o) => o.name), keep);
        if (doomed.length) {
          const del = await sb(cfg, 'DELETE', `/storage/v1/object/${bucket}`, JSON.stringify({ prefixes: doomed }), {
            'content-type': 'application/json',
          });
          if (del.ok) pruned = doomed.length;
        }
      }
    } catch (e) {
      console.warn(`[backup] prune skipped: ${String(e).slice(0, 160)}`);
    }

    const mb = (bytes / 1_048_576).toFixed(1);
    return `backed up ${present.length} path(s), ${mb}MB → ${bucket}/${name}${pruned ? ` (pruned ${pruned} old)` : ''}`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
