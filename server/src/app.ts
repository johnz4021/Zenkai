/**
 * The home app — the persistent surface that exists when no session does.
 *
 *   :3300  targets · intake · per-target queues · launch
 *   :3200  session (spawned per round, owns its own lifecycle)
 *   :3100  IDE container (owned by the session process)
 *
 * The app holds NO authoritative state in memory: every /api/state call
 * reconciles queue statuses from disk (.validated, .used, assessments/) and
 * saves what changed. Killing and restarting the app is always safe — the
 * worst case is a stale page until the next poll.
 *
 * Sessions are separate processes on purpose: a session crash cannot take
 * the app down, and the session keeps sole ownership of the container and
 * port 3200 (assertPortFree guards the double-launch case).
 */

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDimensionKey, validateRoundSpec, type GeneratedProblem, type RoundSpec } from '@interview-prep/shared';
import { ATTACHMENT_MEDIA_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, listTargets, loadTarget, pickSpecInferrer, saveTarget, slugify, targetDir, type SpecDraft, type Target } from './intake.js';
import { bucketIntoDays, loadQueue, nextUp, proposeQueue, reconcileWithDisk, repace, saveQueue, type Queue, type QueueItem } from './queue.js';
import { buildGraphView, gapDescription, loadStore } from './gap-graph.js';
import { mergeConfirm } from './feedback.js';
import { loadTopicLog, rollupTopics } from './topic-log.js';
import { applyAdaptation, pickAdapter, planAdaptation, reconcileAdaptation, retiredSpecIds, type AdaptDiff } from './adapt.js';
import { appendLearnings, gateBlueprint, loadBlueprint, writeBlueprintWithBackup } from './blueprint.js';
import { clearGeneratingMarker, generationProgress, pidAlive, readGeneratingMarker, sweepVerdict, writeGeneratingMarker } from './generation-state.js';
import { pickTopicNamer } from './plan-topics.js';
import { clientScript } from './chrome.js';
import { authConfigFromPublic, makeAuth } from './auth.js';
import { childEnv } from './child-env.js';
import { makeDb, repRow, sessionRow, targetRow, type SessionRow } from './db.js';
import { applyReaping, gatherRepDiskFacts, planReaping } from './retention.js';
import {
  preserveRunTree,
  pristineArchivePath,
  restorability,
  restoreFromSnapshot,
  restorePristine,
} from './artifact.js';
import { makeSessionRouter } from './session-router.js';
import { applySessionSweep, listSessionContainers, planSessionSweep } from './session-sweep.js';
import {
  allocateSlot,
  launchVerdict2,
  loadRegistry,
  newSessionId,
  reconcileEntries,
  saveRegistry,
} from './session-registry.js';
import type { PublicConfig } from './public-config.js';
import {
  isHandledEvent,
  periodStart,
  rowFromSubscription,
  subscribed,
  type SubscriptionRow,
} from './billing.js';
import {
  countPlans,
  roundsUsed,
  expectedText,
  gateVerdict,
  grantsAccess,
  hasGrant,
  probeAction,
  type GateView,
  type PaywallRow,
} from './paywall.js';
import {
  acquireRepLock,
  admissionVerdict,
  createRepRecord,
  repOwnedBy,
  repsVisibleTo,
  gateRepInput,
  launchVerdict,
  loadReps,
  REP_ID_RE,
  repeatVerdict,
  repProblemDir,
  repStateView,
  retryVerdict,
  saveReps,
  sweepReps,
  type Rep,
} from './reps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export interface AppConfig {
  port: number;
  sessionPort: number;
  userId: string;
  /** Browser-facing origins + beta knobs; resolvePublicConfig({}) ≡ pre-beta. */
  pub: PublicConfig;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => resolve(body));
  });
}

/** Probe the session server. `reachable` = something answered on the port;
 *  `live` = answered AND not ended. The distinction is ISSUE-001's fix: a
 *  graded session's server lingers to keep serving the card, and treating
 *  its 200 as "live" soft-locked every future launch. Probed, never
 *  remembered. */
/**
 * Multi-session manager (WU-D, TODOS #22). Registry on disk is truth; every
 * read reconciles against live probes + pids, same discipline as the queue's
 * marker files. Launches serialize behind a promise mutex: verdict →
 * allocate → spawn → append+persist runs with NO awaits between allocate and
 * persist, so two concurrent launches cannot pick one slot — and the entry
 * always exists before the container it names is born (the orphan-container
 * sweep depends on that ordering).
 */
let launchChain: Promise<void> = Promise.resolve();

async function reconcileRegistryNow(): Promise<import('./session-registry.js').Registry> {
  const reg = loadRegistry(repoRoot);
  const probes = new Map<string, import('./session-registry.js').ProbeResult>();
  await Promise.all(
    reg.entries.map(async (e) => {
      const p = await probeSession(e.port);
      probes.set(e.sid, { reachable: p.reachable, ended: p.ended, session_id: p.session_id });
    }),
  );
  const out = reconcileEntries(reg.entries, probes, pidAlive, Date.now());
  if (out.changed) saveRegistry(repoRoot, { entries: out.entries });
  return { entries: out.entries };
}

/** Server-to-server auth for the session probes below. Set once in runApp;
 *  stable across app restarts (derived, not random) so a session spawned by
 *  a previous app process still honors it. */
let internalHeaders: Record<string, string> = {};
/** The pre-beta/local owner id (cfg.userId), for the module-level spawn
 *  helpers that run outside runApp's closure. Set once in runApp. */
let legacyUserId = 'u1';

function probeSession(port: number): Promise<{ reachable: boolean; ended: boolean; session_id: string | null; user_id: string | null }> {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1_000, headers: internalHeaders }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { ended?: boolean; session_id?: string; user_id?: string };
          resolve({
            reachable: res.statusCode === 200,
            ended: Boolean(parsed.ended),
            session_id: parsed.session_id ?? null,
            user_id: parsed.user_id ?? null,
          });
        } catch {
          resolve({ reachable: res.statusCode === 200, ended: false, session_id: null, user_id: null });
        }
      });
    });
    r.on('error', () => resolve({ reachable: false, ended: false, session_id: null, user_id: null }));
    r.on('timeout', () => {
      r.destroy();
      resolve({ reachable: false, ended: false, session_id: null, user_id: null });
    });
  });
}

/** Is a session actually running (not a lingering graded server)? */
async function sessionLive(port: number): Promise<boolean> {
  const p = await probeSession(port);
  return p.reachable && !p.ended;
}

/** The live session's owner (session /api/status user_id), or null when no
 *  session answers / the field is absent (pre-beta session process). */
function probeSessionOwner(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1_000, headers: internalHeaders }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(((JSON.parse(body) as { user_id?: string }).user_id) ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => {
      r.destroy();
      resolve(null);
    });
  });
}

/** POST to the session server; ok=false on any failure. */
function postSession(port: number, apiPath: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: apiPath, method: 'POST', timeout: 5_000, headers: internalHeaders },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: (res.statusCode ?? 500) < 300 }));
      },
    );
    r.on('error', () => resolve({ ok: false }));
    r.on('timeout', () => {
      r.destroy();
      resolve({ ok: false });
    });
    r.end();
  });
}

/** Problem dirs with a generation child alive in THIS app process. Used
 *  only to tell "in progress" from "orphaned" — all authoritative state
 *  stays on disk (.validated / .failed markers). */
const liveGenerations = new Set<string>();

/** The soonest date any of this target's rounds happens — spec dates first,
 *  the target's single date as fallback. Drives index ordering. */
function nearestDeadline(t: {
  interview_date?: string | null;
  specs: { date?: string | null }[];
}): string | undefined {
  let min: string | undefined;
  for (const s of t.specs) {
    const d = s.date ?? t.interview_date;
    if (d && (!min || d < min)) min = d;
  }
  return min ?? t.interview_date ?? undefined;
}

/** Attachment validation shared by /api/target and /api/practice/clarify:
 *  count, media-type allowlist, non-empty, 10MB cap, name trimmed. Byte-
 *  identical to the original /api/target loop it was extracted from. */
function decodeAttachments(
  incoming: { name?: string; media_type?: string; data?: string }[],
): { decoded: { name: string; media_type: string; bytes: Buffer }[] } | { error: string } {
  if (incoming.length > MAX_ATTACHMENTS) {
    return { error: `${incoming.length} attachments — max ${MAX_ATTACHMENTS}` };
  }
  const decoded: { name: string; media_type: string; bytes: Buffer }[] = [];
  for (const a of incoming) {
    const mediaType = a.media_type ?? '';
    if (!ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
      return { error: `"${a.name ?? 'file'}": unsupported type ${mediaType || '(none)'} — images and PDFs only` };
    }
    const bytes = Buffer.from(a.data ?? '', 'base64');
    if (bytes.length === 0) return { error: `"${a.name ?? 'file'}" is empty` };
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return { error: `"${a.name ?? 'file'}" is ${Math.round(bytes.length / 1024 / 1024)}MB — max 10MB` };
    }
    decoded.push({ name: (a.name ?? 'attachment').slice(0, 120), media_type: mediaType, bytes });
  }
  return { decoded };
}

/** The typed content blocks attachmentBlocks() builds from a target's disk —
 *  built here straight from request memory instead: reps never persist
 *  attachments (no re-draft path exists to re-read them). */
function attachmentBlocksFromDecoded(
  decoded: { name: string; media_type: string; bytes: Buffer }[],
): Record<string, unknown>[] {
  return decoded.map((d) =>
    d.media_type === 'application/pdf'
      ? {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: d.bytes.toString('base64') },
          title: d.name,
          citations: { enabled: true },
        }
      : {
          type: 'image',
          source: { type: 'base64', media_type: d.media_type, data: d.bytes.toString('base64') },
        },
  );
}

/** One durable line per session launch — the falsifier's data (2026-08-10
 *  CEO review: if plan-queue launches dominate, the composer landing is
 *  optimizing for the wrong user). Origin is sanitized to the known call-site
 *  values ('repeat' joined them with practice-again, which must be countable
 *  separately from a first run); console scrollback is not a metric, a JSONL
 *  file is. */
function logLaunch(origin: unknown, sessionId: string): void {
  const o = origin === 'repeat' || origin === 'plans' || origin === 'practice' ? origin : 'unknown';
  try {
    appendFileSync(
      path.join(repoRoot, 'launches.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), origin: o, session_id: sessionId }) + '\n',
    );
  } catch {
    /* metrics never block a launch */
  }
}

/** One durable line per willingness-to-pay probe event (paywall.ts) — the
 *  same falsifier discipline as logLaunch above, and for the same reason:
 *  scrollback is not a metric.
 *
 *  Two deliberate divergences from logLaunch. It records `user_id` (and the
 *  email, at n≈10, because you will want to follow up): the unit of analysis
 *  is a PERSON, so one user shown the price four times is one data point, not
 *  four, and only an identity makes that dedup possible at read time. And the
 *  price and threshold come from the SERVER's own config, never the request
 *  body, so a crafted POST cannot fabricate a data point. */
function logPaywall(row: Record<string, unknown>): void {
  try {
    appendFileSync(path.join(repoRoot, 'paywall.jsonl'), JSON.stringify(row) + '\n');
  } catch {
    /* metrics never block a launch */
  }
}

/** The grant ledger, read back. Same torn-tail-tolerant shape as readRuns
 *  (artifact.ts:272) and loadConversation (planner.ts:57): an absent file is
 *  `[]`, and a half-written last line from a crash mid-append is skipped
 *  rather than throwing.
 *
 *  Note what "absent is []" means here: a lost paywall.jsonl reads as NO
 *  grants, so a previously-granted user is gated again. That is not fail-open,
 *  it is recoverable-closed — they press Subscribe a second time, and
 *  dedup-by-user_id at read time absorbs the duplicate row. */
function readPaywallRows(): PaywallRow[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoRoot, 'paywall.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: PaywallRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as PaywallRow;
      if (typeof e.action === 'string') out.push(e);
    } catch {
      /* torn last line from a crash mid-append proves nothing — skip it */
    }
  }
  return out;
}

/** One append-only line per subscription state change (billing.ts). Same
 *  discipline as logPaywall above, and written SYNCHRONOUSLY for a sharper
 *  reason: confirm-on-return responds the instant this returns and the client
 *  retries the gated action immediately — an async append would race it. */
function logSubscription(row: SubscriptionRow): void {
  try {
    appendFileSync(path.join(repoRoot, 'subscriptions.jsonl'), JSON.stringify(row) + '\n');
  } catch (e) {
    // Unlike a metric, losing this loses a paying customer's entitlement.
    // Say so loudly rather than swallowing it the way logPaywall does.
    console.error('[billing] FAILED to record subscription row:', String(e).slice(0, 200));
  }
}

/** The subscription ledger, read back. Torn-tail-tolerant, same shape as
 *  readPaywallRows and readRuns (artifact.ts): an absent file is `[]` and a
 *  half-written last line is skipped. Absent means nobody is subscribed,
 *  which is exactly right on a box with billing switched off. */
function readSubscriptionRows(): SubscriptionRow[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(repoRoot, 'subscriptions.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: SubscriptionRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SubscriptionRow;
      if (typeof e.user_id === 'string' && typeof e.status === 'string') out.push(e);
    } catch {
      /* torn last line from a crash mid-append proves nothing — skip it */
    }
  }
  return out;
}

/** Raw request bytes, for Stripe webhook signature verification.
 *
 *  Deliberately NOT readBody: that accumulates with `body += d`, which decodes
 *  each chunk as UTF-8. Stripe's payloads are UTF-8 JSON so it would usually
 *  work — but a signature is computed over BYTES, and "usually" is the wrong
 *  standard for the check that decides whether a request is genuinely Stripe. */
function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer | string) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Stable label so these Checkout Sessions group together in the Stripe
 *  Dashboard. The 8-letter suffix is fixed, not generated per boot — a
 *  per-restart value would fragment the grouping it exists to provide. */
const STRIPE_INTEGRATION_ID = 'zenkai-paywall-gate-qkzmwrvp';

/** Lazily loaded and cached. `import()` rather than a top-level import so a
 *  box with billing off never loads the SDK — the same shape
 *  `@anthropic-ai/sdk` is used with elsewhere here. */
let stripeCached: { key: string; client: import('stripe').Stripe } | null = null;
async function stripeClient(apiKey: string): Promise<import('stripe').Stripe> {
  if (stripeCached && stripeCached.key === apiKey) return stripeCached.client;
  const { default: Stripe } = await import('stripe');
  const client = new Stripe(apiKey, { apiVersion: '2026-07-29.dahlia' });
  stripeCached = { key: apiKey, client };
  return client;
}

function spawnDetached(args: string[], env: Record<string, string> = {}): number | null {
  // Diagnostics used to vanish with stdio:'ignore': an app-launched round's
  // [interviewer]/[intent]/judge failures left nothing on disk to read (QA
  // 2026-08-14 — a silent interviewer was undiagnosable without relaunching
  // from a terminal). One log per spawn under .ide-data/logs, named by the
  // session when the env names one. Best-effort: never blocks a launch.
  let out: number | 'ignore' = 'ignore';
  try {
    const logDir = path.join(repoRoot, '.ide-data', 'logs');
    mkdirSync(logDir, { recursive: true });
    out = openSync(path.join(logDir, `${env.IP_SESSION_ID ?? `${args[0] ?? 'spawn'}-${Date.now()}`}.log`), 'w');
  } catch { /* fall back to ignore */ }
  const child = spawn('npx', ['tsx', path.join(repoRoot, 'server', 'src', 'cli.ts'), ...args], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', out, out],
    // WU8: sessions need both API keys; the DB service key reaches no child.
    env: childEnv('session', process.env, env),
  });
  child.unref();
  if (typeof out === 'number') {
    try { closeSync(out); } catch { /* child holds its own copy */ }
  }
  return child.pid ?? null;
}

/** Build output goes to `<dir>.build.log` — BESIDE the problem dir, never
 *  inside it: the dir reaches the candidate's IDE and generation output
 *  discusses the planted bug. Truncated per attempt so the log is always
 *  the latest build's. Forced by rep-msnrmt0d (2026-08-10): a build died
 *  partway with stdio ignored and left nothing to diagnose. */
function openBuildLog(dir: string): number {
  return openSync(dir + '.build.log', 'w');
}

/** Generation spawn with failure bookkeeping: a non-zero exit writes a
 *  .failed marker into the item dir so reconcile derives `failed` and the
 *  timeline can offer retry — a silent stuck "generating" row was the
 *  design review's exact never-silent rule. */
/** Builds generating RIGHT NOW across reps and every target queue —
 *  disk-derived (markers via reconcile), never from memory, so an app
 *  restart can't forget a detached opus run when enforcing the cap. */
function countLiveBuilds(): number {
  let n = 0;
  try {
    const reps = reconcileWithDisk(repoRoot, loadReps(repoRoot)) as ReturnType<typeof loadReps>;
    n += reps.items.filter((i) => i.status === 'generating').length;
  } catch { /* unreadable reps file: count what we can */ }
  for (const t of listTargets(repoRoot)) {
    try {
      const q = loadQueue(repoRoot, t.id);
      if (q) n += reconcileWithDisk(repoRoot, q).items.filter((i) => i.status === 'generating').length;
    } catch { /* skip a broken queue, never block the gate on it */ }
  }
  return n;
}

function spawnGeneration(target: Target, item: QueueItem, dir: string): void {
  const args = ['generate-for', target.id, item.spec_id, '--into', dir];
  // Sourced items skip --title: the LC title must not become the manifest
  // title in skinned mode (the title-commitment line would defeat the skin);
  // the generator names its own skin instead. Sets ride as comma slugs, in
  // part order (escalation already applied by the binder).
  if (item.source?.kind === 'leetcode') {
    const slugs = (item.source.parts ?? [item.source]).map((p) => p.slug).join(',');
    args.push('--source', `lc:${slugs}`);
  } else if (item.planned_title) args.push('--title', item.planned_title);
  liveGenerations.add(dir);
  mkdirSync(dir, { recursive: true });
  const logFd = openBuildLog(dir);
  const child = spawn('npx', ['tsx', path.join(repoRoot, 'server', 'src', 'cli.ts'), ...args], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // The generator's targeting note reads the OWNER's gap graph.
    env: childEnv('generator', process.env, { IP_USER_ID: target.user_id ?? legacyUserId }),
  });
  child.unref();
  // Disk-derived liveness (ISSUE-003): the marker carries {pid, started_at}
  // so an app restart can tell a healthy detached generation from a true
  // orphan — and the UI gets an honest start time.
  if (child.pid) writeGeneratingMarker(dir, child.pid);
  child.on('close', (code) => {
    closeSync(logFd);
    liveGenerations.delete(dir);
    clearGeneratingMarker(dir);
    if (code !== 0 && !existsSync(path.join(dir, '.validated'))) {
      writeFileSync(path.join(dir, '.failed'), `exit ${code} at ${new Date().toISOString()}; output in ${dir}.build.log\n`);
      console.warn(`[app] generation failed for ${item.id} (exit ${code})`);
    }
  });
}

/** Rep build spawn — same failure bookkeeping as spawnGeneration, but the
 *  child is `rep-build` (drafts the blueprint, then generates) and the log
 *  lines are rep-shaped: a rep has no target/item pair to interpolate. */
function spawnRepBuild(rep: Rep): void {
  const dir = repProblemDir(repoRoot, rep.id);
  liveGenerations.add(dir);
  mkdirSync(dir, { recursive: true });
  const logFd = openBuildLog(dir);
  const child = spawn('npx', ['tsx', path.join(repoRoot, 'server', 'src', 'cli.ts'), 'rep-build', rep.id], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // The rep creator's gap graph steers the blueprint's emphasis.
    env: childEnv('generator', process.env, { IP_USER_ID: rep.user_id ?? legacyUserId }),
  });
  child.unref();
  // Marker at REQUEST time with the child's pid — drafting happens inside
  // this child, so one pid honestly covers both phases and the wait UI's
  // elapsed includes the ~30s draft (design decision 4A/T6).
  if (child.pid) writeGeneratingMarker(dir, child.pid);
  child.on('close', (code) => {
    closeSync(logFd);
    liveGenerations.delete(dir);
    clearGeneratingMarker(dir);
    if (code !== 0 && !existsSync(path.join(dir, '.validated')) && !existsSync(path.join(dir, '.failed'))) {
      writeFileSync(path.join(dir, '.failed'), `exit ${code} at ${new Date().toISOString()}; output in ${dir}.build.log\n`);
      console.warn(`[app] rep ${rep.id} build failed (exit ${code})`);
    }
  });
}

/** App restart while a generation was mid-flight: probe the marker's pid
 *  before judging (ISSUE-003 — the old sweep trusted an in-memory Set that
 *  restarts empty, and marked HEALTHY generations failed while their agent
 *  kept writing; a retry click then would have double-generated into the
 *  same directory). Liveness is injectable for tests. */
