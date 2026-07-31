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
import { isFailingRun } from '@interview-prep/shared';
import { judgeSession } from './judge.js';
import { buildAssessmentCard } from './feedback.js';
import { buildGraphView, buildTargetNote, loadStore, recordAssessment, saveStore } from './gap-graph.js';
import { clientScript, sessionPage } from './chrome.js';
import { TraceStore } from './trace-store.js';
import {
  TurnQueue,
  bugContext,
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
const PRESSURE_TICK_MS = 30_000;

const IDE_IMAGE = 'gitpod/openvscode-server:latest';
const CONTAINER = 'ip-session';
const BUNDLED_NODE = '/home/.openvscode-server/node';

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
 * The IDE image ships node and nothing else. A problem declaring another
 * runtime gets it installed into the running container as root before the
 * candidate can reach the Run Tests button — if this fails, the round has
 * no trigger at all and the whole session is unassessable, so it throws
 * rather than letting the session start broken.
 */
function ensureRuntime(runtime: 'node' | 'python'): void {
  if (runtime === 'node') return;
  console.log(`[session] installing ${runtime} runtime in the container...`);
  const res = spawnSync(
    'docker',
    ['exec', '-u', '0', CONTAINER, 'bash', '-lc',
     'apt-get update -qq && apt-get install -y -qq python3'],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`could not install ${runtime} in the container: ${res.stderr?.slice(0, 300)}`);
  }
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
function ensureIdeDataDir(repoRoot: string): string {
  const dataDir = path.join(repoRoot, '.ide-data');
  const userDir = path.join(dataDir, 'User');
  const machineDir = path.join(dataDir, 'Machine');
  mkdirSync(userDir, { recursive: true });
  mkdirSync(machineDir, { recursive: true });
  const settings = JSON.parse(
    readFileSync(path.join(repoRoot, 'server', 'ide-settings.json'), 'utf8'),
  ) as Record<string, unknown>;
  for (const k of Object.keys(settings)) if (k.startsWith('//')) delete settings[k];
  const body = JSON.stringify(settings, null, 2);
  // KNOWN ISSUE: neither scope currently reaches the workbench UI — VS Code
  // Web reads workbench settings from browser IndexedDB. Verified failing on
  // clean browser state for User/, Machine/, and product.json
  // configurationDefaults. See server/ide-settings.json for the full note and
  // the remaining fix (pre-boot injection through our proxy). Kept because
  // this dir also gives us logs/workspaceStorage at a known path.
  writeFileSync(path.join(userDir, 'settings.json'), body);
  writeFileSync(path.join(machineDir, 'settings.json'), body);
  return dataDir;
}

/** The debugging trigger: a test run that actually failed (shared predicate). */
function hasFailingRun(events: TraceEvent[]): boolean {
  return events.some(isFailingRun);
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

  const runtime = problem.runtime ?? 'node';
  if (runtime === 'node') ensureLinuxDeps(cfg.problemDir);
  const extDist = ensureExtensionBuilt(cfg.repoRoot);
  const ideDataDir = ensureIdeDataDir(cfg.repoRoot);

  const tracesDir = path.join(cfg.repoRoot, 'traces');
  const gapsDir = path.join(cfg.repoRoot, 'gaps');
  const store = new TraceStore(tracesDir, cfg.sessionId, cfg.userId);

  // ---- IDE container ----
  spawnSync('docker', ['rm', '-f', CONTAINER], { encoding: 'utf8' });
  // The problem declares how its tests run; the vitest default keeps every
  // manifest written before `test_command` existed working unchanged.
  const testCmd =
    problem.test_command ??
    `${BUNDLED_NODE} /home/workspace/problem/node_modules/vitest/vitest.mjs run`;
  sh('docker', [
    'run', '-d', '--name', CONTAINER,
    '-p', `${cfg.idePort}:3000`,
    '--add-host=host.docker.internal:host-gateway',
    '-e', `IP_SESSION_ID=${cfg.sessionId}`,
    '-e', `IP_USER_ID=${cfg.userId}`,
    '-e', `IP_WS_URL=ws://host.docker.internal:${cfg.port}/trace`,
    '-e', `IP_TEST_CMD=${testCmd}`,
    // Kickoff run is the DEFAULT: the debugging trigger must not depend on
    // the candidate finding the status-bar button (learned the hard way).
    ...(cfg.autorunTests ? [] : ['-e', 'IP_AUTORUN_TESTS=0']),
    '-v', `${extDist}:/ext`,
    '-v', `${ideDataDir}:/ipdata`,
    '-v', `${cfg.problemDir}:/home/workspace/problem`,
    IDE_IMAGE,
    '--without-connection-token', '--host', '0.0.0.0',
    '--extensions-dir', '/ext',
    '--user-data-dir', '/ipdata',
  ]);
  ensureRuntime(runtime);

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

  // ---- interviewer ----
  const { bug, bugFile } = bugContext(problem);
  const interviewer =
    cfg.interviewer === undefined
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
    }
  };
  let interviewerBusy = false;

  // ---- intent routing (OUTSIDE the busy lock — eng review issue 1) ----
  // Every utterance is classified the moment it lands; only ADDRESSED ones
  // queue for a reply. Narration never contends for the lock, and a question
  // asked while the agent is mid-turn waits instead of vanishing.
  const intentCheck: IntentCheck | null =
    cfg.intentCheck === undefined ? pickIntentCheck() : cfg.intentCheck;
  const turnQueue = new TurnQueue(2);

  // ---- voice (IP_VOICE flag + key present, else text-only) ----
  const elevenKey = process.env.ELEVENLABS_API_KEY ?? process.env.IP_ELEVENLABS_KEY ?? '';
  const voiceEnabled = (cfg.voice ?? true) && elevenKey.length > 0;
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

  /** One interviewer turn. `null` message = unprompted pressure beat. */
  const runInterviewer = async (candidateMessage: string | null): Promise<void> => {
    if (!interviewer || ended || interviewerBusy) return;
    interviewerBusy = true;
    try {
      const events = store.readAll();
      const now = Date.now();
      const turn = await interviewer({
        spec: problem.spec,
        bug,
        bugFile,
        targetNote,
        elapsedMs: now - (sessionStartedAt ?? now),
        remainingMs: SESSION_LENGTH_MS - (now - (sessionStartedAt ?? now)),
        recentActivity: renderActivity(events, now),
        transcript: events
          .filter((e) => e.type === 'utterance' || e.type === 'interviewer')
          .slice(-10)
          .map((e) => ({
            who: e.type === 'utterance' ? ('candidate' as const) : ('interviewer' as const),
            text: String((e.payload as { text?: string })?.text ?? ''),
          })),
        candidateMessage,
      });
      if (turn.redacted) {
        console.warn('[interviewer] leak guard fired — reply replaced');
      }
      if (!turn.say) return; // silence is a valid turn; nothing to record
      lastInterviewerTs = Date.now();
      store.emitChrome('interviewer', {
        text: turn.say,
        kind: turn.kind,
        nudge: turn.nudge,
        unprompted: candidateMessage === null,
        ...(turn.redacted ? { redacted: true } : {}),
      });
    } catch (e) {
      console.warn('[interviewer] turn failed:', String(e));
    } finally {
      interviewerBusy = false;
      // A question may have stacked while this turn was composing.
      pump();
    }
  };

  let pressureTimer: NodeJS.Timeout | null = null;

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => resolve(b));
    });

  const finalize = async (): Promise<unknown> => {
    if (pressureTimer) clearInterval(pressureTimer);
    voice?.close();
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
      gapStore = recordAssessment(gapStore, result, problem.round_type);
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
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(sessionPage(cfg.sessionId));
    }
    if (url.startsWith('/client/')) {
      const name = path.basename(url); // no traversal: basename only
      const body = clientScript(name);
      if (body === null) {
        res.writeHead(404);
        return res.end('no such client file');
      }
      res.writeHead(200, { 'content-type': 'text/javascript' });
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
          counts,
          trigger_armed: hasFailingRun(events),
          voice: voice
            ? { enabled: true, budget: voice.budget.state(), health: voice.health }
            : { enabled: false },
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
      return res.end(JSON.stringify({ messages, heard, thinking: interviewerBusy }));
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
    if (url === '/api/end' && req.method === 'POST') {
      if (ended) {
        res.writeHead(409);
        return res.end('already ended');
      }
      ended = true;
      try {
        const card = await finalize();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(card));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: String(e) }));
      }
    }
    proxy.web(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
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

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/trace') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (req.url === '/voice') {
      voiceWss.handleUpgrade(req, socket, head, (ws) => voiceWss.emit('connection', ws, req));
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
  // Unprompted pressure beats. Only once the round is genuinely underway —
  // before the first failing run there is nothing to apply pressure about.
  if (interviewer) {
    pressureTimer = setInterval(() => {
      if (ended || interviewerBusy || sessionStartedAt === null) return;
      if (!hasFailingRun(store.readAll())) return;
      if (Date.now() - lastInterviewerTs < PRESSURE_INTERVAL_MS) return;
      void runInterviewer(null);
    }, PRESSURE_TICK_MS);
    pressureTimer.unref();
  }

  console.log(`[session] ${cfg.sessionId}`);
  console.log(`[session] open   http://localhost:${cfg.port}/session`);
  console.log('[session] Ctrl+C tears down the container');

  const teardown = () => {
    spawnSync('docker', ['rm', '-f', CONTAINER], { encoding: 'utf8' });
    process.exit(0);
  };
  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);
}
