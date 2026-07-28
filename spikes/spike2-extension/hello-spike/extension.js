// Spike 2 — proves the two assumptions the trace emitter depends on:
//   1. a custom extension with extensionKind ["workspace"] activates in the
//      REMOTE extension host (inside the container), and
//   2. that host can open an outbound WebSocket to our backend.
//
// It also sends one real edit event, which is a free preview of spike 3
// territory (can we observe editor activity at all).
//
// THROWAWAY CODE. Not the production emitter.

const vscode = require('vscode');
const WebSocket = require('ws');

const BACKEND = process.env.SPIKE_WS_URL || 'ws://host.docker.internal:3400';

function activate(context) {
  const ws = new WebSocket(BACKEND);
  let seq = 0;

  const send = (type, payload) =>
    ws.readyState === WebSocket.OPEN &&
    ws.send(
      JSON.stringify({
        session_id: 'spike2',
        user_id: 'u1',
        source: 'extension',
        seq: seq++,
        ts: Date.now(),
        type,
        payload,
      }),
    );

  ws.on('open', () => {
    send('session_start', {
      remoteName: vscode.env.remoteName ?? null, // proves WHICH host we're in
      appHost: vscode.env.appHost,
      node: process.version,
    });
  });
  ws.on('error', (err) => console.error('[hello-spike] ws error', err.message));

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      send('edit', {
        path: e.document.uri.path,
        changes: e.contentChanges.length,
      });
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