function sweepOrphanedGenerations(isAlive: (pid: number) => boolean = pidAlive): void {
  for (const t of listTargets(repoRoot)) {
    const q = loadQueue(repoRoot, t.id);
    if (!q) continue;
    for (const item of q.items) {
      if (item.status !== 'generating' || !item.problem_dir) continue;
      const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
      if (liveGenerations.has(dir)) continue;
      const marker = readGeneratingMarker(dir);
      const verdict = sweepVerdict({
        marker,
        alive: marker ? isAlive(marker.pid) : false,
        hasTerminalMarker:
          existsSync(path.join(dir, '.validated')) || existsSync(path.join(dir, '.failed')),
      });
      if (verdict === 'clear-marker') {
        clearGeneratingMarker(dir);
      } else if (verdict === 'fail') {
        clearGeneratingMarker(dir);
        writeFileSync(path.join(dir, '.failed'), `orphaned by app restart at ${new Date().toISOString()}\n`);
        console.warn(`[app] ${t.id}/${item.id} orphaned by restart — marked failed (retryable)`);
      } else {
        console.log(`[app] ${t.id}/${item.id} still generating (pid ${marker!.pid} alive) — left alone`);
      }
    }
  }
  // The reps half: same verdicts, rep-shaped logs. Without this loop a rep
  // orphaned by a restart would show "building" forever — the exact failure
  // class generation-state.ts was written to kill, reintroduced through a
  // door the sweep never knew about (CEO review GAP 1A).
  for (const line of sweepReps(repoRoot, loadReps(repoRoot), isAlive, liveGenerations)) {
    console.warn(line);
  }
}

/** Display title for an item: the generated problem's own name wins, the
 *  planned title promises it, the spec's first sentence is the legacy
 *  fallback. Never the "label — round N" string (the twelve-identical-rows
 *  bug the redesign exists to kill). */
/** Post-namer net (2026-08-13): a title that names a real problem both
 *  spoils the round pre-launch and drags that problem's difficulty into the
 *  build commitment against the blueprint's ("Two sum — hash table lookup"
 *  vs "LeetCode-medium", sess-1786643587196). Offenders become undefined —
 *  that item alone goes quiet — the rest land. Dataset absent = no check. */
async function stripSpoilerTitles(titles: string[]): Promise<(string | undefined)[]> {
  try {
    const lc = await import('./lc-source.js');
    if (!lc.lcReady(repoRoot).ok) return titles;
    const { titleSpoilsProblem } = await import('./lc-refs.js');
    const index = lc.loadLcIndex(repoRoot);
    return titles.map((title) => {
      if (titleSpoilsProblem(title, index)) {
        console.warn(`[app] title "${title}" names a real problem — dropped (quiet row)`);
        return undefined;
      }
      return title;
    });
  } catch {
    return titles;
  }
}

function resolveTitle(item: QueueItem): string | null {
  if (item.problem_dir) {
    const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
    const manifest = path.join(dir, 'problem.json');
    if (existsSync(manifest)) {
      try {
        const p = JSON.parse(readFileSync(manifest, 'utf8')) as GeneratedProblem;
        if (p.title) return p.title;
        const sentence = p.spec?.split(/[.!?]/)[0]?.trim();
        if (sentence) return sentence.length > 60 ? `${sentence.slice(0, 57)}…` : sentence;
      } catch {
        /* half-written manifest mid-generation */
      }
    }
  }
  // A bound-but-unbuilt item: display follows provenance. The candidate
  // NAMED a user pick, so its real title is theirs to see; an auto pick
  // stays hidden — the reskin is what keeps the round fresh, and the plan
  // view is read the night before.
  if (item.source) {
    const parts = item.source.parts ?? [item.source];
    const named = parts.filter((p) => p.picked_by === 'user');
    if (parts.length === 1) {
      return item.source.picked_by === 'user'
        ? `${item.source.title} · ${item.source.difficulty} · from the real set`
        : `sourced · ${item.source.difficulty} — revealed when the round starts`;
    }
    if (named.length) {
      const extra = parts.length - named.length;
      return `${named.map((p) => p.title).join(', ')}${extra ? ` + ${extra} more` : ''} · from the real set`;
    }
    return `${parts.length} from the real set — revealed when the round starts`;
  }
  return item.planned_title ?? null;
}

/** Reconcile a target's queue with disk, re-pace, persist if changed, and
 *  auto-kick generation for the next pending item when nothing is in
 *  flight — the queue-driven successor of prepareNext. */
function refreshQueue(target: Target, userId: string, now: number): Queue | null {
  const stored = loadQueue(repoRoot, target.id);
  if (!stored) return null;
  const view = (() => {
    try {
      return buildGraphView(loadStore(path.join(repoRoot, 'gaps'), userId));
    } catch {
      return null;
    }
  })();
  // Crash repair first (D3): an adapt writes target.json before
  // queue.json, so a death between the writes leaves the record ahead of
  // the queue — re-apply the recorded re-points before anything renders.
  const healed = reconcileAdaptation(target, stored) ?? stored;
  const fresh = repace(reconcileWithDisk(repoRoot, healed), target, view, now);

  // Generation is USER-INITIATED (user decision 2026-08-01: no auto-kick).
  // The app never spends a generation the candidate didn't ask for —
  // /api/generate is the only path in. This also caps the unmetered-spend
  // exposure TODOS #12 describes.
  if (JSON.stringify(fresh) !== JSON.stringify(stored)) saveQueue(repoRoot, fresh);
  return fresh;
}

/**
 * The page (design review 2026-07-31, approved mockups firstrun-E-attach +
 * variant-C/A). Two sections, client-toggled: #entry — the first-run screen
 * where the screen IS the input — and #seasons, the day-by-day timeline.
 * Markup here is skeleton + the entry form (real <label for> everywhere —
 * the shipped placeholder-as-label pattern was a hard-rule violation);
 * everything stateful renders client-side from /api/state.
 */
