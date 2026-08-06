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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import httpProxy from 'http-proxy';
import { WebSocket, WebSocketServer } from 'ws';
import type { GeneratedProblem, TraceEvent } from '@interview-prep/shared';
import { isFailingRun, resolveRoundSpec, resolveSurface } from '@interview-prep/shared';
import { judgeSession } from './judge.js';
import { buildAssessmentCard } from './feedback.js';
import { buildGraphView, buildTargetNote, loadStore, recordAssessment, saveStore } from './gap-graph.js';
import { clientScript, sessionPage } from './chrome.js';
import { injectWorkbenchDefaults } from './workbench-inject.js';
import { describeStuck, detectStuck, type StuckState } from './stuck.js';
import { isModelPath, listWorkspaceFiles, runGuard, safeWorkspacePath, summarizeTail } from './panes.js';
import { isCorrectionFollowUp, isExplicitAsk } from './addressing.js';
import { decideAck } from './ack.js';
import { renderWorkspaceView, snapshotWorkspace } from './workspace-view.js';
import { detectMoment } from './moments.js';
import { extractSection, loadBlueprint } from './blueprint.js';
import { TraceStore } from './trace-store.js';
import {
  TurnQueue,
  bugContext,
  candidateVisitedBugFile,
  pickIntentCheck,
  pickInterviewer,
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
  /** Called once the server is listening — the point after which this session
   *  really exists. The caller marks the problem used here, so a start that
   *  fails on the port check leaves the pool untouched. */
  onReady?: () => void;
}

/** Nominal round length — what the interviewer's time pressure counts down. */
const SESSION_LENGTH_MS = 45 * 60_000;
/** Floor between unprompted pressure beats. An interviewer that talks every
 *  minute stops being pressure and starts being noise. */
const PRESSURE_INTERVAL_MS = 4 * 60_000;
/** Floor for event-anchored moment probes — shorter than pressure: a probe
 *  about something that JUST happened tolerates less staleness. */
const MOMENT_INTERVAL_MS = 2 * 60_000;
const PRESSURE_TICK_MS = 30_000;

const IDE_IMAGE = 'gitpod/openvscode-server:latest';
const CONTAINER = 'ip-session';
const BUNDLED_NODE = '/home/.openvscode-server/node';

/** The one way the IDE container dies. Called after grading, on abandon, on
 *  shutdown, and from the signal handlers — a session that ends by ANY path
 *  must not leave a live container behind (QA ISSUE-001: it did, and every
 *  finished round soft-locked the product until a terminal intervened). */
function teardownContainer(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER], { encoding: 'utf8' });
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

