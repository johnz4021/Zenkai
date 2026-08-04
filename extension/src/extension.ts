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
import { isTestCommand } from '@interview-prep/shared';
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

  // NOTE deliberately absent: pause/inactivity detection. This extension once
  // owned a 20s-without-keystrokes timer and emitted `pause` VERDICTS — which
  // scored a candidate narrating out loud (or typing into the chat panel,
  // which never reaches this process) as silence. The server derives
  // inactivity from gaps in the merged trace across ALL sources
  // (server/src/classifier.ts computeInactivity). This extension reports
  // facts only; it never interprets them.

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
      emitter.emit('file_open', { path: doc.uri.path });
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!relevant(doc.uri)) return;
      const rel = folder ? path.relative(folder.uri.fsPath, doc.uri.fsPath) : doc.uri.path;
      const payload: FileSavePayload = {
        path: doc.uri.path,
        is_model_path: modelPathPatterns.some((re) => re.test(rel)),
      };
      emitter.emit('file_save', payload);
    }),
  );

  // ---- terminal test runs: the half of verification we used to miss ----
  // A replay over 19 real traces found the Run Tests button pressed about
  // twice, ever — every other test_run was the autorun at +3s. Candidates
  // verify the normal way, by typing `npm test` in a terminal, and none of
  // it was observed. The judge's `verify` dimension therefore recorded a
  // false negative for anyone who used the terminal, and on one-shot rounds
  // (where the Run Tests button is absent by design) verification was
  // structurally unobservable.
  //
  // Shell integration gives us the command line AND the exit code. It is a
  // recent API and openvscode-server may not implement it, so every access
  // is guarded — a runtime without it degrades to exactly today's behavior
  // rather than failing to activate.
  const shellApi = vscode.window as unknown as {
    onDidStartTerminalShellExecution?: (
      cb: (e: { execution: { commandLine?: { value?: string } } }) => void,
    ) => vscode.Disposable;
    onDidEndTerminalShellExecution?: (
      cb: (e: { exitCode?: number; execution: { commandLine?: { value?: string } } }) => void,
    ) => vscode.Disposable;
  };
  if (typeof shellApi.onDidEndTerminalShellExecution === 'function') {
    context.subscriptions.push(
      shellApi.onDidEndTerminalShellExecution((e) => {
        const cmdline = e.execution?.commandLine?.value ?? '';
        if (!isTestCommand(cmdline)) return;
        // No output capture: shell integration does not hand us the stream,
        // and reading the terminal buffer is unreliable. The exit code is
        // the load-bearing fact (isFailingRun reads only that); the command
        // line stands in for the summary so the judge's timeline still reads.
        emitter.emit('test_run', {
          via: 'terminal',
          exit_code: typeof e.exitCode === 'number' ? e.exitCode : null,
          duration_ms: null,
          summary: `$ ${cmdline.slice(0, 200)}`,
        });
      }),
    );
  } else {
    emitter.emit('sensor', {
      sensor: 'terminal',
      state: 'down',
      reason: 'shell integration API unavailable in this runtime',
    });
  }

  // ---- test runs: spawned, observed, first-class ----
  // One line saying what happened, for the timeline the judge reads. Vitest
  // prints `Tests  1 failed | 15 passed`; python's unittest prints `Ran 16
  // tests` then `OK`/`FAILED (failures=1)`. Matching only the vitest shape
  // left python rounds with a blank summary, so match both and fall back to
  // the last non-empty line rather than emitting nothing.
  const summarizeRun = (tail: string): string => {
    const vitest = tail.match(/^Tests.*$/m);
    if (vitest) return vitest[0];
    const ran = tail.match(/^Ran \d+ tests?.*$/m)?.[0];
    const verdict = tail.match(/^(OK|FAILED)\b.*$/m)?.[0];
    if (ran || verdict) return [ran, verdict].filter(Boolean).join(' — ');
    const lines = tail.trimEnd().split('\n').filter((l) => l.trim());
    return lines[lines.length - 1] ?? '';
  };

  // Output goes to a visible channel: a spawned run prints nowhere by
  // default, and an invisible failing suite made the whole round illegible.
  const testOutput = vscode.window.createOutputChannel('Test Results');
  let running = false;
  const runTests = () => {
    if (running || !folder) return;
    const cmdline = process.env.IP_TEST_CMD ?? 'npm test';
    const [bin, ...args] = cmdline.split(' ');
    if (!bin) return;
    running = true;
    statusItem.text = '$(sync~spin) Tests running…';
    testOutput.clear();
    testOutput.appendLine(`$ ${cmdline}`);
    const t0 = Date.now();
    const child = spawn(bin, args, { cwd: folder.uri.fsPath });
    let tail = '';
    const keep = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-4_000);
      testOutput.append(s);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (code) => {
      running = false;
      const payload: TestRunPayload = {
        via: 'task',
        exit_code: code,
        duration_ms: Date.now() - t0,
      };
      emitter.emit('test_run', { ...payload, summary: summarizeRun(tail) });
      statusItem.text = code === 0 ? '$(check) Tests passed — Run again' : '$(x) Tests failed — Run again';
      // A failing suite is the round's opening move — put it on screen.
      if (code !== 0) testOutput.show(true);
    });
    child.on('error', (err) => {
      running = false;
      statusItem.text = '$(beaker) Run Tests';
      testOutput.appendLine(String(err));
      emitter.emit('test_run', { via: 'task', exit_code: null, duration_ms: Date.now() - t0, error: String(err) });
    });
  };

  // IP_CAN_RUN_TESTS=0: the round's spec says the suite is not an iteration
  // tool here (no-run rounds; one-shot rounds grade server-side at submit).
  // The affordance is ABSENT, not disabled — a greyed-out button reads as
  // broken, an absent one reads as the rules.
  const canRunTests = process.env.IP_CAN_RUN_TESTS !== '0';
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1_000);
  statusItem.text = '$(beaker) Run Tests';
  statusItem.command = 'interviewPrep.runTests';
  if (canRunTests) statusItem.show();
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('interviewPrep.runTests', () => {
      if (canRunTests) runTests();
    }),
  );

  // Kickoff run. For a debugging round the failing suite IS the problem
  // statement, and the rubric's trigger is that first failure — it must not
  // depend on the candidate discovering a status-bar button. Opt OUT with
  // IP_AUTORUN_TESTS=0 (round types where a kickoff run makes no sense).
  if (process.env.IP_AUTORUN_TESTS !== '0' && canRunTests) setTimeout(runTests, 3_000);
}

export function deactivate(): void {
  /* emitter closed via subscriptions */
}