export function appPage(): string {
  return /* html */ `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Zenkai</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%230e0e0f'/%3E%3Cpath d='M42.8 56 L18.5 56 L19.85 42.5 L44.15 21.5 L36.5 42.5 L53.6 42.5 Z' fill='%23bf2b50'/%3E%3Cpath d='M19.85 42.5 L44.15 21.5 L36.5 42.5 Z' fill='%2399203f'/%3E%3Cpath d='M21.2 8 L45.5 8 L44.15 21.5 L19.85 42.5 L27.5 21.5 L10.4 21.5 Z' fill='%235099c2'/%3E%3Cpath d='M44.15 21.5 L19.85 42.5 L27.5 21.5 Z' fill='%2338708f'/%3E%3Cpath d='M44.15 21.5 L19.85 42.5' stroke='%230e0e0f' stroke-width='1.5'/%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    /* Graphite Steel (direction 3a). Brand plates survive at full saturation —
       the ONLY branded pixels in a monochrome shell. The mark is one ribbon
       folded into a Z, so each plate ships a lit face and the fold behind it;
       the pair is what makes the mark read as folded rather than drawn. */
    --plate-blue: #5099c2; --plate-blue-fold: #38708f;
    --plate-red: #bf2b50;  --plate-red-fold: #99203f;
    /* Ground: one tone-step per layer, no elevation. */
    --bg: #0e0e0f; --panel: #151517; --raised: #1d1e20; --sunk: #131314;
    --text-1: #f4f4f5; --text-2: #96979b; --text-3: #66676b;
    --line: #292a2c; --line-soft: #1c1c1e; --rule: #191919;
    /* Steel marks TIME and POSITION — never action, never grade, never identity. */
    --steel: #35708f; --steel-text: #7ea9c2;
    /* Grades: the only other saturation on screen. Shape backs up hue (■/◆/▫). */
    --ok: #5f9e7a; --weak: #e82b86; --weak-text: #ff6fae; --none: #4a4b4f;
    --mono: 'JetBrains Mono', ui-monospace, monospace;
    --rail: 93px; /* x of the timeline spine: date col 74 + gap 14 + dot half */
  }
  * { box-sizing: border-box; }
  /* The hidden attribute is only a UA display:none, so ANY display rule of our
     own outranks it and the "hidden" element keeps its box. #practice carries
     display:flex to center its hero, which meant a hidden #practice still held
     411px above the login screen on the live box. Every route toggle in the
     client sets .hidden, so one specificity slip anywhere silently strands
     content on screen — this makes the attribute mean what it says.
     (No backticks in this block: the stylesheet is a TS template literal.) */
  [hidden] { display: none !important; }
  html { background: var(--bg); }
  body {
    margin: 0 auto; max-width: 760px; padding: 40px 20px 64px;
    font: 14px/1.55 'Archivo', system-ui, sans-serif;
    background: var(--bg); color: var(--text-1);
    min-height: 100vh;
  }
  ::selection { background: var(--steel); color: #fff; }

  .micro { font-family: var(--mono); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .18em; color: var(--text-3); margin: 0 0 18px; }
  .meta { color: var(--text-2); }
  .err { color: var(--weak-text); }
  a { color: inherit; }
  /* ---- masthead: the one persistent chrome ---- */
  nav {
    display: flex; justify-content: space-between; align-items: center;
    gap: 16px; margin: 0 -20px 30px; padding: 0 20px 16px;
    position: sticky; top: 0; z-index: 10;
    background: var(--bg); border-bottom: 1px solid var(--line-soft);
  }
  nav a { text-decoration: none; }
  /* Lockup: mark and wordmark side by side. The plates keep full saturation —
     deliberately the only branded pixels in the graphite shell. The wordmark
     is Archivo in sentence case, NOT mono caps: mono is reserved for micro
     labels and instrument readouts (DESIGN.md, Type), and the shipped
     mono-caps wordmark was that rule's one standing violation. */
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand svg { display: block; height: 30px; width: auto; }
  .brand .plate-blue { fill: var(--plate-blue); }
  .brand .plate-blue-fold { fill: var(--plate-blue-fold); }
  .brand .plate-red { fill: var(--plate-red); }
  .brand .plate-red-fold { fill: var(--plate-red-fold); }
  /* The fold gap is ground showing through, not a drawn line — so it tracks
     --bg and stays invisible as a shape if the ground ever moves. */
  .brand .seam { stroke: var(--bg); }
  .brand .word {
    font-size: 20px; font-weight: 500; letter-spacing: -.005em;
    line-height: 1; color: var(--text-1);
    transition: color .18s;
  }
  #nav-home:hover .word { color: #fff; }
  .navright { display: flex; align-items: center; gap: 18px; }
  #nav-live { display: none; align-items: center; gap: 7px; color: var(--steel-text); font-size: 12px; font-family: var(--mono); }
  #nav-live.on { display: flex; }
  #nav-kill { display: none; color: var(--text-2); font-size: 12px; }
  #nav-kill.on { display: inline; }
  #nav-kill:hover { color: var(--weak-text); }
  #nav-live .pulse { width: 6px; height: 6px; background: var(--steel-text); animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
  /* The tabs (composer-first IA, 2026-08-10). The daily action IS the page
     under the wordmark now; plans and history are secondary destinations.
     Active tab = 2px steel underline — steel marks POSITION, never action.
     The attribute selector outranks the nav-wide text-decoration reset. */
  #nav-practice, #nav-plans, #nav-history { color: var(--text-2); font-size: 12px; transition: color .18s; }
  #nav-practice:hover, #nav-plans:hover, #nav-history:hover { color: var(--text-1); }
  .navright a[aria-current="page"] {
    color: var(--text-1);
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 6px;
    text-decoration-color: var(--steel);
  }

  /* ---- the practice door (design review 2026-08-08, approved mockup) ---- */
  #practice-wrap { max-width: 62ch; margin: 0 auto; }
  #practice-wrap .micro { margin-bottom: 10px; }
  /* The landing composes VERTICALLY: the empty field is deliberate framing,
     not leftover space — the hero block floats at the visual center until
     content (confirm/wait) grows past it. */
  #practice {
    min-height: calc(100vh - 240px);
    display: flex; flex-direction: column; justify-content: center;
  }
  /* The landing hero: the a11y label IS the heading (real-labels rule) —
     the page's voice, centered over the instrument. */
  #practice-wrap .hero { margin: 0 0 30px; text-align: center; }
  #practice-wrap .hero label {
    display: inline; margin: 0;
    font-size: 38px; font-weight: 500; letter-spacing: -.015em;
    line-height: 1.2; color: var(--text-1);
  }
  /* The one status line beneath the composer. Steel-TEXT on the countdown
     (time in its readable tier — raw steel fails contrast on the ground).
     The container keeps the body font-size so 62ch computes the SAME width
     as the composer wrap — the inner line drops to 12px. */
  #home-status { max-width: 62ch; margin: 0 auto; color: var(--text-2); }
  /* The readout strip: the status sentence spoken in the system's own
     instrument voice — mono micro, centered under the composer. Same JS
     strings; the telemetry look is pure presentation. */
  #home-status .statusline {
    margin-top: 22px; text-align: center;
    font-family: var(--mono); font-size: 11px; font-weight: 500;
    text-transform: uppercase; letter-spacing: .14em; color: var(--text-2);
  }
  #home-status .statusline > div + div { margin-top: 7px; }
  #home-status a { color: var(--text-2); text-decoration: none; }
  #home-status a:hover { color: var(--text-1); }
  /* The composer is ONE instrument: a single frame holding the borderless
     textarea and its footer row (affordances left, the action right). Focus
     lifts the whole frame's hairline to steel — the established focus
     convention, applied to the unit the user is actually operating. */
  .composer-frame {
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    transition: border-color .18s;
  }
  .composer-frame:focus-within { border-color: var(--steel); }
  #rep-paste {
    width: 100%; min-height: 132px; resize: vertical; display: block;
    background: transparent; color: var(--text-1); border: 0;
    padding: 16px 18px 8px; font: inherit; font-size: 15px; line-height: 1.6;
  }
  #rep-paste::placeholder { color: var(--text-3); }
  .composer-foot {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 8px 10px 10px 18px;
  }
  .composer-foot .quiet-affordances { font-size: 12px; color: var(--text-3); }
  .composer-foot .quiet-affordances a { color: var(--text-2); text-decoration: none; }
  .composer-foot .quiet-affordances a:hover { color: var(--text-1); }
  /* The readback: ONE chevron select for the closed vocabulary; open prose
     values were real inputs styled flat — affordance matches constraint (D4).
     Superseded 2026-08-12 by the gap-derived confirm screen: #rep-confirm is
     a two-column grid AT 760px (decision 5A — the rail is ~220px and the
     question column ~500px, the planner chat's own 62ch measure). DOM order
     puts the question column FIRST (tab order follows the task, pass 6);
     the grid places the rail visually left, and narrow widths stack the
     rail ABOVE via order (the readback reads before the questions). */
  /* The grid BREAKS OUT of #practice-wrap's 62ch composer measure to the full
     760px shell. Left inside 62ch the question column resolved to 249px, not
     the ~500px decision 5A sized it for, and every question wrapped into a
     tall narrow block (QA 2026-08-12, ISSUE-002). The composer keeps 62ch —
     that calm center is the approved landing (2026-08-10); only the confirm
     step needs two columns. Symmetric negative inline margins, so the grid
     stays centered on the same axis as the composer. */
  #rep-confirm {
    display: grid; grid-template-columns: 220px minmax(0, 1fr);
    gap: 4px 28px; margin-top: 22px; align-items: start;
    margin-inline: calc((720px - 100%) / -2);
  }
  /* Row 2 holds the columns; the commit band takes row 1 (below). The
     columns are LAST in visual order but the questions stay first in the
     DOM, so tab order still hits the task before the action (pass 6). */
  #rep-rail { grid-column: 1; grid-row: 2; }
  #rep-open { grid-column: 2; grid-row: 2; }
  /* The commit BAND: spans both columns on grid row 1, above them (owner
     call 2026-08-15). Anything placed inside a column rides that column's
     length, and the rail runs ~70px per confirmed fact — eight facts put
     Start off-screen. Above the grid it costs the columns no width and its
     position never depends on how long either gets. What you're about to
     build reads on the left, the action sits right. */
  #rep-commit {
    grid-column: 1 / -1; grid-row: 1;
    display: flex; align-items: flex-end; gap: 24px;
    padding-bottom: 14px; margin-bottom: 10px; border-bottom: 1px solid var(--rule);
  }
  #rep-commit .commit-text { flex: 1; min-width: 0; }
  #rep-commit .rep-actions { flex: none; margin-top: 0; }
  #rep-commit #rep-brief { margin-top: 0; }
  /* Readiness is visible, never a gate: ready reads as the loud white
     primary, pending (re-checking, or questions still open) drops to a
     steel outline — still clickable, visibly not-yet-the-moment. */
  #rep-ready { font-size: 12px; margin-top: 12px; }
  #rep-ready.is-ready { color: var(--ok); }
  #rep-ready.is-pending { color: var(--steel-text); }
  button.primary.pending { background: transparent; border-color: var(--steel); color: var(--steel-text); font-weight: 500; }
  button.primary.pending:hover { background: transparent; border-color: var(--steel-text); color: var(--text-1); }
  @media (max-width: 760px) {
    /* Narrow: no breakout (it would overflow the shell), commit band on top,
       then the rail, then the questions. The band stacks (text over button)
       so a 44px Start never squeezes the brief into a column of one word. */
    #rep-confirm { display: flex; flex-direction: column; margin-inline: 0; }
    #rep-commit { order: -2; flex-direction: column; align-items: stretch; gap: 10px; }
    #rep-rail { order: -1; }
  }
  /* Rail rows are the editable readback (decision 1A) — compact by default
     (owner report 2026-08-15): always-open 44px controls made the rail
     outgrow the viewport and pushed Start below it. The value is a
     click-to-edit button; the boxed .gapedit control appears per-row on
     demand. .gaterow/.tier reuse the planner's chips and flash. */
  #rep-rail .gaterow { padding: 6px 2px; }
  #rep-rail .gaterow label { display: block; }
  /* Dotted underline = the clickability a borderless value would lack. */
  #rep-rail .gapval {
    display: block; width: 100%; text-align: left; background: none; border: 0;
    padding: 3px 0; min-height: 32px; font: inherit; font-size: 13px; color: var(--text-1);
    cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px;
    text-decoration-color: var(--line);
  }
  #rep-rail .gapval:hover { text-decoration-color: var(--steel); }
  /* The planner's .tier is a BUTTON that cycles evidence, so it carries
     cursor: pointer. On the rail it is a read-only span stating provenance —
     inheriting the pointer made it look clickable and do nothing (QA
     2026-08-12, ISSUE-003). Affordance matches constraint (DESIGN.md rule 3)
     cuts both ways: no affordance where there is no action. */
  #rep-rail .tier { cursor: default; }
  .gapedit {
    display: block; width: 100%; min-height: 44px; margin-top: 4px;
    background: var(--panel); color: var(--text-1); border: 1px solid var(--line);
    border-radius: 6px; padding: 8px 10px; font: inherit;
  }
  .gapwhy { color: var(--text-3); font-size: 12px; margin-top: 4px; }
  .gapinput-row { display: flex; margin-top: 8px; }
  .gapinput {
    flex: 1; min-height: 44px; background: var(--panel); color: var(--text-1);
    border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font: inherit;
  }
  #rep-brief { color: var(--text-2); font-size: 14px; line-height: 1.6; margin-top: 18px; }
  /* The honest decline (decision 2B): visible, never blocking. --weak is a
     verdict color and this IS a verdict about the round's fidelity. */
  #rep-unsupported { color: var(--text-2); font-size: 13px; margin-top: 10px; border-left: 2px solid var(--weak); padding-left: 10px; }
  /* Step 2's read-only referent for "Confirmed from your paste", and the way
     back to step 1. A button, not a field: in step 2 the paste is frozen. */
  #rep-back {
    display: block; width: 100%; text-align: left; background: var(--sunk);
    border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px;
    min-height: 44px; font: inherit; color: var(--text-2); cursor: pointer;
  }
  #rep-back:hover { border-color: var(--line); color: var(--text-1); }
  #rep-back .micro { display: block; margin-bottom: 2px; }
  #rep-back .rep-src {
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #rep-note { color: var(--text-3); font-size: 12px; margin: 6px 0 14px; }
  /* .metaline is runway/reprow-scoped elsewhere; the practice surface needs
     its own copy or helper lines shout in body white (QA ISSUE-001). */
  #practice-wrap .metaline { color: var(--text-2); font-size: 12px; margin-top: 6px; }
  #practice-wrap .metaline a { color: var(--text-2); }
  /* Chips and the link row live INSIDE the composer frame. */
  .composer-frame #plan-attach { padding: 0 18px; }
  /* The explicit link input — same row the planner composer carries,
     revealed on request (progressive disclosure). */
  #practice-wrap .linkrow { display: flex; gap: 8px; margin-top: 8px; }
  .composer-frame .linkrow { margin: 4px 10px 0 18px; }
  #practice-wrap .linkrow input { flex: 1; font-size: 13px; padding: 7px 10px; color: var(--text-2); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; font-family: inherit; }
  #practice-wrap .linkrow input:focus { color: var(--text-1); }
  #practice-wrap .linkrow button { min-height: 0; padding: 4px 12px; font-size: 13px; color: var(--text-2); }
  /* One sticky-bottom element per stack (QA ISSUE-003): the practice screen
     has NO sticky at all — it fits a viewport; Start sits in flow. */
  .rep-actions { display: flex; justify-content: flex-end; margin-top: 14px; }
  .rep-strip { margin-top: 34px; }
  .rep-strip .err { font-size: 12px; }
  .reprow {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 12px 2px; border-top: 1px solid var(--rule);
  }
  .reprow .grow { flex: 1; min-width: 0; }
  .reprow .metaline { color: var(--text-2); margin-top: 3px; font-size: 12px; }
  .reprow .primary { min-width: 96px; min-height: 44px; }
  .reprow b { font-weight: 500; }

  /* ---- first paint: the shape of the page before data lands ---- */
  #boot { padding-top: 6px; }
  #boot .sk { height: 11px; background: var(--line-soft); margin: 16px 0; animation: breathe 1.5s ease-in-out infinite; }
  #boot .sk:nth-child(1) { width: 42%; height: 30px; }
  #boot .sk:nth-child(2) { width: 100%; animation-delay: .1s; }
  #boot .sk:nth-child(3) { width: 78%; animation-delay: .2s; }
  #boot .sk:nth-child(4) { width: 88%; animation-delay: .3s; }
  @keyframes breathe { 0%, 100% { opacity: .5; } 50% { opacity: .22; } }

  /* ---- scrollbar: part of the instrument, not the OS ---- */
  * { scrollbar-width: thin; scrollbar-color: #2a2b2e var(--bg); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: #2a2b2e; border: 3px solid var(--bg); border-radius: 5px; }
  ::-webkit-scrollbar-thumb:hover { background: #3c3d40; }

  button {
    background: none; border: 1px solid var(--line); color: var(--text-1);
    padding: 6px 14px; font: inherit; font-weight: 500; cursor: pointer; min-height: 32px;
    border-radius: 6px;
    transition: border-color .18s, background .18s;
  }
  button:hover { border-color: #3c3d40; }
  /* The action is WHITE. Steel never sits on a button — it would stop meaning time. */
  button.primary { background: var(--text-1); border-color: var(--text-1); color: var(--bg); font-weight: 600; }
  button.primary:hover { background: #fff; border-color: #fff; }
  :is(button, input, textarea, a, [tabindex]):focus-visible { outline: 2px solid var(--steel); outline-offset: 2px; }
  input, textarea {
    width: 100%; background: var(--sunk); border: 1px solid var(--line);
    color: inherit; font: inherit; padding: 9px 11px; border-radius: 6px; transition: border-color .18s;
  }
  input:hover, textarea:hover { border-color: #3c3d40; }
  input:focus, textarea:focus { border-color: var(--steel); }
  label { display: block; margin: 18px 0 5px; font-weight: 500; }
  .banner { border: 1px solid var(--steel); background: rgba(53, 112, 143, .08); padding: 10px 14px; margin: 0 0 20px; border-radius: 6px; }

  /* WTP gate (paywall.ts). An OVERLAY: the app stays visible and dimmed
     behind it, so the gate reads as an interruption of work in progress
     rather than a page you navigated to — which is what it is.
     Still no shadow and no glow (DESIGN.md rule 1): the card separates from
     the scrim the system's way, by one tone-step (--raised) plus a 1px
     hairline. The scrim is a dimming layer, not elevation.
     z-index clears the sticky nav (z-index 10); overflow-y keeps a tall card
     reachable on a short viewport. */
  #paywall {
    position: fixed; inset: 0; z-index: 20;
    background: rgba(14, 14, 15, .78);
    backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
    display: flex; align-items: center; justify-content: center;
    padding: 20px; overflow-y: auto;
  }
  #paywall .card { width: 100%; max-width: 460px; background: var(--raised); border: 1px solid var(--line); border-radius: 6px; padding: 24px 26px; }
  #paywall h2 { margin: 0 0 12px; font-size: 17px; font-weight: 600; }
  #paywall p { margin: 0 0 14px; color: var(--text-2); }
  #paywall .price { font-family: var(--mono); font-size: 22px; color: var(--text-1); margin: 0 0 14px; }
  #paywall .ask { margin-top: 18px; }
  #paywall label { display: block; margin: 0 0 6px; color: var(--text-2); }
  #paywall input { width: 100%; min-height: 44px; box-sizing: border-box; background: var(--sunk); border: 1px solid var(--line); border-radius: 6px; color: var(--text-1); font: inherit; padding: 0 12px; }
  #paywall .btnrow { display: flex; gap: 10px; margin-top: 20px; }
  #paywall .btnrow button { flex: 1; min-height: 44px; }

  /* ---- entrance choreography: one orchestrated load per page, never on
         polls; fully off under reduced motion ---- */
  @keyframes rise { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
  .animate .runway li, .animate a.plancard, .animate .season > * { animation: rise .45s cubic-bezier(.2, .7, .2, 1) both; animation-delay: calc(var(--i, 0) * 32ms); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }

  /* ---- entry (make a plan) ---- */
  .attach { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--line-soft); }
  .attach .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach .kind { color: var(--text-2); font-size: 12px; }
  .attach button { border: 0; color: var(--text-2); padding: 0 6px; min-height: 0; }
  .attach button:hover { color: var(--text-1); }
  .findings p { margin: 7px 0; }
  .rationale { color: var(--text-2); white-space: pre-wrap; }
  .specbox { border: 1px solid var(--line); padding: 13px 15px; margin: 10px 0; background: var(--panel); border-radius: 6px; }
  .specbox.dropped { opacity: .55; }
  .specbox .keep { display: inline-flex; gap: 6px; margin-left: 12px; color: var(--text-2); font-weight: 400; }
  .specbox .keep input { width: auto; }
  .progress { height: 2px; background: var(--line); margin: 16px 0; overflow: hidden; }
  .progress .fill { height: 100%; background: var(--steel); width: 30%; animation: slide 1.5s ease-in-out infinite alternate; }
  /* Determinate variant: width measures real elapsed vs the 8-min wall. */
  .progress .fill.det { animation: none; transition: width 1s linear; }
  @keyframes slide { from { margin-left: 0; } to { margin-left: 70%; } }

  /* ---- planning surface: Cowork grammar (design D1, 2026-08-07) ----
     The chat contains NOTHING but prose; ALL structure lives in the plan
     panel, which the model maintains through its propose_rounds tool. Wide
     screens get a right rail; narrow ones stack the panel above the
     composer. body.wide widens the page column for this route only. */
  body.wide { max-width: 1180px; }
  #plan-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 28px; align-items: start; }
  /* Empty state (no conversation yet): no panel to reserve a rail for —
     single column, centered, so the intake moment isn't lopsided (QA ISSUE-001). */
  #plan-wrap.nopanel { grid-template-columns: minmax(0, 1fr); min-height: calc(100vh - 230px); align-content: center; }
  #plan-wrap.nopanel #plan-main { max-width: 62ch; margin: 0 auto; width: 100%; }
  /* This moment IS the intake — "paste everything you have" needs room to
     land in, not a two-row sliver. Conversation mode stays compact. */
  #plan-wrap.nopanel #plan-composer { position: static; }
  #plan-wrap.nopanel #plan-composer textarea { min-height: 170px; flex-basis: 100%; }
  #plan-wrap.nopanel #plan-composer .row { flex-wrap: wrap; }
  #plan-wrap.nopanel #plan-composer .row button:first-of-type { margin-left: auto; }
  #plan-wrap.nopanel #plan-intro { margin-top: 0; }
  #plan-main { min-width: 0; }
  #plan-chat { max-width: 62ch; }
  .turn-user { border-left: 1px solid var(--line); padding-left: 16px; margin: 24px 0; white-space: pre-wrap; }
  .turn-user .att { color: var(--text-2); font-size: 12px; margin-top: 6px; white-space: normal; }
  .turn-planner { margin: 24px 0; }
  .turn-planner p { margin: 0 0 12px; line-height: 1.65; }
  .turn-planner a { color: var(--steel-text); text-decoration: none; border-bottom: 1px solid rgba(126, 169, 194, .4); overflow-wrap: anywhere; }
  .turn-planner strong { color: var(--text-1); font-weight: 500; }
  .turn-planner code { font-family: var(--mono); font-size: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 1px 5px; }
  /* Settled turns recede; the current turn is where the eye should land. */
  .turn-planner.history { opacity: .55; }
  .turn-planner.history:hover { opacity: 1; }
  /* Pasted walls collapse to chips — the candidate's own paste must never
     dominate the viewport (live-screenshot finding, 2026-08-07). */
  .pastechip { display: flex; gap: 10px; width: 100%; text-align: left; background: none; border: 0; border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); padding: 7px 0; min-height: 0; color: var(--text-2); font-size: 12px; cursor: pointer; font-family: var(--mono); }
  .pastechip:hover { color: var(--text-1); }
  /* Folded planner notes reuse the pastechip chrome but read as prose, not
     mono — the summary IS the note's first sentence, not metadata. */
  .foldnote { font-family: inherit; font-size: 13px; align-items: baseline; }
  .foldnote .foldmeta { color: var(--text-3); white-space: nowrap; }
  .pastebody { margin: 0; padding: 4px 0 10px 20px; font-size: 13px; line-height: 1.6; color: var(--text-2); white-space: pre-wrap; }
  #plan-intro { color: var(--text-2); margin: 28px 0; line-height: 1.65; }
  /* An unreadable link: a fact about the plan's evidence, not an app error
     — stated calmly, with the repair (paste it) in the same sentence. */
  .unread { border-left: 2px solid var(--weak); padding: 8px 0 8px 12px; margin: 12px 0; color: var(--text-2); font-size: 13px; line-height: 1.6; }
  .unread b { color: var(--text-1); font-weight: 500; }
  /* ask_user options: tappable shortcuts under the latest planner turn.
     Pills, not radios — tapping IS answering. */
  /* The open question rides the COMPOSER, not the transcript: a live
     control you have to scroll back to find is not a control. Inside
     #plan-composer it inherits the sticky bottom in both layouts. */
  #plan-ask { position: relative; border: 1px solid var(--line); border-bottom: 0; background: var(--panel); border-radius: 6px 6px 0 0; padding: 12px 14px 10px; }
  #plan-ask + #plan-attach { margin-top: 6px; }
  #ask-dismiss { position: absolute; top: 6px; right: 8px; background: none; border: 0; min-height: 0; padding: 2px 6px; color: var(--text-3); font-size: 14px; line-height: 1; cursor: pointer; }
  #ask-dismiss:hover { color: var(--text-1); }
  .askrow { margin: 0 0 4px; padding-right: 20px; }
  .askrow + .askrow { margin-top: 12px; border-top: 1px solid var(--line-soft); padding-top: 12px; }
  .askq { font-weight: 500; margin-bottom: 8px; }
  .askopts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .qopt { border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 6px 14px; min-height: 0; font-size: 13px; color: var(--text-1); cursor: pointer; }
  .qopt:hover { border-color: var(--steel); }
  .qopt .rec { color: var(--steel-text); font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin-left: 7px; }
  .optdetail { color: var(--text-3); font-size: 12px; margin-right: 4px; }
  .askor { color: var(--text-3); font-size: 12px; margin-top: 9px; }
  /* The plan panel: the ONE structured surface. */
  #plan-panel { border: 1px solid var(--line); background: var(--panel); border-radius: 6px; position: sticky; top: 64px; display: flex; flex-direction: column; max-height: calc(100vh - 90px); }
  #plan-panel .phead { padding: 12px 16px 8px; border-bottom: 1px solid var(--line); }
  #plan-panel .phead .micro { margin: 0; }
  #plan-panel .phead .meta { font-size: 12px; margin-top: 3px; }
  #plan-panel .pbody { overflow-y: auto; min-height: 0; }
  .gaterow { border-bottom: 1px solid var(--line-soft); border-left: 2px solid transparent; padding: 10px 14px 10px 12px; }
  .gaterow.flash { animation: rowflash 1.1s ease-out; }
  @keyframes rowflash { 0% { border-left-color: transparent; } 15% { border-left-color: var(--steel); } 100% { border-left-color: transparent; } }
  @media (prefers-reduced-motion: reduce) { .gaterow.flash { animation: none; } }
  .gaterow .gcheck { display: flex; gap: 8px; align-items: baseline; margin: 0; font-weight: 500; cursor: pointer; }
  .gaterow .gcheck input { width: auto; accent-color: var(--steel); }
  .gaterow .gshape { color: var(--text-2); font-size: 12px; margin: 3px 0 0 22px; line-height: 1.5; }
  .gaterow .grow2 { display: flex; align-items: center; gap: 10px; margin: 6px 0 0 22px; }
  .gaterow .gdate { font-size: 12px; color: var(--text-2); }
  .gaterow .gdate.nodate { color: var(--text-3); }
  .tier { font: inherit; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; background: none; border: 1px solid var(--line); padding: 1px 7px; cursor: pointer; color: var(--text-2); min-height: 0; }
  .tier:hover { border-color: var(--text-3); color: var(--text-1); }
  .gaterow .gexpand { background: none; border: 0; min-height: 0; padding: 0; margin-left: auto; color: var(--text-2); font-size: 12px; cursor: pointer; white-space: nowrap; }
  .gaterow .gexpand:hover { color: var(--text-1); }
  .gatedetail { padding: 6px 0 2px 22px; color: var(--text-2); font-size: 12px; line-height: 1.6; }
  .gatedetail b { color: var(--text-1); font-weight: 500; }
  /* A declined round is a full row with an opt-IN checkbox (2B applied to
     this door, 2026-08-15) — the weak left border is the verdict color:
     this IS a verdict about the round's fidelity, not a broken spec. */
  .gaterow.gatedecline { border-left: 2px solid var(--weak); }
  .gdeclinewhy { color: var(--text-2); font-size: 12px; margin-top: 4px; }
  .paceline { padding: 10px 14px; font-size: 12px; line-height: 1.5; color: var(--text-2); }
  #plan-panel .pfoot { padding: 12px 14px 14px; border-top: 1px solid var(--line); }
  #plan-panel .pfoot button { width: 100%; padding: 10px; }
  #plan-panel .pfoot .meta { font-size: 12px; margin-top: 8px; display: block; line-height: 1.5; }
  /* The settle signal is information, not completed work: steel, not --ok. */
  #plan-panel .pfoot .meta.settled { color: var(--steel-text); }
  /* Armed: the button asked a question and is waiting on an answer, so the
     note steps up to body white — it is the thing to read right now. */
  #plan-panel .pfoot .meta.armed { color: var(--text-1); }
  #plan-composer { margin-top: 14px; position: sticky; bottom: 0; background: var(--bg); padding-bottom: 10px; max-width: 62ch; }
  #plan-composer .row { display: flex; gap: 8px; align-items: flex-start; }
  #plan-composer textarea { flex: 1; min-height: 58px; resize: none; }
  #plan-composer .helper { font-size: 12px; color: var(--text-3); margin-top: 7px; line-height: 1.5; }
  #plan-attach { margin-bottom: 6px; }
  /* Optional link row: deliberately quiet — links are one more kind of
     evidence, not a required field. */
  #plan-composer .linkrow { display: flex; gap: 8px; margin-top: 8px; }
  #plan-composer .linkrow input { flex: 1; font-size: 13px; padding: 7px 10px; color: var(--text-2); }
  #plan-composer .linkrow input:focus { color: var(--text-1); }
  #plan-composer .linkrow button { min-height: 0; padding: 4px 12px; font-size: 13px; color: var(--text-2); }
  #plan-composer .linkrow button:hover { color: var(--text-1); }
  @media (max-width: 1099px) {
    body.wide { max-width: 760px; }
    /* The base grid rule's align-items:start would leak into this flex
       context and shrink the panel to content width (QA ISSUE-004). */
    #plan-wrap { display: flex; flex-direction: column; align-items: stretch; }
    #plan-main { display: contents; }
    #plan-chat { order: 1; }
    #plan-panel { order: 2; position: sticky; bottom: 0; top: auto; max-height: 45vh; }
    /* Only ONE bottom-sticky element per stack: a sticky composer here would
       sit on top of the panel and hide the confirm button (QA ISSUE-003). */
    #plan-composer { order: 3; position: static; }
  }
  .carddel { border: 0; color: var(--text-2); font-size: 12px; padding: 0; min-height: 0; margin-top: 8px; }
  .carddel:hover { color: var(--weak-text); }

  /* ---- all plans (index) ---- */
  a.plancard {
    display: block; border: 1px solid var(--line); padding: 16px; margin: 12px 0;
    text-decoration: none; background: var(--panel); border-radius: 6px;
    transition: border-color .18s, transform .18s;
  }
  a.plancard:hover { border-color: #3c3d40; transform: translateY(-1px); }
  .plancard h2 { font-size: 16px; font-weight: 500; margin: 0 0 4px; }
  .plancard .bar { height: 2px; background: var(--line); margin: 12px 0 8px; }
  .plancard .bar .fill { height: 100%; background: var(--steel); }
  .plancard .nextline { color: var(--text-2); }
  .plancard.setup { color: var(--text-2); }
  .plancard.setup .go { color: var(--text-1); }
  .backlink { display: inline-block; color: var(--text-2); text-decoration: none; margin-bottom: 16px; transition: color .18s; }
  .backlink:hover { color: var(--text-1); }
  .addlink { color: var(--text-2); }
  .addlink:hover { color: var(--text-1); }

  /* ---- season timeline: the countdown instrument ---- */
  .season { margin-bottom: 44px; }
  .season .daysleft { font-size: 15px; font-weight: 400; line-height: 1.2; margin: 0; color: var(--text-2); }
  /* The countdown numeral: JBM light, tabular — steel's label sits beside it,
     the number itself stays white (the brightest thing on the page). */
  .season .daysleft b { font-family: var(--mono); font-size: 54px; font-weight: 300; letter-spacing: -.04em; font-variant-numeric: tabular-nums; color: var(--text-1); display: inline-block; margin-right: 6px; vertical-align: -4px; }
  .seasonbar { height: 2px; background: var(--line); margin: 16px 0 7px; position: relative; }
  .seasonbar .fill { height: 100%; background: var(--steel); transition: width .8s cubic-bezier(.2, .7, .2, 1); }
  /* Round-day milestones on the one spine — markers, never separate bars. */
  .seasonbar .tick { position: absolute; top: -3px; width: 1px; height: 8px; background: var(--text-3); }
  .debrief { margin: -12px 0 18px; }
  .debrief a { color: var(--steel-text); }
  .paceline { display: flex; justify-content: space-between; color: var(--text-2); font-family: var(--mono); font-size: 12px; margin-bottom: 26px; }

  /* adaptation: the last change + the door for new information */
  .adaptrow { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; font-size: 12px; margin: -14px 0 22px; }
  .adaptrow .addlearn { color: var(--text-2); text-decoration: none; border-bottom: 1px dotted var(--line); white-space: nowrap; }
  .adaptrow .addlearn:hover { color: var(--text-1); border-bottom-color: var(--text-3); }
  .adaptpanel { border: 1px solid var(--line); padding: 15px; margin: 0 0 24px; background: var(--panel); border-radius: 6px; }
  .adaptpanel .learnbox { width: 100%; min-height: 96px; resize: vertical; }
  .adaptpanel .btnrow { margin-top: 12px; }
  .adaptpanel .adaptsum { font-weight: 500; margin-bottom: 10px; }
  /* Judged feedback, re-readable from the plan. Grade grammar = color AND
     shape (■ strong · ◆ weak · ▫ not-shown + hatch) so no pair of grades
     ever rests on hue alone. */
  .fbtoggle { color: var(--text-2); margin-left: 10px; font-size: 12px; }
  .fbtoggle:hover { color: inherit; }
  .fbcard { display: block; margin: 10px 0 4px; padding: 4px 14px 10px; border: 1px solid var(--line); border-radius: 6px; font-weight: 400; }
  .fbcard .desc { margin: 8px 0 4px; }
  .fbcard .fbrow { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .fbcard .fbrow:last-child { border-bottom: 0; }
  .fbcard .dim { font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
  .fbcard .fbrow .dim::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 7px; border: 1px solid var(--none); vertical-align: 0; }
  .fbcard .v-strong .dim { color: var(--ok); }
  .fbcard .v-strong .dim::before { background: var(--ok); border-color: var(--ok); }
  .fbcard .v-weak .dim { color: var(--weak-text); }
  .fbcard .v-weak .dim::before { background: var(--weak); border-color: var(--weak); transform: rotate(45deg) scale(.9); }
  .fbcard .v-none { opacity: .55; background: repeating-linear-gradient(45deg, transparent 0 5px, rgba(255, 255, 255, .03) 5px 10px); }
  .fbcard .cite { color: var(--text-2); font-size: 12px; margin: 3px 0 3px 14px; }
  .fbcard .clk { color: inherit; opacity: .9; }
  .fbcard .closedmark { border-left: 2px solid var(--steel); padding-left: 10px; }
  .fbcard .fbfocus { border: 1px solid var(--steel); padding: 8px 10px; margin-top: 10px; border-radius: 6px; }
  .fbcard .fbfocus .k { color: var(--steel-text); font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; margin: 0 0 4px; }
  /* The Gaps band (#/history) + the season topics band. Existing tokens
     only: verdict hues stay --ok/--weak/--none, shape backs hue (the strip
     glyphs differ by character, never color alone), no elevation. */
  .gapsband { border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px 12px; margin: 0 0 18px; }
  .gapsband .micro { margin: 0 0 2px; }
  .gaprow { border-top: 1px solid var(--line-soft); padding: 7px 0 6px; }
  .gaprow:first-of-type { border-top: 0; }
  .gaprow .dim { font-family: var(--mono); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; display: inline-block; width: 104px; }
  .gapstrip { font-family: var(--mono); font-size: 12px; letter-spacing: .12em; margin-right: 10px; white-space: nowrap; }
  .g-ok { color: var(--ok); }
  .g-weak { color: var(--weak-text); }
  .g-none { color: var(--none); }
  .gb { letter-spacing: 0; opacity: .8; }
  .gapstate { color: var(--text-2); font-size: 12px; }
  .gapcite { color: var(--text-3); font-size: 12px; margin: 3px 0 0 104px; }
  /* Long citations render in FULL and clamp to two lines (QA 2026-08-15:
     the old 157-char slice cut mid-word with no way to read the rest);
     click toggles .open. Ellipsis is the affordance, cursor confirms it. */
  .gapcite.clamped { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
  .gapcite.open { cursor: pointer; }
  .topicband { border: 1px solid var(--line); border-radius: 6px; padding: 8px 14px 10px; margin: 10px 0 4px; }
  .topicrow { display: flex; gap: 10px; align-items: baseline; border-top: 1px solid var(--line-soft); padding: 5px 0; }
  .topicrow:first-of-type { border-top: 0; }
  .topicrow .tmark { font-family: var(--mono); font-size: 11px; color: var(--steel-text); width: 44px; flex: none; }
  .topicrow.drill .tlabel { color: var(--weak-text); }
  .adaptpanel .bpchange summary { cursor: pointer; margin: 6px 0; }
  .adaptpanel .bpview { max-height: 260px; overflow: auto; border: 1px solid var(--line); padding: 10px 12px; font-size: 12px; white-space: pre-wrap; }
  .adaptpanel .repoint b { color: var(--text-1); }
  .stale { color: var(--weak-text); }
  .genclock { font-family: var(--mono); font-size: 11px; color: var(--text-3); }

  ol.runway { list-style: none; margin: 0; padding: 0; position: relative; }
  /* The spine: one continuous rail the whole season hangs from. */
  ol.runway::before { content: ''; position: absolute; left: var(--rail); top: 10px; bottom: 10px; width: 1px; background: var(--line); }
  .runway li { display: flex; gap: 14px; border-top: 1px solid var(--line-soft); padding: 9px 0; align-items: baseline; position: relative; }
  .runway li:first-child { border-top: 0; }
  .runway .date { width: 74px; flex: none; color: var(--text-2); font-family: var(--mono); font-size: 11px; font-weight: 400; text-transform: uppercase; letter-spacing: .08em; font-variant-numeric: tabular-nums; }
  /* Rail marks are SQUARES (3a mark grammar); the one diamond belongs to the interview. */
  .runway .dot { flex: none; width: 11px; height: 11px; border: 1.5px solid var(--line); background: var(--bg); align-self: center; z-index: 1; position: relative; left: -1px; }
  .runway .body { flex: 1; min-width: 0; }
  .runway li.past { opacity: .5; }
  .runway li.past .dot.done { border-color: var(--ok); background: var(--ok); }
  .runway li.past .body .ok { color: var(--ok); margin-right: 6px; }
  .runway li.empty .body { color: var(--text-2); }
  .runway li.today { padding: 18px 0; opacity: 1; border-top-color: var(--line); }
  .runway li.today .date { color: var(--steel-text); }
  /* Today is the brightest mark on the rail — white, outranking even the
     interview's steel diamond. Steel says where the terminus is; white says
     where YOU are. */
  .runway li.today .dot { border-color: var(--text-1); background: var(--text-1); }
  .runway li.today .title { font-size: 16px; font-weight: 500; }
  .runway .metaline { color: var(--text-2); margin-top: 3px; font-size: 12px; }
  .runway .aimed { color: var(--weak-text); margin-top: 6px; font-style: italic; }  /* the gap is the attention axis */
  .runway li.today .body { display: flex; gap: 16px; align-items: center; }
  .runway li.today .grow { flex: 1; min-width: 0; }
  .runway li.today button.primary { min-width: 96px; min-height: 44px; }
  .runway li.future { color: var(--text-2); }
  .runway li.future.empty { padding: 5px 0; }
  .runway li.quiet { padding: 4px 0; border-top: 1px solid var(--line-soft); }
  .runway li.quiet .body { color: var(--text-3); font-family: var(--mono); font-size: 11px; letter-spacing: .08em; }
  .runway li.past.donetoday { opacity: .78; }
  .runway li.past.donetoday .date { color: var(--ok); }
  .runway li.today.complete .date { color: var(--ok); }
  .runway li.today.complete .dot { border-color: var(--ok); background: var(--ok); }
  .runway button.mini { background: none; border: 1px solid var(--line); color: var(--text-2); padding: 2px 9px; font: inherit; font-size: 11px; cursor: pointer; margin-left: 10px; border-radius: 6px; }
  .runway button.mini:hover { color: var(--text-1); border-color: #3c3d40; }
  /* Future-row build affordance: a text link, not a second Generate button —
     TODAY's primary is the page's one big action (owner report 2026-08-15).
     Dotted underline = the clickability a borderless gray word lacks. */
  .runway button.quietgen { background: none; border: 0; min-height: 0; padding: 0; margin-left: 10px; font: inherit; font-size: 12px; color: var(--text-2); text-decoration: underline dotted; text-underline-offset: 3px; cursor: pointer; }
  .runway button.quietgen:hover { color: var(--text-1); }
  .runway button.quietgen:disabled { opacity: .5; cursor: default; }
  /* The runway's caption — names the row unit (a practice day / a queued
     round) so the spine reads as a plan, not a list. */
  .season .runwaykey { margin: 20px 0 8px; }
  .runway li.future.empty .dot { width: 5px; height: 5px; border-width: 1px; left: 2px; }
  .runway li.collapsed .body { color: var(--text-2); }
  .runway li.collapsed .dot { border-style: dashed; background: transparent; }
  .runway li.interview { padding: 16px 0; color: var(--text-1); border-top: 1px solid var(--line); }
  .runway li.interview .date { color: var(--steel-text); }
  .runway li.interview .dot { border-color: var(--steel); background: var(--steel); transform: rotate(45deg); }
  .runway li.interview .body { font-weight: 500; letter-spacing: .02em; }

  /* Beta tag (WU9): micro-label voice, steel not identity — global
     expectation-setting that buys forgiveness for rough edges without
     pointing at any specific missing feature. */
  .betatag { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .18em; color: var(--steel-text); border: 1px solid var(--steel); border-radius: 4px; padding: 1px 6px; margin-left: 10px; align-self: center; }

  /* ---- beta login (WU4) — shown only when auth is on and no token ---- */
  /* ---- signed-out auth: two-pane brief (design review 2026-08-12, direction B).
     The old screen was a headline and two buttons floating in a 760px column:
     an invited stranger could not tell what they were signing into, and the
     email field used its placeholder as its label, the exact hard-rule
     violation DESIGN.md rule 5 records as having already shipped once.
     The left pane now does the explaining so the right can stay bare. Rides
     body.wide (the planner's existing 1180px precedent) and collapses to the
     single column on the same 1099px breakpoint. ---- */
  #login { padding-top: 60px; }
  .loginpane { display: grid; grid-template-columns: 1fr 380px; gap: 72px; align-items: start; }
  .loginsay h1 { font-size: 34px; line-height: 1.2; margin: 0; font-weight: 600; letter-spacing: -.01em; max-width: 21ch; }
  .loginsay .desc { color: var(--text-2); font-size: 15px; margin: 12px 0 0; max-width: 52ch; }
  .loginbox { display: flex; flex-direction: column; gap: 16px; }
  /* Mode tabs are mono micro-labels on a hairline. Never a filled pill: fill
     means primary action in this system, and the action here is the white
     button below. */
  .modes { display: flex; gap: 26px; border-bottom: 1px solid var(--line-soft); }
  .mode {
    background: none; border: 0; border-bottom: 1px solid transparent; border-radius: 0;
    padding: 0 0 10px; margin-bottom: -1px; min-height: 0;
    font-family: var(--mono); font-size: 11px; font-weight: 500;
    letter-spacing: .18em; text-transform: uppercase; color: var(--text-3);
  }
  .mode:hover { border-color: transparent; color: var(--text-2); }
  .mode[aria-selected="true"] { color: var(--text-1); border-bottom-color: var(--text-1); }
  .loginbox label {
    margin: 0 0 7px; font-family: var(--mono); font-size: 11px; font-weight: 500;
    letter-spacing: .18em; text-transform: uppercase; color: var(--text-3);
  }
  .loginbox .primary { width: 100%; min-height: 44px; }
  .loginsep {
    display: flex; align-items: center; gap: 12px; color: var(--text-3);
    font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: .18em;
  }
  .loginsep::before, .loginsep::after { content: ""; flex: 1; height: 1px; background: var(--line-soft); }
  .loginrow { display: flex; gap: 8px; }
  .loginrow input { flex: 1; min-height: 44px; }
  .loginrow button { min-height: 44px; white-space: nowrap; }
  #login-msg {
    font-family: var(--mono); font-size: 11px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--text-3); margin: 0;
  }
  #login-msg.bad { color: var(--weak-text); }
  #login-msg.good { color: var(--steel-text); }
  .loginfine { color: var(--text-3); font-size: 12px; line-height: 1.6; margin: 0; }
  /* What a round actually costs you, before you commit to 45 minutes. */
  .expect {
    border-top: 1px solid var(--line-soft); margin: 34px 0 0; padding-top: 16px;
    display: flex; flex-direction: column; gap: 9px; max-width: 52ch;
  }
  /* Grid, not flex with a min-width: THE INTERVIEWER is wider than any min
     that suits the other two, so a flex row pushed its value out of the
     column and the three descriptions no longer shared a left edge. */
  .expect > div { display: grid; grid-template-columns: 136px 1fr; gap: 14px; align-items: baseline; }
  .expect dt {
    font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: .18em;
    text-transform: uppercase; color: var(--text-3);
  }
  .expect dd { margin: 0; color: var(--text-2); font-size: 13px; }
  @media (max-width: 1099px) {
    .loginpane { grid-template-columns: 1fr; gap: 40px; max-width: 460px; }
    .loginsay h1 { font-size: 28px; }
  }

  /* ---- desktop only (design decision D7: stated, not broken) ---- */
  #narrow { display: none; }
  @media (max-width: 700px) {
    #narrow { display: block; padding: 40vh 24px 0; text-align: left; }
    #page { display: none; }
  }
</style>
<div id="narrow">
  <p class="micro">Zenkai</p>
  <p>This runs practice sessions in a real code editor, so it lives on your laptop. Open it there.</p>
</div>
<div id="page">
  <nav>
    <a href="#/" id="nav-home" class="brand" aria-label="Zenkai — home">
      <!-- One ribbon folded into a Z, split corner-to-corner across the
           diagonal: blue half above the fold, red half below, each with its
           own darker fold face. The whole mark is 180°-rotationally
           symmetric — the red half IS the blue half turned over — so the two
           paths are the same shape and only the colors differ. -->
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
        <path class="plate-red" d="M34.8 48 L10.5 48 L11.85 34.5 L36.15 13.5 L28.5 34.5 L45.6 34.5 Z" />
        <path class="plate-red-fold" d="M11.85 34.5 L36.15 13.5 L28.5 34.5 Z" />
        <path class="plate-blue" d="M13.2 0 L37.5 0 L36.15 13.5 L11.85 34.5 L19.5 13.5 L2.4 13.5 Z" />
        <path class="plate-blue-fold" d="M36.15 13.5 L11.85 34.5 L19.5 13.5 Z" />
        <path class="seam" d="M36.15 13.5 L11.85 34.5" stroke-width="1.3" />
      </svg>
      <span class="word">Zenkai</span>
      <span class="betatag">beta</span>
    </a>
    <span class="navright">
      <a href="#/t/" id="nav-live" aria-live="polite"><span class="pulse"></span>session live</a>
      <a href="#" id="nav-kill" title="end the running session without grading">end session</a>
      <a href="#/" id="nav-practice">practice</a>
      <a href="#/plans" id="nav-plans">plans</a>
      <a href="#/history" id="nav-history">history</a>
    </span>
  </nav>
  <div id="banner" aria-live="polite"></div>
  <div id="boot"><div class="sk"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>

  <section id="index" hidden></section>

  <section id="entry" hidden>
    <!-- Cowork grammar (design D1, 2026-08-07): the chat contains nothing
         but prose; ALL structure lives in the plan panel. The client renders
         the whole surface — composer, chat, panel — into entry-flow. -->
    <div id="entry-flow" aria-live="polite"></div>
    <input id="e-file" type="file" multiple hidden aria-hidden="true" />
  </section>

  <section id="practice" hidden>
    <!-- The front door (CEO review 2026-08-10, composer-first): paste what
         you gathered, confirm the inferred shape, one rep — no target, no
         queue, no pace. Rendered whole by the client, same contract as
         entry-flow. -->
    <!-- The live region is a dedicated sr-only sibling, NOT the container:
         renderPractice replaces the container's whole innerHTML, and with
         the gap screen that now happens on every shape answer — a container
         live region would re-read the entire panel each time (decision 6A,
         2026-08-12). announce() writes only the delta. -->
    <div id="practice-flow"></div>
    <div id="rep-live" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"></div>
    <!-- The one status line beneath the composer — a SIBLING of the flow so
         renderPractice's innerHTML wipes never touch it, repainted on every
         poll from render() (outside the typing-protection guard). No
         aria-live: the genclock rewrites its text every second. -->
    <div id="home-status"></div>
  </section>

  <section id="history" hidden>
    <!-- Practice history: the reps strip + judged cards. Reps and seasons
         never share a page (design review 2026-08-10). -->
  </section>

  <section id="timeline" hidden></section>
</div>
<!-- Willingness-to-pay probe host (paywall.ts). OUTSIDE every repainted
     region: render() clears #banner and rewrites #timeline/#index,
     renderPractice() rewrites #practice-flow, renderHistory() rewrites
     #history — an inline card anywhere would be wiped by the 5s poll
     mid-read. A div, not a section, so renderLogin's section sweep does not
     own it. Empty and hidden until showPaywallProbe paints it. -->
<div id="paywall" hidden></div>
<script src="/client/app.js"></script>
`;
}

