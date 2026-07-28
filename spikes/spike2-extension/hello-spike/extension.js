// Spike 2 + Spike 3 — proves the assumptions the trace emitter depends on:
//   1. extensionKind ["workspace"] activates in the REMOTE host (spike 2, PASSED)
//   2. that host can open an outbound WebSocket (spike 2, PASSED)
//   3. test runs launched as extension-owned tasks are observable with
//      start + exit code (spike 3 — the eng-review question that decides
//      whether "never ran the failing test" is detectable at all)
//
// THROWAWAY CODE. Not the production emitter.

// Load-order marker: proves whether the extension host required this module
// at all, independent of whether activate() succeeded.
try {
  require('fs').appendFileSync('/tmp/hello-spike.log', `[${Date.now()}] module loaded\n`);
} catch {}

const vscode = require('vscode');
const WebSocket = require('ws');

const BACKEND = process.env.SPIKE_WS_URL || 'ws://host.docker.internal:3400';
// Overridable because the spike container has no npm on PATH; the runner
// injects the server's bundled node + vitest entry instead.
const TEST_CMD = process.env.SPIKE_TEST_CMD || 'npm test';

function activate(context) {
  try {
    require('fs').appendFileSync('/tmp/hello-spike.log', `[${Date.now()}] activate() called\n`);
  } catch {}
  const ws = new WebSocket(BACKEND);
  let seq = 0;

  const send = (type, payload) =>
    ws.readyState === WebSocket.OPEN &&
    ws.send(
      JSON.stringify({
        session_id: 'spike3',
        user_id: 'u1',
        source: 'extension',
        seq: seq++,
        ts: Date.now(),
        type,
        payload,
      }),
    );

  // --- spike 3: observe ALL task processes (candidate-initiated ones too) ---
  const started = new Map(); // taskName -> start ts
  context.subscriptions.push(
    vscode.tasks.onDidStartTaskProcess((e) => {
      started.set(e.execution.task.name, Date.now());
    }),
    vscode.tasks.onDidEndTaskProcess((e) => {
      const t0 = started.get(e.execution.task.name);
      send('test_run', {
        via: 'task',
        task: e.execution.task.name,
        exit_code: e.exitCode ?? null,
        duration_ms: t0 ? Date.now() - t0 : null,
      });
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      send('edit', { path: e.document.uri.path, changes: e.contentChanges.length });
    }),
  );

  ws.on('open', () => {
    send('session_start', {
      remoteName: vscode.env.remoteName ?? null,
      node: process.version,
      workspace: vscode.workspace.workspaceFolders?.[0]?.uri.path ?? null,
      test_cmd: TEST_CMD,
    });

    // Fire one extension-owned test run a few seconds after boot. The
    // listeners above are the same ones that would observe a HUMAN running
    // the task — self-triggering just makes the spike headless.
    setTimeout(() => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return send('test_run', { via: 'task', error: 'no workspace folder' });
      // PATH A: vscode tasks API. Requires the pty host (tasks run in a
      // terminal); in headless openvscode-server no pty host spawns, so
      // executeTask resolves but nothing runs and no process events fire.
      const [bin, ...args] = TEST_CMD.split(' ');
      const task = new vscode.Task(
        { type: 'process', task: 'spike-test' },
        folder,
        'spike-test',
        'spike',
        new vscode.ProcessExecution(bin, args, { cwd: folder.uri.path }),
      );
      vscode.tasks.executeTask(task).then(
        () => send('task_api_probe', { executed: true }),
        (err) => send('task_api_probe', { error: String(err) }),
      );

      // PATH B: extension spawns the run itself. No pty host, no shell, no
      // terminal — deterministic start/exit observation. This is what the
      // product's own "Run tests" action would use.
      const t0 = Date.now();
      const child = require('child_process').spawn(bin, args, {
        cwd: folder.uri.path,
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => {
        send('test_run', {
          via: 'spawn',
          exit_code: code,
          duration_ms: Date.now() - t0,
          failed_line: (out.match(/Tests\s+.*$/m) || [''])[0].trim(),
        });
      });
    }, 3000);
  });
  ws.on('error', (err) => console.error('[hello-spike] ws error', err.message));
}

function deactivate() {}

module.exports = { activate, deactivate };
