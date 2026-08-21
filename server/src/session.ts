/**
 * Session runtime — the one process that runs a live session.
 *
 *   browser ──► :3200 ── /session            chrome page
 *                     ├─ /client/session.js  extracted chrome client
 *                     ├─ /api/status         event counts + trigger-armed
 *                     ├─ /api/utterance      chrome-source trace events
 *                     ├─ /api/messages       interviewer turns since seq
 *                     ├─ /api/end            judge → gap graph → feedback
 *                     ├─ /trace (ws)         emitter ingest (ack per event)
 *                     └─ everything else ──► openvscode-server :3100
 *                                            (root-namespace partition, spike 1)
 *
 * The chrome is backend-driven only: it never reads editor state from the
 * iframe (eng review architecture rule).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import httpProxy from 'http-proxy';
import { WebSocket, WebSocketServer } from 'ws';
import type { GeneratedProblem, TraceEvent } from '@interview-prep/shared';
import { isFailingRun, resolveRoundSpec, resolveSurface, validateRoundSpec } from '@interview-prep/shared';
import { makeAuth } from './auth.js';
import { childEnv } from './child-env.js';
import { clampSilentDimensions, judgeSession } from './judge.js';
import { buildAssessmentCard, mergeConfirm } from './feedback.js';
import { buildGraphView, buildTargetNote, isMemorableSessionId, loadStore, recordAssessment, saveStore } from './gap-graph.js';
import { attemptsFromSession, recordTopicAttempts } from './topic-graph.js';
import { clientScript, sessionPage } from './chrome.js';
import {
  isPosthogAssetUrl,
  makePh,
  posthogAssetFile,
  posthogAssetPath,
  posthogAssetVersion,
  posthogConfigFromEnv,
  posthogSnippet,
} from './posthog.js';
import { injectPreBoot, injectWorkbenchDefaults, preBootSeedScript } from './workbench-inject.js';
import { describeStuck, detectStuck, type StuckState } from './stuck.js';
import { describeAdrift, describeWarm, detectAdrift, regionContainsAnswer } from './adrift.js';
import { assessAgenda, renderAgenda } from './agenda.js';
import { CLOSING_TOPIC, WRAP_UP_QUESTIONS, countsAsWrapQuestion, detectWrapSignal, renderWrapState, selectWrapTopic, shouldAutoFinalize } from './wrapup.js';
import { isModelPath, listWorkspaceFiles, parseRunCounts, partitionWorkspaceFiles, runGuard, safeWorkspacePath, shadowsTestRunner, summarizeTail } from './panes.js';
import { isAnswerToPendingQuestion, isCorrectionFollowUp, isExplicitAsk } from './addressing.js';
import { decideAck } from './ack.js';
import { renderWorkspaceView, selectRecentlyEdited, snapshotWorkspace } from './workspace-view.js';
import { codebaseViewOf, focusViewOf, namedOutOfContextFiles, toRel } from './problem-view.js';
import { detectMoment, detectUrgentMoment } from './moments.js';
import { SpeechTurnBuffer } from './endpoint.js';
import { extractSection, loadBlueprint } from './blueprint.js';
import { TraceStore } from './trace-store.js';
import {
  QUESTION_STREAK_LIMIT,
  TurnQueue,
  buildTranscript,
  candidateVisitedBugFile,
  interviewerGroundTruth,
  pickIntentCheck,
  pickInterviewer,
  questionStreak,
  renderActivity,
  type IntentCheck,
  type Interviewer,
} from './interviewer.js';
import { VoiceRuntime, type ClientVoiceMessage } from './voice.js';

export interface SessionConfig {
  repoRoot: string;
  problemDir: string;
  sessionId: string;
  userId: string;
  port: number;
  idePort: number;
  autorunTests: boolean;
  /** Multi-session mode (WU-A): per-session container name + ide-data dir.
   *  Unset/false = legacy single-session, byte-identical. */
  multiSession?: boolean;
  /** Beta auth (WU3). Omitted/enabled:false = local dev, everything open.
   *  The session verifies JWTs itself — it must, since it listens on all
   *  interfaces for the container's trace WS and the LAN can reach it. */
  auth?: import('./auth.js').AuthConfig;
  /** Generate the next (gap-targeted) problem when this session ends. */
  prepareNext: boolean;
  /** Injectable; omit for the real agent, null to run without one. */
  interviewer?: Interviewer | null;
  /** Injectable; omit for the real model check. */
  intentCheck?: IntentCheck | null;
  /** Voice on/off. Rollback is a restart with IP_VOICE=0 (feature flag). */
  voice?: boolean;
  /** The target this round belongs to (derived from problemDir); with appUrl
   *  it builds the page's "← back to plan" link. Absent for pool problems. */
  targetId?: string;
  /** The home app's origin (IP_APP_URL) — where "back to plan" points. */
  appUrl?: string;
  /** Sample round (IP_SAMPLE=1): the full loop runs — interviewer, judge,
   *  card — but finalize's ONE persist seam is skipped, so nothing lands in
   *  the user's history, memory, or counts. See the seam in finalize. */
  sample?: boolean;
  /** Called once the server is listening — the point after which this session
   *  really exists. The caller marks the problem used here, so a start that
   *  fails on the port check leaves the pool untouched. */
  onReady?: () => void;
}

/**
 * What the interviewer is told about the clock. `null` = untimed, all the
 * way to the prompt.
 *
 * It used to be `caps.time_limit_ms ?? SESSION_LENGTH_MS` — a nominal 45
 * minutes substituted for a missing limit — and the number rode into the
 * prompt as fact: sess-qa813-panesint-b opened "…and you've got 45 minutes"
 * on a round whose spec says `time_limit_ms: null`, while the candidate's
 * own header clock (chrome.ts emits `data-limit` only when timed) counted
 * UP with no deadline. `time_limit_ms: null` is the DEFAULT_SPEC shape, so
 * that was most rounds. Rendering 0 instead would be WORSE — "Remaining:
 * 0 min" reads as "time is up" — so the untimed case is stated positively
 * in the prompt (round-rules.ts timeRules), never as a number. Pure.
 */
export function remainingMsFor(limitMs: number | null, elapsedMs: number): number | null {
  return limitMs === null ? null : limitMs - elapsedMs;
}
/**
 * Initiative clocks (sess-1786220758002 redesign). The old single clock —
 * "5 minutes since ANY spoken turn" — meant every reply reset the initiative
 * budget: the more the candidate talked to the interviewer, the quieter it
 * got, and a 26-minute session with 8 candidate questions produced ZERO
 * unprompted-lane turns after the opening. Now:
 *   - the ANY-turn guard is only anti-stacking (don't talk on top of a
 *     reply just delivered);
 *   - the lanes pace themselves on time since the last UNPROMPTED turn.
 */
/** No unprompted turn within this of ANY spoken turn (anti-stacking). */
const ANY_TURN_GUARD_MS = 60_000;
/** Scaffolding (stuck/adrift) fires this soon after the last exchange —
 *  help is paced by need, not by the metronome. */
const SCAFFOLD_FLOOR_MS = 90_000;
/** Floor between warm-adrift encouragements. Uncapped per session (unlike
 *  the redirect), but "keep pulling on that" every 90 seconds is nagging —
 *  replayed sess-1786220758002 showed back-to-back warms without this. */
const WARM_COOLDOWN_MS = 3 * 60_000;
/** Floor between unprompted pressure beats, on the UNPROMPTED clock. */
const PRESSURE_INTERVAL_MS = 5 * 60_000;
/** Floor for event-anchored moment probes — shorter than pressure: a probe
 *  about something that JUST happened tolerates less staleness. */
const MOMENT_INTERVAL_MS = 2.5 * 60_000;
/** Anti-stack guard for URGENT moments (the suite just went green): the
 *  full 60s guard made the climax reaction arrive minutes late or never —
 *  sess-1786861469215's pass met silence behind a reply 24s earlier. */
const URGENT_MOMENT_GUARD_MS = 20_000;
/** Wrap-up lane guard, replacing ANY_TURN_GUARD_MS there: the wrap-up is a
 *  conversation the interviewer LEADS, and 60s of dead air between its
 *  turns reads as the interviewer checking out (same session: phase armed,
 *  zero questions asked before the candidate gave up and ended). */
const WRAP_TURN_GUARD_MS = 30_000;
/** The wrap lane also waits for this much candidate silence — a talking
 *  candidate gets the next question via their reply, not talked over. */
const WRAP_CANDIDATE_QUIET_MS = 15_000;
/** Engagement lane (intent verdict 'engage'): no reaction within this of
 *  any spoken turn, and at most one reaction per cooldown — seasoning,
 *  never a metronome. Loosened 45s/2min → 15s/90s (Codex consult,
 *  2026-08-17): post-endpointing a false engage lands after a COMPLETED
 *  turn, not mid-thought, and the busy lock + endpoint buffer + question
 *  governor now carry the barge-in protection the old timidity was
 *  standing in for. Live evidence: engage fired once in ~23 gated turns
 *  while three engage-worthy statements dropped to silence. */
const ENGAGE_GUARD_MS = 15_000;
const ENGAGE_COOLDOWN_MS = 90_000;
const PRESSURE_TICK_MS = 30_000;

const IDE_IMAGE = 'gitpod/openvscode-server:latest';
const BUNDLED_NODE = '/home/.openvscode-server/node';

/** Container identity (multi-session WU-A). Legacy single-session keeps the
 *  historic fixed name; multi mode names per session so launch B can never
 *  `docker rm -f` session A's container — the exact incident assertPortFree's
 *  header documents. Pure; unit-tested. */
export function containerNameFor(sessionId: string, multiSession: boolean): string {
  return multiSession ? `ip-session-${sessionId}` : 'ip-session';
}

/** Per-session network name (multi mode only). Isolates each round's container
 *  on its OWN user-defined bridge so one candidate's terminal cannot reach
 *  another's tokenless IDE across the shared default bridge (the cross-tenant
 *  hole: HTTP authz was right, but L3 bypassed it). Legacy single-session uses
 *  the default bridge — one user, one container, nothing to isolate from. */
export function networkNameFor(sessionId: string): string {
  return `ip-net-${sessionId}`;
}

/** The network paired with a container, DERIVED from its name so teardown (and
 *  the app-side sweeper) need no extra state — the same derive-don't-store
 *  convention the sweeper already uses for container names. Null for the legacy
 *  'ip-session' container, which has no per-session network. */
export function networkNameForContainer(containerName: string): string | null {
  return containerName.startsWith('ip-session-')
    ? containerName.replace(/^ip-session-/, 'ip-net-')
    : null;
}

/** The one way the IDE container dies. Called after grading, on abandon, on
 *  shutdown, and from the signal handlers — a session that ends by ANY path
 *  must not leave a live container behind (QA ISSUE-001: it did, and every
 *  finished round soft-locked the product until a terminal intervened). The
 *  per-session network goes AFTER the container — `docker network rm` fails
 *  while a container is still attached; best-effort, legacy/absent no-ops. */
function teardownContainerByName(name: string): void {
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
  const net = networkNameForContainer(name);
  if (net) spawnSync('docker', ['network', 'rm', net], { encoding: 'utf8' });
}

function sh(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr?.slice(0, 500)}`);
  }
  return res.stdout;
}

/** Generator installs deps on the host (darwin); the container needs linux
 * natives (rollup/esbuild). Marker file keeps this idempotent. Node only —
 * python problems carry no node_modules. */
function ensureLinuxDeps(problemDir: string): void {
  const marker = path.join(problemDir, '.linux-deps-ok');
  if (existsSync(marker)) return;
  console.log('[session] installing linux-native deps for the container...');
  sh('docker', ['run', '--rm', '-v', `${problemDir}:/app`, '-w', '/app', 'node:22-slim',
    'npm', 'install', '--no-fund', '--no-audit']);
  writeFileSync(marker, String(Date.now()));
}

/**
 * The runtime a problem needs, as a prebuilt IMAGE rather than a per-session
 * install.
 *
 * This used to `apt-get install python3` into the freshly-run container on
 * every launch, before the HTTP server bound its port. Every container is
 * disposable, so every python round paid it again: measured at ~40s of a
 * ~55s cold start, during which the app showed "booting the environment —
 * a few seconds…" and nothing was reachable. It reads as a hang, and the
 * user reported it as one.
 *
 * Docker caches the derived image, so the cost is paid once per machine.
 * Bump the tag when the recipe changes — that is what triggers a rebuild.
 */
const RUNTIME_IMAGES: Record<'node' | 'python', string> = {
  node: IDE_IMAGE,
  python: 'ip-ide-python:1',
};

const PYTHON_DOCKERFILE = `FROM ${IDE_IMAGE}
USER root
RUN apt-get update -qq && apt-get install -y -qq python3 && rm -rf /var/lib/apt/lists/*
USER openvscode-server
`;

function ensureRuntimeImage(runtime: 'node' | 'python'): string {
  const image = RUNTIME_IMAGES[runtime];
  if (runtime === 'node') return image;
  if (spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }).status === 0) {
    return image;
  }
  console.log(`[session] building the ${runtime} IDE image — one time, about a minute...`);
  const built = spawnSync('docker', ['build', '-t', image, '-'], {
    input: PYTHON_DOCKERFILE,
    encoding: 'utf8',
  });
  if (built.status !== 0) {
    // Without the runtime the suite cannot run: no trigger, nothing to
    // assess. Fail loudly rather than starting a broken round.
    throw new Error(`could not build the ${runtime} IDE image: ${built.stderr?.slice(0, 300)}`);
  }
  return image;
}

/** Ops hook (WU-H): provision.sh pre-builds the python image so two
 *  simultaneous cold python launches on the VPS never race the build. */
