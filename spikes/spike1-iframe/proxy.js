// Spike 1 — same-origin reverse proxy in front of openvscode-server.
//
// Kill condition being tested: X-Frame-Options / CSP frame-ancestors from the
// framed app refusing embedding, and whether the workbench (JS, websockets,
// workers) actually boots inside an iframe on the same origin.
//
// Two mount strategies under one origin (:3200):
//   /shell        → page with <iframe src="/">        (IDE mounted at root)
//   /shell-prefix → page with <iframe src="/ide/">    (IDE under a path prefix)
//   /ide/*        → prefix stripped, forwarded to the IDE
//   everything else → forwarded to the IDE at :3100
//
// THROWAWAY CODE. Not the production proxy.

const http = require('http');
const fs = require('fs');
const path = require('path');
const httpProxy = require('http-proxy');

const IDE = 'http://127.0.0.1:3100';
const PORT = 3200;

const proxy = httpProxy.createProxyServer({ target: IDE, ws: true });
proxy.on('error', (err, _req, res) => {
  console.error('[proxy error]', err.message);
  if (res && !res.headersSent && res.writeHead) {
    res.writeHead(502);
    res.end('proxy error');
  }
});

function page(name) {
  return fs.readFileSync(path.join(__dirname, name));
}

const server = http.createServer((req, res) => {
  if (req.url === '/shell') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('shell-root.html'));
  }
  if (req.url === '/shell-prefix') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('shell-prefix.html'));
  }
  if (req.url === '/shell-folder') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('shell-folder.html'));
  }
  if (req.url.startsWith('/ide/')) {
    req.url = req.url.slice('/ide'.length);
    return proxy.web(req, res);
  }
  proxy.web(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ide/')) req.url = req.url.slice('/ide'.length);
  proxy.ws(req, socket, head);
});

server.listen(PORT, () => console.log(`spike1 proxy on :${PORT}`));
