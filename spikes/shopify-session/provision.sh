#!/usr/bin/env bash
# Provision the CHE-378 session host (Debian 12). Idempotent: run it again after
# changing any file in this directory.
#
#   gcloud compute scp --recurse --tunnel-through-iap --zone europe-west1-b \
#     --project meet-assistant-6d8ad spikes/shopify-session checkmyapp-session-host:~/
#   gcloud compute ssh checkmyapp-session-host --tunnel-through-iap --zone europe-west1-b \
#     --project meet-assistant-6d8ad --command 'sudo bash ~/shopify-session/provision.sh'
#
# The tunnel token is not in this repo. It is put on the host separately into
# /etc/cloudflared/tunnel.env (root, 0600) — see README.md.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q ca-certificates curl gnupg xvfb x11vnc novnc websockify \
  fonts-liberation fonts-noto-color-emoji

install -d -m 0755 /etc/apt/keyrings

if ! command -v google-chrome-stable >/dev/null; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
fi

if ! command -v cloudflared >/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /etc/apt/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/etc/apt/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
fi

apt-get update -q
apt-get install -y -q google-chrome-stable cloudflared nodejs

id session-host >/dev/null 2>&1 || useradd --system --home-dir /var/lib/session-host --shell /usr/sbin/nologin session-host
install -d -o session-host -g session-host -m 0700 /var/lib/session-host
install -d -o session-host -g session-host -m 0700 /var/lib/session-host/profile

# noVNC: a copy of the packaged client plus an index that opens the viewer
# already connected, so the owner lands on the screen and not on a file list.
install -d -m 0755 /opt/session-host
rm -rf /opt/session-host/novnc
cp -r /usr/share/novnc /opt/session-host/novnc
cat > /opt/session-host/novnc/index.html <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>Session host</title>
<meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=true&amp;resize=scale&amp;reconnect=true&amp;path=websockify">
<a href="vnc.html?autoconnect=true&amp;resize=scale&amp;reconnect=true&amp;path=websockify">Open the session</a>
HTML

install -d -m 0755 /opt/session-host/probe
install -m 0644 "$SRC/probe.mjs" "$SRC/classify.mjs" "$SRC/package.json" /opt/session-host/probe/
(cd /opt/session-host/probe && npm install --omit=dev --no-audit --no-fund --silent)

# portability.mjs reaches DevTools through an IAP SSH tunnel. On 2026-10-01 the
# tunnel's sshd kept its forwarded DevTools sockets open after the client was
# gone; make sshd notice a dead client within ~45 s instead of never.
cat > /etc/ssh/sshd_config.d/session-host.conf <<'SSHD'
ClientAliveInterval 15
ClientAliveCountMax 3
SSHD
sshd -t && systemctl reload ssh

install -d -m 0700 /etc/cloudflared
install -m 0644 "$SRC"/systemd/*.service "$SRC"/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now session-xvfb session-chrome session-x11vnc session-novnc session-probe.timer
if [ -s /etc/cloudflared/tunnel.env ]; then
  systemctl enable --now session-cloudflared
  systemctl restart session-cloudflared
else
  echo "provision: /etc/cloudflared/tunnel.env is missing — the tunnel is not started (README.md, 'Tunnel token')."
fi

systemctl --no-pager --plain list-units 'session-*'