function ensureIdeDataDir(repoRoot: string): string {
  const dataDir = path.join(repoRoot, '.ide-data');
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
  const dist = path.join(repoRoot, 'extension', 'dist');
  if (!existsSync(path.join(dist, 'trace-emitter-0.0.1', 'extension.js'))) {
    console.log('[session] building extension...');
    sh('node', ['build.mjs'], { cwd: path.join(repoRoot, 'extension') });
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

export async function runSession(cfg: SessionConfig): Promise<void> {
  // First statement in the function, on purpose: everything below this line
  // mutates state the running session owns.
  assertPortFree(cfg.port);

  const problem = JSON.parse(
    readFileSync(path.join(cfg.problemDir, 'problem.json'), 'utf8'),
  ) as GeneratedProblem;

  // The round's shape — everything below renders/enforces from THESE flags,
  // never from a format name (capabilities, not categories).
  const roundSpec = resolveRoundSpec(problem);
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
  const ideDataDir = ensureIdeDataDir(cfg.repoRoot);

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
  spawnSync('docker', ['rm', '-f', CONTAINER], { encoding: 'utf8' });
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
    'run', '-d', '--name', CONTAINER,
    '-p', `${cfg.idePort}:3000`,
    '--add-host=host.docker.internal:host-gateway',
    '-e', `IP_SESSION_ID=${cfg.sessionId}`,
    '-e', `IP_USER_ID=${cfg.userId}`,
    '-e', `IP_WS_URL=ws://host.docker.internal:${cfg.port}/trace`,
    '-e', `IP_TEST_CMD=${testCmd}`,
    // Kickoff run is the DEFAULT for failure-triggered rounds: the debugging
    // trigger must not depend on the candidate finding the status-bar button
    // (learned the hard way). Other check kinds start green or blank — an
    // opening wall of red is noise, not a trigger.
    ...(cfg.autorunTests && roundSpec.check.kind === 'one_failing_test' ? [] : ['-e', 'IP_AUTORUN_TESTS=0']),
    // No-run rounds and one-shot rounds both hide the Run Tests affordance:
    // in one case the suite is off-limits, in the other it is not an
    // iteration tool (it runs once, server-side, at submit).
    ...(caps.can_run_tests && caps.submit !== 'one_shot' ? [] : ['-e', 'IP_CAN_RUN_TESTS=0']),
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
    caps.submit === 'one_shot'
      ? 'The suite does NOT run during this round. It runs once, server-side, when they press Submit. There is no run command available to them — say so plainly if asked.'
      : !caps.can_run_tests
      ? 'This round does not allow running the suite at all. There is no run command — say so plainly if asked.'
      : `They press the **Run Tests** button in the session header (top right, above the editor). It runs \`${testCmd}\` in the workspace and shows the output in the ${surface === 'panes' ? 'test results panel below the editor' : "editor's Test Results panel"}. That is the intended path. No other test runner is installed.`;

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
  // The live extension socket, so the chrome's Run Tests button can reach
  // the IDE's own runner (see /api/ide-run).
  let traceSocket: WebSocket | null = null;
  // Doorbell to /events clients — assigned once the socket server exists;
  // a no-op until then so early turns just ride the poll.
  let notifyTurn: () => void = () => {};

  // ---- interviewer ----
  const { bug, bugFile } = bugContext(problem);
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
  const markCandidateContact = () => {
    if (sessionStartedAt === null) {
      sessionStartedAt = Date.now();
      lastInterviewerTs = sessionStartedAt;
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
              'The candidate just arrived. Open the round: greet, frame the task from the spec, say how it runs, invite them to begin.',
          }),
        );
      }
    }
  };
  let interviewerBusy = false;

  // Timed rounds: the spec's limit is BOTH the interviewer's countdown and a
  // hard cap; untimed rounds keep the nominal 45-minute pressure horizon
  // with no enforcement (exactly today's behavior).
  const sessionLengthMs = caps.time_limit_ms ?? SESSION_LENGTH_MS;
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
  const voiceOffReason: 'disabled' | 'no_key' | null =
    cfg.voice === false ? 'disabled' : elevenKey.length === 0 ? 'no_key' : null;
  const voiceEnabled = voiceOffReason === null;
  if (voiceOffReason === 'no_key') {
    console.warn(
      '[session] voice OFF — no ELEVENLABS_API_KEY (or IP_ELEVENLABS_KEY) in this process.\n' +
        '          The interviewer still runs, text-only. Put the key in .env at the repo\n' +
        '          root (auto-loaded) or export it before starting the app server — sessions\n' +
        '          inherit the APP server\'s environment, not your current shell.',
    );
  } else if (voiceOffReason === 'disabled') {
    console.log('[session] voice OFF — IP_VOICE=0 for this session');
  }
  const voice = voiceEnabled
    ? new VoiceRuntime(
        {
          apiKey: elevenKey,
          upstreamFactory: (url, headers) => new WebSocket(url, { headers }) as never,
        },
        {
          emitSensor: (sensor, state, reason) =>
            store.emitChrome('sensor', { sensor, state, reason }),
          emitUtterance: (text, speechStartTs) => {
            store.emitChrome(
              'utterance',
              { text, via: 'voice', ...(text ? {} : { untranscribed: true }), speech_start_ts: speechStartTs },
              speechStartTs, // stamped at SPEECH START, never transcript arrival
            );
            routeUtterance(text); // intent check; narration stays silent
          },
        },
      )
    : null;

  const pump = (): void => {
    if (ended || interviewerBusy) return;
    const merged = turnQueue.drain();
    if (merged !== null) void runInterviewer(merged);
  };

  const routeUtterance = (text: string): void => {
    if (!interviewer || !intentCheck || !text.trim() || ended) return;
    // Deterministic fast path: unambiguous asks and post-answer corrections
    // never touch the LLM gate — no model call, no latency, no chance of the
    // "narration" misread that dropped three real asks in one session.
    if (isExplicitAsk(text) || isCorrectionFollowUp(text, store.readAll(), Date.now())) {
      console.log(`[intent] fast-path ADDRESSED: ${text.slice(0, 80)}`);
      turnQueue.push(text);
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
      .then((addressed) => {
        // "Judged not-addressed" and "check crashed" must never look the
        // same in the log (first live session was undebuggable without this).
        console.log(`[intent] ${addressed ? 'ADDRESSED' : 'narration'}: ${text.slice(0, 80)}`);
        if (!addressed) return; // narration: traced, agent stays silent
        turnQueue.push(text);
        pump();
      })
      .catch((e) => {
        console.warn(`[intent] check FAILED (staying silent): ${String(e).slice(0, 120)}`);
      });
  };

  // Stuck-turn bookkeeping, keyed by the streak's start: a redacted hint is
  // retried on a later tick (silence costs nothing), but after two failed
  // compositions the episode is abandoned — a guard that keeps firing means
  // the model can't phrase this one safely, and pressure resumes.
  const stuckRedactions = new Map<number, number>();

  /** One interviewer turn. `null` message = unprompted (pressure or stuck). */
  const runInterviewer = async (
    candidateMessage: string | null,
    stuck: StuckState | null = null,
    moment: { kind: string; observation: string } | null = null,
  ): Promise<void> => {
    if (!interviewer || ended || interviewerBusy) return;
    interviewerBusy = true;
    try {
      const events = store.readAll();
      const now = Date.now();
      const turn = await interviewer({
        spec: problem.spec,
        bug,
        bugFile,
        howToRun,
        targetNote,
        elapsedMs: now - (sessionStartedAt ?? now),
        remainingMs: sessionLengthMs - (now - (sessionStartedAt ?? now)),
        recentActivity: renderActivity(events, now),
        transcript: events
          .filter((e) => e.type === 'utterance' || e.type === 'interviewer')
          .slice(-10)
          .map((e) => ({
            who: e.type === 'utterance' ? ('candidate' as const) : ('interviewer' as const),
            text: String((e.payload as { text?: string })?.text ?? ''),
          })),
        candidateMessage,
        // The scaffolding move (one step when stuck): the observation is
        // aliased by describeStuck — identity, never file names.
        stuckObservation: stuck ? describeStuck(stuck, now) : null,
        allowedExtra: problem.planted_bug?.failing_test ?? '',
        // The eyes: real diffs + test output, per turn. Cheap — reads only
        // the few recently-edited files.
        workspaceView: renderWorkspaceView(cfg.problemDir, events),
        bugFileVisited: candidateVisitedBugFile(events, bugFile),
        rubric: rubricText,
        engagement,
        momentObservation: moment ? moment.observation : null,
      });
      if (turn.redacted) {
        console.warn('[interviewer] leak guard fired — reply replaced');
        if (stuck && !turn.say) {
          const n = (stuckRedactions.get(stuck.since_ms) ?? 0) + 1;
          stuckRedactions.set(stuck.since_ms, n);
          console.warn(`[interviewer] stuck hint redacted (${n}/2 for this episode)`);
        }
      }
      if (!turn.say) {
        // Silence is a valid turn — but an UNEXPLAINED silence is how three
        // real asks vanished without a diagnosable trace. Name the cause:
        // model-silent carries the model's own reason; anything else here
        // means the parse failed or the call errored (logged upstream).
        console.log(
          `[interviewer] silent turn${candidateMessage !== null ? ' (was a reply!)' : ''}: ${turn.reason ?? '(no reason — parse failure or error, see warnings above)'}`,
        );
        return;
      }
      lastInterviewerTs = Date.now();
      store.emitChrome('interviewer', {
        text: turn.say,
        kind: turn.kind,
        nudge: turn.nudge,
        unprompted: candidateMessage === null,
        ...(turn.redacted ? { redacted: true } : {}),
        // Marked so replays can tell scaffolding from pressure — this is
        // how the K=3 threshold gets tuned from real sessions.
        ...(stuck ? { stuck: true } : {}),
      });
      notifyTurn();
    } catch (e) {
      console.warn('[interviewer] turn failed:', String(e));
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
    voice?.close();

    // One-shot rounds are graded HERE, server-side: the suite runs once, at
    // submit, via docker exec — the extension's Run button never existed for
    // this round, so there is no other path to a test_run in the trace.
    if (caps.submit === 'one_shot') {
      console.log('[session] one-shot submit — running the grading suite');
      const t0 = Date.now();
      const run = spawnSync(
        'docker',
        ['exec', CONTAINER, 'bash', '-lc', `cd ${workspacePath} && ${testCmd}`],
        { encoding: 'utf8', timeout: 180_000 },
      );
      const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.slice(-4_000);
      store.emitChrome('test_run', {
        via: 'submit',
        exit_code: run.status,
        duration_ms: Date.now() - t0,
        summary: summarizeTail(tail),
        output_tail: tail,
      });
    }

    store.emitChrome('session_end', {});
    const events: TraceEvent[] = store.readAll();

    // The judge IS the feedback (2026-07-30 design). Blind to the gap graph;
    // knows the planted bug; failure yields UNASSESSED, never a verdict.
    const result = await judgeSession({
      sessionId: cfg.sessionId,
      events,
      problem,
      templatePath: path.join(cfg.repoRoot, 'prompts', 'judge-session.md'),
    });

    mkdirSync(path.join(cfg.repoRoot, 'assessments'), { recursive: true });
    writeFileSync(
      path.join(cfg.repoRoot, 'assessments', `${cfg.sessionId}.json`),
      JSON.stringify(result, null, 2),
    );

    let gapStore = loadStore(gapsDir, cfg.userId);
    if (result.status === 'assessed') {
      // Unassessed writes NOTHING — a judge failure must not become history.
      const spec = resolveRoundSpec(problem);
      gapStore = recordAssessment(gapStore, result, spec.label, spec.memory_tags);
      saveStore(gapsDir, gapStore);
    }

    const view = buildGraphView(gapStore, cfg.sessionId);
    const card = buildAssessmentCard(result, view, events, problem.planted_bug?.description);
    mkdirSync(path.join(cfg.repoRoot, 'feedback'), { recursive: true });
    writeFileSync(
      path.join(cfg.repoRoot, 'feedback', `${cfg.sessionId}.json`),
      JSON.stringify(
        {
          card,
          view,
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
          env: { ...process.env, IP_TARGET_NOTE: note ?? '', IP_USER_ID: cfg.userId },
        },
      );
      child.unref();
      console.log(`[session] preparing next problem in background${note ? ' (targeted)' : ''}`);
    }

    return card;
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
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
    if (url === '/api/utterance' && req.method === 'POST') {
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
        JSON.stringify({ messages, heard, thinking: interviewerBusy, time_up: timeUpAt !== null }),
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
      if (body.dimension) confirms[body.dimension] = Boolean(body.agree);
      mkdirSync(path.join(cfg.repoRoot, 'assessments'), { recursive: true });
      writeFileSync(file, JSON.stringify(confirms, null, 2));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
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
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ files: listWorkspaceFiles(cfg.problemDir) }));
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
      const child = spawn('docker', ['exec', CONTAINER, 'bash', '-lc', `cd ${workspacePath} && ${testCmd}`]);
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
        // Teardown race: if the session ended mid-run, docker rm killed the
        // exec — a post-session_end test_run would corrupt the trace's story.
        if (!ended) {
          store.emitChrome('test_run', {
            via: 'panes',
            exit_code: code,
            duration_ms: Date.now() - t0,
            summary,
            output_tail: tail,
          });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ exit_code: code, summary, tail }));
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
        return res.end(injectWorkbenchDefaults(html, ideSettings));
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
    if (req.url === '/trace') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (req.url === '/voice') {
      voiceWss.handleUpgrade(req, socket, head, (ws) => voiceWss.emit('connection', ws, req));
    } else if (req.url === '/events') {
      eventsWss.handleUpgrade(req, socket, head, (ws) => eventsWss.emit('connection', ws, req));
    } else {
      proxy.ws(req, socket, head);
    }
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
  // Unprompted turns. Only once the round is genuinely underway — before
  // the first failing run there is nothing to say. When the stuck detector
  // fires, the unprompted turn IS the scaffolding move instead of a pressure
  // beat (decision D3): one voice at a time, same 4-minute floor. Pressure
  // aimed at someone already grinding produces flailing, not progress.
  if (interviewer) {
    pressureTimer = setInterval(() => {
      if (ended || interviewerBusy || sessionStartedAt === null) return;
      const events = store.readAll();
      if (!hasFailingRun(events)) return;
      const sinceTurn = Date.now() - lastInterviewerTs;
      // Priority: stuck/pressure (4-min floor) over moments (2-min floor).
      // Stuck is help; a moment is engagement; pressure is the metronome —
      // help beats engagement beats rhythm.
      if (sinceTurn >= PRESSURE_INTERVAL_MS) {
        const stuck = detectStuck(events, Date.now(), sessionStartedAt);
        const episodeSpent = stuck ? (stuckRedactions.get(stuck.since_ms) ?? 0) >= 2 : false;
        void runInterviewer(null, stuck && !episodeSpent ? stuck : null);
        return;
      }
      if (sinceTurn >= MOMENT_INTERVAL_MS) {
        // Event-anchored probes: the first failure read, the first fix that
        // ran, the pass after a struggle. Each fires ONCE — marked before
        // dispatch so even a guard-silenced turn never re-fires it.
        const moment = detectMoment(events, roundSpec.check.kind, firedMoments, Date.now());
        if (moment) {
          firedMoments.add(moment.kind);
          console.log(`[moment] ${moment.kind}`);
          void runInterviewer(null, null, moment);
        }
      }
    }, PRESSURE_TICK_MS);
    pressureTimer.unref();

    // Listening signals between substantive turns. The candidate once asked
    // "can you hear me?" four times at a working mic because silence was the
    // interviewer's only other state — acks are canned, content-free, and
    // deliberately do NOT touch lastInterviewerTs, so they never delay or
    // replace a real turn.
    ackTimer = setInterval(() => {
      if (ended || interviewerBusy || sessionStartedAt === null || timeUpAt !== null) return;
      const events = store.readAll();
      if (!hasFailingRun(events)) return; // same "genuinely underway" gate as pressure
      if (Date.now() - lastInterviewerTs >= PRESSURE_INTERVAL_MS) return; // a real turn is due — let it speak
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
    let warned = false;
    capTimer = setInterval(() => {
      if (ended || sessionStartedAt === null) return;
      const elapsed = Date.now() - sessionStartedAt;
      if (!warned && elapsed >= sessionLengthMs * 0.8) {
        warned = true;
        const left = Math.max(1, Math.round((sessionLengthMs - elapsed) / 60_000));
        store.emitChrome('interviewer', {
          text: `${left} minute${left === 1 ? '' : 's'} remaining.`,
          kind: 'time',
          nudge: false,
        });
        notifyTurn();
      }
      if (elapsed >= sessionLengthMs && timeUpAt === null) {
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
        void finalize().catch((e) => console.error('[session] cap finalize failed:', e));
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
