/**
 * Trace-emitter extension — the production replacement for spike code.
 *
 *   editor activity ──► DurableEmitter (append-only file + ws ship w/ acks)
 *
 * Spike findings baked in:
 *   - untrustedWorkspaces declared in the manifest, or Workspace Trust
 *     silently disables us whenever a folder is open (spike 3).
 *   - Test runs are SPAWNED by the extension, never the tasks API: headless
 *     openvscode-server has no pty host, so executeTask no-ops silently.
 *   - "Run Tests" is a first-class product action (status bar + command).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { FileSavePayload, GeneratedProblem, TestRunPayload } from '@interview-prep/shared';
import { INACTIVITY_THRESHOLD_MS } from '@interview-prep/shared';
import { DurableEmitter } from './durable-log.js';

const IGNORED = ['/node_modules/', '/.git/', '/.trace/'];

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*');
  return new RegExp(`(^|/)${escaped}$`);
}

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];

  const emitter = new DurableEmitter({
    dir: process.env.IP_TRACE_DIR ?? '/tmp/ip-trace',
    sessionId: process.env.IP_SESSION_ID ?? `local-${Date.now()}`,
    userId: process.env.IP_USER_ID ?? 'u1',
    source: 'extension',
    wsUrl: process.env.IP_WS_URL ?? 'ws://host.docker.internal:3400/trace',
  });
  context.subscriptions.push({ dispose: () => emitter.close() });

  // Problem manifest (model paths + test command) travels WITH the problem.
  let problem: GeneratedProblem | null = null;
  if (folder) {
    const manifest = path.join(folder.uri.fsPath, 'problem.json');
    if (existsSync(manifest)) {
      try {
        problem = JSON.parse(readFileSync(manifest, 'utf8')) as GeneratedProblem;
      } catch {
        /* a broken manifest must not kill the emitter */
      }
    }
  }
  const modelPathPatterns = (problem?.model_paths ?? []).map(globToRegExp);

  emitter.emit('session_start', {
    workspace: folder?.uri.path ?? null,
    node: process.version,
    remote: vscode.env.remoteName ?? null,
    round_type: problem?.round_type ?? null,
  });

  // ---- activity + pause detection (operational definition: 20s silence) ----
  let lastActivity = Date.now();
  let pauseEmitted = false;
  const touch = () => {
    lastActivity = Date.now();
    pauseEmitted = false;
  };
  const pauseTimer = setInterval(() => {
    const silence = Date.now() - lastActivity;
    if (!pauseEmitted && silence >= INACTIVITY_THRESHOLD_MS) {
      pauseEmitted = true;
      emitter.emit('pause', { since_ts: lastActivity, silence_ms: silence });
    }
  }, 5_000);
  context.subscriptions.push({ dispose: () => clearInterval(pauseTimer) });

  const relevant = (uri: vscode.Uri): boolean =>
    uri.scheme === 'file' && !IGNORED.some((p) => uri.path.includes(p));

  // ---- editor events ----
  // Edits coalesce per document over a 1s window for transport economy;
  // ordering is preserved because coalescing only merges CONSECUTIVE changes
  // to the SAME document (2A: classifier-grade, ~1s precision is fine).
  const editBuffer = new Map<string, { changes: number; timer: NodeJS.Timeout }>();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!relevant(e.document.uri) || e.contentChanges.length === 0) return;
      touch();
      const key = e.document.uri.path;
      const buf = editBuffer.get(key);
      if (buf) {
        buf.changes += e.contentChanges.length;
        return;
      }
      const timer = setTimeout(() => {
        const b = editBuffer.get(key);
        editBuffer.delete(key);
        emitter.emit('edit', { path: key, changes: b?.changes ?? 1 });
      }, 1_000);
      editBuffer.set(key, { changes: e.contentChanges.length, timer });
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!relevant(doc.uri)) return;
      touch();
      emitter.emit('file_open', { path: doc.uri.path });
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!relevant(doc.uri)) return;
      touch();
      const rel = folder ? path.relative(folder.uri.fsPath, doc.uri.fsPath) : doc.uri.path;
      const payload: FileSavePayload = {
        path: doc.uri.path,
        is_model_path: modelPathPatterns.some((re) => re.test(rel)),
      };
      emitter.emit('file_save', payload);
    }),
  );

  // ---- test runs: spawned, observed, first-class ----
  let running = false;
  const runTests = () => {
    if (running || !folder) return;
    const cmdline = process.env.IP_TEST_CMD ?? 'npm test';
    const [bin, ...args] = cmdline.split(' ');
    if (!bin) return;
    running = true;
    touch();
    statusItem.text = '$(sync~spin) Tests running…';
    const t0 = Date.now();
    const child = spawn(bin, args, { cwd: folder.uri.fsPath });
    let tail = '';
    const keepTail = (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4_000);
    };
    child.stdout.on('data', keepTail);
    child.stderr.on('data', keepTail);
    child.on('close', (code) => {
      running = false;
      const payload: TestRunPayload = {
        via: 'task',
        exit_code: code,
        duration_ms: Date.now() - t0,
      };
      emitter.emit('test_run', { ...payload, summary: (tail.match(/Tests.*$/m) ?? [''])[0] });
      statusItem.text = code === 0 ? '$(check) Tests passed — Run again' : '$(x) Tests failed — Run again';
      vscode.window.setStatusBarMessage(code === 0 ? 'Tests passed' : 'Tests failed', 4_000);
    });
    child.on('error', (err) => {
      running = false;
      statusItem.text = '$(beaker) Run Tests';
      emitter.emit('test_run', { via: 'task', exit_code: null, duration_ms: Date.now() - t0, error: String(err) });
    });
  };

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1_000);
  statusItem.text = '$(beaker) Run Tests';
  statusItem.command = 'interviewPrep.runTests';
  statusItem.show();
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('interviewPrep.runTests', runTests),
  );

  // Headless smoke path: lets the E2E script exercise the full loop without
  // clicking the status bar.
  if (process.env.IP_AUTORUN_TESTS === '1') setTimeout(runTests, 3_000);
}

export function deactivate(): void {
  /* emitter closed via subscriptions */
}
