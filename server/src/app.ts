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
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRoundSpec, type RoundSpec } from '@interview-prep/shared';
import { listTargets, loadTarget, pickSpecInferrer, saveTarget, slugify, targetDir, type SpecDraft, type Target } from './intake.js';
import { loadQueue, nextUp, proposeQueue, reconcileWithDisk, repace, saveQueue, type Queue } from './queue.js';
import { buildGraphView, loadStore } from './gap-graph.js';
import { clientScript } from './chrome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export interface AppConfig {
  port: number;
  sessionPort: number;
  userId: string;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => resolve(body));
  });
}

/** Is a session process currently serving? Probed, never remembered. */
function sessionLive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1_000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => {
      r.destroy();
      resolve(false);
    });
  });
}

function spawnDetached(args: string[], env: Record<string, string> = {}): void {
  const child = spawn('npx', ['tsx', path.join(repoRoot, 'server', 'src', 'cli.ts'), ...args], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
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
  const fresh = repace(reconcileWithDisk(repoRoot, stored), target, view, now);

  const inFlight = fresh.items.some((i) => i.status === 'generating' || i.status === 'ready');
  const pending = fresh.items.find((i) => i.status === 'pending');
  if (!inFlight && pending) {
    const dir = path.join(targetDir(repoRoot, target.id), 'problems', pending.id);
    pending.status = 'generating';
    pending.problem_dir = dir;
    console.log(`[app] generating ${target.id}/${pending.id} (queue-driven)`);
    spawnDetached(['generate-for', target.id, pending.spec_id, '--into', dir]);
  }

  if (JSON.stringify(fresh) !== JSON.stringify(stored)) saveQueue(repoRoot, fresh);
  return fresh;
}

export function appPage(): string {
  return /* html */ `<!doctype html>
<meta charset="utf-8" />
<title>interview prep</title>
<style>
  :root { --accent: #7c5cff; --line: #2a2a2e; --dim: #9a9aa2; }
  * { box-sizing: border-box; }
  body { margin: 0 auto; max-width: 760px; padding: 24px 16px; font: 13px/1.5 ui-monospace, monospace; background: #17171a; color: #e6e6ea; }
  h1 { font-size: 13px; font-weight: normal; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
  h2 { font-size: 13px; font-weight: normal; margin: 0; }
  .target { border: 1px solid var(--line); padding: 14px; margin: 14px 0; }
  .meta { color: var(--dim); }
  .item { display: flex; gap: 10px; padding: 6px 0; border-top: 1px solid var(--line); align-items: baseline; }
  .item .st { width: 88px; color: var(--dim); }
  .item.ready .st { color: var(--accent); }
  .item.done .st { color: #4caf7d; }
  .item .note { color: var(--accent); }
  button { background: none; border: 1px solid var(--line); color: #e6e6ea; padding: 4px 10px; font: inherit; cursor: pointer; }
  button.primary { border-color: var(--accent); }
  button:disabled { opacity: .5; cursor: default; }
  input, textarea { width: 100%; background: none; border: 1px solid var(--line); color: inherit; font: inherit; padding: 6px 8px; margin: 4px 0; }
  textarea { min-height: 70px; }
  #newform, #inferbox { border: 1px solid var(--line); padding: 14px; margin: 14px 0; }
  .rationale { color: var(--dim); white-space: pre-wrap; }
  .specbox { border: 1px solid var(--line); padding: 10px; margin: 8px 0; }
  .err { color: #e6a23c; }
  .banner { border: 1px solid var(--accent); padding: 10px 14px; margin: 14px 0; }
</style>
<h1>interview prep — your season</h1>
<div id="banner"></div>
<div id="targets"><p class="meta">loading…</p></div>
<div id="newform">
  <h2>new target</h2>
  <p class="meta">What are you interviewing for? Finding out what the round looks like is part of the prep — recruiter emails, Blind/LeetCode threads, anything you've got.</p>
  <input id="nt-label" placeholder="label — e.g. Palantir SWE (new grad)" />
  <input id="nt-date" placeholder="interview date YYYY-MM-DD (optional)" />
  <textarea id="nt-desc" placeholder="describe the round(s): format, length, what the recruiter said…"></textarea>
  <textarea id="nt-context" placeholder="paste reference material (optional): a found question, an email, notes from someone who sat it"></textarea>
  <button id="nt-add" class="primary">add target</button>
  <p class="err" id="nt-err"></p>
</div>
<div id="inferbox" style="display:none"></div>
<script src="/client/app.js"></script>
`;
}

export function runApp(cfg: AppConfig): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(appPage());
      }
      if (url.startsWith('/client/')) {
        const body = clientScript(path.basename(url));
        if (body === null) {
          res.writeHead(404);
          return res.end('no such client file');
        }
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(body);
      }
      if (url === '/api/state') {
        const now = Date.now();
        const live = await sessionLive(cfg.sessionPort);
        const targets = listTargets(repoRoot).map((t) => {
          const queue = refreshQueue(t, cfg.userId, now);
          return {
            target: { id: t.id, label: t.label, interview_date: t.interview_date ?? null, specs: t.specs.map((s) => ({ id: s.id, label: s.label })) },
            queue,
            next: queue ? nextUp(queue) : null,
          };
        });
        return json(200, { targets, session_live: live, session_url: `http://localhost:${cfg.sessionPort}/session` });
      }
      if (url === '/api/target' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { label?: string; date?: string; description?: string; context?: string };
        if (!b.label?.trim()) return json(400, { error: 'label required' });
        const t: Target = {
          id: `${slugify(b.label)}-${Date.now().toString(36)}`,
          label: b.label.trim(),
          ...(b.date?.trim() ? { interview_date: b.date.trim() } : {}),
          description: b.description?.trim() ?? '',
          ...(b.context?.trim() ? { context: b.context.trim() } : {}),
          specs: [],
          created: new Date().toISOString(),
        };
        saveTarget(repoRoot, t);
        return json(200, { id: t.id });
      }
      if (url === '/api/infer' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; description?: string };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (!t) return json(404, { error: 'no such target' });
        const description = b.description?.trim() || t.description;
        if (!description) return json(400, { error: 'describe the round first' });
        const infer = pickSpecInferrer(path.join(repoRoot, 'prompts', 'infer-round-spec.md'));
        const context = [t.context, t.research?.confirmed ? t.research.summary : ''].filter(Boolean).join('\n\n');
        try {
          const draft = await infer(description, context);
          return json(200, draft);
        } catch (e) {
          return json(502, { error: `inference failed: ${String(e).slice(0, 300)}` });
        }
      }
      if (url === '/api/accept-spec' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; spec?: RoundSpec };
        const t = b.target_id ? loadTarget(repoRoot, b.target_id) : null;
        if (!t || !b.spec) return json(400, { error: 'target_id and spec required' });
        // The confirm gate re-proves the vocabulary server-side — the client
        // may have let the user edit the draft.
        const failures = validateRoundSpec(b.spec);
        if (failures.length > 0) return json(400, { error: failures.join('; ') });
        t.specs = [...t.specs.filter((s) => s.id !== b.spec!.id), b.spec];
        saveTarget(repoRoot, t);
        if (!loadQueue(repoRoot, t.id)) saveQueue(repoRoot, proposeQueue(t, Date.now()));
        return json(200, { ok: true, specs: t.specs.map((s) => s.id) });
      }
      if (url === '/api/skip' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const q = b.target_id ? loadQueue(repoRoot, b.target_id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!q || !item) return json(404, { error: 'no such item' });
        item.status = 'skipped';
        saveQueue(repoRoot, q);
        return json(200, { ok: true });
      }
      if (url === '/api/launch' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { target_id?: string; item_id?: string };
        const q = b.target_id ? loadQueue(repoRoot, b.target_id) : null;
        const item = q?.items.find((i) => i.id === b.item_id);
        if (!q || !item?.problem_dir || item.status !== 'ready') {
          return json(400, { error: 'item is not ready' });
        }
        if (await sessionLive(cfg.sessionPort)) {
          return json(409, { error: 'a session is already running — finish or end it first' });
        }
        const sessionId = `sess-${Date.now()}`;
        // IP_PREPARE_NEXT=0: the queue drives generation now; the legacy
        // post-session prepare would write into the generic pool nobody is
        // drawing from in queue mode.
        spawnDetached(['session', item.problem_dir], {
          IP_SESSION_ID: sessionId,
          IP_USER_ID: cfg.userId,
          IP_PREPARE_NEXT: '0',
        });
        return json(200, { session_id: sessionId, url: `http://localhost:${cfg.sessionPort}/session` });
      }
      if (url === '/api/session-live') {
        return json(200, { live: await sessionLive(cfg.sessionPort) });
      }
      res.writeHead(404);
      return res.end('not found');
    } catch (e) {
      return json(500, { error: String(e).slice(0, 300) });
    }
  });
  server.listen(cfg.port, () => {
    console.log(`[app] open http://localhost:${cfg.port}/`);
  });
  return server;
}