export function runApp(cfg: AppConfig): http.Server {
  // In-process auth (WU3). The HTML shell and client scripts stay open (no
  // data lives in them); every /api/* route requires a resolved user. When
  // auth is off (no supabase config) resolve() always returns the local
  // admin, so the gate below never fires — pre-beta behavior, byte-identical.
  const auth = makeAuth(authConfigFromPublic(cfg.pub.supabase, cfg.pub.adminEmails, cfg.userId));
  internalHeaders = auth.internalToken ? { 'x-ip-internal': auth.internalToken } : {};
  legacyUserId = cfg.userId;

  /** Multi-session launch (WU-D): verdict → allocate → spawn → append+persist,
   *  serialized behind launchChain with no awaits inside the critical block —
   *  concurrent launches can't share a slot, and the registry entry exists
   *  before the container it names. Returns the HTTP response to send.
   *
   *  `beforeSpawn` is the repeat path's workspace reset (preserve the old run
   *  tree, restore pristine). It runs INSIDE the serialized block, after the
   *  verdict and the slot both hold and before the container is spawned, so a
   *  double-click can never re-wipe a dir mid-boot. It must stay synchronous:
   *  an await here would reopen the slot race the chain exists to close. A
   *  throw aborts the launch with no registry entry and no container. */
  const multiLaunch = async (
    who: { id: string; admin: boolean },
    problemDirArg: string,
    opts?: { ignoreEndedOnSameDir?: boolean; beforeSpawn?: () => void },
  ): Promise<{ code: number; body: Record<string, unknown> }> => {
    await reconcileRegistryNow();
    let result: { code: number; body: Record<string, unknown> } = {
      code: 500, body: { error: 'launch did not run' },
    };
    const busy = {
      code: 409,
      body: { error: `all ${cfg.pub.sessions.maxConcurrentSessions} interview rooms are busy — try again in ~45 minutes` },
    };
    await (launchChain = launchChain.then(() => {
      const reg = loadRegistry(repoRoot);
      const verdict = launchVerdict2(reg.entries, who.id, who.admin, problemDirArg, cfg.pub.sessions, opts);
      if (verdict === 'your-session-live') {
        result = { code: 409, body: { error: 'your session is live — finish or end it first' } };
        return;
      }
      if (verdict === 'already-launching') {
        result = { code: 409, body: { error: 'that problem is already starting — give it a moment' } };
        return;
      }
      if (verdict === 'all-slots-busy') { result = busy; return; }
      const slot = allocateSlot(reg.entries, cfg.pub.sessions.maxConcurrentSessions);
      if (!slot) { result = busy; return; }
      if (opts?.beforeSpawn) {
        try {
          opts.beforeSpawn();
        } catch (e) {
          // The slot was never persisted, so returning here releases it —
          // nothing was spawned and no entry names a container that will
          // not exist. Loud on purpose: a half-restored workspace must not
          // become a session.
          console.error(`[app] launch aborted before spawn: ${String(e)}`);
          result = {
            code: 500,
            body: { error: `could not reset the workspace: ${String(e instanceof Error ? e.message : e).slice(0, 200)}` },
          };
          return;
        }
      }
      const sid = newSessionId(Date.now());
      const pid = spawnDetached(['session', problemDirArg], {
        IP_SESSION_ID: sid,
        IP_USER_ID: who.id,
        IP_PREPARE_NEXT: '0',
        IP_APP_URL: cfg.pub.appPublicUrl,
        IP_MULTI_SESSION: '1',
        IP_SESSION_PORT: String(slot.port),
        IP_IDE_PORT: String(slot.idePort),
        ...(internalHeaders['x-ip-internal']
          ? { IP_INTERNAL_TOKEN: internalHeaders['x-ip-internal'] }
          : {}),
      });
      reg.entries.push({
        sid, user_id: who.id, port: slot.port, ide_port: slot.idePort,
        pid: pid ?? -1, problem_dir: problemDirArg, started_at: Date.now(),
      });
      saveRegistry(repoRoot, reg);
      result = {
        code: 200,
        body: { session_id: sid, url: `${cfg.pub.sessionPublicUrl}/session?sid=${encodeURIComponent(sid)}` },
      };
    }));
    return result;
  };

  // WU7: the Postgres mirror — records only, disk stays truth. Sessions are
  // swept from feedback/ by mtime watermark (starts at 0 = one-time backfill
  // of pre-beta history; upserts make re-mirroring harmless).
  const db = makeDb(cfg.pub.supabase);
  const mirroredUsers = new Set<string>();
  let feedbackWatermark = 0;
  const sweepSessionsToDb = (): void => {
    if (!db.enabled) return;
    try {
      const dir = path.join(repoRoot, 'feedback');
      if (!existsSync(dir)) return;
      const rows: SessionRow[] = [];
      let maxSeen = feedbackWatermark;
      for (const f of readdirSync(dir)) {
        const m = /^(sess-[\w-]+)\.json$/.exec(f);
        if (!m) continue;
        const mtime = statSync(path.join(dir, f)).mtimeMs;
        if (mtime <= feedbackWatermark) continue;
        maxSeen = Math.max(maxSeen, mtime);
        try {
          const fb = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { user_id?: string; card?: { solved?: boolean } };
          let assessment: unknown = null;
          const aFile = path.join(repoRoot, 'assessments', `${m[1]}.json`);
          if (existsSync(aFile)) assessment = JSON.parse(readFileSync(aFile, 'utf8'));
          rows.push(sessionRow(m[1]!, fb, assessment, cfg.userId, mtime));
        } catch { /* half-written or legacy-shaped file: next sweep retries nothing — it's below the new watermark, and that's fine for a record */ }
      }
      feedbackWatermark = maxSeen;
      db.mirrorSessions(rows);
    } catch { /* mirror is best-effort by design */ }
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (url === '/') {
        // no-store for the same reason /client/ has it: no build step and no
        // content hash, and this page inlines the WHOLE stylesheet and section
        // markup. A cached copy outlives a deploy exactly like a stale app.js
        // does — and pairs it with fresh JS, which is worse than either alone.
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        return res.end(appPage());
      }
      if (url.startsWith('/client/')) {
        const body = clientScript(path.basename(url));
        if (body === null) {
          res.writeHead(404);
          return res.end('no such client file');
        }
        // no-store: the client is served from source with no build step or
        // content hash, so a cached copy silently outlives a code change and
        // meets payloads it cannot parse (found in QA — a stale app.js threw
        // on a new row kind and reported itself as a dead server).
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        return res.end(body);
      }
      if (url === '/api/auth-config' && req.method === 'GET') {
        // The one unauthenticated API route: the login screen needs to know
        // whether auth is on and where to send the OTP/OAuth calls. Anon key
        // only — it is designed to live in the browser.
        return json(200, {
          enabled: auth.enabled,
          ...(cfg.pub.supabase
            ? { supabase_url: cfg.pub.supabase.url, anon_key: cfg.pub.supabase.anonKey }
            : {}),
        });
      }
      if (url === '/api/stripe/webhook' && req.method === 'POST') {
        // ABOVE the auth gate on purpose: Stripe sends no JWT, so below this
        // line it would 401 forever and every subscription change would be
        // silently lost. The SIGNATURE is the authentication here — which is
        // why it is verified before anything else touches the payload.
        const sc = cfg.pub.stripe;
        if (!sc) return json(200, { ok: true, ignored: 'billing off' });
        const raw = await readRawBody(req);
        const sig = req.headers['stripe-signature'];
        let event: import('stripe').Stripe.Event;
        try {
          const stripe = await stripeClient(sc.apiKey);
          event = stripe.webhooks.constructEvent(raw, String(sig ?? ''), sc.webhookSecret);
        } catch (e) {
          // Unverified means not from Stripe. 400 so Stripe surfaces it in the
          // dashboard rather than retrying a payload we will never accept.
          console.warn('[billing] webhook signature rejected:', String(e).slice(0, 160));
          return json(400, { error: 'bad signature' });
        }
        try {
          if (isHandledEvent(event.type)) {
            const stripe = await stripeClient(sc.apiKey);
            // Resolve the subscription and OUR user id for each shape. The
            // user id rides subscription metadata (set at Checkout creation)
            // rather than being looked up from the customer — a subscription
            // event carries no client_reference_id, and metadata travels with
            // every one of them.
            let sub: import('stripe').Stripe.Subscription | null = null;
            let userId = '';
            const obj = event.data.object as unknown as Record<string, unknown>;
            if (event.type === 'checkout.session.completed') {
              userId = String(obj.client_reference_id ?? '');
              const subId = typeof obj.subscription === 'string' ? obj.subscription : '';
              if (subId) sub = await stripe.subscriptions.retrieve(subId);
            } else if (String(event.type).startsWith('customer.subscription.')) {
              sub = obj as unknown as import('stripe').Stripe.Subscription;
              userId = String((sub.metadata ?? {}).user_id ?? '');
            } else {
              const subId = typeof obj.subscription === 'string' ? obj.subscription : '';
              if (subId) {
                sub = await stripe.subscriptions.retrieve(subId);
                userId = String((sub.metadata ?? {}).user_id ?? '');
              }
            }
            if (userId && sub) {
              logSubscription(
                rowFromSubscription(userId, sub as unknown as Record<string, never>, Date.now(), event.id),
              );
            } else {
              console.warn(`[billing] ${event.type} with no resolvable user — ignored`);
            }
          }
        } catch (e) {
          // A 500 makes Stripe retry, which is what we want for a transient
          // failure — but log it, because a silent retry loop is invisible.
          console.error('[billing] webhook handling failed:', String(e).slice(0, 200));
          return json(500, { error: 'handler failed' });
        }
        return json(200, { received: true });
      }
      const user = await auth.resolve(req);
      if (url.startsWith('/api/') && !user) {
        return json(401, { error: 'sign in required' });
      }
      // WU5 ownership rules. Absent user_id = pre-beta record = the local
      // user's (the founder). Admins see and touch everything.
      const ownsTarget = (t: Target | null | undefined): boolean =>
        Boolean(t && (user!.admin || (t.user_id ?? cfg.userId) === user!.id));
      const ownsRep = (r: { user_id?: string }): boolean =>
        user!.admin || repOwnedBy(r, user!.id, cfg.userId);

      /**
       * The willingness-to-pay gate (paywall.ts). Returns a GateView to refuse
       * with, or null to proceed. THIS ONE REALLY DENIES — see the module
       * header for why that is deliberate.
       *
       * FAILS OPEN on any throw. A broken counter, an unreadable target dir, a
       * corrupt queue — all let the round start. What is lost is the
       * measurement, which is the right thing to lose. The try/catch wraps the
       * WHOLE body rather than each call, so a disk read added here later
       * cannot quietly become the exception.
       *
       * Uses loadQueue + reconcileWithDisk WITHOUT saving: refreshQueue writes
       * (app.ts saveQueue) and pulls in the gap graph, and a launch must not
       * mutate state just to count. Reconciling matters even so — session_id
       * is re-pointed from the .used marker there, so a raw loadQueue would
       * count differently from the number /api/state already showed the user.
       */
      const gateFor = (reason: 'rounds' | 'plans'): GateView | null => {
        const pw = cfg.pub.paywall;
        if (!pw.enabled || user!.admin) return null;
        try {
          // A manual grant still comps forever (append a would_pay row for a
          // user_id and they are through) — that lever predates billing and
          // stays, for handing free access to people whose feedback is worth
          // having.
          if (hasGrant(readPaywallRows(), user!.id)) return null;
          const subs = readSubscriptionRows();
          // A SUBSCRIBER is not ungated — they get a per-period allowance.
          // `since` is their billing period start, so last month's rounds do
          // not eat this month's. The free tier passes null and counts for a
          // lifetime: a trial has no period to reset.
          const since = periodStart(subs, user!.id);
          const paid = subscribed(subs, user!.id);
          const mine = listTargets(repoRoot).filter(
            (t) => (t.user_id ?? cfg.userId) === user!.id,
          );
          // Plans are a spend guardrail on the free tier only. A subscriber
          // paid for the product; rationing which companies they may prep for
          // would be petty and is not what the money is protecting.
          if (reason === 'plans' && paid) return null;
          const used =
            reason === 'plans'
              ? countPlans(mine, user!.id, cfg.userId)
              : roundsUsed(
                  repsVisibleTo(repStateView(repoRoot, loadReps(repoRoot)), user!, cfg.userId),
                  mine.flatMap((t) => {
                    const q = loadQueue(repoRoot, t.id);
                    return q ? (reconcileWithDisk(repoRoot, q).items ?? []) : [];
                  }),
                  user!.id,
                  cfg.userId,
                  since,
                );
          return gateVerdict({
            enabled: true,
            admin: false,
            granted: false,
            reason,
            used,
            free: reason === 'plans' ? pw.freePlans : paid ? pw.paidRounds : pw.freeRounds,
            priceUsd: pw.priceUsd,
            // A subscriber who has spent their monthly rounds is NOT sold the
            // same subscription again — the card says "you have used this
            // month's rounds", and there is nothing to buy.
            subscribed: paid,
          });
        } catch {
          return null;
        }
      };

      /**
       * Refuse, and record that we did. The `error` string is load-bearing:
       * every existing client call site branches on `s.error` and none read
       * `r.status` (the 429 build-cap precedent, app.ts admissionVerdict), so
       * a body without it would fall through into the launch poll loop and
       * hang on "Starting…" for 180s. Updated call sites read the richer
       * `paywall` object; un-updated ones degrade to a readable sentence.
       */
      const refuse = (g: GateView): { code: number; body: Record<string, unknown> } => {
        logPaywall({
          ts: new Date().toISOString(),
          user_id: user!.id,
          email: user!.email,
          action: 'gated',
          reason: g.reason,
          used: g.used,
          free: g.free,
          price_usd: g.price_usd,
        });
        return {
          code: 402,
          body: {
            error:
              g.reason === 'plans'
                ? `You have used your ${g.free} free plans. Zenkai is $${g.price_usd}/mo after the beta.`
                : `You have used your ${g.free} free rounds. Zenkai is $${g.price_usd}/mo after the beta.`,
            paywall: g,
          },
        };
      };
      if (url === '/api/memory' && req.method === 'GET') {
        // The Gaps band's data: every assessed session the caller owns, full
        // verdict rows, trend, per-dimension states — read fresh from disk
        // each call (fetched once per history open, never on the poll).
        // Failure honesty: expected per-file skips are COUNTED in the
        // payload; an unexpected reader throw sets `degraded` — a server bug
        // must never masquerade as "no rounds yet".
        try {
          const asmDir = path.join(repoRoot, 'assessments');
          const assessments: import('./judge.js').JudgeResult[] = [];
          let skipped = 0;
          const sids: string[] = [];
          if (existsSync(asmDir)) {
            const { isMemorableSessionId } = await import('./gap-graph.js');
            for (const f of readdirSync(asmDir)) {
              // Filename regex drops sidecars (.confirm/.cause); the
              // mint-shape boundary drops harness sessions — including the
              // sess-qa814-* ids that beat a bare prefix check.
              const m = /^(sess-[\w-]+)\.json$/.exec(f);
              if (!m || !isMemorableSessionId(m[1]!)) continue;
              try {
                assessments.push(JSON.parse(readFileSync(path.join(asmDir, f), 'utf8')) as import('./judge.js').JudgeResult);
                sids.push(m[1]!);
              } catch {
                skipped += 1;
              }
            }
          }
          const owners: Record<string, string | undefined> = {};
          const presentFeedback = new Set<string>();
          for (const sid of sids) {
            try {
              const fb = JSON.parse(
                readFileSync(path.join(repoRoot, 'feedback', `${sid}.json`), 'utf8'),
              ) as { user_id?: string };
              presentFeedback.add(sid);
              owners[sid] = fb.user_id;
            } catch { /* absent → unattributable, counted by the reader */ }
          }
          const archivedIds = new Set<string>();
          try {
            for (const f of readdirSync(path.join(repoRoot, 'gaps', 'archive'))) {
              try {
                const arch = JSON.parse(readFileSync(path.join(repoRoot, 'gaps', 'archive', f), 'utf8')) as {
                  sessions?: { session_id?: string }[];
                };
                for (const s of arch.sessions ?? []) if (s.session_id) archivedIds.add(s.session_id);
              } catch { /* unreadable archive file proves nothing */ }
            }
          } catch { /* no archive dir */ }
          const { buildVerdictHistory } = await import('./verdict-history.js');
          const { PATTERN_MIN_SESSIONS } = await import('./gap-graph.js');
          const h = buildVerdictHistory({
            assessments, owners, presentFeedback, archivedIds,
            userId: user!.id, legacyOwnerId: cfg.userId, isAdmin: user!.admin,
            nowMs: Date.now(),
          });
          return json(200, {
            ...h,
            mode: h.sessions.length < PATTERN_MIN_SESSIONS ? 'observations' : 'patterns',
            sessions_until_patterns: Math.max(0, PATTERN_MIN_SESSIONS - h.sessions.length),
            skipped,
          });
        } catch (e) {
          return json(200, { degraded: String(e).slice(0, 200) });
        }
      }
      if (url.startsWith('/api/feedback') && req.method === 'GET') {
        // A finished round's judged card, read from the file finalize (and
        // rejudge --record) writes. The planning page is where feedback
        // LIVES after a session — the session server that first rendered
        // the card is torn down long before anyone wants to re-read it.
        const sid = new URL(url, 'http://x').searchParams.get('session') ?? '';
        if (!/^sess-[\w-]+$/.test(sid)) return json(400, { error: 'bad session id' });
        try {
          const fb = JSON.parse(
            readFileSync(path.join(repoRoot, 'feedback', `${sid}.json`), 'utf8'),
          ) as { card?: unknown; user_id?: string };
          if (!fb.card) return json(404, { error: 'no card for this session' });
          // WU5: cards are the owner's. Legacy files (no user_id) are the
          // founder's — same absent-means-local rule as reps and targets.
          if (!user!.admin && (fb.user_id ?? cfg.userId) !== user!.id) {
            return json(404, { error: 'no feedback recorded for this session' });
          }
          // WU-C: hydrate confirm state so the history card can render
          // noted/unanswered rows — the response is a snapshot, and a
          // confirm written later must show up on the next open.
          let confirms: Record<string, boolean> = {};
          try {
            confirms = JSON.parse(
              readFileSync(path.join(repoRoot, 'assessments', `${sid}.confirm.json`), 'utf8'),
            ) as Record<string, boolean>;
          } catch { /* none yet */ }
          return json(200, { card: fb.card, confirms });
        } catch {
          return json(404, { error: 'no feedback recorded for this session' });
        }
      }
      if (url === '/api/card-feedback' && req.method === 'POST') {
        // WU-C: the durable home of "did this match?". The session-card
        // control dies with its tab (and, in multi-session, with the 30-min
        // ended-session reap) — the history card is where confirms actually
        // get given. Feeds promote-fixture; same file, same shape.
        const b = JSON.parse((await readBody(req)) || '{}') as {
          session?: string; dimension?: string; agree?: boolean;
        };
        const sid = b.session ?? '';
        if (!/^sess-[\w-]+$/.test(sid)) return json(400, { error: 'bad session id' });
        if (typeof b.dimension !== 'string' || !isDimensionKey(b.dimension)) {
          return json(400, { error: 'bad dimension' });
        }
        let fbOwner: string | undefined;
        try {
          fbOwner = (JSON.parse(
            readFileSync(path.join(repoRoot, 'feedback', `${sid}.json`), 'utf8'),
          ) as { user_id?: string }).user_id;
        } catch {
          return json(404, { error: 'no feedback recorded for this session' });
        }
        if (!user!.admin && (fbOwner ?? cfg.userId) !== user!.id) {
          return json(404, { error: 'no feedback recorded for this session' });
        }
        const file = path.join(repoRoot, 'assessments', `${sid}.confirm.json`);
        let confirms: Record<string, boolean> = {};
        try {
          confirms = JSON.parse(readFileSync(file, 'utf8')) as Record<string, boolean>;
        } catch { /* first confirmation */ }
        confirms = mergeConfirm(confirms, b.dimension, Boolean(b.agree));
        mkdirSync(path.join(repoRoot, 'assessments'), { recursive: true });
        writeFileSync(file, JSON.stringify(confirms, null, 2));
        return json(200, { ok: true });
      }
      if (url === '/api/state') {
        const now = Date.now();
        // Multi mode: liveness and the session link are the CALLER's — the
        // URL carries ?sid so a browser restart (no ip_sid cookie) still
        // resumes into the right room through the router.
        let live: boolean;
        let sessionUrl = `${cfg.pub.sessionPublicUrl}/session`;
        if (cfg.pub.multiSession) {
          const reg = await reconcileRegistryNow();
          const mine = reg.entries.find((e) => e.user_id === user!.id && e.ended_at === undefined);
          live = Boolean(mine);
          if (mine) sessionUrl = `${cfg.pub.sessionPublicUrl}/session?sid=${encodeURIComponent(mine.sid)}`;
        } else {
          live = await sessionLive(cfg.sessionPort);
        }
        // The candidate's active gap, as a sentence — TODAY's "aimed at:"
        // line. The raw key ("clarify") explained nothing on the old page.
        const focus = (() => {
          try {
            const view = buildGraphView(loadStore(path.join(repoRoot, 'gaps'), user!.id));
            return view.focus ? { key: view.focus, description: gapDescription(view.focus) } : null;
          } catch {
            return null;
          }
        })();
        const targets = listTargets(repoRoot)
          .filter((t) => user!.admin || (t.user_id ?? cfg.userId) === user!.id)
          .map((t) => {
            const queue = refreshQueue(t, t.user_id ?? cfg.userId, now);
            const withTitles = queue
              ? {
                  ...queue,
                  items: queue.items.map((i) => {
                    const dir =
                      i.status === 'generating' && i.problem_dir
                        ? path.isAbsolute(i.problem_dir)
                          ? i.problem_dir
                          : path.join(repoRoot, i.problem_dir)
                        : null;
                    return {
                      ...i,
                      title: resolveTitle(i),
                      // Honest progress (ISSUE-007): start time from the
                      // .generating marker, live file count, and a phase —
                      // replaces the decorative infinite bar.
                      ...(dir ? { generating: generationProgress(dir) } : {}),
                    };
                  }),
                }
              : null;
            // Season-topic coverage for the plan page's band: the frozen
            // list joined with topic-log outcomes. Derived per poll — the
            // log is one tiny file read in a loop that already does disk
            // work per target; corrupt/missing degrades to no band.
            let topicRollup: import('./topic-log.js').TopicRollup[] | null = null;
            if (t.topics?.length) {
              try {
                topicRollup = rollupTopics(t.topics, loadTopicLog(repoRoot, t.id));
              } catch { /* unreadable log — band absent, plan unaffected */ }
            }
            return {
              target: {
                id: t.id,
                label: t.label,
                interview_date: t.interview_date ?? null,
                specs: t.specs.map((s) => ({ id: s.id, label: s.label, capabilities: s.capabilities, date: s.date ?? null, evidence_tier: s.evidence_tier ?? null })),
                topics: t.topics ?? null,
              },
              topic_rollup: topicRollup,
              queue: withTitles,
              // Latest adaptation only — the timeline explains why rounds
              // changed with one line, not the whole history.
              adaptation: t.adaptations?.length
                ? { at: t.adaptations[t.adaptations.length - 1]!.at, summary: t.adaptations[t.adaptations.length - 1]!.summary }
                : null,
              // next must come from the TITLED items — the raw queue's
              // label is the "— round N" string the redesign banned.
              next: withTitles ? nextUp(withTitles as unknown as Queue) : null,
              days: queue
                ? bucketIntoDays(withTitles as unknown as Queue, t, now)
                : null,
            };
          })
          // Nearest ROUND first (a loop's rounds carry their own dates);
          // the target date stands in for undated specs; undated targets last.
          .sort((a, b) => (nearestDeadline(a.target) ?? '9999') < (nearestDeadline(b.target) ?? '9999') ? -1 : 1);
        // The practice door's rows — reconciled + phase-derived on every
        // poll, same one-poll-drives-everything contract as targets, same
        // save-if-changed discipline as refreshQueue.
        const repsStored = loadReps(repoRoot);
        const repsFresh = reconcileWithDisk(repoRoot, repsStored) as typeof repsStored;
        if (JSON.stringify(repsFresh) !== JSON.stringify(repsStored)) {
          saveReps(repoRoot, repsFresh);
          db.mirrorReps(repsFresh.items.map((r) => repRow(r, cfg.userId, now)));
        }
        if (user!.email && !mirroredUsers.has(user!.id)) {
          mirroredUsers.add(user!.id);
          db.upsertUsers([{ id: user!.id, email: user!.email, is_admin: user!.admin }]);
        }
        sweepSessionsToDb();
        const repsForUser = repsVisibleTo(repStateView(repoRoot, repsFresh), user!, cfg.userId);
        // Willingness-to-pay allowance (paywall.ts). ADVISORY ONLY — the gate
        // is enforced at the ten spend routes, which is what makes it real.
        // This key is what the client renders a remaining-rounds readout and a
        // "manage billing" affordance from.
        //
        // Pure arithmetic over arrays this handler already holds, plus two
        // small ledger reads — a route polled every 5s gains no per-target
        // disk work. ABSENT for admins, a gate-off box, and anyone comped, so
        // the client's fail-open default is the only default it has.
        //
        // Subscribers are NOT excluded here: they have a per-period allowance
        // too, and the readout is how they see what is left. Miss that and a
        // paying customer either sees a free-tier nag or no counter at all.
        const pw = cfg.pub.paywall;
        const subRows = readSubscriptionRows();
        const paidNow = subscribed(subRows, user!.id);
        const allowance =
          pw.enabled && !user!.admin && !hasGrant(readPaywallRows(), user!.id)
            ? {
                price_usd: pw.priceUsd,
                subscribed: paidNow,
                billing_enabled: cfg.pub.stripe !== null,
                rounds_used: roundsUsed(
                  repsForUser,
                  targets.flatMap((t) => t.queue?.items ?? []),
                  user!.id,
                  cfg.userId,
                  periodStart(subRows, user!.id),
                ),
                free_rounds: paidNow ? pw.paidRounds : pw.freeRounds,
                // `targets` is already owner-filtered above, so its length IS
                // the plan count — countPlans is for the routes that hold raw
                // Target records instead.
                plans_used: targets.length,
                // null = UNLIMITED, and a subscriber really is: gateFor returns
                // null for `plans` the moment `paid` is true. Reporting
                // pw.freePlans here regardless would have this advisory
                // contradict the enforcement it describes — a subscriber shown
                // "3 of 3 plans used" while the route happily makes a fourth.
                // Nothing renders this yet; the point is that it cannot lie
                // when something does.
                free_plans: paidNow ? null : pw.freePlans,
              }
            : null;
        return json(200, {
          targets,
          reps: repsForUser,
          focus,
          today: new Date(now).toISOString(),
          session_live: live,
          session_url: sessionUrl,
          user: { id: user!.id, email: user!.email, admin: user!.admin },
          ...(allowance ? { paywall: allowance } : {}),
        });
      }
      if (url === '/api/stripe/checkout' && req.method === 'POST') {
        // Creates a hosted Checkout Session and hands back its URL. Hosted,
        // not embedded: no Stripe.js on our page, so no CSP change and no card
        // field ever touches this origin — the property this flow has had from
        // the start.
        const sc = cfg.pub.stripe;
        if (!sc) return json(503, { error: 'billing is not configured' });
        try {
          const stripe = await stripeClient(sc.apiKey);
          const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            // NO payment_method_types — omitting it lets Stripe pick eligible
            // methods per customer from Dashboard settings. Hardcoding ['card']
            // silently locks out everything else.
            line_items: [{ price: sc.priceId, quantity: 1 }],
            // Our user id, on both the session and the subscription. The
            // session's is read on confirm-on-return; the subscription's
            // metadata is what later lifecycle webhooks resolve by, since they
            // carry no client_reference_id.
            client_reference_id: user!.id,
            subscription_data: { metadata: { user_id: user!.id } },
            ...(user!.email ? { customer_email: user!.email } : {}),
            success_url: `${cfg.pub.appPublicUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${cfg.pub.appPublicUrl}/?checkout=cancelled`,
            integration_identifier: STRIPE_INTEGRATION_ID,
          });
          if (!session.url) return json(502, { error: 'stripe returned no checkout url' });
          return json(200, { url: session.url });
        } catch (e) {
          console.error('[billing] checkout create failed:', String(e).slice(0, 200));
          return json(502, { error: 'could not start checkout — try again' });
        }
      }
      if (url.startsWith('/api/stripe/confirm') && req.method === 'GET') {
        // Confirm-on-return. The webhook is the durable record, but it can
        // land after the user is already back — and "I paid and nothing
        // happened" is the worst first impression a paid product can make.
        // This writes the entitlement row synchronously so the retry that
        // follows immediately gets through.
        const sc = cfg.pub.stripe;
        if (!sc) return json(503, { error: 'billing is not configured' });
        const sid = new URL(url, 'http://x').searchParams.get('session_id') ?? '';
        if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return json(400, { error: 'bad session id' });
        try {
          const stripe = await stripeClient(sc.apiKey);
          const session = await stripe.checkout.sessions.retrieve(sid);
          // Ownership: a session id is not a secret, so without this check
          // anyone holding one could confirm someone else's purchase onto
          // their own account.
          if (session.client_reference_id !== user!.id) {
            return json(403, { error: 'not your checkout session' });
          }
          if (session.status !== 'complete') return json(200, { subscribed: false, pending: true });
          const subId = typeof session.subscription === 'string' ? session.subscription : '';
          if (!subId) return json(200, { subscribed: false, pending: true });
          const sub = await stripe.subscriptions.retrieve(subId);
          logSubscription(
            rowFromSubscription(user!.id, sub as unknown as Record<string, never>, Date.now()),
          );
          return json(200, { subscribed: subscribed(readSubscriptionRows(), user!.id) });
        } catch (e) {
          console.error('[billing] confirm failed:', String(e).slice(0, 200));
          return json(502, { error: 'could not confirm the purchase — refresh in a moment' });
        }
      }
      if (url === '/api/stripe/portal' && req.method === 'POST') {
        // Cancellation, receipts, payment-method updates — all Stripe's
        // Customer Portal, none of it ours to build or to get wrong.
        const sc = cfg.pub.stripe;
        if (!sc) return json(503, { error: 'billing is not configured' });
        const row = readSubscriptionRows().filter((r) => r.user_id === user!.id).pop();
        if (!row?.customer_id) return json(400, { error: 'no billing account yet' });
        try {
          const stripe = await stripeClient(sc.apiKey);
          const portal = await stripe.billingPortal.sessions.create({
            customer: row.customer_id,
            return_url: `${cfg.pub.appPublicUrl}/`,
          });
          return json(200, { url: portal.url });
        } catch (e) {
          console.error('[billing] portal failed:', String(e).slice(0, 200));
          return json(502, { error: 'could not open billing — try again' });
        }
      }
      if (url === '/api/paywall/probe' && req.method === 'POST') {
        // The WTP gate's recorder (paywall.ts). This route can return ONLY
        // 200 — the client awaits it on the grant path, and a 4xx/5xx here
        // would strand a user who just pressed Subscribe.
        //
        // It is also where a grant is MINTED: pressing Subscribe writes the
        // row that hasGrant() reads at every gate. That makes the write
        // ordering load-bearing — the row must be on disk before this
        // responds, because the client retries the launch the moment it
        // resolves. Everything here is synchronous for that reason; an async
        // append would deadlock the user on their own gate.
        const b = JSON.parse((await readBody(req)) || '{}') as { action?: string; expect?: string };
        const action = probeAction(b.action);
        // Admins and a gate-off box record NOTHING: the founder's own clicks
        // are not signal, and a stale tab must not pollute the log.
        const recorded = cfg.pub.paywall.enabled && !user!.admin;
        if (recorded) {
          const expect = expectedText(b.expect);
          logPaywall({
            ts: new Date().toISOString(),
            user_id: user!.id,
            email: user!.email,
            action,
            price_usd: cfg.pub.paywall.priceUsd,
            free_rounds: cfg.pub.paywall.freeRounds,
            free_plans: cfg.pub.paywall.freePlans,
            ...(expect ? { expect } : {}),
          });
        }
        // `granted` tells the client its retry will get through rather than
        // looping on the same gate. True for an admin/gate-off box too — they
        // were never gated in the first place.
        return json(200, { ok: true, granted: !recorded || grantsAccess(action) });
      }
      if (url === '/api/target' && req.method === 'POST') {
        // The plan guardrail, checked FIRST — before label validation, before
        // decodeAttachments, before any byte hits disk. This handler makes no
        // model call (that is /api/plan/turn, which planFirstSend fires right
        // after), so refusing here costs the user nothing but a message.
        // The client gates the entry point earlier so nobody types a whole
        // description first; this is the backstop that makes it real.
        {
          const g = gateFor('plans');
          if (g) {
            const out = refuse(g);
            return json(out.code, out.body);
          }
        }
        const b = JSON.parse((await readBody(req)) || '{}') as {
          label?: string; date?: string; description?: string; context?: string;
          attachments?: { name?: string; media_type?: string; data?: string }[];
        };
        if (!b.label?.trim()) return json(400, { error: 'label required' });
        // "AUg 20" stored verbatim rendered as "NaN days to Palantir". The
        // date is optional; a garbled one is an error, never silent data.
        const date = b.date?.trim() ?? '';
        if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`)))) {
          return json(400, { error: `couldn't read that date — write it like 2026-08-20 (got "${date}")` });
        }
        // Binary attachments: media-type allowlist + size caps, decoded and
        // written under the target dir. Rejecting BEFORE the target exists
        // keeps a bad upload from leaving a half-made plan behind.
        const att = decodeAttachments(b.attachments ?? []);
        if ('error' in att) return json(400, { error: att.error });
        const decoded = att.decoded;
        const t: Target = {
          id: `${slugify(b.label)}-${Date.now().toString(36)}`,
          label: b.label.trim(),
          user_id: user!.id,
          ...(date ? { interview_date: date } : {}),
          description: b.description?.trim() ?? '',
          ...(b.context?.trim() ? { context: b.context.trim() } : {}),
          specs: [],
          created: new Date().toISOString(),
        };
        if (decoded.length > 0) {
          const dir = path.join(targetDir(repoRoot, t.id), 'attachments');
          mkdirSync(dir, { recursive: true });
          t.attachments = decoded.map((d, i) => {
            // basename + strip traversal: the name is client input.
            const safe = `${i + 1}-${path.basename(d.name).replace(/[^\w.\-]+/g, '_')}`;
            writeFileSync(path.join(dir, safe), d.bytes);
            return { name: d.name, media_type: d.media_type, file: path.join('attachments', safe) };
          });
        }
        saveTarget(repoRoot, t);
        db.mirrorTargets([targetRow(t, cfg.userId)]);
        return json(200, { id: t.id });
      }
      if (url === '/api/clarify' && req.method === 'POST') {
        // The intake reasoner: sees everything intake knows, returns 0-3
        // structured questions + 1+ round drafts. A contradiction inside
        // what the candidate provided becomes a QUESTION, and multiple
        // real rounds become multiple specs.
        const b = JSON.parse((await readBody(req)) || '{}') as {
          target_id?: string;
          answers?: { question: string; answer: string }[];
        };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        if (!t) return json(404, { error: 'no such target' });
        if (!t.description) return json(400, { error: 'describe the round first' });
        const { pickClarifier } = await import('./clarify.js');
        const { attachmentBlocks } = await import('./intake.js');
        try {
          const result = await pickClarifier(path.join(repoRoot, 'prompts', 'clarify-intake.md'))({
            description: t.description,
            context: t.context ?? '',
            answers: b.answers,
            attachments: attachmentBlocks(repoRoot, t),
          });
          return json(200, result);
        } catch (e) {
          // Gate failure or model failure: fall back to plain single-spec
          // inference rather than showing broken questions.
          console.warn(`[app] clarify failed, falling back to infer: ${String(e).slice(0, 200)}`);
          try {
            const infer = pickSpecInferrer(path.join(repoRoot, 'prompts', 'infer-round-spec.md'));
            const draft = await infer(t.description, t.context ?? '');
            return json(200, { questions: [], drafts: [draft] });
          } catch (e2) {
            return json(502, { error: `inference failed: ${String(e2).slice(0, 300)}` });
          }
        }
      }
      if (url === '/api/practice/clarify' && req.method === 'POST') {
        {
          const g = gateFor('rounds');
          if (g) {
            const out = refuse(g);
            return json(out.code, out.body);
          }
        }
        // The practice door's inference: the gap-deriving clarifier (design
        // review 2026-08-12) — material arrives INLINE, a rep has no target
        // to read from. Same fallback ladder shape as /api/clarify; failures
        // reach the candidate as actionable copy, never gate internals.
        // DEGRADATION INVARIANT: every 200 carries >=1 draft and a gaps
        // array, so the client renders ONE confirm screen on every path.
        const b = JSON.parse((await readBody(req)) || '{}') as {
          description?: string;
          context?: string;
          answers?: { id?: string; question?: string; answer?: string }[];
          attachments?: { name?: string; media_type?: string; data?: string }[];
        };
        const { clarifyFailureMessage } = await import('./clarify.js');
        const { deriveRuntimeGaps, pickPracticeClarifier } = await import('./practice-clarify.js');
        const { deriveTaskFromSpec } = await import('./blueprint.js');
        let input: { description: string; context: string };
        try {
          input = gateRepInput(b);
        } catch (e) {
          return json(400, { error: String(e instanceof Error ? e.message : e) });
        }
        // Caps are checked HERE, not only at Start (T11, 2026-08-12 review):
        // "come back tomorrow" must land before the candidate co-authors a
        // round, not after. Same copy as /api/practice.
        const admission = admissionVerdict(
          loadReps(repoRoot).items, user!.id, cfg.userId, Date.now(), cfg.pub.caps,
        );
        if (admission === 'daily-cap') {
          return json(429, { error: "that's your practice budget for today — the beta caps rounds per day; come back tomorrow" });
        }
        if (admission === 'pending-cap') {
          return json(429, { error: 'you have unplayed rounds waiting — run or retry one of those before building another' });
        }
        if (admission === 'global-cap') {
          return json(429, { error: "Zenkai hit its build budget for today — everyone's rounds run on the same meter. Come back tomorrow." });
        }
        const att = decodeAttachments(b.attachments ?? []);
        if ('error' in att) return json(400, { error: att.error });
        const answers = (b.answers ?? [])
          .filter((a) => a.id?.trim() && a.answer?.trim())
          .map((a) => ({ id: a.id!.trim(), question: a.question?.trim() || a.id!.trim(), answer: a.answer!.trim() }));
        // Declines are decision 2B: never block, always visible, ALWAYS
        // counted — this warn is the only frequency data 2B's "revisit with
        // data" clause has.
        const warnUnsupported = (drafts: { spec: { label: string }; unsupported?: string }[]) => {
          for (const d of drafts) {
            if (d.unsupported) console.warn(`[practice] unsupported round "${d.spec.label}": ${d.unsupported}`);
          }
        };
        try {
          const result = await pickPracticeClarifier(path.join(repoRoot, 'prompts', 'practice-clarify.md'))({
            description: input.description,
            context: input.context,
            answers,
            attachments: attachmentBlocksFromDecoded(att.decoded),
          });
          warnUnsupported(result.drafts);
          // Real-set sourcing (2026-08-13, "source by default"): every
          // algorithmic draft gets a binding — a NAMED problem resolved
          // mechanically, else a memory-blind diverse pick. This whole
          // step is decoration: any failure (dataset absent, pool dry)
          // just means the draft invents, exactly the pre-sourcing path.
          try {
            const lc = await import('./lc-source.js');
            if (lc.lcReady(repoRoot).ok) {
              const { resolveProblemRef } = await import('./lc-refs.js');
              const { autoSourceEligible, composeSourceBinding, resolveNamedRefs, sourceSetSize } =
                await import('./lc-bind.js');
              const { recentlyAttemptedSlugs } = await import('./topic-graph.js');
              const { namedProblemGap } = await import('./practice-clarify.js');
              const index = lc.loadLcIndex(repoRoot);
              const blocked = lc.blocklistedSlugs(repoRoot);
              // A row the candidate already ANSWERED outranks everything a
              // re-inference produced — their edit must not be undone by
              // the model's next turn (the answered-gaps rule, applied to
              // sourcing). "invent" opts the whole screen out of binding.
              const srcAnswer = answers.find((a) => a.id === 'named-problem')?.answer.trim() ?? null;
              const srcInvent = srcAnswer !== null && /^invent/i.test(srcAnswer);
              for (const d of result.drafts) {
                if (!autoSourceEligible(d.task, d.spec) || srcInvent) continue;
                // An answered row is the strongest ref and must not be
                // silently substituted when it fails to resolve — door-level
                // strictness, checked BEFORE the shared lenient resolution.
                if (srcAnswer) {
                  const hit = resolveProblemRef(srcAnswer, index);
                  if (!hit || blocked.has(hit.slug) || !lc.eligibleForSourcing(hit)) continue;
                }
                const named = resolveNamedRefs(
                  [...(srcAnswer ? [srcAnswer] : []), ...(d.named_problems ?? [])],
                  { index, blocked },
                );
                const { binding } = composeSourceBinding({
                  index,
                  named,
                  count: sourceSetSize(d.part_count, named.length, d.spec),
                  excludeSlugs: new Set([
                    ...recentlyAttemptedSlugs(repoRoot, user!.id, Date.now()),
                    ...blocked,
                  ]),
                  // Seeded on user+spec: re-clarifying the same round deals
                  // the same set (stable confirm screen). Deliberately no
                  // cross-draft dedup on this door — accept-spec's `bound`
                  // accumulator is the door that must not repeat.
                  seed: `${user!.id}:${d.spec.id}`,
                });
                if (!binding) continue;
                d.source = binding;
                result.gaps.push(
                  namedProblemGap(
                    (binding.parts ?? [binding]).map((p) => ({ title: p.title, difficulty: p.difficulty, picked_by: p.picked_by })),
                  ),
                );
              }
            }
          } catch (e) {
            console.warn(`[practice] source decoration skipped: ${String(e).slice(0, 160)}`);
          }
          return json(200, result);
        } catch (e) {
          console.warn(`[app] practice clarify failed, falling back to infer: ${String(e).slice(0, 200)}`);
          try {
            const infer = pickSpecInferrer(path.join(repoRoot, 'prompts', 'infer-round-spec.md'));
            const draft = await infer(input.description, input.context);
            warnUnsupported([draft]);
            // The blind read: single-spec inference reports no evidence, so
            // time is a gap unless the draft carries a limit. `degraded`
            // tells the client to say "check the facts" instead of nothing.
            const ms = draft.spec.capabilities.time_limit_ms;
            return json(200, {
              drafts: [draft],
              // Single-spec inference reports no provenance at all, so BOTH
              // floors fire: a blind read is exactly when the candidate must
              // be asked rather than guessed at.
              gaps: deriveRuntimeGaps({
                timeEvidence: ms === null ? 'unknown' : 'stated_timed',
                timeLimitMs: ms,
                languageEvidence: 'unknown',
                language: '',
                languageOptions: [],
                // The blind read has no hypothesis; capability facts stand in
                // and the rail says GUESSED, which is the honest chip here.
                task: deriveTaskFromSpec(draft.spec),
                taskEvidence: 'inferred',
                answeredIds: new Set(answers.map((a) => a.id)),
                answers,
              }),
              brief: '',
              degraded: true,
            });
          } catch (e2) {
            return json(502, { error: clarifyFailureMessage(e2) });
          }
        }
      }
      if (url === '/api/practice' && req.method === 'POST') {
        {
          const g = gateFor('rounds');
          if (g) {
            const out = refuse(g);
            return json(out.code, out.body);
          }
        }
        // Start a rep build. Gate order matters: identity, vocabulary,
        // size, THEN the lock — nothing is created until every check holds,
        // and the mkdir lock is what makes a double-click spawn exactly one
        // detached agent (both clicks carry the same client-generated id).
        const b = JSON.parse((await readBody(req)) || '{}') as {
          rep_id?: string; spec?: unknown; description?: string; context?: string; task?: string;
          source_ref?: string; source_auto?: boolean;
          /** Set form: refs in part order + which were auto picks. */
          source_refs?: string[]; source_autos?: boolean[];
        };
        if (typeof b.rep_id !== 'string' || !REP_ID_RE.test(b.rep_id)) {
          return json(400, { error: 'bad rep id' });
        }
        const specErrors = validateRoundSpec(b.spec);
        if (specErrors.length > 0) {
          // The server re-proves the spec no matter what the client edited —
          // the accept-spec discipline.
          return json(400, { error: `spec failed the gate: ${specErrors.join('; ')}` });
        }
        let input: { description: string; context: string };
        try {
          input = gateRepInput(b);
        } catch (e) {
          return json(400, { error: String(e instanceof Error ? e.message : e) });
        }
        // Beta caps (WU6). Per-user admission first (cheap, pure), then the
        // global build slot — each opus build is real money and the beta
        // runs them one at a time.
        const admission = admissionVerdict(
          loadReps(repoRoot).items, user!.id, cfg.userId, Date.now(), cfg.pub.caps,
        );
        if (admission === 'daily-cap') {
          return json(429, { error: "that's your practice budget for today — the beta caps rounds per day; come back tomorrow" });
        }
        if (admission === 'pending-cap') {
          return json(429, { error: 'you have unplayed rounds waiting — run or retry one of those before building another' });
        }
        if (admission === 'global-cap') {
          // The only cap that bounds spend while signup is open: per-user
          // limits reset for the price of a new email address.
          return json(429, { error: "Zenkai hit its build budget for today — everyone's rounds run on the same meter. Come back tomorrow." });
        }
        if (countLiveBuilds() >= cfg.pub.caps.maxConcurrentBuilds) {
          return json(409, { error: "someone else's round is generating — builds run one at a time in the beta; try again in ~5 minutes" });
        }
        try {
          acquireRepLock(repoRoot, b.rep_id);
        } catch (e) {
          return json(409, { error: String(e instanceof Error ? e.message : e) });
        }
        // The task hypothesis rides only when it names a real task — an
        // absent/garbled value falls back to capability derivation in
        // rep-build, never an error (recipe-side, not vocabulary).
        const { ROUND_TASKS } = await import('./blueprint.js');
        const task = typeof b.task === 'string' && (ROUND_TASKS as readonly string[]).includes(b.task)
          ? b.task : undefined;
        // The source binding rides only after the SERVER re-proves it —
        // resolve the ref, run the one ladder. "invent", an unresolvable
        // ref, or a refused slug all mean the same thing: no binding, the
        // build invents. Never an error: a vanished dataset must not block
        // a round the pre-sourcing product could build.
        let source: QueueItem['source'];
        // Set form wins; the single-ref form stays for compatibility. Every
        // ref is re-resolved and re-verdicted server-side; "invent" (any
        // ref) opts out entirely; a failed ref DROPS with a warn — the set
        // that binds is the set that resolves.
        const rawRefs = Array.isArray(b.source_refs) && b.source_refs.length
          ? b.source_refs.map((r, i) => ({ ref: String(r ?? '').trim(), auto: b.source_autos?.[i] === true }))
          : (typeof b.source_ref === 'string' && b.source_ref.trim()
              ? [{ ref: b.source_ref.trim(), auto: b.source_auto === true }]
              : []);
        const optedOut = rawRefs.some(({ ref }) => /^invent/i.test(ref));
        if (rawRefs.length && !optedOut) {
          try {
            const lc = await import('./lc-source.js');
            const { resolveProblemRef } = await import('./lc-refs.js');
            if (lc.lcReady(repoRoot).ok) {
              const index = lc.loadLcIndex(repoRoot);
              const parts: NonNullable<NonNullable<QueueItem['source']>['parts']> = [];
              for (const { ref, auto } of rawRefs.slice(0, 4)) {
                if (!ref) continue;
                const hit = resolveProblemRef(ref, index);
                const verdict = hit ? lc.sourceBindingVerdict(repoRoot, hit.slug) : null;
                if (hit && verdict?.ok && !parts.some((x) => x.slug === hit.slug)) {
                  parts.push({ slug: hit.slug, title: hit.title, difficulty: hit.difficulty, picked_by: auto ? 'auto' : 'user' });
                } else {
                  console.warn(`[practice] source ref not bound ("${ref.slice(0, 60)}"): ${verdict && !verdict.ok ? verdict.reason : 'unresolved'}`);
                }
              }
              if (parts.length) {
                source = {
                  kind: 'leetcode',
                  ...parts[0]!,
                  ...(parts.length > 1 ? { parts } : {}),
                };
              }
            }
          } catch (e) {
            console.warn(`[practice] source binding skipped: ${String(e).slice(0, 160)}`);
          }
        }
        const rep = createRepRecord({
          userId: user!.id,
          id: b.rep_id,
          spec: b.spec as RoundSpec,
          description: input.description,
          ...(input.context ? { context: input.context } : {}),
          ...(task ? { task } : {}),
          ...(source ? { source } : {}),
        });
        const file = loadReps(repoRoot);
        file.items.push(rep);
        if (!file.created) file.created = rep.created;
        saveReps(repoRoot, file);
        db.mirrorReps([repRow(rep, cfg.userId, Date.now())]);
        console.log(`[app] rep ${rep.id} requested (${rep.spec.label})`);
        spawnRepBuild(rep);
        return json(200, { ok: true, rep_id: rep.id });
      }
      if (url === '/api/practice/launch' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { rep_id?: string; origin?: string };
        if (typeof b.rep_id !== 'string' || !REP_ID_RE.test(b.rep_id)) {
          return json(400, { error: 'bad rep id' });
        }
        const views = repStateView(repoRoot, loadReps(repoRoot));
        const rep = views.find((r) => r.id === b.rep_id);
        if (!rep) return json(404, { error: 'no such rep' });
        if (!ownsRep(rep)) return json(403, { error: 'not your rep' });
        // WTP gate, above the mode fork so one check covers both session
        // modes. After ownership so a stranger still gets 403, not a price.
        {
          const g = gateFor('rounds');
          if (g) {
            const out = refuse(g);
            return json(out.code, out.body);
          }
        }
        const dir = repProblemDir(repoRoot, rep.id);
        if (cfg.pub.multiSession) {
          // Ready/used checks still apply; liveness verdicts live in the
          // registry. NEVER probe cfg.sessionPort here — that's the router.
          const pre = launchVerdict(rep, {
            usedExists: existsSync(path.join(dir, '.used')),
            sessionLive: false,
          });
          if (pre === 'not-ready') return json(400, { error: 'rep is not ready' });
          if (pre === 'already-used') return json(409, { error: 'that rep already ran — its card is under history, where "practice again" runs it fresh' });
          const out = await multiLaunch({ id: user!.id, admin: user!.admin }, dir);
          if (out.code === 200) {
            logLaunch(b.origin, String(out.body.session_id));
            console.log(`[app] rep ${rep.id} launching as ${String(out.body.session_id)}`);
          }
          return json(out.code, out.body);
        }
        const probe = await probeSession(cfg.sessionPort);
        const verdict = launchVerdict(rep, {
          usedExists: existsSync(path.join(dir, '.used')),
          sessionLive: probe.reachable && !probe.ended,
        });
        if (verdict === 'not-ready') return json(400, { error: 'rep is not ready' });
        if (verdict === 'already-used') return json(409, { error: 'that rep already ran — its card is under history, where "practice again" runs it fresh' });
        if (verdict === 'session-live') {
          const owner = await probeSessionOwner(cfg.sessionPort);
          return json(409, {
            error: owner === null || owner === user!.id || user!.admin
              ? 'a session is already running — finish or end it first'
              : 'someone is mid-round — sessions run one at a time in the beta; check back in ~45 minutes',
          });
        }
        if (probe.reachable && probe.ended) {
          // Reap a graded session's lingering card server (the /api/launch
          // pattern, verbatim) so port 3200 frees up for the new session.
          await postSession(cfg.sessionPort, '/api/shutdown');
          for (let i = 0; i < 10; i++) {
            if (!(await probeSession(cfg.sessionPort)).reachable) break;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        const sessionId = `sess-${Date.now()}`;
        logLaunch(b.origin, sessionId);
        spawnDetached(['session', dir], {
          IP_SESSION_ID: sessionId,
          // The person at the keyboard is whose gap graph gets written.
          IP_USER_ID: user!.id,
          IP_PREPARE_NEXT: '0',
          IP_APP_URL: cfg.pub.appPublicUrl,
          ...(internalHeaders['x-ip-internal']
            ? { IP_INTERNAL_TOKEN: internalHeaders['x-ip-internal'] }
            : {}),
        });
        console.log(`[app] rep ${rep.id} launching as ${sessionId}`);
        return json(200, { session_id: sessionId, url: `${cfg.pub.sessionPublicUrl}/session` });
      }
      if (url === '/api/practice/repeat' && req.method === 'POST') {
        // "Practice again" (artifact.ts / TODOS #48): preserve the finished
        // run's tree, reset the workspace to pristine, launch a fresh
        // session on the same rep. Same request/response shape as
        // /api/practice/launch — the client's launchCommon drives both.
        //
        // Still DELIBERATELY no admissionVerdict: a repeat spends zero
        // GENERATION budget (no opus build, no new problem dir), so the build
        // caps have nothing to protect here.
        //
        // The WTP gate below is the opposite case, and the distinction is the
        // point: that reasoning is build-cost-based, and a repeat still spends
        // full SESSION cost — interviewer turns, judge, voice, container time
        // — and is a round the user experiences. Leaving repeats ungated would
        // also make the whole gate bypassable: use your free rounds, then
        // repeat forever.
        const b = JSON.parse((await readBody(req)) || '{}') as { rep_id?: string; origin?: string };
        if (typeof b.rep_id !== 'string' || !REP_ID_RE.test(b.rep_id)) {
          return json(400, { error: 'bad rep id' });
        }
        const views = repStateView(repoRoot, loadReps(repoRoot));
        const rep = views.find((r) => r.id === b.rep_id);
        if (!rep) return json(404, { error: 'no such rep' });
        if (!ownsRep(rep)) return json(403, { error: 'not your rep' });
        {
          const g = gateFor('rounds');
          if (g) {
            const out = refuse(g);
            return json(out.code, out.body);
          }
        }
        const dir = repProblemDir(repoRoot, rep.id);
        const usedFile = path.join(dir, '.used');
        const restorable = restorability({
          hasPristine: existsSync(pristineArchivePath(dir)),
          hasSnapshot: existsSync(path.join(dir, '.session-snapshot')),
        });
        // Liveness is per-DIR here, not per-user: the danger is restoring
        // files out from under a container that has them bind-mounted.
        const probe = cfg.pub.multiSession ? null : await probeSession(cfg.sessionPort);
        const sessionLiveOnDir = cfg.pub.multiSession
          ? (await reconcileRegistryNow()).entries.some(
              (e) => e.problem_dir === dir && e.ended_at === undefined,
            )
          : probe!.reachable && !probe!.ended;
        const verdict = repeatVerdict(rep, {
          usedExists: existsSync(usedFile),
          sessionLiveOnDir,
          restorable,
        });
        if (verdict === 'not-done') {
          return json(409, { error: "that round hasn't finished — its session is still live or unjudged" });
        }
        if (verdict === 'not-consumed') {
          return json(409, { error: "that rep hasn't run yet — use start" });
        }
        if (verdict === 'session-live') {
          const owner = cfg.pub.multiSession ? null : await probeSessionOwner(cfg.sessionPort);
          return json(409, {
            error: owner === null || owner === user!.id || user!.admin
              ? 'a session is already running — finish or end it first'
              : 'someone is mid-round — sessions run one at a time in the beta; check back in ~45 minutes',
          });
        }
        if (verdict === 'not-repeatable') {
          return json(409, { error: 'this round predates repeatable artifacts and its pristine copy is gone' });
        }
        // `.used` is overwrite-latest and two lines (`sid\nISO\n`) — the
        // first line names the run whose tree we are about to replace.
        const oldSid = readFileSync(usedFile, 'utf8').split('\n')[0]!;
        const resetWorkspace = (): void => {
          preserveRunTree(dir, oldSid); // non-fatal insurance
          if (restorable === 'pristine') restorePristine(dir);
          else restoreFromSnapshot(dir);
        };
        if (cfg.pub.multiSession) {
          // ignoreEndedOnSameDir: the round we are repeating just ended and
          // its entry lingers to serve its card — that must not 409 us.
          const out = await multiLaunch({ id: user!.id, admin: user!.admin }, dir, {
            ignoreEndedOnSameDir: true,
            beforeSpawn: resetWorkspace,
          });
          if (out.code === 200) {
            logLaunch(b.origin, String(out.body.session_id));
            console.log(`[app] rep ${rep.id} repeating as ${String(out.body.session_id)} (was ${oldSid})`);
          }
          return json(out.code, out.body);
        }
        if (probe!.reachable && probe!.ended) {
          // Reap a graded session's lingering card server (the /api/launch
          // pattern, verbatim) so port 3200 frees up for the new session.
          await postSession(cfg.sessionPort, '/api/shutdown');
          for (let i = 0; i < 10; i++) {
            if (!(await probeSession(cfg.sessionPort)).reachable) break;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        try {
          resetWorkspace();
        } catch (e) {
          console.error(`[app] repeat aborted before spawn: ${String(e)}`);
          return json(500, {
            error: `could not reset the workspace: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`,
          });
        }
        const sessionId = `sess-${Date.now()}`;
        logLaunch(b.origin, sessionId);
        spawnDetached(['session', dir], {
          IP_SESSION_ID: sessionId,
          // The person at the keyboard is whose gap graph gets written.
          IP_USER_ID: user!.id,
          IP_PREPARE_NEXT: '0',
          IP_APP_URL: cfg.pub.appPublicUrl,
          ...(internalHeaders['x-ip-internal']
            ? { IP_INTERNAL_TOKEN: internalHeaders['x-ip-internal'] }
            : {}),
        });
        console.log(`[app] rep ${rep.id} repeating as ${sessionId} (was ${oldSid})`);
        return json(200, { session_id: sessionId, url: `${cfg.pub.sessionPublicUrl}/session` });
      }
      if (url === '/api/practice/retry' && req.method === 'POST') {
        {
          const g = gateFor('rounds');
          if (g) {
            const out = refuse(g);
            return json(out.code, out.body);
          }
        }
        const b = JSON.parse((await readBody(req)) || '{}') as { rep_id?: string };
        if (typeof b.rep_id !== 'string' || !REP_ID_RE.test(b.rep_id)) {
          return json(400, { error: 'bad rep id' });
        }
        const views = repStateView(repoRoot, loadReps(repoRoot));
        const rep = views.find((r) => r.id === b.rep_id);
        if (!rep) return json(404, { error: 'no such rep' });
        if (!ownsRep(rep)) return json(403, { error: 'not your rep' });
        const dir = repProblemDir(repoRoot, rep.id);
        const gm = readGeneratingMarker(dir);
        const verdict = retryVerdict(rep, { markerAlive: Boolean(gm && pidAlive(gm.pid)) });
        if (verdict === 'not-failed') return json(400, { error: 'rep is not in a failed state' });
        if (verdict === 'still-running') return json(409, { error: 'that build is actually still running — give it a minute' });
        rmSync(path.join(dir, '.failed'), { force: true });
        console.log(`[app] rep ${rep.id} retrying`);
        spawnRepBuild(rep);
        return json(200, { ok: true });
      }
      if (url === '/api/plan/turn' && req.method === 'POST') {
        // One planner conversation turn, awaited inline (the repo's pattern
        // for model calls — /api/clarify does the same). Research turns can
        // run 30-60s; the client shows determinate progress. Turns persist
        // only AFTER the model+gate succeed, so a 502 retry is idempotent.
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; message?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        if (!t) return json(404, { error: 'no such target' });
        if (!process.env.ANTHROPIC_API_KEY) {
          // The conversational planner needs typed content blocks + server
          // tools, which the claude -p path cannot carry. 501 tells the
          // client to fall back to the classic wizard.
          return json(501, { error: 'the conversational planner needs ANTHROPIC_API_KEY — falling back to the classic intake' });
        }
        // A chip-only intake is valid: pasted material lands in context and
        // attachments, not description. Empty-of-everything is the real error.
        if (!t.description && !t.context && !(t.attachments?.length) && !b.message?.trim()) {
          return json(400, { error: 'describe the round first — type or paste something' });
        }
        if ((b.message ?? '').length > 32 * 1024) return json(400, { error: 'message too long — trim it to the relevant part' });
        const { runPlannerTurn } = await import('./planner.js');
        try {
          const result = await runPlannerTurn({
            root: repoRoot,
            target: t,
            templatePath: path.join(repoRoot, 'prompts', 'planner.md'),
            userMessage: b.message,
          });
          return json(200, { turns: result.turns, done: t.specs.length > 0 });
        } catch (e) {
          return json(502, { error: `planner turn failed: ${String(e).slice(0, 300)}` });
        }
      }
      if (url.startsWith('/api/plan/conversation')) {
        // Replay for resume — the fix for the orphan-target litter: a
        // target with a conversation and no specs picks up where it left
        // off instead of rotting as "finish setting up".
        const tid = new URL(url, 'http://x').searchParams.get('target') ?? '';
        const t = tid ? loadTarget(repoRoot, tid) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        if (!t) return json(404, { error: 'no such target' });
        const { loadConversation, renderConversation, latestProposal } = await import('./planner.js');
        const turns = loadConversation(repoRoot, tid);
        return json(200, {
          turns: renderConversation(turns),
          proposal: latestProposal(turns),
          planner_available: Boolean(process.env.ANTHROPIC_API_KEY),
        });
      }
      if (url === '/api/target/delete' && req.method === 'POST') {
        // The other half of the abandoned-plan fix: an explicit way OUT.
        // Deleting removes the whole target dir — conversation, attachments,
        // generated problems. The candidate confirmed in the UI; traces and
        // assessments live outside the target dir and are untouched.
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        if (!t) return json(404, { error: 'no such target' });
        rmSync(targetDir(repoRoot, t.id), { recursive: true, force: true });
        return json(200, { ok: true });
      }
      if (url === '/api/accept-spec' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as {
          target_id?: string;
          spec?: RoundSpec;          // legacy single-spec shape
          specs?: RoundSpec[];       // multi-round accept
          /** Conversational pace override (1-7); falls back to the latest
           *  proposal's value, then the default. */
          pace_per_week?: number;
        };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        const incoming = b.specs ?? (b.spec ? [b.spec] : []);
        if (!t || incoming.length === 0) return json(400, { error: 'target_id and spec(s) required' });
        // The confirm gate re-proves the vocabulary server-side — the client
        // may have let the user edit the drafts.
        for (const spec of incoming) {
          const failures = validateRoundSpec(spec);
          if (failures.length > 0) return json(400, { error: `${spec?.id ?? 'spec'}: ${failures.join('; ')}` });
        }
        const ids = new Set(incoming.map((x) => x.id));
        t.specs = [...t.specs.filter((x) => !ids.has(x.id)), ...incoming];
        saveTarget(repoRoot, t);
        // Planner-settled facts feed generation: persist the summary the
        // model wrote at proposal time so the blueprint drafter reads it
        // (composeRoundBrief deliberately drops description/context once a
        // blueprint exists — this is the door conversation content takes).
        // The conversational pace ("about an hour a day" → 4/week) sizes the
        // queue; an explicit client value wins over the stored proposal.
        let pace: number | undefined =
          typeof b.pace_per_week === 'number' && Number.isFinite(b.pace_per_week)
            ? Math.min(7, Math.max(1, Math.round(b.pace_per_week)))
            : undefined;
        // Named problems ride the STORED proposal, never the client body —
        // the same server-side re-read the summary uses, so nothing the
        // browser edited can invent a binding.
        const namedBySpec = new Map<string, string[]>();
        const partCountBySpec = new Map<string, number>();
        const taskBySpec = new Map<string, string>();
        try {
          const { loadConversation, latestProposal } = await import('./planner.js');
          const prop = latestProposal(loadConversation(repoRoot, t.id));
          if (prop?.summary) {
            writeFileSync(path.join(targetDir(repoRoot, t.id), 'planner-summary.md'), prop.summary + '\n');
          }
          if (pace === undefined && prop?.pace_per_week) pace = prop.pace_per_week;
          // Season topics FREEZE here, once: already gated at proposal time
          // (gateConceptTopics), re-read from the STORED proposal like the
          // summary and named_problems — never the client body — and never
          // overwritten on a later accept (append-only, the specs
          // discipline: topic-log.json counts over this list, so history
          // must keep pointing at the list it ran under).
          if (!t.topics?.length && prop?.topics?.length) {
            t.topics = prop.topics;
            saveTarget(repoRoot, t);
          }
          for (const d of prop?.drafts ?? []) {
            if (d.named_problems?.length) namedBySpec.set(d.spec.id, d.named_problems);
            // Raw stated count — no >=2 filter; sourceSetSize's floor makes a
            // stated 1 identical to undefined (the old filter was drift).
            if (d.part_count) partCountBySpec.set(d.spec.id, d.part_count);
            if (d.task) taskBySpec.set(d.spec.id, d.task);
          }
        } catch { /* no conversation — CLI or legacy path */ }
        if (!loadQueue(repoRoot, t.id)) {
          const queue = proposeQueue(t, Date.now(), pace);
          // Real-set sourcing (2026-08-13, "source by default"): algorithmic
          // specs get bindings BEFORE naming — named problems land on the
          // spec's items in order, memory-blind diverse picks cover the
          // rest. Any failure (dataset absent, pool dry) leaves items
          // unbound and they invent, the pre-sourcing path — never an error.
          try {
            const lc = await import('./lc-source.js');
            if (lc.lcReady(repoRoot).ok) {
              const { autoSourceEligible, composeSourceBinding, resolveNamedRefs, sourceSetSize } =
                await import('./lc-bind.js');
              const { recentlyAttemptedSlugs } = await import('./topic-graph.js');
              const index = lc.loadLcIndex(repoRoot);
              const blocked = lc.blocklistedSlugs(repoRoot);
              const bound = new Set<string>();
              const owner = t.user_id ?? legacyUserId;
              for (const spec of t.specs) {
                // The eligibility gate is the shared module's — the 2026-08-15
                // incident was exactly this door running the capability
                // fallback alone while the practice door consulted the
                // hypothesis; lc-bind.ts carries the incident record and the
                // matrix test.
                if (!autoSourceEligible(taskBySpec.get(spec.id), spec)) continue;
                const mine = queue.items.filter((i) => i.spec_id === spec.id);
                if (mine.length === 0) continue;
                // EVERY item of this spec is one full session of the round,
                // so a 3-part OA spec means a 3-part SET per item — size is
                // computed ONCE per spec. Named problems land in the FIRST
                // item's set; later items are all-auto. `bound` accumulates
                // so no slug repeats across the queue (it gates named refs
                // AND auto picks; the recency window gates picks only).
                const named = resolveNamedRefs(namedBySpec.get(spec.id) ?? [], {
                  index,
                  blocked,
                  excludeSlugs: bound,
                });
                const count = sourceSetSize(partCountBySpec.get(spec.id), named.length, spec);
                mine.forEach((item, itemIdx) => {
                  const { binding, boundSlugs } = composeSourceBinding({
                    index,
                    named: itemIdx === 0 ? named : [],
                    count,
                    excludeSlugs: new Set([
                      ...recentlyAttemptedSlugs(repoRoot, owner, Date.now()),
                      ...blocked,
                      ...bound,
                    ]),
                    seed: `${t.id}:${spec.id}:${item.id}`,
                  });
                  if (!binding) return;
                  for (const s of boundSlugs) bound.add(s);
                  item.source = binding;
                });
              }
            }
          } catch (e) {
            console.warn(`[app] sourcing skipped at accept: ${String(e).slice(0, 160)}`);
          }
          // Name every planned round now (D-impl): one call PER SPEC so a
          // multi-round queue gets titles that fit each round's shape.
          // Failure degrades to quiet rows — naming never blocks the plan.
          // Sourced items are EXCLUDED: a bound item needs no invented
          // title (and the LC title must never become one).
          const namer = pickTopicNamer(path.join(repoRoot, 'prompts', 'plan-topics.md'));
          for (const spec of t.specs) {
            const mine = queue.items.filter((i) => i.spec_id === spec.id && !i.source);
            if (mine.length === 0) continue;
            try {
              const brief = [
                `Round: ${spec.label}.`,
                spec.emphasis ? `Emphasis: ${spec.emphasis}.` : '',
                t.description ? `The candidate describes it as: ${t.description}` : '',
              ].filter(Boolean).join('\n');
              const titles = await stripSpoilerTitles(await namer(brief, mine.length));
              mine.forEach((item, i) => {
                if (titles[i]) item.planned_title = titles[i];
              });
            } catch (e) {
              console.warn(`[app] topic naming failed for ${spec.id} (quiet rows): ${String(e).slice(0, 200)}`);
            }
          }
          saveQueue(repoRoot, queue);
        }
        // Draft a blueprint per accepted spec, detached — the CLI is
        // idempotent (exits 0 when the file exists), so unconditional spawns
        // are safe and a re-accepted spec keeps its existing blueprint
        // (blueprint mutation belongs to adaptation, not re-accept). Drafter
        // failure never blocks this 200: generation falls back to the
        // legacy brief until a draft lands.
        for (const spec of incoming) {
          spawnDetached(['blueprint', t.id, spec.id]);
        }
        return json(200, { ok: true, specs: t.specs.map((x) => x.id) });
      }
      if (url === '/api/adapt' && req.method === 'POST') {
        // PREVIEW ONLY — computes a diff and writes NOTHING. No model
        // output reaches the plan without the candidate approving the
        // diff (D5); /api/adapt/apply is the only writer.
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; material?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        if (!t) return json(404, { error: 'no such target' });
        const material = (b.material ?? '').trim();
        if (!material) return json(400, { error: 'paste what you learned — an email, problem titles, a message' });
        if (material.length > 256 * 1024) {
          return json(400, { error: `that's ${Math.round(material.length / 1024)}KB — trim it to the relevant part (max 256KB)` });
        }
        const q = loadQueue(repoRoot, t.id);
        if (!q) return json(400, { error: 'no plan yet — build one first, then adapt it' });
        try {
          // The model sees only ACTIVE rounds — a retired spec is history,
          // not a supersession target; retired ids stay in the collision
          // universe so they can never be reused.
          const retired = retiredSpecIds(t);
          const activeSpecs = t.specs.filter((s) => !retired.has(s.id));
          // The model sees each active round's current blueprint — that is
          // what blueprint_edits revise. Absent files render as "(no
          // blueprint yet)".
          const outcome = await pickAdapter(path.join(repoRoot, 'prompts', 'adapt-plan.md'))({
            specs: activeSpecs,
            allSpecIds: t.specs.map((s) => s.id),
            blueprints: activeSpecs
              .map((s) => ({ spec_id: s.id, markdown: loadBlueprint(repoRoot, t.id, s.id) ?? '' }))
              .filter((b) => b.markdown),
            material,
          });
          const drafts = outcome.drafts;
          const diff = planAdaptation(t, q, drafts, outcome.blueprint_edits);
          // Name the re-pointed rounds NOW so the preview shows old → new
          // titles, not placeholders. Failure degrades to quiet rows.
          const namer = pickTopicNamer(path.join(repoRoot, 'prompts', 'plan-topics.md'));
          const bySpec = new Map<string, typeof diff.repointed>();
          for (const r of diff.repointed) {
            bySpec.set(r.to_spec_id, [...(bySpec.get(r.to_spec_id) ?? []), r]);
          }
          const allSpecs = [...t.specs, ...diff.new_specs];
          for (const [specId, rows] of bySpec) {
            const spec = allSpecs.find((s) => s.id === specId);
            if (!spec) continue;
            try {
              const brief = [
                `Round: ${spec.label}.`,
                spec.emphasis ? `Emphasis: ${spec.emphasis}.` : '',
                `The candidate just learned: ${material.slice(0, 2000)}`,
              ].filter(Boolean).join('\n');
              const titles = await stripSpoilerTitles(await namer(brief, rows.length));
              rows.forEach((r, i) => {
                if (titles[i]) r.new_title = titles[i];
              });
            } catch (e) {
              console.warn(`[app] adapt naming failed for ${specId} (quiet rows): ${String(e).slice(0, 200)}`);
            }
          }
          return json(200, {
            diff,
            drafts: drafts.map((d) => ({
              spec: d.spec,
              rationale: d.rationale,
              supersedes: d.supersedes,
              ...(d.unsupported ? { unsupported: d.unsupported } : {}),
            })),
          });
        } catch (e) {
          return json(502, { error: `couldn't read the material: ${String(e).slice(0, 300)}` });
        }
      }
      if (url === '/api/adapt/apply' && req.method === 'POST') {
        // The only writer. Re-proves the vocabulary server-side (the
        // client held the diff), re-loads fresh state, and writes
        // target.json FIRST (specs + record = the commit marker), then
        // queue.json — reconcileAdaptation repairs a death in between.
        const b = JSON.parse((await readBody(req)) || '{}') as {
          target_id?: string;
          diff?: AdaptDiff;
          /** Full raw note — appended verbatim to learnings.md. */
          material?: string;
          /** Legacy clients send only the excerpt; tolerated. */
          material_excerpt?: string;
        };
        const diff = b.diff;
        if (!b.target_id || !diff || !Array.isArray(diff.new_specs) || !Array.isArray(diff.repointed) || !Array.isArray(diff.flagged)) {
          return json(400, { error: 'target_id and a complete diff required' });
        }
        const t = loadTarget(repoRoot, b.target_id);
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        const q = t ? loadQueue(repoRoot, t.id) : null;
        if (!t || !q) return json(404, { error: 'no such target or plan' });
        for (const spec of diff.new_specs) {
          const failures = validateRoundSpec(spec);
          if (failures.length > 0) return json(400, { error: `${spec?.id ?? 'spec'}: ${failures.join('; ')}` });
          if (t.specs.some((s) => s.id === spec.id)) {
            return json(400, { error: `spec "${spec.id}" already exists — specs are append-only` });
          }
        }
        const known = new Set([...t.specs, ...diff.new_specs].map((s) => s.id));
        for (const r of diff.repointed) {
          if (!known.has(r.to_spec_id)) return json(400, { error: `re-point targets unknown spec "${r.to_spec_id}"` });
        }
        // Blueprint rows re-prove the gate server-side (the client held the
        // diff). Tolerate absence — an in-flight preview from an old tab.
        for (const row of diff.blueprints ?? []) {
          if (!known.has(row.spec_id)) return json(400, { error: `blueprint targets unknown spec "${row.spec_id}"` });
          if (row.action !== 'new' && row.action !== 'revised') return json(400, { error: 'blueprint action out of vocabulary' });
          try {
            gateBlueprint(row.markdown);
          } catch (e) {
            return json(400, { error: `blueprint for ${row.spec_id}: ${String(e).slice(0, 200)}` });
          }
        }
        const material = (b.material ?? '').trim();
        if (material.length > 256 * 1024) return json(400, { error: 'material too large' });
        // Write order is deliberate: (1) the raw learning survives even if
        // everything after crashes; (2) blueprint files (.prev.md backup);
        // (3) target.json (the commit marker) then queue.json.
        if (material || b.material_excerpt) {
          appendLearnings(repoRoot, t.id, material || (b.material_excerpt ?? ''), Date.now());
        }
        for (const row of diff.blueprints ?? []) {
          writeBlueprintWithBackup(repoRoot, t.id, row.spec_id, row.markdown);
        }
        const applied = applyAdaptation(t, q, diff, material || (b.material_excerpt ?? ''), Date.now());
        saveTarget(repoRoot, applied.target);
        saveQueue(repoRoot, applied.queue);
        const record = applied.target.adaptations![applied.target.adaptations!.length - 1]!;
        console.log(`[app] adapted ${t.id}: ${record.summary}`);
        return json(200, { ok: true, record });
      }
      if (url === '/api/rebuild' && req.method === 'POST') {
        {
          const g = gateFor('rounds');
          if (g) {
            const out = refuse(g);
            return json(out.code, out.body);
          }
        }
        // A stale READY item: built under a superseded shape, never
        // launched — no candidate work exists in it, so regenerating in
        // place is safe. The dir is wiped so the old .validated marker
        // can't flip the item back to ready before generation runs.
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        const q = t ? loadQueue(repoRoot, t.id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!t || !q || !item?.problem_dir || item.status !== 'ready' || !item.stale) {
          return json(400, { error: 'item is not a stale ready problem' });
        }
        {
          const rd = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
          const gm = readGeneratingMarker(rd);
          if (gm && pidAlive(gm.pid)) {
            return json(409, { error: 'a generation is still running in that directory — give it a minute' });
          }
        }
        if (q.items.some((i) => i.status === 'generating')) {
          return json(409, { error: 'a problem is already generating — one at a time' });
        }
        if (countLiveBuilds() >= cfg.pub.caps.maxConcurrentBuilds) {
          return json(409, { error: "someone else's round is generating — builds run one at a time in the beta; try again in ~5 minutes" });
        }
        const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
        rmSync(dir, { recursive: true, force: true });
        delete item.stale;
        item.status = 'generating';
        saveQueue(repoRoot, q);
        console.log(`[app] rebuilding ${t.id}/${item.id} under spec ${item.spec_id}`);
        spawnGeneration(t, item, dir);
        return json(200, { ok: true });
      }
      if (url === '/api/generate' && req.method === 'POST') {
        {
          const g = gateFor('rounds');
          if (g) {
            const out = refuse(g);
            return json(out.code, out.body);
          }
        }
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        const q = t ? loadQueue(repoRoot, t.id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!t || !q || !item || item.status !== 'pending') {
          return json(400, { error: 'item is not pending' });
        }
        if (q.items.some((i) => i.status === 'generating')) {
          return json(409, { error: 'a problem is already generating — one at a time' });
        }
        if (countLiveBuilds() >= cfg.pub.caps.maxConcurrentBuilds) {
          return json(409, { error: "someone else's round is generating — builds run one at a time in the beta; try again in ~5 minutes" });
        }
        const dir = path.join(targetDir(repoRoot, t.id), 'problems', item.id);
        item.status = 'generating';
        item.problem_dir = dir;
        saveQueue(repoRoot, q);
        console.log(`[app] generating ${t.id}/${item.id} (user-initiated)`);
        spawnGeneration(t, item, dir);
        return json(200, { ok: true });
      }
      if (url === '/api/retry' && req.method === 'POST') {
        {
          const g = gateFor('rounds');
          if (g) {
            const out = refuse(g);
            return json(out.code, out.body);
          }
        }
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        const q = t ? loadQueue(repoRoot, t.id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!t || !q || !item?.problem_dir || item.status !== 'failed') {
          return json(400, { error: 'item is not in a failed state' });
        }
        const dir = path.isAbsolute(item.problem_dir) ? item.problem_dir : path.join(repoRoot, item.problem_dir);
        // The double-agent guard (ISSUE-003): a false 'failed' can coexist
        // with a live detached generation for a moment — retrying then
        // would spawn a second agent into the same directory.
        const gm = readGeneratingMarker(dir);
        if (gm && pidAlive(gm.pid)) {
          return json(409, { error: 'that generation is actually still running — give it a minute' });
        }
        rmSync(path.join(dir, '.failed'), { force: true });
        item.status = 'generating';
        saveQueue(repoRoot, q);
        console.log(`[app] retrying generation for ${t.id}/${item.id}`);
        spawnGeneration(t, item, dir);
        return json(200, { ok: true });
      }
      if (url === '/api/skip' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        const q = t ? loadQueue(repoRoot, t.id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!q || !item) return json(404, { error: 'no such item' });
        item.status = 'skipped';
        saveQueue(repoRoot, q);
        return json(200, { ok: true });
      }
      if (url === '/api/launch' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string; origin?: string };
        // Ownership before readiness: without it any signed-in user who knew
        // a target id could consume someone else's ready round — .used
        // written, graded into the LAUNCHER's gap graph (2026-08-15 QA).
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (t && !ownsTarget(t)) return json(403, { error: 'not your plan' });
        const q = t ? loadQueue(repoRoot, t.id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!q || !item?.problem_dir || item.status !== 'ready') {
          return json(400, { error: 'item is not ready' });
        }
        // WTP gate, above the mode fork. After the readiness check so a
        // not-ready item still reports that rather than a price.
        {
          const g = gateFor('rounds');
          if (g) {
            const out = refuse(g);
            return json(out.code, out.body);
          }
        }
        if (cfg.pub.multiSession) {
          const out = await multiLaunch({ id: user!.id, admin: user!.admin }, item.problem_dir);
          if (out.code === 200) logLaunch(b.origin, String(out.body.session_id));
          return json(out.code, out.body);
        }
        const probe = await probeSession(cfg.sessionPort);
        if (probe.reachable && !probe.ended) {
          const owner = await probeSessionOwner(cfg.sessionPort);
          return json(409, {
            error: owner === null || owner === user!.id || user!.admin
              ? 'a session is already running — finish or end it first'
              : 'someone is mid-round — sessions run one at a time in the beta; check back in ~45 minutes',
          });
        }
        if (probe.reachable && probe.ended) {
          // A graded session's server lingers to serve its card; reap it so
          // the port is free for the new session.
          await postSession(cfg.sessionPort, '/api/shutdown');
          for (let i = 0; i < 10; i++) {
            if (!(await probeSession(cfg.sessionPort)).reachable) break;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        const sessionId = `sess-${Date.now()}`;
        logLaunch(b.origin, sessionId);
        // IP_PREPARE_NEXT=0: the queue drives generation now; the legacy
        // post-session prepare would write into the generic pool nobody is
        // drawing from in queue mode.
        spawnDetached(['session', item.problem_dir], {
          IP_SESSION_ID: sessionId,
          // The person at the keyboard is whose gap graph gets written.
          IP_USER_ID: user!.id,
          IP_PREPARE_NEXT: '0',
          IP_APP_URL: cfg.pub.appPublicUrl,
          ...(internalHeaders['x-ip-internal']
            ? { IP_INTERNAL_TOKEN: internalHeaders['x-ip-internal'] }
            : {}),
        });
        return json(200, { session_id: sessionId, url: `${cfg.pub.sessionPublicUrl}/session` });
      }
      if (url === '/api/session-live' || url.startsWith('/api/session-live?')) {
        if (cfg.pub.multiSession) {
          const sidQ = new URL(url, 'http://x').searchParams.get('sid');
          const reg = await reconcileRegistryNow();
          const entry = sidQ
            ? reg.entries.find((e) => e.sid === sidQ)
            : reg.entries.find((e) => e.user_id === user!.id && e.ended_at === undefined);
          if (!entry) return json(200, { live: false, gone: true });
          const p = await probeSession(entry.port);
          return json(200, { live: p.reachable && !p.ended });
        }
        return json(200, { live: await sessionLive(cfg.sessionPort) });
      }
      if (url === '/api/session-kill' && req.method === 'POST') {
        // The masthead's "end session" (QA D1): abandon = discard, never
        // grade. The session server tears down its container and exits;
        // the trace stays on disk for a CLI rejudge.
        // WU5: only the session's owner (or an admin) may kill it — the
        // session reports its user_id on /api/status.
        if (cfg.pub.multiSession) {
          const kb = JSON.parse((await readBody(req)) || '{}') as { sid?: string };
          const reg = await reconcileRegistryNow();
          const mine = kb.sid && user!.admin
            ? reg.entries.find((e) => e.sid === kb.sid)
            : reg.entries.find((e) => e.user_id === user!.id && e.ended_at === undefined);
          if (!mine) return json(404, { error: 'no live session of yours to end' });
          const rr = await postSession(mine.port, '/api/abandon');
          if (!rr.ok) return json(502, { error: 'the session did not respond — it may already be gone' });
          return json(200, { ok: true });
        }
        const owner = await probeSessionOwner(cfg.sessionPort);
        if (!user!.admin && owner !== null && owner !== user!.id) {
          return json(403, { error: "someone else is mid-round — that session isn't yours to end" });
        }
        const r = await postSession(cfg.sessionPort, '/api/abandon');
        if (!r.ok) return json(502, { error: 'no session responded — it may already be gone' });
        return json(200, { ok: true });
      }
      res.writeHead(404);
      return res.end('not found');
    } catch (e) {
      return json(500, { error: String(e).slice(0, 300) });
    }
  });
  // Boot-only sweeps were fine when the founder was the only watcher; with
  // strangers, a detached build that dies mid-beta must not show "building"
  // until a restart, and the reaper needs a heartbeat. 10 min, unref'd.
  const sweep = () => {
    sweepOrphanedGenerations();
    if (cfg.pub.multiSession) {
      // Session lifecycle (WU-G): reconcile, reap ended card servers after
      // their 30-min window, clean up after crashed sessions and orphaned
      // containers. Async probes feed a pure plan; failures never throw.
      void (async () => {
        try {
          const reg = loadRegistry(repoRoot);
          const probes = new Map<string, import('./session-registry.js').ProbeResult>();
          await Promise.all(reg.entries.map(async (e) => {
            const pr = await probeSession(e.port);
            probes.set(e.sid, { reachable: pr.reachable, ended: pr.ended, session_id: pr.session_id });
          }));
          applySessionSweep(
            planSessionSweep(reg.entries, probes, pidAlive, listSessionContainers(), Date.now()),
            {
              root: repoRoot,
              save: (entries) => saveRegistry(repoRoot, { entries }),
              postShutdown: (port) => postSession(port, '/api/shutdown'),
            },
          );
        } catch (e) {
          console.warn(`[sweep] session sweep failed: ${String(e).slice(0, 160)}`);
        }
      })();
    }
    if (cfg.pub.retention.days !== null || cfg.pub.retention.reapNodeModules) {
      try {
        applyReaping(
          planReaping(gatherRepDiskFacts(repoRoot), Date.now(), {
            days: cfg.pub.retention.days,
            reapNodeModules: cfg.pub.retention.reapNodeModules,
          }),
        );
      } catch (e) {
        console.warn(`[retention] sweep failed: ${String(e).slice(0, 160)}`);
      }
    }
  };
  sweep();
  setInterval(sweep, 10 * 60_000).unref();
  // IP_APP_BIND=127.0.0.1 in the beta: the tunnel is the only ingress to the
  // app. (The SESSION server must stay on all interfaces — the container's
  // trace WS dials the docker gateway IP, never loopback.)
  // The gate advertises a price from IP_PAYWALL_PRICE_USD while Stripe charges
  // whatever STRIPE_PRICE_ID actually costs. If those drift the product lies
  // about its own price to the person about to pay it — worse than any bug in
  // here. Read the real amount once at boot and let it win; the env value
  // stays as the fallback for a box that cannot reach Stripe.
  if (cfg.pub.stripe) {
    void (async () => {
      try {
        const stripe = await stripeClient(cfg.pub.stripe!.apiKey);
        const price = await stripe.prices.retrieve(cfg.pub.stripe!.priceId);
        if (typeof price.unit_amount === 'number') {
          const real = Math.round(price.unit_amount / 100);
          if (real !== cfg.pub.paywall.priceUsd) {
            console.warn(
              `[billing] IP_PAYWALL_PRICE_USD says $${cfg.pub.paywall.priceUsd} but ` +
                `${cfg.pub.stripe!.priceId} charges $${real} — using $${real}`,
            );
            cfg.pub.paywall.priceUsd = real;
          }
        }
      } catch (e) {
        console.warn('[billing] could not read the Stripe price:', String(e).slice(0, 160));
      }
    })();
  }
  const announce = () => {
    console.log(`[app] open ${cfg.pub.appPublicUrl}/`);
  };
  if (cfg.pub.appBindHost) server.listen(cfg.port, cfg.pub.appBindHost, announce);
  else server.listen(cfg.port, announce);

  // Multi mode: the app owns the public session port as a ROUTER — spawned
  // sessions live on dynamic ports behind it. Legacy mode leaves the port
  // alone (a directly-run `cli.ts session` binds it, exactly as always).
  if (cfg.pub.multiSession) {
    const router = makeSessionRouter({
      resolveEntry: (sid) => loadRegistry(repoRoot).entries.find((e) => e.sid === sid) ?? null,
      liveEntries: () => loadRegistry(repoRoot).entries.filter((e) => e.ended_at === undefined),
      authEnabled: auth.enabled,
      publicIsHttps: cfg.pub.sessionPublicUrl.startsWith('https:'),
    });
    // Cutover hazard (found in the local smoke): a LEGACY session's ended
    // card server can still be squatting this port the first time multi
    // mode boots. Reap it and retry once; and a router bind failure must
    // degrade (launches keep working on direct ports), never crash the app.
    const bindRouter = async (attempt: number): Promise<void> => {
      router.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt === 0) {
          console.warn(`[app] :${cfg.sessionPort} busy — reaping a lingering legacy session server`);
          void postSession(cfg.sessionPort, '/api/shutdown').then(() => {
            setTimeout(() => void bindRouter(1), 1_500);
          });
        } else {
          console.error(`[app] session router could not bind :${cfg.sessionPort} — ${String(err)}. ` +
            'Multi-session links will not route until this is freed and the app restarts.');
        }
      });
      router.listen(cfg.sessionPort, () => {
        console.log(`[app] session router on :${cfg.sessionPort} (multi-session)`);
      });
    };
    void bindRouter(0);
  }
  return server;
}
