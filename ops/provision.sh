#!/usr/bin/env bash
# Zenkai beta VPS provision — Ubuntu 24.04, Hetzner CPX31 (Ashburn, 4 vCPU/8GB).
# US locations are AMD-only (CPX/CCX); the Intel CX line is EU-only.
# Idempotent: safe to re-run. Run as root on a fresh box:
#   scp -r ops root@<box>: && ssh root@<box> 'bash ops/provision.sh'
# Then: point DNS at this box, copy .env (ops/push-env.sh), start zenkai-app.
set -euo pipefail

ZENKAI_USER="zenkai"
REPO_URL="${ZENKAI_REPO_URL:-git@github.com:johnz4021/Zenkai.git}"
REPO_DIR="/home/${ZENKAI_USER}/Zenkai"
NODE_MAJOR=22

echo "== deploy key (add this to GitHub BEFORE the clone step) =="
# Printed first on purpose: the repo is private, so the clone below needs a
# read-only deploy key. Add it at
#   github.com/johnz4021/Zenkai → Settings → Deploy keys → Add
# while the package install runs, then re-run this script if the clone fails.
id "${ZENKAI_USER}" >/dev/null 2>&1 || useradd -m -s /bin/bash "${ZENKAI_USER}"
sudo -u "${ZENKAI_USER}" bash -c 'test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N "" -q -f ~/.ssh/id_ed25519'
sudo -u "${ZENKAI_USER}" bash -c 'ssh-keyscan -H github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u ~/.ssh/known_hosts -o ~/.ssh/known_hosts'
echo "---8<--- deploy key ---8<---"
sudo -u "${ZENKAI_USER}" cat /home/"${ZENKAI_USER}"/.ssh/id_ed25519.pub
echo "---8<-------------------8<---"

echo "== packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# lsof is NOT in Ubuntu minimal — assertPortFree (session.ts) does
# spawnSync('lsof').stdout.trim() and TypeErrors on a missing binary at the
# first statement of every session boot. Not optional.
apt-get install -yq docker.io lsof git curl jq ufw

echo "== node ${NODE_MAJOR} =="
# Node 20 reached EOL on 2026-04-30 — no security patches. This box faces the
# public internet, so it runs a supported line. 22 is Maintenance LTS through
# April 2027 (comfortably past this beta) and is one major from the 20 the
# code was written against; 24 is Active LTS if you want the longer runway.
# NodeSource ships a codename-independent "nodistro" suite, so this works on
# 24.04 and 26.04 alike.
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt "${NODE_MAJOR}" ]; then
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
usermod -aG docker "${ZENKAI_USER}"   # user itself was created above with its key

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
    || { echo "CLONE FAILED — add the deploy key printed at the top of this run to"; \
         echo "github.com/johnz4021/Zenkai → Settings → Deploy keys, then re-run this script."; \
         echo "Also confirm the 'beta' branch has been PUSHED (git push -u origin beta)."; exit 1; }
fi
cd "${REPO_DIR}"
sudo -u "${ZENKAI_USER}" git pull --ff-only || true
sudo -u "${ZENKAI_USER}" npm install
sudo -u "${ZENKAI_USER}" node extension/build.mjs

echo "== leetcode dataset (idempotent; pinned in server/src/lc-source.ts) =="
sudo -u "${ZENKAI_USER}" npx tsx server/src/cli.ts lc fetch \
  || echo "  (lc fetch failed — LC-sourced rounds degrade to fresh generation until it succeeds)"

echo "== docker images (pre-pull so first launches skip the cold build) =="
docker pull gitpod/openvscode-server:latest
# The python round image is defined INLINE in session.ts (ensureRuntimeImage
# builds it from stdin on first python round, guarded by an image inspect).
# Pre-build it here so two simultaneous cold python launches never race the
# build. The tag is read from session.ts so a rename there is picked up; the
# three RUN lines are duplicated below because `tsx -e` cannot resolve a
# relative import (no base path for './server/...'), which is how the first
# attempt at this silently no-op'd. session.ts stays the source of truth —
# if these drift, the worst case is one redundant build on first python round.
PY_TAG=$(sed -n "s/.*python: '\([^']*\)'.*/\1/p" server/src/session.ts | head -1)
PY_TAG=${PY_TAG:-ip-ide-python:1}
echo "  python round image: ${PY_TAG}"
PY_CTX=$(mktemp -d)
cat > "${PY_CTX}/Dockerfile" <<'PYDOCKER'
FROM gitpod/openvscode-server:latest
USER root
RUN apt-get update -qq && apt-get install -y -qq python3 && rm -rf /var/lib/apt/lists/*
USER openvscode-server
PYDOCKER
docker build -t "${PY_TAG}" "${PY_CTX}" \
  || echo "  (python image prebuild failed — it will build on first python round)"
rm -rf "${PY_CTX}"

echo "== systemd units =="
cp ops/systemd/zenkai-app.service /etc/systemd/system/
# Nightly off-box backup of the irreplaceable dirs (gaps/topics/traces/
# feedback/targets). db.ts mirrors reps/targets/sessions to Postgres but NOT
# the memory layer, so without this a disk loss is permanent.
cp ops/systemd/zenkai-backup.service /etc/systemd/system/
cp ops/systemd/zenkai-backup.timer /etc/systemd/system/
install -d /etc/caddy
cp ops/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now zenkai-backup.timer 2>/dev/null || true
systemctl enable zenkai-app caddy
# Caddy's .deb STARTS the service at install time with the stock Caddyfile, so
# the copy above lands under a caddy that is already running — and `systemctl
# start caddy` in the closing steps is then a no-op against an active unit.
# The box sat on the default config serving :80 with no TLS at all, and the
# only hint was one "listening only on the HTTP port" warning in the journal.
# Restart unconditionally so the config we just installed is the live one.
systemctl restart caddy

cat <<'DONE'

== provision complete — remaining manual steps ==
1. DNS: point A records for zenkai.run AND session.zenkai.run at this box's
   IPv4 (wherever the domain's DNS lives — no migration needed). If DNS is
   on Cloudflare, set both records to "DNS only" (grey cloud) so the 100s
   proxy timeout stays out of the path.
2. Edit the email at the top of /etc/caddy/Caddyfile (cert expiry notices).
3. Copy your .env to /home/zenkai/Zenkai/.env — start from
   ops/env.launch.template, which carries the VPS-only settings
   (IP_MULTI_SESSION, the room/build caps, retention) already sized for
   this box. Keep it mode 600 and owned by zenkai.
4. systemctl start zenkai-app   (caddy is already restarted by this script)
   (Caddy issues certs on first request — allow ~30s, then check
    `journalctl -u caddy -n 30` for "certificate obtained successfully".)
5. Verify per docs/beta-runbook.md — ESPECIALLY the trace-WS smoke
   (traces/<sid>.jsonl must grow during an IDE round; if it doesn't, the
   firewall is eating docker0 traffic).
DONE
