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
apt-get install -y -q ca-certificates curl gnupg xvfb x11vnc novnc websockify nftables \
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

# CHE-389: the browser (and the display it draws on) has a user of its own, so
# that firewall.nft can keep every page in it off this host's own ports.
# session-host keeps the probe, the session server and websockify.
id session-browser >/dev/null 2>&1 || useradd --system --home-dir /var/lib/session-browser --shell /usr/sbin/nologin session-browser
install -d -o session-browser -g session-browser -m 0700 /var/lib/session-browser
install -d -o session-browser -g session-browser -m 0700 /var/lib/session-browser/profile
install -d -m 0700 /etc/session-host
install -m 0644 "$SRC/firewall.nft" /etc/session-host/firewall.nft
# Until 2026-10-02 Chrome ran as session-host with its profile here. Nobody had
# signed in to it; a second profile lying around is one somebody opens by mistake.
rm -rf /var/lib/session-host/profile

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
# The session server (CHE-389) lives beside the probe: they share classify.mjs
# and one node_modules. It is restarted only when one of its own files changed —
# a restart drops the check that is connected at that moment.
server_changed=0
for file in session-server.mjs lease.mjs classify.mjs package.json; do
  cmp -s "$SRC/$file" "/opt/session-host/probe/$file" || server_changed=1
done
install -m 0644 "$SRC/probe.mjs" "$SRC/classify.mjs" "$SRC/session-server.mjs" "$SRC/lease.mjs" "$SRC/package.json" /opt/session-host/probe/
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

# A rerun must deploy a changed unit, and must not restart an unchanged one:
# restarting session-chrome ends the owner's Shopify session (its session
# cookies die with the process), and restarting the tunnel drops his noVNC view.
# So only the units whose file actually changed are restarted.
changed=()
for unit in "$SRC"/systemd/*.service "$SRC"/systemd/*.timer; do
  name="$(basename "$unit")"
  if ! cmp -s "$unit" "/etc/systemd/system/$name"; then
    install -m 0644 "$unit" "/etc/systemd/system/$name"
    changed+=("$name")
  fi
done
systemctl daemon-reload
# The firewall first, and its rules loaded again on every run: the file may
# have changed, and it replaces its own table in one step. Loaded with nft
# directly, NOT by restarting the unit — Chrome requires that unit, so
# restarting it restarts Chrome, and a provision would end the owner's session
# every time (seen 2026-10-02: Chrome's pid changed across a run that changed
# nothing).
nft -f /etc/session-host/firewall.nft
systemctl enable --now session-firewall
systemctl enable --now session-xvfb session-chrome session-x11vnc session-novnc session-probe.timer
if [ ${#changed[@]} -gt 0 ]; then
  echo "provision: unit files changed: ${changed[*]}"
  case " ${changed[*]} " in *" session-chrome.service "*|*" session-xvfb.service "*|*" session-firewall.service "*)
    echo "provision: Chrome restarts — the owner will have to sign in again." ;;
  esac
  systemctl try-restart "${changed[@]}"
fi
# websockify chdirs into its web root at start; the copy above replaced that
# directory, so a running websockify would answer every request with ENOENT.
systemctl restart session-novnc
if [ -s /etc/cloudflared/tunnel.env ]; then
  systemctl enable --now session-cloudflared
else
  echo "provision: /etc/cloudflared/tunnel.env is missing — the tunnel is not started (README.md, 'Tunnel token')."
fi
if [ -s /etc/session-host/server.env ]; then
  systemctl enable --now session-server
  # try-restart above covered a changed unit file; this covers changed code.
  if [ "$server_changed" = 1 ]; then
    systemctl restart session-server
  fi
else
  echo "provision: /etc/session-host/server.env is missing — the session server is not started (README.md, 'The session server')."
fi

systemctl --no-pager --plain list-units 'session-*'

# The isolation, observed rather than assumed — a provision that leaves the
# browser's user able to reach the host fails here, loudly.
as() { runuser -u "$1" -- "${@:2}"; }
reach() { as "$1" curl -s -o /dev/null -m 5 "$2"; }
for i in $(seq 1 30); do as session-host curl -s -o /dev/null -m 2 http://127.0.0.1:9222/json/version && break; sleep 1; done
fail=0
reach session-host http://127.0.0.1:9222/json/version || { echo "provision: FAIL — session-host cannot reach DevTools (the probe and the session server need it)"; fail=1; }
for url in http://127.0.0.1:9222/json http://127.0.0.1:6080/ http://127.0.0.1:9090/state http://169.254.169.254/computeMetadata/v1/ \
  "http://$(hostname -I | awk '{print $1}'):22/" http://0.0.0.0:9222/json 'http://[::ffff:127.0.0.1]:9222/json' http://localhost:9222/json 'http://[::1]:5900/'; do
  if reach session-browser "$url"; then echo "provision: FAIL — the browser's user can reach $url"; fail=1; fi
done
if as session-browser bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900' 2>/dev/null; then echo "provision: FAIL — the browser's user can reach VNC"; fail=1; fi
reach session-browser https://admin.shopify.com/ || { echo "provision: FAIL — the browser's user cannot reach the public web (DNS or routing)"; fail=1; }
chrome_uids="$(ps -o uid= -C chrome | sort -u | tr -d ' ' | tr '\n' ' ')"
[ "$chrome_uids" = "$(id -u session-browser) " ] || { echo "provision: FAIL — Chrome is not running as session-browser alone (uids: $chrome_uids)"; fail=1; }
if [ "$fail" = 0 ]; then echo "provision: isolation holds — the browser's user reaches the public web and nothing on this host or its private network"; fi
exit "$fail"