export function prebuildPythonImage(): void {
  ensureRuntimeImage('python');
}

/**
 * Materialize the IDE user-data dir with our seeded settings.
 *
 * Found by driving a real session in a browser: without these settings the
 * candidate hits a Workspace Trust modal before they can read the problem,
 * and VS Code's built-in Chat panel captures typing meant for the editor —
 * a silent data-loss path, since we never see that text.
 *
 * Mount a host dir we create ourselves; never let Docker auto-create the
 * parents (root-owned parents are what broke extension registration in
 * spike 2).
 */
/** The seeded IDE settings, comment keys stripped. Written to the user-data
 *  dir (reaches the remote extension host) AND injected into the workbench
 *  boot HTML by the proxy (reaches the UI — the lever the KNOWN ISSUE named;
 *  see workbench-inject.ts). */
function loadIdeSettings(repoRoot: string): Record<string, unknown> {
  const settings = JSON.parse(
    readFileSync(path.join(repoRoot, 'server', 'ide-settings.json'), 'utf8'),
  ) as Record<string, unknown>;
  for (const k of Object.keys(settings)) if (k.startsWith('//')) delete settings[k];
  return settings;
}

/** Multi mode gives each session its own dir: the legacy shared path holds
 *  VS Code's SQLite globalStorage, and two concurrent containers on one
 *  bind-mounted SQLite file is a corruption class, not a race. Pure path
 *  derivation exported for tests. */
export function ideDataDirFor(repoRoot: string, sessionId: string | null): string {
  return sessionId
    ? path.join(repoRoot, '.ide-data', sessionId)
    : path.join(repoRoot, '.ide-data');
}

function ensureIdeDataDir(repoRoot: string, sessionId: string | null): string {
  const dataDir = ideDataDirFor(repoRoot, sessionId);
  const userDir = path.join(dataDir, 'User');
  const machineDir = path.join(dataDir, 'Machine');
  mkdirSync(userDir, { recursive: true });
  mkdirSync(machineDir, { recursive: true });
  const body = JSON.stringify(loadIdeSettings(repoRoot), null, 2);
  // These file scopes never reached the workbench UI (VS Code Web reads
  // workbench settings from browser IndexedDB) — the UI path is now the
  // proxy's boot-HTML injection (workbench-inject.ts). Kept because they DO
  // reach the remote extension host, and this dir gives us logs +
  // workspaceStorage at a known host path.
  writeFileSync(path.join(userDir, 'settings.json'), body);
  writeFileSync(path.join(machineDir, 'settings.json'), body);
  return dataDir;
}

/** The debugging trigger: a test run that actually failed (shared predicate). */
function hasFailingRun(events: TraceEvent[]): boolean {
  return events.some(isFailingRun);
}

/** How long silent reading counts as "not underway yet" before the round is
 *  underway regardless — someone can study a one-shot statement for a while,
 *  but three minutes in, the interview has started whether or not anything
 *  ran. */
export const UNDERWAY_FLOOR_MS = 3 * 60_000;

/**
 * Is the round genuinely underway — should the interviewer take initiative?
 *
 * This used to be `hasFailingRun` alone, which is right for a debugging
 * round (the kickoff autorun makes it true in the first seconds) and wrong
 * for every other shape: a no-run round produces no test_run at all, an
 * all_passing round starts green, and (pre-un-conflation, 2026-08-15)
 * one-shot rounds could not run either — they now can, but a candidate who
 * simply hasn't run yet must still count as underway.
 * QA 2026-08-14 measured the result — on 6 of 8 shipped rounds the entire
 * unprompted interviewer (pressure, moments, stuck, adrift, wrap-up, even
 * the acks) was unreachable for the whole session; the candidate got an
 * opening turn and replies, nothing else, for 45-90 minutes.
 *
 * Underway now means: a failing run happened (the debugging trigger,
 * unchanged), OR the candidate started working (an edit or save), OR they
 * have been in the room past the floor — reading IS working on rounds whose
 * work starts with reading. Pure over the trace, clock injected.
 */
export function roundUnderway(
  events: TraceEvent[],
  nowMs: number,
  sessionStartedAt: number,
): boolean {
  if (hasFailingRun(events)) return true;
  if (events.some((e) => e.type === 'edit' || e.type === 'file_save')) return true;
  return nowMs - sessionStartedAt >= UNDERWAY_FLOOR_MS;
}

/** Buffer a small GET from the IDE (used only for the workbench boot HTML,
 *  which is a few hundred KB). Rejects on non-200 so the caller falls back
 *  to the transparent proxy. */
function fetchIdeHtml(port: number, urlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 5_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`ide ${res.statusCode}`));
      }
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(body));
    });
    r.on('error', reject);
    r.on('timeout', () => {
      r.destroy();
      reject(new Error('ide timeout'));
    });
  });
}

function ensureExtensionBuilt(repoRoot: string): string {
  const extRoot = path.join(repoRoot, 'extension');
  const dist = path.join(extRoot, 'dist');
  const bundle = path.join(dist, 'trace-emitter-0.0.1', 'extension.js');
  // Staleness by mtime, not existence. The existence-only check shipped a
  // two-day-old bundle while src had moved on (output_tail never reached a
  // session), and nothing anywhere said so. esbuild is ~100ms — rebuilding
  // on a newer source is cheaper than one silently stale session.
  const newestSource = [
    ...readdirSync(path.join(extRoot, 'src'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => path.join(extRoot, 'src', f)),
    path.join(extRoot, 'build.mjs'),
    path.join(extRoot, 'manifest.mjs'),
  ].reduce((newest, p) => {
    try {
      return Math.max(newest, statSync(p).mtimeMs);
    } catch {
      return newest;
    }
  }, 0);
  const bundledAt = existsSync(bundle) ? statSync(bundle).mtimeMs : 0;
  if (bundledAt < newestSource) {
    console.log(`[session] ${bundledAt === 0 ? 'building' : 'rebuilding'} extension (source newer than bundle)...`);
    sh('node', ['build.mjs'], { cwd: extRoot });
  }
  return dist;
}

/**
 * Refuse to start if a previous session still owns our port — BEFORE anything
 * destructive happens.
 *
 * The listen() call already reported EADDRINUSE, but it ran ~450 lines in,
 * after `docker rm -f` had destroyed the live session's container and a new
 * one had booted on the IDE port. The old server proxies blindly to that IDE
 * port, so the browser kept working and served the NEW container: the
 * candidate practiced problem B inside a session that believed it was running
 * problem A, the new container's extension posted traces to a port nobody was
 * listening on (losing every edit and test run), and the judge was handed a
 * timeline and a spec from two different problems. Cost: one real session.
 *
 * Checking first turns a silently corrupted round into a two-line error.
 */
export function assertPortFree(port: number): void {
  const who = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  }).stdout.trim().split('\n').filter(Boolean)[0];
  if (!who) return;
  throw new Error(
    `port ${port} is already in use by pid ${who} — a previous session is still running.\n` +
      `Nothing has been changed. Stop it first:  kill ${who}`,
  );
}

/**
 * /trace upgrade gate (beta WU2). The trace-emitter extension runs inside the
 * container and dials host.docker.internal — the docker GATEWAY IP — so the
 * session server must listen on all interfaces and cannot rely on network
 * binding to keep the trace channel private. The extension carries no auth
 * header either (DurableEmitter uses IP_WS_URL verbatim), so the session
 * mints a random token at boot and delivers it inside IP_WS_URL itself.
 * Pure; timing-safe via hash-then-compare (lengths differ on raw compare).
 */
export function traceUpgradeAllowed(reqUrl: string | undefined, expectedToken: string): boolean {
  const got = new URL(reqUrl ?? '', 'http://x').searchParams.get('token') ?? '';
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(a, b);
}

/** Voice-off reason, ordered by product truth: a round with nobody listening
 *  outranks the session flag, which outranks a missing key. 'no_interviewer'
 *  exists because a live mic on a solo round records a silent room for a
 *  consumer that does not exist (TODOS #49's phantom "you (voice)" turns) —
 *  the mic exists iff someone is listening (owner decision 2026-08-15).
 *  `hasInterviewer` is the RUNTIME handle (caps.interviewer && the model is
 *  wired), matching what the page itself keys on — an IP_INTERVIEWER=0 run
 *  has nobody listening either. */
export function voiceOffReasonFor(
  hasInterviewer: boolean,
  voiceFlag: boolean,
  hasKey: boolean,
): 'no_interviewer' | 'disabled' | 'no_key' | null {
  if (!hasInterviewer) return 'no_interviewer';
  if (!voiceFlag) return 'disabled';
  if (!hasKey) return 'no_key';
  return null;
}

