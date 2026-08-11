#!/usr/bin/env bash
# Zenkai beta VPS provision — Ubuntu 24.04, Hetzner CPX31 class (4 vCPU/8GB).
# Idempotent: safe to re-run. Run as root on a fresh box:
#   scp -r ops root@<box>: && ssh root@<box> 'bash ops/provision.sh'
# Then: point DNS at this box, copy .env, `systemctl start zenkai-app caddy`.
set -euo pipefail

ZENKAI_USER="zenkai"
REPO_URL="${ZENKAI_REPO_URL:-git@github.com:johnz4021/interview_prep.git}"
REPO_DIR="/home/${ZENKAI_USER}/interview_prep"
NODE_MAJOR=20

echo "== packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# lsof is NOT in Ubuntu minimal — assertPortFree (session.ts) does
# spawnSync('lsof').stdout.trim() and TypeErrors on a missing binary at the
# first statement of every session boot. Not optional.
apt-get install -yq docker.io lsof git curl jq ufw

echo "== node ${NODE_MAJOR} =="
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -yq nodejs
fi

echo "== claude cli (generation runs claude -p on ANTHROPIC_API_KEY) =="
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code

echo "== caddy (TLS + reverse proxy) =="
# Caddy, not a Cloudflare tunnel: Cloudflare's proxy read timeout is a fixed
# 100s below Enterprise, and /api/plan/turn awaits a model call WITH web
# search inline — a long planner turn would 524 mid-conversation. Caddy lets
# us set the timeout (see ops/Caddyfile) and drops a daemon from the stack.
if ! command -v caddy >/dev/null; then
  apt-get install -yq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -q
  apt-get install -yq caddy
fi

echo "== service user =="
id "${ZENKAI_USER}" >/dev/null 2>&1 || useradd -m -s /bin/bash "${ZENKAI_USER}"
usermod -aG docker "${ZENKAI_USER}"

echo "== firewall =="
# THE critical rule: the trace-emitter extension dials the session server
# from INSIDE docker via host.docker.internal (= the docker0 gateway).
# That traffic traverses the host INPUT chain; a bare "allow ssh only"
# silently drops it and every edit/test-run is lost while the session
# looks fine. 80/443 are for Caddy; the app (3300) and session ports
# (3200, 3401+) are NEVER opened — Caddy reaches them over loopback.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow in on docker0
ufw --force enable

echo "== repo =="
if [ ! -d "${REPO_DIR}/.git" ]; then
  sudo -u "${ZENKAI_USER}" git clone --branch beta "${REPO_URL}" "${REPO_DIR}" \
    || { echo "clone failed — add this box's deploy key to the repo first:"; \
         sudo -u "${ZENKAI_USER}" bash -c 'test -f ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519; cat ~/.ssh/id_ed25519.pub'; exit 1; }
fi
cd "${REPO_DIR}"
sudo -u "${ZENKAI_USER}" git pull --ff-only || true
sudo -u "${ZENKAI_USER}" npm install
sudo -u "${ZENKAI_USER}" node extension/build.mjs

echo "== docker images (pre-pull so first launches skip the cold build) =="
docker pull gitpod/openvscode-server:latest
# The python round image is defined INLINE in session.ts (ensureRuntimeImage
# builds it from stdin on first python round, guarded by image inspect).
# Pre-build it here so two simultaneous cold python launches never race the
# build: extract the same dockerfile via node.
sudo -u "${ZENKAI_USER}" bash -c "cd '${REPO_DIR}' && npx tsx -e \"
  import { prebuildPythonImage } from './server/src/session.js';
  prebuildPythonImage();
\"" || echo "  (python image prebuild skipped — it will build on first python round)"

echo "== systemd units =="
cp ops/systemd/zenkai-app.service /etc/systemd/system/
install -d /etc/caddy
cp ops/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable zenkai-app caddy

cat <<'DONE'

== provision complete — remaining manual steps ==
1. DNS: point A records for zenkai.run AND session.zenkai.run at this box's
   IPv4 (wherever the domain's DNS lives — no migration needed). If DNS is
   on Cloudflare, set both records to "DNS only" (grey cloud) so the 100s
   proxy timeout stays out of the path.
2. Edit the email at the top of /etc/caddy/Caddyfile (cert expiry notices).
3. Copy your .env to /home/zenkai/interview_prep/.env  (see docs/beta-runbook.md;
   for the VPS add: IP_MULTI_SESSION=1, IP_MAX_CONCURRENT_SESSIONS=2)
4. systemctl start zenkai-app caddy
   (Caddy issues certs on first request — allow ~30s, then check
    `journalctl -u caddy -n 30` for "certificate obtained successfully".)
5. Verify per docs/beta-runbook.md — ESPECIALLY the trace-WS smoke
   (traces/<sid>.jsonl must grow during an IDE round; if it doesn't, the
   firewall is eating docker0 traffic).
DONE
