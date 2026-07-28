// Spike 2 host-side collector: logs every message the extension sends.
// THROWAWAY.
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const logFile = path.join(OUT, 'ws-received.jsonl');

const wss = new WebSocketServer({ port: 3400 });
wss.on('connection', (ws, req) => {
  console.log('[host] connection from', req.socket.remoteAddress);
  ws.on('message', (data) => {
    fs.appendFileSync(logFile, data.toString() + '\n');
    console.log('[host] received:', data.toString().slice(0, 120));
  });
});
console.log('[host] ws collector on :3400');
