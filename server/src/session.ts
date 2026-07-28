/**
 * Session runtime — the one process that runs a live session.
 *
 *   browser ──► :3200 ── /session            chrome page
 *                     ├─ /api/utterance      chrome-source trace events
 *                     ├─ /api/end            classify → gap graph → feedback
 *                     ├─ /trace (ws)         emitter ingest (ack per event)
 *                     └─ everything else ──► openvscode-server :3100
 *                                            (root-namespace partition, spike 1)
 *
 * The chrome is backend-driven only: it never reads editor state from the
 * iframe (eng review architecture rule).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import httpProxy from 'http-proxy';
import { WebSocketServer } from 'ws';
import type { GeneratedProblem, TraceEvent } from '@interview-prep/shared';
import { classify } from './classifier.js';
import { claudeJudge } from './llm-judge.js';
import { buildFeedback } from './feedback.js';
import { buildGraphView, loadStore, recordSession, saveStore } from './gap-graph.js';
import { sessionPage } from './chrome.js';
import { TraceStore } from './trace-store.js';

export interface SessionConfig {
  repoRoot: string;
  problemDir: string;
  sessionId: string;
  userId: string;
  port: number;
  idePort: number;
  autorunTests: boolean;
}

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
 * natives (rollup/esbuild). Marker file keeps this idempotent. */
function ensureLinuxDeps(problemDir: string): void {
  const marker = path.join(problemDir, '.linux-deps-ok');
  if (existsSync(marker)) return;
  console.log('[session] installing linux-native deps for the container...');
  sh('docker', ['run', '--rm', '-v', `${problemDir}:/app`, '-w', '/app', 'node:22-slim',
    'npm', 'install', '--no-fund', '--no-audit']);
  writeFileSync(marker, String(Date.now()));
}

function ensureExtensionBuilt(repoRoot: string): string {
  const dist = path.join(repoRoot, 'extension', 'dist');
  if (!existsSync(path.join(dist, 'trace-emitter-0.0.1', 'extension.js'))) {
    console.log('[session] building extension...');
    sh('node', ['build.mjs'], { cwd: path.join(repoRoot, 'extension') });
  }
  return dist;
}

export async function runSession(cfg: SessionConfig): Promise<void> {
  const problem = JSON.parse(
    readFileSync(path.join(cfg.problemDir, 'problem.json'), 'utf8'),
  ) as GeneratedProblem;

  ensureLinuxDeps(cfg.problemDir);
  const extDist = ensureExtensionBuilt(cfg.repoRoot);

  const tracesDir = path.join(cfg.repoRoot, 'traces');
  const gapsDir = path.join(cfg.repoRoot, 'gaps');
  const store = new TraceStore(tracesDir, cfg.sessionId, cfg.userId);

  // ---- IDE container ----
  spawnSync('docker', ['rm', '-f', CONTAINER], { encoding: 'utf8' });
  const testCmd = `${BUNDLED_NODE} /home/workspace/problem/node_modules/vitest/vitest.mjs run`;
  sh('docker', [
    'run', '-d', '--name', CONTAINER,
    '-p', `${cfg.idePort}:3000`,
    '--add-host=host.docker.internal:host-gateway',
    '-e', `IP_SESSION_ID=${cfg.sessionId}`,
    '-e', `IP_USER_ID=${cfg.userId}`,
    '-e', `IP_WS_URL=ws://host.docker.internal:${cfg.port}/trace`,
    '-e', `IP_TEST_CMD=${testCmd}`,
    ...(cfg.autorunTests ? ['-e', 'IP_AUTORUN_TESTS=1'] : []),
    '-v', `${extDist}:/ext`,
    '-v', `${cfg.problemDir}:/home/workspace/problem`,
    IDE_IMAGE,
    '--without-connection-token', '--host', '0.0.0.0', '--extensions-dir', '/ext',
  ]);

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
  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => resolve(b));
    });

  const finalize = async (): Promise<unknown> => {
    store.emitChrome('session_end', {});
    const events: TraceEvent[] = store.readAll();
    const classification = await classify(events, problem.rubric, problem.spec, claudeJudge);

    let gapStore = loadStore(gapsDir, cfg.userId);
    gapStore = recordSession(
      gapStore,
      {
        session_id: cfg.sessionId,
        ts: Date.now(),
        round_type: problem.round_type,
        trigger_occurred: classification.trigger_occurred,
        labels_fired: classification.labels.map((l) => l.label),
      },
      Object.fromEntries(classification.labels.map((l) => [l.label, l.evidence])),
    );
    saveStore(gapsDir, gapStore);

    const view = buildGraphView(gapStore, cfg.sessionId);
    const card = buildFeedback(cfg.sessionId, classification, view);
    mkdirSync(path.join(cfg.repoRoot, 'feedback'), { recursive: true });
    writeFileSync(
      path.join(cfg.repoRoot, 'feedback', `${cfg.sessionId}.json`),
      JSON.stringify({ card, classification, view }, null, 2),
    );
    return card;
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (url === '/session') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(sessionPage(cfg.sessionId));
    }
    if (url === '/api/utterance' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { text?: string };
      const ev = store.emitChrome('utterance', { text: body.text ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ seq: ev.seq }));
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
        store.ingest(ev);
        ws.send(JSON.stringify({ ack: { seq: ev.seq } }));
      } catch {
        /* malformed frame */
      }
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/trace') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      proxy.ws(req, socket, head);
    }
  });

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
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