export async function runSession(cfg: SessionConfig): Promise<void> {
  // First statement in the function, on purpose: everything below this line
  // mutates state the running session owns.
  assertPortFree(cfg.port);

  // Per-session /trace credential — minted here, delivered to the container
  // via IP_WS_URL, checked at the WS upgrade. See traceUpgradeAllowed.
  const traceToken = randomBytes(16).toString('hex');

  // Per-session identities (WU-A): legacy mode keeps the historic values.
  const containerName = containerNameFor(cfg.sessionId, Boolean(cfg.multiSession));
  const teardownContainer = (): void => teardownContainerByName(containerName);

  // Browser + server-to-server auth (WU3). Auth off → local admin always.
  const auth = makeAuth(
    cfg.auth ?? { supabaseUrl: null, adminEmails: [], localUserId: cfg.userId },
  );

  const problem = JSON.parse(
    readFileSync(path.join(cfg.problemDir, 'problem.json'), 'utf8'),
  ) as GeneratedProblem;

  // The round's shape — everything below renders/enforces from THESE flags,
  // never from a format name (capabilities, not categories).
  const roundSpec = resolveRoundSpec(problem);
  // Validation ran only at build/intake, never here — so a manifest carrying
  // an out-of-vocabulary check.kind silently fell through roundRules() to the
  // DEBUGGING defaults, running "you know where the bug is" rules on a round
  // with no bug (QA 2026-08-14 audit). A legacy manifest with NO round_spec
  // still resolves to the default spec above and stays launchable; only an
  // spec that EXISTS and is invalid refuses to run.
  if (problem.round_spec) {
    const specFailures = validateRoundSpec(problem.round_spec);
    if (specFailures.length > 0) {
      throw new Error(
        `problem.json round_spec is invalid — refusing to run a round whose rules would silently default to debugging:\n  - ${specFailures.join('\n  - ')}`,
      );
    }
  }
  const caps = roundSpec.capabilities;
  const surface = resolveSurface(caps);

  // IDE surface only: dock the problem statement in the workspace, where the
  // extension opens it as a preview at activation (HackerRank's project IDE
  // docks its question the same way). Panes rounds render the statement in
  // their own pane — a stray PROBLEM.md there would pollute /api/files.
  if (surface === 'ide' && !existsSync(path.join(cfg.problemDir, 'PROBLEM.md'))) {
    const title = problem.title ? `# ${problem.title}\n\n` : '# Problem\n\n';
    writeFileSync(path.join(cfg.problemDir, 'PROBLEM.md'), title + problem.spec + '\n');
  }

  const runtime = problem.runtime ?? 'node';
  // Resolve (and, once per machine, build) the runtime image BEFORE the
  // container runs — the old order installed the runtime into an
  // already-running container, which is why the port stayed unbound for a
  // minute on every python round.
  const ideImage = ensureRuntimeImage(runtime);
  if (runtime === 'node') ensureLinuxDeps(cfg.problemDir);
  const extDist = ensureExtensionBuilt(cfg.repoRoot);
  const ideDataDir = ensureIdeDataDir(cfg.repoRoot, cfg.multiSession ? cfg.sessionId : null);

  const tracesDir = path.join(cfg.repoRoot, 'traces');
  const gapsDir = path.join(cfg.repoRoot, 'gaps');
  const store = new TraceStore(tracesDir, cfg.sessionId, cfg.userId);

  // Session-start baseline for the interviewer's workspace eyes: every turn
  // diffs the candidate's current files against this. Overwrites any prior
  // snapshot — a rebuilt problem must never diff a stale baseline.
  snapshotWorkspace(cfg.problemDir);

  // ---- IDE container ----
  // Panes rounds launch the SAME container: /api/run needs docker exec, and
  // node_modules are Linux binaries (ensureLinuxDeps installs them via
  // docker). The openvscode process inside simply idles unused — nobody
  // loads the workbench, so the extension never activates. Accepted idle
  // cost over a second launch path.
  // Clear any stale container AND its stale network from a crashed prior run of
  // this sid before we recreate them (teardown removes both, in order).
  teardownContainerByName(containerName);
  if (cfg.multiSession) {
    // Fresh per-session network. If it somehow still exists (create races the
    // rm above), the run below still attaches by name — non-fatal.
    spawnSync('docker', ['network', 'create', networkNameFor(cfg.sessionId)], { encoding: 'utf8' });
  }
  // Per-session workspace path (QA ISSUE-005): VS Code Web keys workbench
  // state (open tabs, layout) by folder URI in BROWSER IndexedDB — a
  // constant path meant every round opened on the previous round's tabs.
  // A fresh URI per session starts the workbench clean.
  const workspacePath = `/home/workspace/p-${cfg.sessionId}`;
  // The problem declares how its tests run; the vitest default keeps every
  // manifest written before `test_command` existed working unchanged.
  const testCmd =
    problem.test_command ??
    `${BUNDLED_NODE} ${workspacePath}/node_modules/vitest/vitest.mjs run`;
  sh('docker', [
    'run', '-d', '--name', containerName,
    // Per-session network (multi mode): isolates this container from every other
    // live round's container. --add-host=host-gateway (below) still resolves on a
    // user-defined bridge, so the trace WS is unaffected. See networkNameFor.
    ...(cfg.multiSession ? ['--network', networkNameFor(cfg.sessionId)] : []),
    // Runaway bounds. --pids-limit caps a fork bomb (safe, no OOM risk).
    // --memory is opt-in via IP_SESSION_MEMORY: left unset it is byte-identical
    // to today — measure `docker stats` on a busy evening before pinning a hard
    // cap, or a heavy-but-legit round OOM-kills mid-session.
    '--pids-limit', process.env.IP_SESSION_PIDS || '512',
    ...(process.env.IP_SESSION_MEMORY ? ['--memory', process.env.IP_SESSION_MEMORY] : []),
    // Loopback publish: the only consumer of the IDE port is the host-side
    // proxy (target 127.0.0.1). Publishing on 0.0.0.0 exposed a TOKENLESS
    // remote IDE to the LAN, beside whatever auth the servers enforce.
    '-p', `127.0.0.1:${cfg.idePort}:3000`,
    '--add-host=host.docker.internal:host-gateway',
    '-e', `IP_SESSION_ID=${cfg.sessionId}`,
    '-e', `IP_USER_ID=${cfg.userId}`,
    '-e', `IP_WS_URL=ws://host.docker.internal:${cfg.port}/trace?token=${traceToken}`,
    '-e', `IP_TEST_CMD=${testCmd}`,
    // Kickoff run is the DEFAULT for failure-triggered rounds: the debugging
    // trigger must not depend on the candidate finding the status-bar button
    // (learned the hard way). Other check kinds start green or blank — an
    // opening wall of red is noise, not a trigger.
    ...(cfg.autorunTests && roundSpec.check.kind === 'one_failing_test' ? [] : ['-e', 'IP_AUTORUN_TESTS=0']),
    // can_run_tests ALONE governs the run loop (un-conflation 2026-08-15):
    // one_shot is the autograding contract — the graded run at Submit —
    // and a visible suite stays runnable while working, like a real OA.
    ...(caps.can_run_tests ? [] : ['-e', 'IP_CAN_RUN_TESTS=0']),
    '-v', `${extDist}:/ext`,
    '-v', `${ideDataDir}:/ipdata`,
    '-v', `${cfg.problemDir}:${workspacePath}`,
    ideImage,
    '--without-connection-token', '--host', '0.0.0.0',
    '--extensions-dir', '/ext',
    '--user-data-dir', '/ipdata',
  ]);

  // What the interviewer may tell a candidate who asks how to run tests.
  // Derived from the same facts the runtime enforces, so it can never drift
  // into a runner that is not installed.
  const howToRun =
    !caps.can_run_tests
      ? 'This round does not allow running the suite at all. There is no run command — say so plainly if asked.'
      : `They press the **Run Tests** button in the session header (top right, above the editor). It runs \`${testCmd}\` in the workspace and shows the output in the ${surface === 'panes' ? 'test results panel below the editor' : "editor's Test Results panel"}. That is the intended path${surface === 'ide' ? `; running \`${testCmd}\` in the integrated terminal also works and is observed` : ''}.${caps.submit === 'one_shot' ? ' The GRADED run is separate: it happens once, server-side, when they press Submit.' : ''}`;

  // What the agenda may treat as reachable: on a no-run round the suite
  // cannot run mid-round, so verify/reflect are not-applicable rather than
  // open gaps (agenda.ts AgendaCaps). One-shot rounds run freely since the
  // un-conflation (2026-08-15) — only can_run_tests decides.
  const agendaCaps = { runnable: caps.can_run_tests };

  // The round's mechanics, stated to the interviewer — the axes the prompt
  // never used to carry (QA 2026-08-14: rules assumed iteration on one-shot
  // rounds, "Reading their actual work" promised test output that cannot
  // exist, and nothing named the review round's deliverable). Derived from
  // the same capabilities the runtime enforces; session-constant → cached.
  const partCount = problem.source?.parts?.length ?? 0;
  const roundMechanics = [
    surface === 'ide'
      ? 'They work in a full IDE — editor and integrated terminal; terminal test commands are observed.'
      : 'They work in a lightweight editor with the problem statement docked beside it; there is no terminal.',
    caps.starts_from === 'blank'
      ? 'They start from a blank scaffold — the files they create ARE the work.'
      : caps.starts_from === 'diff'
        ? 'They are reviewing a change: the diff is the artifact under review, and their WRITTEN review (REVIEW.md) is the deliverable that gets graded. Probe the write-up — coverage, severity calls, evidence — not just the reading.'
        : 'They work inside an existing repo.',
    // Two independent axes, two independent sentences (un-conflation
    // 2026-08-15): the run loop and the grading contract.
    caps.can_run_tests
      ? 'They can run the suite anytime and read the results.'
      : 'Nothing runs in this round at all — never ask whether a change worked or what a run showed; nothing has run.',
    caps.submit === 'one_shot'
      ? 'ONE graded submission, at the end, when they press Submit — the authoritative graded run happens there, and there is no iterating after it.'
      : '',
    partCount >= 2
      ? `This is a multi-part set: ${partCount} independent problems (solution_part1 … solution_part${partCount}). Track which part they are on from their activity; progress on one part says nothing about the others.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  // What a strong candidate does in THIS round — the judge's own grading
  // dimensions, finally shared with the interviewer (the rubric-blind
  // finding: one dimension graded a question "to the interviewer" the
  // interviewer never knew to expect). Per-session constant → cached half.
  const rubricText = Object.entries(problem.rubric?.dimensions ?? {})
    .map(([k, v]) => `- ${k}: ${String(v)}`)
    .join('\n');
  // Engagement style from the round's blueprint (optional section; pool
  // problems and pre-section blueprints fall back to a per-check default).
  const ENGAGEMENT_DEFAULTS: Record<string, string> = {
    one_failing_test:
      'Restrained: frame the round at the open, probe method at flagged moments, let them drive.',
    all_failing:
      'Moderately led: probe design decisions before code exists; reward incremental suite progress.',
    all_passing: 'Balanced: probe intent behind changes.',
    diff_present: 'Balanced: probe what they would flag and why.',
  };
  const blueprintText = cfg.targetId ? loadBlueprint(cfg.repoRoot, cfg.targetId, roundSpec.id) : null;
  const engagement =
    (blueprintText ? extractSection(blueprintText, '## Interviewer engagement') : null) ??
    ENGAGEMENT_DEFAULTS[roundSpec.check.kind] ??
    'Balanced: probe at the flagged moments, otherwise let them work.';

  const ideSettings = loadIdeSettings(cfg.repoRoot);
  // Hoisted install: the workspace root owns node_modules (same assumption
  // the vitest testCmd default makes about problem dirs).
  const monacoRoot = path.join(cfg.repoRoot, 'node_modules', 'monaco-editor', 'min', 'vs');

  // PostHog (posthog.ts) — from env, NOT resolvePublicConfig: a spawned
  // session deliberately receives a partial Supabase config (no service key,
  // WU8) and the all-or-nothing rule there would throw. child-env passes the
  // IP_POSTHOG_* trio to session children; unset = all of this is inert.
  const phCfg = posthogConfigFromEnv(process.env);
  const phSession = makePh(phCfg);
  const phAsset = phCfg ? posthogAssetFile(cfg.repoRoot) : null;
  // The round page's replay boundary. Default: the ROUND INTERIOR is blocked
  // — the IDE iframe (same-origin, so rrweb WOULD record into it), the
  // Monaco pane, the transcript, the test output. Two reasons, both real:
  // rrweb serializes DOM mutations on the main thread and a VS Code
  // workbench is the heaviest mutation source there is, on the page that
  // also runs the timer, voice and the trace WS; and the intro copy above
  // PROMISES "other terminal commands are not observed". IP_POSTHOG_
  // REPLAY_ROUND=1 lifts the blocks — measure input latency first, and fix
  // the copy (public-config.ts has the full note).
  const sessionAnalytics =
    phCfg && phAsset
      ? posthogSnippet(phCfg, {
          assetPath: posthogAssetPath(posthogAssetVersion(cfg.repoRoot)),
          distinctId: cfg.userId,
          ...(phCfg.replayRound ? {} : { blockSelector: 'main iframe, #editor, #log, #runout' }),
        })
      : '';

  // ---- one server: chrome + api + trace ingest + IDE proxy ----
  const proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${cfg.idePort}`,
    ws: true,
  });
  proxy.on('error', (_e, _req, res) => {
    const r = res as http.ServerResponse;
    if (r && !r.headersSent && r.writeHead) {
      r.writeHead(502);
      r.end('ide not ready');
    }
  });

  let ended = false;
  // One suite run at a time through /api/run (panes surface); the docker
  // exec is not reentrant-safe against itself on a shared workspace.
  let paneRunning = false;
  // Moment probes fire once each per session (restart forgets at most one —
  // the stuckRedactions precedent).
  const firedMoments = new Set<string>();
  // The adrift REDIRECT is once per session: "the region you're in is spent"
  // is a location signal, and repeating it turns the round into a guided
  // tour. The warm inversion (they are already in the right place) carries
  // no location content and is deliberately not capped by this.
  // Set when a redirect turn actually SPEAKS — a guard-silenced attempt
  // retries (the stuckRedactions pattern), with its own 2-strike budget so
  // a composition the guard keeps rejecting cannot loop all session.
  let adriftFired = false;
  let adriftRedactions = 0;
  // Wrap-up phase state (I3): set once by detectWrapSignal; questions are
  // counted by wrap turns that actually SPOKE, and after the closing the
  // interviewer goes quiet for good. All verbal — /api/end is untouched.
  let wrapUpAt: number | null = null;
  let wrapQuestionsAsked = 0;
  let wrapClosed = false;
  // When the closing SPOKE — the auto-finalize grace anchors here
  // (wrapup.ts shouldAutoFinalize; owner call 2026-08-17).
  let wrapClosedAt: number | null = null;
  let lastWarmTs = 0;
  // Engagement lane: burned only when an engage turn actually SPEAKS (the
  // adrift-budget lesson — a silent composition must not spend the slot).
  let lastEngageTs = 0;
  // Interviewer health for the chip (owner decision, QA 2026-08-14): a
  // model-path failure used to be indistinguishable from deliberate silence
  // — the candidate concluded they were being ignored. Set by the intent
  // gate's and the turn's failure paths, cleared by the next healthy one.
  let interviewerFault: 'intent' | 'turn' | null = null;
  // The live extension socket, so the chrome's Run Tests button can reach
  // the IDE's own runner (see /api/ide-run).
  let traceSocket: WebSocket | null = null;
  // Doorbell to /events clients — assigned once the socket server exists;
  // a no-op until then so early turns just ride the poll.
  let notifyTurn: () => void = () => {};

  // ---- interviewer ----
  const { bug, bugFile, hasAnswerKnowledge } = interviewerGroundTruth(problem, roundSpec.check.kind);
  // The stable code context (repo map + the failing test verbatim), computed
  // ONCE: it describes the problem as handed out, so the cached system block
  // stays byte-identical across turns.
  const codebaseView = codebaseViewOf(cfg.problemDir, problem.planted_bug?.failing_test ?? null);
  const workspaceFileList = listWorkspaceFiles(cfg.problemDir);
  // The grading key can span several files — a review round plants defects
  // across the diff, and the single bugFile field could only ever guard one
  // of them (QA 2026-08-14: rep-mst39p35's rollup.py held a planted BLOCKER
  // and was unguarded). Every workspace file the key's description names is
  // a never-name location; on a debugging round this also protects sibling
  // files the description cites as answer context.
  const bugBase = bugFile.split('/').pop() ?? bugFile;
  const descText = (problem.planted_bug?.description ?? '').toLowerCase();
  const extraProtectedFiles = hasAnswerKnowledge
    ? [
        ...new Set(
          workspaceFileList
            .map((p) => p.split('/').pop() ?? p)
            .filter((base) => base !== bugBase && descText.includes(base.toLowerCase())),
        ),
      ]
    : [];
  // The spec's interviewer:false (an OA) wins over everything: nobody
  // replies, so the intent check has nothing to route to either. The mic
  // stays live — think-aloud is still judge signal.
  const interviewer = !caps.interviewer
    ? null
    : cfg.interviewer === undefined
      ? pickInterviewer(path.join(cfg.repoRoot, 'prompts', 'interviewer.md'))
      : cfg.interviewer;
  // The interviewer silently reads the candidate's gap history — it shapes
  // where pressure lands and is never mentioned (prompt rule + leaksGapNote
  // guard). Same never-mention contract as the generator (T15).
  const targetNote = buildTargetNote(buildGraphView(loadStore(gapsDir, cfg.userId)));
  // The session clock anchors at the CANDIDATE'S ARRIVAL, never process
  // start. First live session: the server idled 71 minutes before the
  // candidate opened the page, "elapsed" blew past the 45-minute round, and
  // the interviewer role-played "time's up" from its first turn — then
  // pressured a 9-minute-old session into giving up. Null until first
  // contact; the pressure timer stays quiet until then.
  let sessionStartedAt: number | null = null;
  let lastInterviewerTs = 0;
  // The initiative clock: reset ONLY by unprompted turns, so replying to the
  // candidate never buys the interviewer silence (see the clock comment at
  // the constants).
  let lastUnpromptedTs = 0;
  const markCandidateContact = () => {
    if (sessionStartedAt === null) {
      sessionStartedAt = Date.now();
      lastInterviewerTs = sessionStartedAt;
      lastUnpromptedTs = sessionStartedAt;
      console.log('[session] candidate arrived — clock started');
      // OPENING: a real interviewer runs the room from the first second —
      // the round used to begin in dead silence. Fires exactly once, on
      // arrival, without waiting for a failing run. setImmediate so the
      // contact-triggering request finishes first.
      if (interviewer) {
        setImmediate(() =>
          void runInterviewer(null, null, {
            kind: 'opening',
            observation:
              'The candidate just arrived. Open the round per the OPENING rule and this round’s engagement style — if the style prescribes a pre-code segment (e.g. behavioral questions first), begin with that segment instead of framing the task.',
          }),
        );
      }
    }
  };
  let interviewerBusy = false;

  // Timed rounds: the spec's limit is BOTH the interviewer's countdown and a
  // hard cap. Untimed rounds have NO horizon at all — no default is
  // substituted anywhere (remainingMsFor's header has the incident: the old
  // nominal 45 minutes rode into the prompt as a fact the interviewer told
  // the candidate). The cap timer below already ran only on timed rounds, so
  // nothing is un-enforced that was enforced before.
  // Set when the cap is reached. /api/messages carries it so the client can
  // end through the normal path (mic released first); the grace timer below
  // is the fallback for a closed tab — the record must close either way.
  let timeUpAt: number | null = null;

  // ---- intent routing (OUTSIDE the busy lock — eng review issue 1) ----
  // Every utterance is classified the moment it lands; only ADDRESSED ones
  // queue for a reply. Narration never contends for the lock, and a question
  // asked while the agent is mid-turn waits instead of vanishing.
  const intentCheck: IntentCheck | null = !caps.interviewer
    ? null
    : cfg.intentCheck === undefined
      ? pickIntentCheck()
      : cfg.intentCheck;
  const turnQueue = new TurnQueue(2);

  // ---- voice (IP_VOICE flag + key present, else text-only) ----
  // The REASON matters as much as the state: "voice: off" with no cause is
  // what made a missing credential look like a broken feature. Each cause
  // gets its own name so the chip can say something actionable.
  const elevenKey = process.env.ELEVENLABS_API_KEY ?? process.env.IP_ELEVENLABS_KEY ?? '';
  const voiceOffReason = voiceOffReasonFor(interviewer !== null, cfg.voice !== false, elevenKey.length > 0);
  const voiceEnabled = voiceOffReason === null;
  if (voiceOffReason === 'no_interviewer') {
    console.log('[session] voice OFF — no interviewer this round (the mic exists iff someone is listening)');
  } else if (voiceOffReason === 'no_key') {
    console.warn(
      '[session] voice OFF — no ELEVENLABS_API_KEY (or IP_ELEVENLABS_KEY) in this process.\n' +
        '          The interviewer still runs, text-only. Put the key in .env at the repo\n' +
        '          root (auto-loaded) or export it before starting the app server — sessions\n' +
        '          inherit the APP server\'s environment, not your current shell.',
    );
  } else if (voiceOffReason === 'disabled') {
    console.log('[session] voice OFF — IP_VOICE=0 for this session');
  }
  // Endpointing (endpoint.ts): voice utterances are TRACED per segment as
  // ever, but ROUTED once per human turn — the buffer holds while the
  // candidate is still talking and flushes after real silence. Routing per
  // VAD breath is how the interviewer answered a slow speaker clause by
  // clause (sess-1786948725100). Text keeps routing immediately.
  const speechBuffer = new SpeechTurnBuffer();
  const voice = voiceEnabled
    ? new VoiceRuntime(
        {
          apiKey: elevenKey,
          upstreamFactory: (url, headers) => new WebSocket(url, { headers }) as never,
        },
        {
          emitSensor: (sensor, state, reason) =>
            store.emitChrome('sensor', { sensor, state, reason }),
          // SERVER clock for the buffer, never the browser's msg.ts: the
          // flush compares against Date.now(), and browser clock skew
          // would silently stretch or collapse the settle window.
          onSpeechStart: () => speechBuffer.speechStarted(Date.now()),
          onSpeechEnd: () => speechBuffer.speechEnded(Date.now()),
          emitUtterance: (text, speechStartTs) => {
            store.emitChrome(
              'utterance',
              { text, via: 'voice', ...(text ? {} : { untranscribed: true }), speech_start_ts: speechStartTs },
              speechStartTs, // stamped at SPEECH START, never transcript arrival
            );
            speechBuffer.push(text, Date.now()); // routes at flush, below
          },
        },
      )
    : null;
  let endpointTimer: NodeJS.Timeout | null = null;
  if (voice) {
    endpointTimer = setInterval(() => {
      if (speechBuffer.shouldFlush(Date.now())) {
        const turn = speechBuffer.flush();
        // Visibility for tuning: the 15-37s lag diagnosis took trace
        // archaeology; one line here makes the next one a grep.
        console.log(`[endpoint] turn routed (${turn.length} chars): ${turn.slice(0, 80)}`);
        routeUtterance(turn);
      }
    }, 500);
    endpointTimer.unref();
  }

  /**
   * Settling window before a turn starts composing.
   *
   * One spoken question is often TWO utterances: the browser endpoints on a
   * 1s pause (presence.js), so "Can you tell me — / — if a Future can be a
   * dict key?" commits as two segments. The first started a turn, the second
   * queued behind `interviewerBusy`, and the `finally` pump drained it as a
   * SECOND turn — measured live at 12:01 and 12:05, two near-identical
   * probes 3.6s apart answering one question.
   *
   * Waiting a beat lets the second half land in the same drain, where
   * TurnQueue already joins them into one breath. The cost is ~600ms on a
   * single-segment ask; the benefit is never talking over yourself.
   */
  const SETTLE_MS = 600;
  let settleTimer: NodeJS.Timeout | null = null;
  const settlePending = (): boolean => settleTimer !== null;

  const pump = (): void => {
    if (ended || interviewerBusy) return;
    if (settleTimer) return; // already waiting for stragglers
    if (turnQueue.size === 0) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (ended || interviewerBusy) return; // a turn started meanwhile; its finally re-pumps
      const merged = turnQueue.drain();
      if (merged !== null) void runInterviewer(merged);
    }, SETTLE_MS);
    settleTimer.unref?.();
  };

  const routeUtterance = (text: string): void => {
    if (!interviewer || !intentCheck || !text.trim() || ended) return;
    // Deterministic fast path: unambiguous asks, post-answer corrections,
    // and the first words after a pending interviewer question never touch
    // the LLM gate — no model call, no latency, no chance of the
    // "narration" misread that dropped three real asks in one session (and
    // later read a candidate's complete root-cause answer to a direct
    // instruction as narration — sess-qa814-leak, 190s of silence).
    if (
      isExplicitAsk(text) ||
      isCorrectionFollowUp(text, store.readAll(), Date.now()) ||
      isAnswerToPendingQuestion(text, store.readAll(), Date.now())
    ) {
      console.log(`[intent] fast-path ADDRESSED: ${text.slice(0, 80)}`);
      turnQueue.push(text);
      notifyTurn(); // ring the doorbell now so the "…" appears immediately
      pump();
      return;
    }
    // Context matters: a question split across breaths ("So I'm thinking...
    // / ...can you tell me if that's right?") is unreadable as a lone
    // fragment. Exclude the utterance itself — it is passed separately as
    // the one under judgement.
    const recent = store
      .readAll()
      .filter(
        (e) =>
          (e.type === 'utterance' && String((e.payload as { text?: string })?.text ?? '').trim()) ||
          e.type === 'interviewer',
      )
      .slice(-5)
      .map((e) => ({
        who: e.type === 'utterance' ? ('candidate' as const) : ('interviewer' as const),
        text: String((e.payload as { text?: string })?.text ?? ''),
      }))
      .filter((r) => r.text !== text);
    void intentCheck(text, problem.spec, recent)
      .then((verdict) => {
        // "Judged not-addressed" and "check crashed" must never look the
        // same in the log (first live session was undebuggable without this).
        console.log(
          `[intent] ${verdict === 'addressed' ? 'ADDRESSED' : verdict === 'engage' ? 'ENGAGE' : 'narration'}: ${text.slice(0, 80)}`,
        );
        if (interviewerFault === 'intent') interviewerFault = null; // gate healthy again
        if (verdict === 'silent') return; // narration: traced, agent stays silent
        if (verdict === 'engage') {
          // A completed thought, not a question. During wrap-up it gets the
          // full reply treatment — the conversation IS the round there, and
          // the reply also carries the next evaluation question. Otherwise
          // it is optional seasoning: never contends with a real turn, paced
          // by its own guard + cooldown, and the turn may still choose
          // silence (the cooldown burns only if it speaks).
          if (wrapUpAt !== null && !wrapClosed) {
            turnQueue.push(text);
            notifyTurn();
            pump();
            return;
          }
          const now = Date.now();
          if (interviewerBusy || turnQueue.size > 0) return;
          if (now - lastInterviewerTs < ENGAGE_GUARD_MS) return;
          if (now - lastEngageTs < ENGAGE_COOLDOWN_MS) return;
          void runInterviewer(text, null, null, null, null, null, true);
          return;
        }
        turnQueue.push(text);
        notifyTurn();
        pump();
      })
      .catch((e) => {
        console.warn(`[intent] check FAILED (staying silent): ${String(e).slice(0, 120)}`);
        interviewerFault = 'intent';
      });
  };

  // Stuck-turn bookkeeping, keyed by the streak's start: a redacted hint is
  // retried on a later tick (silence costs nothing), but after two failed
  // compositions the episode is abandoned — a guard that keeps firing means
  // the model can't phrase this one safely, and pressure resumes.
  const stuckRedactions = new Map<number, number>();

  /** One interviewer turn. `null` message = unprompted (pressure, stuck,
   *  adrift, or moment). */
  const runInterviewer = async (
    candidateMessage: string | null,
    stuck: StuckState | null = null,
    moment: { kind: string; observation: string } | null = null,
    adriftObservation: string | null = null,
    /** Set on wrap-lane turns: this turn asks the next evaluation question
     *  (or delivers the closing). Bookkeeping happens only if it speaks. */
    wrapTopic: string | null = null,
    /** describeWarm() output — its own lane, no longer riding the adrift
     *  slot: the ADRIFT prompt rules instruct a redirect ("say plainly that
     *  it looks sound — that region is not where the fault is"), the exact
     *  opposite of what a warm observation means (QA 2026-08-14 audit). */
    warmObservation: string | null = null,
    /** Engagement turn: candidateMessage is thinking-aloud flagged by the
     *  intent gate, not a question — the ENGAGE prompt rules apply. */
    narrationEngage = false,
  ): Promise<void> => {
    if (!interviewer || ended) return;
    if (interviewerBusy) {
      // An unprompted beat that lands mid-reply used to VANISH here without
      // a trace — including the opening turn. The tick retries on its next
      // pass, so the loss is recoverable; the silence about it was not.
      if (candidateMessage === null) {
        console.log('[interviewer] unprompted turn skipped — a reply was in flight (tick will retry)');
      }
      return;
    }
    interviewerBusy = true;
    try {
      const events = store.readAll();
      const now = Date.now();
      // Reply-carried wrap questions: while the phase is open, every reply
      // carries the next evaluation question. The lane's unprompted turn
      // paces on candidate SILENCE, and a wrap-phase candidate is rarely
      // silent — sess-1786861469215 armed the phase, took three replies,
      // asked zero questions, and the candidate ran their own wrap-up.
      const replyWrapTopic =
        wrapTopic === null &&
        candidateMessage !== null &&
        wrapUpAt !== null &&
        !wrapClosed &&
        wrapQuestionsAsked < WRAP_UP_QUESTIONS
          ? selectWrapTopic(assessAgenda(events, now, agendaCaps), wrapQuestionsAsked, roundSpec.check.kind)
          : null;
      const streak = questionStreak(events);
      const governed =
        streak >= QUESTION_STREAK_LIMIT && wrapTopic === null && replyWrapTopic === null;
      // The eyes, per turn: the file under their eyes first (focus sensor),
      // then real diffs + test output. Cheap — a handful of reads.
      const focusView = focusViewOf(cfg.problemDir, events, now);
      const workspaceView = [focusView, renderWorkspaceView(cfg.problemDir, events)]
        .filter(Boolean)
        .join('\n\n');
      // read_file instrumentation (decides the deferred-tool question with
      // data): a candidate naming a file whose CONTENT the interviewer does
      // not have is the one situation a tool would have served.
      if (candidateMessage) {
        const focusRel = focusView.match(/^── currently viewing: (\S+)/)?.[1];
        const inContext = [
          focusRel,
          // Diffed files ride in the workspace view — their content is
          // (partially) in front of the interviewer too.
          ...selectRecentlyEdited(events).map((p) => toRel(p)),
        ].filter((f): f is string => Boolean(f));
        const named = namedOutOfContextFiles(candidateMessage, workspaceFileList, inContext);
        if (named.length > 0) {
          console.log(`[context] candidate named ${named.join(', ')} — content not in interviewer context`);
        }
      }
      const turn = await interviewer({
        spec: problem.spec,
        bug,
        bugFile,
        howToRun,
        mechanics: roundMechanics,
        targetNote,
        elapsedMs: now - (sessionStartedAt ?? now),
        remainingMs: remainingMsFor(caps.time_limit_ms, now - (sessionStartedAt ?? now)),
        recentActivity: renderActivity(events, now),
        // Real lines only; unheard voice segments collapse to a count line
        // instead of eating window slots as empty candidate turns.
        transcript: buildTranscript(events),
        candidateMessage,
        // The scaffolding move (one step when stuck): the observation is
        // aliased by describeStuck — identity, never file names.
        stuckObservation: stuck ? describeStuck(stuck, now) : null,
        adriftObservation,
        warmObservation,
        // Only a debugging round's failing_test is a real test name on the
        // candidate's screen. On other kinds the field is repurposed prose —
        // a review round's carried a sentence naming the defect areas, which
        // whitelisted seven answer stems in the vocabulary guard
        // (QA 2026-08-14).
        allowedExtra:
          roundSpec.check.kind === 'one_failing_test' ? (problem.planted_bug?.failing_test ?? '') : '',
        workspaceView,
        bugFileVisited: candidateVisitedBugFile(events, bugFile),
        hasAnswerKnowledge,
        protectedExtras: extraProtectedFiles.map((f) => ({
          file: f,
          visited: candidateVisitedBugFile(events, f),
        })),
        rubric: rubricText,
        engagement,
        // The opening rides its OWN slot: passed through the moment slot it
        // inherited "Follow the moment rules above" (kind probe, nudge true)
        // — flatly contradicting the OPENING rule's kind answer/nudge false,
        // and agenda.ts keys `clarify` off a prompted kind:'answer', so the
        // mislabel corrupted the agenda (QA 2026-08-14 audit).
        momentObservation: moment && moment.kind !== 'opening' ? moment.observation : null,
        openingObservation: moment?.kind === 'opening' ? moment.observation : null,
        checkKind: roundSpec.check.kind,
        codebase: codebaseView,
        // The agenda rides UNPROMPTED turns only. It used to ride replies
        // too, which was one of four instructions mandating a question be
        // appended to every turn — the same follow-up got bolted onto three
        // consecutive replies inside 43 seconds (QA 2026-08-14,
        // sess-qa814-leak). A reply's job is the answer.
        agenda: candidateMessage === null ? renderAgenda(assessAgenda(events, now, agendaCaps)) : undefined,
        // During wrap-up every turn sees the phase state; the wrap-lane turn
        // carries its assigned topic, and an open-phase reply carries the
        // next question as a first-class assignment (viaReply).
        wrapState:
          wrapTopic !== null
            ? renderWrapState(wrapQuestionsAsked, wrapTopic)
            : replyWrapTopic !== null
              ? renderWrapState(wrapQuestionsAsked, replyWrapTopic, { viaReply: true })
              : wrapUpAt !== null
                ? wrapClosed
                  ? 'WRAP-UP is over — you have signed off. Stay silent unless directly asked.'
                  : `WRAP-UP phase is active (all ${WRAP_UP_QUESTIONS} questions asked; the closing is coming). This turn is a reply — just answer.`
                : undefined,
        narrationEngage: narrationEngage || undefined,
        // Question-density governor (mechanical half): a streak of
        // question-ended turns orders this one to give, not ask. Wrap
        // turns are exempt — their whole job is the next question.
        questionStreak: governed ? streak : undefined,
      });
      if (turn.redacted) {
        console.warn('[interviewer] leak guard fired — reply replaced');
        if (stuck && !turn.say) {
          const n = (stuckRedactions.get(stuck.since_ms) ?? 0) + 1;
          stuckRedactions.set(stuck.since_ms, n);
          console.warn(`[interviewer] stuck hint redacted (${n}/2 for this episode)`);
        }
        if (adriftObservation && !turn.say) {
          adriftRedactions++;
          if (adriftRedactions >= 2) adriftFired = true;
          console.warn(`[interviewer] adrift redirect redacted (${adriftRedactions}/2 — then the lane gives up)`);
        }
      }
      if (!turn.say) {
        // Silence is a valid turn — but an UNEXPLAINED silence is how three
        // real asks vanished without a diagnosable trace. Name the cause:
        // model-silent carries the model's own reason; anything else here
        // means the parse failed or the call errored (logged upstream).
        console.log(
          `[interviewer] silent turn${candidateMessage !== null ? ' (was a reply!)' : ''}: ${
            turn.redacted
              ? 'REDACTED by the leak guard (unprompted leak → silence)'
              : (turn.reason ?? '(no reason — parse failure or error, see warnings above)')
          }`,
        );
        // A reasoned silence proves the model path is healthy; a reasonless,
        // unredacted one IS the failure shape (parse/call error).
        if (turn.redacted || turn.reason) interviewerFault = null;
        else interviewerFault = 'turn';
        return;
      }
      lastInterviewerTs = Date.now();
      if (candidateMessage === null) lastUnpromptedTs = lastInterviewerTs;
      interviewerFault = null; // a spoken turn is the all-clear
      // The once-per-session redirect budget burns on a SPOKEN redirect only.
      if (adriftObservation) adriftFired = true;
      if (narrationEngage) lastEngageTs = lastInterviewerTs;
      // Governor observability: a COMPLIANT governed turn used to be
      // indistinguishable from a voluntary statement — the one brake we
      // built was invisible when it worked (diagnosis 2026-08-17).
      if (governed) {
        console.log(
          `[governor] question budget spent (streak ${streak}) — ${
            turn.say.includes('?') ? 'turn LEAKED a question (marked non-pending)' : 'turn complied'
          }`,
        );
      }
      const wrapQuestionViaReply = replyWrapTopic !== null && countsAsWrapQuestion(turn.say);
      if (wrapTopic !== null) {
        // Count only turns that actually spoke; a silent wrap turn retries.
        if (wrapTopic === CLOSING_TOPIC) {
          wrapClosed = true;
          wrapClosedAt = lastInterviewerTs;
          console.log('[wrapup] closed — interviewer signed off');
        } else {
          wrapQuestionsAsked++;
          console.log(`[wrapup] question ${wrapQuestionsAsked}/${WRAP_UP_QUESTIONS} asked`);
        }
      } else if (wrapQuestionViaReply) {
        // A reply-carried question counts only when the turn actually ASKED
        // one — counting an unasked question would skip its topic.
        wrapQuestionsAsked++;
        console.log(`[wrapup] question ${wrapQuestionsAsked}/${WRAP_UP_QUESTIONS} asked (via reply)`);
      }
      store.emitChrome('interviewer', {
        text: turn.say,
        kind: turn.kind,
        nudge: turn.nudge,
        unprompted: candidateMessage === null,
        ...(turn.redacted ? { redacted: true } : {}),
        // Marked so replays can tell scaffolding from pressure — this is
        // how the K=3 threshold gets tuned from real sessions.
        ...(stuck ? { stuck: true } : {}),
        ...(wrapTopic !== null || wrapQuestionViaReply ? { wrap: true } : {}),
        ...(narrationEngage ? { engage: true } : {}),
        // Non-re-arming backstop: a governed turn that leaked a '?' anyway
        // must not open a pending-answer window — one leak restarts the
        // interrogation loop (addressing.ts reads this flag).
        ...(governed && turn.say.includes('?') ? { governed: true } : {}),
      });
      notifyTurn();
    } catch (e) {
      console.warn('[interviewer] turn failed:', String(e));
      interviewerFault = 'turn';
    } finally {
      interviewerBusy = false;
      // A question may have stacked while this turn was composing.
      pump();
    }
  };

  let pressureTimer: NodeJS.Timeout | null = null;
  let ackTimer: NodeJS.Timeout | null = null;
  let capTimer: NodeJS.Timeout | null = null;

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => resolve(b));
    });

  const finalize = async (): Promise<unknown> => {
    if (pressureTimer) clearInterval(pressureTimer);
    if (ackTimer) clearInterval(ackTimer);
    if (capTimer) clearInterval(capTimer);
    if (endpointTimer) clearInterval(endpointTimer);
    voice?.close();

    // One-shot rounds are graded HERE, server-side: the suite runs once, at
    // submit, via docker exec — the extension's Run button never existed for
    // this round, so there is no other path to a test_run in the trace.
    // can_run_tests:false rounds (review_diff — the coherence gate in
    // round-spec.ts makes that the only shape) have NO graded suite: the
    // deliverable is the written review, and QA 2026-08-14 showed the
    // unconditional run injecting a green 31/31 test_run into the trace,
    // which the judge then narrated as the candidate's result.
    if (caps.submit === 'one_shot' && caps.can_run_tests) {
      console.log('[session] one-shot submit — running the grading suite');
      const t0 = Date.now();
      const run = spawnSync(
        'docker',
        ['exec', containerName, 'bash', '-lc', `cd ${workspacePath} && ${testCmd}`],
        { encoding: 'utf8', timeout: 180_000 },
      );
      const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.slice(-4_000);
      store.emitChrome('test_run', {
        via: 'submit',
        exit_code: run.status,
        duration_ms: Date.now() - t0,
        summary: summarizeTail(tail),
        output_tail: tail,
        // Pass counts when the summary lines parse — the graded run is the
        // ONLY signal on a one-shot round, and without counts the judge
        // cannot tell 15/16 from 0/16 (timeline renderer v3).
        ...(parseRunCounts(tail) ?? {}),
      });
    }

    store.emitChrome('session_end', {});
    const events: TraceEvent[] = store.readAll();

    // The judge IS the feedback (2026-07-30 design). Blind to the gap graph;
    // knows the planted bug; failure yields UNASSESSED, never a verdict.
    // Talk-dimension clamp BEFORE any write: on a solo round with zero
    // utterances, communicate/reflect verdicts would be fabricated (see
    // clampSilentDimensions) — and a fabricated 'weak' becomes a gap.
    const result = clampSilentDimensions(
      await judgeSession({
        sessionId: cfg.sessionId,
        events,
        problem,
        problemDir: cfg.problemDir,
        templatePath: path.join(cfg.repoRoot, 'prompts', 'judge-session.md'),
      }),
      {
        hasInterviewer: interviewer !== null,
        utteranceCount: events.filter((e) => e.type === 'utterance').length,
        // Panes-solo clamps clarify/approach too — tab-switching is not
        // evidence (owner decision 2026-08-16); IDE-solo keeps them.
        surface,
      },
    );

    // THE PERSIST SEAM — the one gate between a judged round and durable
    // state (owner call 2026-08-18, the sample-session design). A sample
    // round runs the entire loop — interviewer, judge, card — but writes
    // NOTHING here: no assessment file, no feedback file, no gap or topic
    // deposit. Everything below that durably records the round must sit
    // inside `persist`; anything added to finalize later that writes to
    // disk belongs behind this same flag or it breaks the sample contract.
    const persist = cfg.sample !== true;
    if (persist) {
      mkdirSync(path.join(cfg.repoRoot, 'assessments'), { recursive: true });
      writeFileSync(
        path.join(cfg.repoRoot, 'assessments', `${cfg.sessionId}.json`),
        JSON.stringify(result, null, 2),
      );
    }

    let gapStore = loadStore(gapsDir, cfg.userId);
    // QA harness sessions run this same finalize with fabricated ids and
    // polluted the founder's memory twice (qa-lc-*, then sess-qa814-* which
    // beat a prefix guard). Only ids shaped like a real mint deposit —
    // see isMemorableSessionId for the arms-race record.
    const realSession = isMemorableSessionId(cfg.sessionId);
    if (persist && result.status === 'assessed' && realSession) {
      // Unassessed writes NOTHING — a judge failure must not become history.
      const spec = resolveRoundSpec(problem);
      gapStore = recordAssessment(gapStore, result, spec.label, spec.memory_tags, cfg.targetId);
      saveStore(gapsDir, gapStore);
      // Second graph: an LC-sourced round deposits topic-ledger rows —
      // one per part for a set (attemptsFromSession returns [] for
      // everything else). Same assessed-only gate; never fatal — finalize
      // must not crash on memory bookkeeping.
      try {
        recordTopicAttempts(cfg.repoRoot, cfg.userId, attemptsFromSession({
          assessment: result, problem, spec, events, origin: 'session',
        }));
      } catch (e) {
        console.warn(`[session] topic record skipped: ${String(e)}`);
      }
      // Third graph: a plan round whose manifest carries topics_exercised
      // (already subset-filtered against the plan's frozen list at build
      // time) deposits one row into the plan's topic-log. Same gates.
      if (cfg.targetId && Array.isArray(problem.topics_exercised) && problem.topics_exercised.length) {
        try {
          const { recordTopicLogRow } = await import('./topic-log.js');
          recordTopicLogRow(cfg.repoRoot, cfg.targetId, {
            session_id: cfg.sessionId,
            ts: result.judged_at,
            topics: problem.topics_exercised,
            solved: result.solved ?? null,
          });
        } catch (e) {
          console.warn(`[session] plan-topic record skipped: ${String(e)}`);
        }
      }
    }

    const view = buildGraphView(gapStore, cfg.sessionId);
    const card = buildAssessmentCard(result, view, events, problem.planted_bug?.description, {
      interviewer: interviewer !== null,
    });
    if (persist) {
    mkdirSync(path.join(cfg.repoRoot, 'feedback'), { recursive: true });
    writeFileSync(
      path.join(cfg.repoRoot, 'feedback', `${cfg.sessionId}.json`),
      JSON.stringify(
        {
          card,
          view,
          // WU5: the card's owner. The app's /api/feedback scopes on this;
          // legacy files without it read as the founder's.
          user_id: cfg.userId,
          // Voice health belongs in the record you open when a session felt
          // wrong: "the mic seemed off" must be checkable after the fact.
          // speech_starts vs transcripts is the gate-quality ratio — if it
          // drifts high, the energy gate is streaming non-speech and Silero
          // gets un-deferred (TODOS.md #3).
          voice: voice ? { budget: voice.budget.state(), health: voice.health } : null,
        },
        null,
        2,
      ),
    );
    }

    // The round's lifecycle record, mirrored (posthog.ts; the trace stays
    // authoritative). Plain capture, NOT captureAndWait: finalize's return
    // value is the card the candidate is actively waiting for, and this
    // process lingers ≥30 min serving that card (session-sweep
    // ENDED_LINGER_MS), so the void'ed fetch has all the flush time it
    // needs at zero added latency. judge_unassessed is its own event — a
    // judge failure writes no memory and needs its own alarm.
    if (result.status !== 'assessed') {
      phSession.capture(cfg.userId, 'judge_unassessed', { session_id: cfg.sessionId });
    }
    phSession.capture(cfg.userId, 'round_ended', {
      session_id: cfg.sessionId,
      sample: cfg.sample === true,
      status: result.status,
      solved: result.status === 'assessed' ? (result.solved ?? null) : null,
      interviewer: interviewer !== null,
      surface,
      duration_ms: sessionStartedAt ? Date.now() - sessionStartedAt : null,
    });

    // Close the memory loop: generate the NEXT problem now, aimed at the gap
    // this session just surfaced. Detached and unwaited — it takes ~5 minutes
    // and nobody is watching, so by the time they come back it is ready.
    if (cfg.prepareNext) {
      const note = buildTargetNote(view, gapStore);
      const child = spawn(
        'npx',
        ['tsx', path.join(cfg.repoRoot, 'server', 'src', 'cli.ts'), 'prepare'],
        {
          cwd: cfg.repoRoot,
          detached: true,
          stdio: 'ignore',
          env: childEnv('generator', process.env, { IP_TARGET_NOTE: note ?? '', IP_USER_ID: cfg.userId }),
        },
      );
      child.unref();
      console.log(`[session] preparing next problem in background${note ? ' (targeted)' : ''}`);
    }

    return card;
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    // WU3 gate. Open: the chrome shell + its statics (no data in them — the
    // shell reads everything through /api/*). Everything else, including the
    // IDE proxy fall-through and the TTS stream, needs a user. The app's
    // server-to-server probes authenticate via x-ip-internal.
    {
      const openPath =
        url === '/session' || url.startsWith('/client/') || url.startsWith('/vendor/monaco/') ||
        // The analytics bundle is a page static like the two above — and if
        // this is missed, the script 404s behind auth and round analytics
        // die silently (the page itself is built to survive exactly that).
        isPosthogAssetUrl(url);
      if (!openPath) {
        const viewer = await auth.resolve(req);
        if (!viewer) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'sign in required' }));
        }
        // WU5: a live round is the CANDIDATE's room. Another invited user
        // reaching this origin must not see their workspace or chat.
        if (!viewer.admin && !viewer.internal && viewer.id !== cfg.userId) {
          res.writeHead(403, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'someone else is mid-round on this server' }));
        }
      }
    }
    if (url === '/session') {
      markCandidateContact();
      const backUrl = cfg.appUrl
        ? cfg.targetId
          ? `${cfg.appUrl}/#/t/${encodeURIComponent(cfg.targetId)}`
          : `${cfg.appUrl}/#/`
        : null;
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(
        sessionPage(cfg.sessionId, {
          interviewer: Boolean(interviewer),
          time_limit_ms: caps.time_limit_ms,
          one_shot: caps.submit === 'one_shot',
          autorun: cfg.autorunTests && roundSpec.check.kind === 'one_failing_test',
          surface,
          can_run_tests: caps.can_run_tests,
          statement: problem.spec,
          back_url: backUrl,
          workspace_path: workspacePath,
          elapsed_ms: sessionStartedAt ? Date.now() - sessionStartedAt : 0,
          voice: Boolean(voice),
          ...(sessionAnalytics ? { analytics: sessionAnalytics } : {}),
        }),
      );
    }
    if (url.startsWith('/client/')) {
      const name = path.basename(url); // no traversal: basename only
      const body = clientScript(name);
      if (body === null) {
        res.writeHead(404);
        return res.end('no such client file');
      }
      // See app.ts: no build step means no cache busting, so never store.
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      return res.end(body);
    }
    if (url === '/api/status') {
      const events = store.readAll();
      const counts: Record<string, number> = {};
      for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          session_id: cfg.sessionId,
          // WU5: whose round this is — the app's session-kill ownership
          // check and the launch 409 copy both read it.
          user_id: cfg.userId,
          // A graded/abandoned session answering 200 is NOT a live session.
          // The app reads this to decide whether Start is available (QA
          // ISSUE-001: without it, one finished round soft-locked every
          // future launch until someone opened a terminal).
          ended,
          counts,
          trigger_armed: hasFailingRun(events),
          voice: voice
            ? { enabled: true, budget: voice.budget.state(), health: voice.health }
            : { enabled: false, reason: voiceOffReason },
        }),
      );
    }
    // A page from an earlier session keeps polling and writing after its
    // server dies; once the next session binds :3200 those writes would land
    // in the NEW session's trace (QA 2026-08-14: a second stale client
    // contaminated a live run). Pages stamp their session id on every write;
    // a mismatch is refused, never recorded. Header absent (old pages, the
    // IDE extension's WS path) ⇒ no check — this is trace hygiene, not auth.
    {
      const claimed = req.headers['x-ip-session'];
      const writeRoute =
        req.method !== 'GET' &&
        (url === '/api/utterance' || url === '/api/file' || url === '/api/panes-event' ||
          url === '/api/run' || url === '/api/ide-run' || url === '/api/end' || url === '/api/card-feedback');
      if (writeRoute && typeof claimed === 'string' && claimed !== '' && claimed !== cfg.sessionId) {
        res.writeHead(409, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'stale_session_page', live_session: cfg.sessionId }));
      }
      // Same trace-hygiene rule in the time dimension: once the round has
      // ended the judge has ALREADY read the trace and the assessment is on
      // disk, so a later append silently makes the record disagree with what
      // was graded. QA 2026-08-14 fix-verification: a reloaded ended page
      // still posted edits/saves/utterances into the closed trace. /api/end
      // and /api/card-feedback stay open — ending twice is idempotent and the
      // card's confirm buttons live on the ended page by design.
      const appendRoute =
        url === '/api/utterance' || url === '/api/file' || url === '/api/panes-event';
      if (ended && appendRoute && req.method !== 'GET') {
        res.writeHead(409, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'session_ended' }));
      }
    }
    if (url === '/api/utterance' && req.method === 'POST') {
      // Solo rounds have no utterance channel AT ALL (owner decision
      // 2026-08-15): the client no longer posts, and this guard keeps any
      // stray caller from planting talk-evidence in a trace the judge would
      // then grade narration against.
      if (!interviewer) {
        res.writeHead(409, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no interviewer this round' }));
      }
      const body = JSON.parse((await readBody(req)) || '{}') as { text?: string };
      const ev = store.emitChrome('utterance', { text: body.text ?? '', via: 'text' });
      // Typed and spoken words take the SAME path: trace always, intent
      // check outside the lock, reply via /api/messages if addressed.
      routeUtterance(body.text ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ seq: ev.seq, pending: Boolean(interviewer) }));
    }
    if (url.startsWith('/voice/tts/') && voice) {
      // The text is read from the STORED interviewer event — downstream of
      // guard() by construction. A redacted turn reaches the speaker
      // redacted; there is no path from raw model output to audio.
      const seq = Number(url.slice('/voice/tts/'.length));
      const turn = store
        .readAll()
        .find((e) => e.type === 'interviewer' && e.seq === seq);
      const text = String((turn?.payload as { text?: string } | undefined)?.text ?? '');
      if (!text) {
        res.writeHead(404);
        return res.end('no such turn');
      }
      const out = await voice.tts(text);
      if (!out.ok) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: out.error }));
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      const { Readable } = await import('node:stream');
      Readable.fromWeb(out.body as never).pipe(res);
      return;
    }
    if (url.startsWith('/api/messages')) {
      const since = Number(new URL(url, 'http://x').searchParams.get('since') ?? -1);
      const all = store.readAll();
      const messages = all
        .filter((e) => e.type === 'interviewer' && e.seq > since)
        .map((e) => ({
          seq: e.seq,
          ts: e.ts,
          ...(e.payload as Record<string, unknown>),
        }));
      // Spoken words echo back to the panel. First live session lesson:
      // transcripts landed in the trace but NOTHING showed the candidate
      // their voice registering, so a half-broken pipeline read as fully
      // dead. seq keying is separate from interviewer seq, so the client
      // tracks a second cursor (vsince).
      const vsince = Number(new URL(url, 'http://x').searchParams.get('vsince') ?? -1);
      const heard = all
        .filter(
          (e) =>
            e.type === 'utterance' &&
            e.source === 'chrome' &&
            (e.payload as { via?: string })?.via === 'voice' &&
            e.seq > vsince,
        )
        .map((e) => ({
          seq: e.seq,
          text: String((e.payload as { text?: string })?.text ?? ''),
          untranscribed: Boolean((e.payload as { untranscribed?: boolean })?.untranscribed),
        }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        // "Thinking" starts the moment a question is ACCEPTED, not when the
        // model call begins — the settling window and queue wait are dead air
        // to the candidate otherwise, and dead air with no indicator is
        // indistinguishable from a broken interviewer.
        JSON.stringify({
          messages,
          heard,
          thinking: interviewerBusy || turnQueue.size > 0 || settlePending(),
          time_up: timeUpAt !== null,
          // Interviewer health, the voiceOffReason precedent made dynamic: a
          // model-path failure used to be COMPLETE silence with no signal of
          // any kind — the QA candidates concluded they were being ignored
          // (sess-1786686415240 asked four direct questions into the void).
          // Cleared by the next healthy turn/intent check; null when off.
          interviewer_fault: interviewer ? interviewerFault : null,
        }),
      );
    }
    if (url === '/api/card-feedback' && req.method === 'POST') {
      // Phase 6 golden-set loop: per-dimension "did this match?" from the
      // candidate. Confirmations accumulate next to the assessment; a
      // confirmed session can be promoted into the gauntlet's golden
      // fixtures (cli promote-fixture) — the library grows from REAL
      // sessions, never app-testing runs.
      const body = JSON.parse((await readBody(req)) || '{}') as {
        dimension?: string;
        agree?: boolean;
      };
      const file = path.join(cfg.repoRoot, 'assessments', `${cfg.sessionId}.confirm.json`);
      let confirms: Record<string, boolean> = {};
      try {
        confirms = JSON.parse(readFileSync(file, 'utf8')) as Record<string, boolean>;
      } catch {
        /* first confirmation */
      }
      if (body.dimension) confirms = mergeConfirm(confirms, body.dimension, Boolean(body.agree));
      mkdirSync(path.join(cfg.repoRoot, 'assessments'), { recursive: true });
      writeFileSync(file, JSON.stringify(confirms, null, 2));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (isPosthogAssetUrl(url) && req.method === 'GET') {
      // The vendored analytics bundle — same one the app serves, same
      // immutable caching (the version in the URL is the cache buster; see
      // app.ts's vendor route for the full note on why this one asset may
      // diverge from no-store).
      if (!phAsset) {
        res.writeHead(404);
        return res.end('no such asset');
      }
      res.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'public, max-age=31536000, immutable',
      });
      return res.end(readFileSync(phAsset));
    }
    if (url.startsWith('/vendor/monaco/') && req.method === 'GET') {
      // Monaco's prebuilt AMD tree served straight from node_modules — the
      // no-bundler rule holds for the panes surface too. Same traversal
      // gate as the file API, different root.
      const rel = url.slice('/vendor/monaco/'.length).split('?')[0]!;
      const abs = safeWorkspacePath(monacoRoot, rel);
      if (!abs) {
        res.writeHead(400);
        return res.end('bad path');
      }
      try {
        const body = readFileSync(abs);
        const type =
          abs.endsWith('.js') ? 'text/javascript'
          : abs.endsWith('.css') ? 'text/css'
          : abs.endsWith('.ttf') ? 'font/ttf'
          : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        return res.end(body);
      } catch {
        res.writeHead(404);
        return res.end('no such asset');
      }
    }
    // ---- panes surface API ----
    // The panes renderer has no extension inside it, so these routes ARE its
    // trace pipeline: the client posts edit/file_open/file_save, the run
    // route emits test_run, and the server owns every seq (emitChrome) so
    // client events can never collide with interviewer/sensor seqs.
    if (url === '/api/files' && req.method === 'GET') {
      // `files` stays the full flat list (client back-compat); primary/infra
      // partition the tab strip and `model` drives per-file defaults (the
      // md preview opens rendered for docs, as source for files the
      // candidate is meant to write). See partitionWorkspaceFiles.
      const files = listWorkspaceFiles(cfg.problemDir);
      const model = (problem.model_paths ?? []).map((m) => m.replace(/^\.\//, ''));
      const { primary, infra } = partitionWorkspaceFiles(files, model);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ files, primary, infra, model }));
    }
    if (url.startsWith('/api/file') && req.method === 'GET') {
      const rel = new URL(url, 'http://x').searchParams.get('path') ?? '';
      const abs = safeWorkspacePath(cfg.problemDir, rel);
      // problem.json is the manifest — rubric and planted bug. Not listed,
      // not readable by a guessed name either.
      if (!abs || path.basename(abs) === 'problem.json') {
        res.writeHead(400);
        return res.end('bad path');
      }
      try {
        const content = readFileSync(abs, 'utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ path: rel, content }));
      } catch {
        res.writeHead(404);
        return res.end('no such file');
      }
    }
    if (url === '/api/file' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)) || '{}') as { path?: string; content?: string };
      const abs = safeWorkspacePath(cfg.problemDir, body.path ?? '');
      // problem.json write-block: overwriting the manifest would corrupt
      // grading for the very session doing the writing.
      if (
        !abs ||
        path.basename(abs) === 'problem.json' ||
        typeof body.content !== 'string' ||
        body.content.length > 1_000_000
      ) {
        res.writeHead(400);
        return res.end('bad path or content');
      }
      // One-shot rounds extend the block to the grading contract itself:
      // tests/ and the cases files are exactly what the submit run executes
      // (QA 2026-08-14 — test_partN.py was editable in-session, so a
      // candidate could grade their own round green). Iterate rounds keep
      // test-editing freedom; their runs are formative, not graded.
      const relPath = path.relative(cfg.problemDir, abs);
      if (
        caps.submit === 'one_shot' &&
        (relPath === 'tests' ||
          relPath.startsWith(`tests${path.sep}`) ||
          /^cases.*\.json$/i.test(path.basename(abs)) ||
          shadowsTestRunner(relPath))
      ) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'the grading suite is read-only on a one-shot round' }));
      }
      markCandidateContact();
      mkdirSync(path.dirname(abs), { recursive: true }); // blank scaffolds invite new files
      writeFileSync(abs, body.content);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url === '/api/panes-event' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        type?: string;
        payload?: Record<string, unknown>;
      };
      // Closed vocabulary at the door: the panes client may only produce the
      // three activity types the extension produces. Everything else in the
      // trace stays server-authored.
      if (body.type !== 'edit' && body.type !== 'file_open' && body.type !== 'file_save') {
        res.writeHead(400);
        return res.end('event type not accepted from the panes client');
      }
      markCandidateContact();
      const payload = { ...(body.payload ?? {}) };
      if (body.type === 'file_save') {
        payload.is_model_path = isModelPath(String(payload.path ?? ''), problem.model_paths ?? []);
      }
      const ev = store.emitChrome(body.type, payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ seq: ev.seq }));
    }
    if (url === '/api/ide-run' && req.method === 'POST') {
      // The IDE surface's Run Tests, pressed in OUR header. It does not run
      // the suite here — it asks the extension to, so the output lands in
      // the IDE's Test Results panel and the trace records a first-class
      // `via: 'task'` run instead of a second kind of test run.
      const rejected = runGuard(caps, ended, false);
      if (rejected) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: rejected }));
      }
      if (!traceSocket || traceSocket.readyState !== traceSocket.OPEN) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'ide_not_connected' }));
      }
      markCandidateContact();
      traceSocket.send(JSON.stringify({ cmd: 'run_tests' }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url === '/api/run' && req.method === 'POST') {
      const rejected = runGuard(caps, ended, paneRunning);
      if (rejected) {
        res.writeHead(rejected === 'busy' ? 409 : 403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: rejected }));
      }
      markCandidateContact();
      paneRunning = true;
      const t0 = Date.now();
      // spawn, not spawnSync: a suite can take minutes and the status /
      // message polls must keep answering while it runs.
      const child = spawn('docker', ['exec', containerName, 'bash', '-lc', `cd ${workspacePath} && ${testCmd}`]);
      let tail = '';
      const keep = (chunk: Buffer) => {
        tail = (tail + chunk.toString()).slice(-4_000);
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const killer = setTimeout(() => child.kill('SIGKILL'), 180_000);
      child.on('close', (code) => {
        clearTimeout(killer);
        paneRunning = false;
        const summary = summarizeTail(tail);
        const counts = parseRunCounts(tail);
        // Teardown race: if the session ended mid-run, docker rm killed the
        // exec — a post-session_end test_run would corrupt the trace's story.
        if (!ended) {
          store.emitChrome('test_run', {
            via: 'panes',
            exit_code: code,
            duration_ms: Date.now() - t0,
            summary,
            output_tail: tail,
            ...(counts ?? {}),
          });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exit_code: code, summary, tail, ...(counts ?? {}) }));
      });
      child.on('error', (e) => {
        clearTimeout(killer);
        paneRunning = false;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      });
      return;
    }
    if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
      // Workbench boot HTML: the ONE channel through which settings reach
      // the VS Code Web UI (ide-settings KNOWN ISSUE — file scopes land in
      // browser-side IndexedDB territory the server can't touch). Inject
      // our defaults; any failure falls back to the transparent proxy.
      try {
        const html = await fetchIdeHtml(cfg.idePort, url);
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(
          injectPreBoot(injectWorkbenchDefaults(html, ideSettings), preBootSeedScript()),
        );
      } catch {
        /* IDE still booting or unexpected response — proxy as before */
      }
    }
    if (url === '/api/end' && req.method === 'POST') {
      if (ended) {
        res.writeHead(409);
        return res.end('already ended');
      }
      ended = true;
      try {
        const card = await finalize();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(card));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
      // Grading done (one-shot docker exec included) — the container has no
      // further job. The HTTP server stays up so the rendered card and
      // "did this match?" keep working; the next launch reaps it via
      // /api/shutdown.
      setImmediate(teardownContainer);
      return;
    }
    if (url === '/api/shutdown' && req.method === 'POST') {
      // Reap path for a lingering ended server (the app calls this before
      // starting the next session). Idempotent.
      teardownContainer();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setImmediate(() => process.exit(0));
      return;
    }
    if (url === '/api/abandon' && req.method === 'POST') {
      // The in-app "end session" (QA D1): DISCARD, never grade. A false
      // start must not pollute the gap graph with an all-unassessable
      // session — Submit remains the one graded path. The trace stays on
      // disk, so a CLI rejudge can recover a genuine attempt.
      if (!ended) {
        ended = true;
        if (pressureTimer) clearInterval(pressureTimer);
        if (capTimer) clearInterval(capTimer);
        if (endpointTimer) clearInterval(endpointTimer);
        voice?.close();
        // Closed trace vocabulary: abandonment is a session_end with a flag,
        // not a new event type.
        store.emitChrome('session_end', { abandoned: true });
      }
      teardownContainer();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, abandoned: true }));
      setImmediate(() => process.exit(0));
      return;
    }
    proxy.web(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    traceSocket = ws;
    ws.on('close', () => {
      if (traceSocket === ws) traceSocket = null;
    });
    ws.on('message', (data) => {
      try {
        const ev = JSON.parse(String(data)) as TraceEvent;
        if (ev.session_id !== cfg.sessionId) return; // stale emitter from a prior run
        markCandidateContact(); // extension activity also proves arrival
        store.ingest(ev);
        ws.send(JSON.stringify({ ack: { seq: ev.seq } }));
      } catch {
        /* malformed frame */
      }
    });
  });
  // Browser voice client: presence/audio control messages in, nothing out.
  // Transcripts and replies travel the normal trace + /api/messages paths.
  const voiceWss = new WebSocketServer({ noServer: true });
  voiceWss.on('connection', (ws) => {
    ws.on('message', (data) => {
      try {
        voice?.handleClientMessage(JSON.parse(String(data)) as ClientVoiceMessage);
      } catch {
        /* malformed frame */
      }
    });
  });

  // Turn-delivery doorbell. The client used to learn about a new interviewer
  // turn only via its 2s /api/messages poll — 0-2000ms of pure dead air on
  // EVERY reply, invisible to any server-side timing. The poke carries no
  // data (the poll path stays the single source of truth); it only makes the
  // next fetch immediate. If this socket dies, the poll still delivers.
  const eventsWss = new WebSocketServer({ noServer: true });
  const eventsClients = new Set<WebSocket>();
  eventsWss.on('connection', (ws) => {
    eventsClients.add(ws);
    ws.on('close', () => eventsClients.delete(ws));
  });
  notifyTurn = () => {
    for (const ws of eventsClients) {
      try {
        ws.send('{"poke":true}');
      } catch {
        /* dead socket — close handler reaps it */
      }
    }
  };

  server.on('upgrade', (req, socket, head) => {
    // Route on pathname: /trace now carries ?token=…, and the emitter uses
    // IP_WS_URL verbatim, so the exact-match routing would silently proxy
    // the trace socket into openvscode and tracing would die.
    const upgradePath = new URL(req.url ?? '', 'http://x').pathname;
    if (upgradePath === '/trace') {
      // Token-gated, NOT JWT-gated: the emitter dials from inside the
      // container with no cookie. See traceUpgradeAllowed.
      if (!traceUpgradeAllowed(req.url, traceToken)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    // Everything else — /voice, /events, and the openvscode workbench WS
    // through the proxy — carries the browser's auth cookie.
    void auth.resolve(req).then((user) => {
      // Same viewer-ownership rule as the HTTP gate: the room belongs to
      // the candidate whose round this is.
      if (!user || (!user.admin && !user.internal && user.id !== cfg.userId)) {
        socket.destroy();
        return;
      }
      if (upgradePath === '/voice') {
        voiceWss.handleUpgrade(req, socket, head, (ws) => voiceWss.emit('connection', ws, req));
      } else if (upgradePath === '/events') {
        eventsWss.handleUpgrade(req, socket, head, (ws) => eventsWss.emit('connection', ws, req));
      } else {
        proxy.ws(req, socket, head);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        const who = spawnSync('lsof', ['-tiTCP:' + cfg.port, '-sTCP:LISTEN'], {
          encoding: 'utf8',
        }).stdout.trim();
        reject(
          new Error(
            `port ${cfg.port} is already in use${who ? ` by pid ${who}` : ''} — ` +
              `a previous session is still running. Kill it (kill ${who || '<pid>'}) and retry.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(cfg.port, resolve);
  });
  cfg.onReady?.();
  // Unprompted turns. Only once the round is genuinely underway — a failing
  // run, a first edit, or the floor elapsing (roundUnderway's header has the
  // QA incident: the old failing-run-only gate silenced every initiative
  // lane for whole one-shot and green-start rounds). When the stuck detector
  // fires, the unprompted turn IS the scaffolding move instead of a pressure
  // beat (decision D3): one voice at a time, same 4-minute floor. Pressure
  // aimed at someone already grinding produces flailing, not progress.
  if (interviewer) {
    pressureTimer = setInterval(() => {
      if (ended || interviewerBusy || sessionStartedAt === null) return;
      const events = store.readAll();
      const now = Date.now();
      if (!roundUnderway(events, now, sessionStartedAt)) return;

      // Wrap signal: checked every tick regardless of clocks, set once.
      if (wrapUpAt === null) {
        const sig = detectWrapSignal(events, now, { checkKind: roundSpec.check.kind });
        if (sig !== null) {
          wrapUpAt = now;
          console.log('[wrapup] working phase over — evaluation questions begin');
        }
      }

      // Wrap-up lane: once active it OWNS initiative — no scaffolding, no
      // moments, no pressure aimed at work that is already done. It paces
      // on its OWN short guard, NOT the 60s anti-stack guard below: in
      // sess-1786861469215 the phase armed and never asked one question,
      // because every reply to the candidate's polite check-ins reset the
      // long guard until they gave up and ended the session. A talking
      // candidate gets the next question through their reply
      // (replyWrapTopic); this lane exists for the quiet one, so it also
      // waits for a short speech-free window instead of talking over an
      // answer in progress.
      if (wrapUpAt !== null) {
        let lastSpeechTs = 0;
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i]!.type === 'utterance') {
            lastSpeechTs = events[i]!.ts;
            break;
          }
        }
        if (wrapClosed) {
          // The interviewer owns the ending (owner call 2026-08-17,
          // superseding wrapup.ts's verbal-only decision): a closing that
          // stands unanswered runs the SAME finalize as the End button —
          // announce once, then the time-cap grace sequence verbatim.
          if (
            wrapClosedAt !== null &&
            shouldAutoFinalize(wrapClosedAt, lastInterviewerTs, lastSpeechTs, now)
          ) {
            ended = true;
            store.emitChrome('interviewer', {
              text: 'Wrapping up here — your feedback is on its way.',
              kind: 'time',
              nudge: false,
            });
            notifyTurn();
            console.log('[wrapup] closing stood unanswered — auto-finalizing');
            void finalize()
              .then(() => setImmediate(teardownContainer))
              .catch((err) => console.error('[session] wrap auto-finalize failed:', err));
          }
          return;
        }
        if (now - lastInterviewerTs < WRAP_TURN_GUARD_MS) return;
        if (now - lastSpeechTs < WRAP_CANDIDATE_QUIET_MS) return;
        const topic =
          wrapQuestionsAsked >= WRAP_UP_QUESTIONS
            ? CLOSING_TOPIC
            : selectWrapTopic(assessAgenda(events, now, agendaCaps), wrapQuestionsAsked, roundSpec.check.kind);
        void runInterviewer(null, null, null, null, topic);
        return;
      }

      // Urgent moments — the suite just went green — react on a short
      // guard and skip the moment-cadence gate entirely: the climax of the
      // round tolerates no staleness. Checked via its OWN detector, not
      // detectMoment's priority chain, so a stale unfired moment can't
      // mask the pass (moments.ts detectUrgentMoment header).
      const urgentMoment = detectUrgentMoment(events, roundSpec.check.kind, firedMoments);
      if (urgentMoment && now - lastInterviewerTs >= URGENT_MOMENT_GUARD_MS) {
        firedMoments.add(urgentMoment.kind);
        console.log(`[moment] ${urgentMoment.kind} (urgent)`);
        void runInterviewer(null, null, urgentMoment);
        return;
      }

      // Anti-stacking guard only: never talk on top of a turn just
      // delivered. Everything else paces on the UNPROMPTED clock — replies
      // no longer buy the interviewer silence (the single-clock bug that
      // produced ZERO unprompted turns in a 26-minute session).
      if (now - lastInterviewerTs < ANY_TURN_GUARD_MS) return;

      // Priority unchanged: help > engagement > rhythm.
      // Scaffolding lane — paced by NEED (the detectors), not the metronome.
      if (now - lastInterviewerTs >= SCAFFOLD_FLOOR_MS) {
        const stuck = detectStuck(events, now, sessionStartedAt);
        const episodeSpent = stuck ? (stuckRedactions.get(stuck.since_ms) ?? 0) >= 2 : false;
        if (stuck && !episodeSpent) {
          void runInterviewer(null, stuck);
          return;
        }
        // Nothing is being CHANGED — but is anything being read productively?
        // detectStuck is blind to a candidate who only reads (its own doc
        // says reading must never trip it), which left the wrong-file reader
        // with no help at all for 35 minutes in sess-1786072934316.
        // EVIDENCE GATE: a redirect asserts "no answer lives where you are
        // reading", and without a ground-truth location there is nothing to
        // back that with — the old code always redirected on bugless rounds
        // (regionContainsAnswer short-circuits false on an empty bugFile),
        // pushing candidates off regions the system knew nothing about
        // (QA 2026-08-14). No answer knowledge → no adrift lane at all.
        const adrift = hasAnswerKnowledge ? detectAdrift(events, now, sessionStartedAt) : null;
        // The once-per-session budget is spent on the REDIRECT only: "the
        // region you are in is spent" is a location signal, and repeating it
        // turns the round into a guided tour. The warm inversion carries no
        // location content — it is pure "keep pulling on that" — so it stays
        // available all session, which is the half the candidate actually
        // asked for ("rarely making me feel like I was on to something").
        if (adrift) {
          // Warm against EVERY protected location: a review round's defects
          // span files, and reading any of them is the right neighbourhood.
          const warm =
            regionContainsAnswer(adrift, bugFile, problem.planted_bug?.line) ||
            extraProtectedFiles.some((f) => regionContainsAnswer(adrift, f, null));
          const warmCooling = warm && now - lastWarmTs < WARM_COOLDOWN_MS;
          if ((warm && !warmCooling) || (!warm && !adriftFired)) {
            if (warm) lastWarmTs = now;
            // The redirect budget is burned when the turn actually SPEAKS
            // (below) — the old pre-dispatch mark spent the once-per-session
            // slot on turns the guard then silenced.
            console.log(`[adrift] ${warm ? 'WARM — answer is in their region; encouraging, not redirecting' : 'REDIRECT'}`);
            void runInterviewer(
              null,
              null,
              null,
              warm ? null : describeAdrift(adrift, now),
              null,
              warm ? describeWarm(adrift, now) : null,
            );
            return;
          }
        }
      }

      const sinceUnprompted = now - lastUnpromptedTs;
      if (sinceUnprompted >= MOMENT_INTERVAL_MS) {
        // Event-anchored probes: the first failure read, the first fix that
        // ran, the pass after a struggle. Each fires ONCE — marked before
        // dispatch so even a guard-silenced turn never re-fires it.
        const moment = detectMoment(events, roundSpec.check.kind, firedMoments, now);
        if (moment) {
          firedMoments.add(moment.kind);
          console.log(`[moment] ${moment.kind}`);
          void runInterviewer(null, null, moment);
          return;
        }
      }
      if (sinceUnprompted >= PRESSURE_INTERVAL_MS) {
        void runInterviewer(null, null);
      }
    }, PRESSURE_TICK_MS);
    pressureTimer.unref();

    // Listening signals between substantive turns. The candidate once asked
    // "can you hear me?" four times at a working mic because silence was the
    // interviewer's only other state — acks are canned, content-free, and
    // deliberately do NOT touch lastInterviewerTs, so they never delay or
    // replace a real turn.
    ackTimer = setInterval(() => {
      // No "Mm-hm" during the wrap-up: the interviewer is actively leading
      // the conversation there, and a canned continuer reads as checked-out.
      if (ended || interviewerBusy || sessionStartedAt === null || timeUpAt !== null || wrapUpAt !== null) return;
      const events = store.readAll();
      if (!roundUnderway(events, Date.now(), sessionStartedAt)) return; // same "genuinely underway" gate as pressure
      if (Date.now() - lastUnpromptedTs >= PRESSURE_INTERVAL_MS) return; // a real turn is due — let it speak
      const ack = decideAck(events, Date.now(), { askPending: turnQueue.size > 0 });
      if (!ack) return;
      store.emitChrome('interviewer', { text: ack, kind: 'ack', nudge: false, unprompted: true });
      notifyTurn();
    }, PRESSURE_TICK_MS);
    ackTimer.unref();
  }

  // Hard time cap (timed rounds only). Anchored to the candidate's arrival,
  // never process start — the 71-idle-minutes lesson. The client is asked to
  // end first (mic released through the normal path); a 30s grace covers the
  // closed-tab case so the record always closes.
  if (caps.time_limit_ms) {
    // Bound here, not read through `caps` in the callback: the outer
    // narrowing does not survive into setInterval, and the cap timer should
    // read THE CAP, never a shared "session length" that once had a fallback.
    const limitMs = caps.time_limit_ms;
    let warned = false;
    capTimer = setInterval(() => {
      if (ended || sessionStartedAt === null) return;
      const elapsed = Date.now() - sessionStartedAt;
      if (!warned && elapsed >= limitMs * 0.8) {
        warned = true;
        const left = Math.max(1, Math.round((limitMs - elapsed) / 60_000));
        store.emitChrome('interviewer', {
          text: `${left} minute${left === 1 ? '' : 's'} remaining.`,
          kind: 'time',
          nudge: false,
        });
        notifyTurn();
      }
      if (elapsed >= limitMs && timeUpAt === null) {
        timeUpAt = Date.now();
        store.emitChrome('interviewer', {
          text: "Time's up — submitting what's there now.",
          kind: 'time',
          nudge: false,
        });
        notifyTurn();
        console.log('[session] time cap reached — waiting for the client to end');
      }
      if (timeUpAt !== null && Date.now() - timeUpAt > 30_000 && !ended) {
        ended = true;
        console.log('[session] grace elapsed — finalizing server-side');
        void finalize()
          // The card never needs the container; in multi mode an idle
          // openvscode container would burn ~1GB beside live rooms.
          .then(() => setImmediate(teardownContainer))
          .catch((e) => console.error('[session] cap finalize failed:', e));
      }
    }, 5_000);
    capTimer.unref();
  }

  console.log(`[session] ${cfg.sessionId}`);
  console.log(`[session] open   http://localhost:${cfg.port}/session`);
  console.log('[session] Ctrl+C tears down the container');

  const teardown = () => {
    teardownContainer();
    process.exit(0);
  };
  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);
}
