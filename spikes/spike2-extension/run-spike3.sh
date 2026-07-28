#!/usr/bin/env bash
# Spike 3 — can we observe a test run (start + exit code) from the extension?
#
# Boots the IDE with a REAL generated problem mounted as the workspace folder,
# plus the spike extension. The extension launches `vitest run` as an
# extension-owned task and reports onDidEndTaskProcess to the host collector.
#
# Key constraint discovered in spike 2 prep: the IDE image has NO node/npm on
# PATH — only a bundled runtime at /home/.openvscode-server/node. So the test
# command uses that binary directly against the problem's vitest entry.
#
# Usage: ./run-spike3.sh <path-to-generated-problem>
set -euo pipefail

PROBLEM="${1:?usage: run-spike3.sh <problem-dir>}"
PROBLEM="$(cd "$PROBLEM" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "[spike3] problem: $PROBLEM"
[ -d "$PROBLEM/node_modules/vitest" ] || { echo "[spike3] FATAL: problem has no vitest installed"; exit 1; }

# The generator installs node_modules on the HOST (darwin-arm64). Native
# binaries (rollup, esbuild) are platform-specific and blow up inside the
# linux container. Re-install for linux before mounting.
# Production note: generation and sessions both run in linux containers, so
# this step exists only because our current generate step runs on the host.
if [ ! -f "$PROBLEM/.linux-deps-ok" ]; then
  echo "[spike3] installing linux-native deps..."
  docker run --rm -v "$PROBLEM:/app" -w /app node:22-slim \
    npm install --no-fund --no-audit >/dev/null 2>&1
  touch "$PROBLEM/.linux-deps-ok"
fi

rm -rf "$HERE/ext-dir" && mkdir -p "$HERE/ext-dir"
cp -R "$HERE/hello-spike" "$HERE/ext-dir/hello-spike-0.0.1"
mkdir -p "$HERE/out" && rm -f "$HERE/out/ws-received.jsonl"

# Kill by PORT, not by command pattern: these get launched from varying cwds
# so `pkill -f <path>` misses instances started as bare `node host-server.js`.
free_port() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true; }
free_port 3400
free_port 3200

nohup node "$HERE/host-server.js" > "$HERE/out-host.log" 2>&1 &
echo "[spike3] collector pid $!"
nohup node "$HERE/../spike1-iframe/proxy.js" > "$HERE/../spike1-iframe/out.log" 2>&1 &
echo "[spike3] proxy pid $!"
sleep 1
grep -q EADDRINUSE "$HERE/out-host.log" && { echo "[spike3] FATAL: collector could not bind 3400"; exit 1; }

NODE_BIN=/home/.openvscode-server/node
TEST_CMD="$NODE_BIN /home/workspace/problem/node_modules/vitest/vitest.mjs run"

docker rm -f spike3-ovs >/dev/null 2>&1 || true
docker run -d --name spike3-ovs -p 3100:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e "SPIKE_TEST_CMD=$TEST_CMD" \
  -v "$HERE/ext-dir:/ext" \
  -v "$PROBLEM:/home/workspace/problem" \
  gitpod/openvscode-server:latest \
  --without-connection-token --host 0.0.0.0 --extensions-dir /ext >/dev/null

for i in $(seq 1 40); do
  curl -sf -o /dev/null http://127.0.0.1:3100/ && { echo "[spike3] IDE up (~${i}s)"; break; }
  sleep 1
done

# Connecting a client is what starts the remote extension host.
"$HOME/.claude/skills/gstack/browse/dist/browse" goto "http://127.0.0.1:3200/shell-folder" >/dev/null 2>&1
echo "[spike3] workbench opened on the problem folder; waiting for task run..."
sleep 45

echo "=== events received ==="
cat "$HERE/out/ws-received.jsonl" 2>/dev/null || echo "NOTHING RECEIVED"
