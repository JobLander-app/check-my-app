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
# tinyproxy: the local forwarder to the residential egress (proxy-render.sh).
# jq: proxy-render.sh reads the metadata token and the secret with it.
# xsel: reads the display's clipboard when a paste does not land (CHE-419).
apt-get install -y -q ca-certificates curl gnupg jq xvfb x11vnc websockify nftables tinyproxy xsel \
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

# CHE-426: one browser per team. SLOTS=<n> (kept in /etc/session-host/slots
# once given) adds team slots 1..n beside "main": user sb-<n>, display :1<n>,
# profile /var/lib/sb-<n>/profile, DevTools 923<n>. A slot is never removed
# here — it holds a team's sign-in; lowering SLOTS only stops adding.
# A fresh host gets the slots migration 0060 seeds (1..3), so a team given
# one is never refused by its own host (Codex on #292).
SEEDED_SLOTS=3
SLOTS="${SLOTS:-$(cat /etc/session-host/slots 2>/dev/null || echo "$SEEDED_SLOTS")}"
case "$SLOTS" in [0-9]) ;; *) echo "provision: FAIL — SLOTS must be 0..9"; exit 1 ;; esac
echo "$SLOTS" > /etc/session-host/slots
browser_users='"session-browser"'
slots_env="main=9222"
for n in $(seq 1 "$SLOTS"); do
  id "sb-$n" >/dev/null 2>&1 || useradd --system --home-dir "/var/lib/sb-$n" --shell /usr/sbin/nologin "sb-$n"
  install -d -o "sb-$n" -g "sb-$n" -m 0700 "/var/lib/sb-$n" "/var/lib/sb-$n/profile"
  browser_users="$browser_users, \"sb-$n\""
  slots_env="$slots_env,$n=923$n"
done
printf 'SESSION_SLOTS=%s\n' "$slots_env" > /etc/session-host/slots.env.new
slots_changed=0
cmp -s /etc/session-host/slots.env.new /etc/session-host/slots.env || slots_changed=1
mv /etc/session-host/slots.env.new /etc/session-host/slots.env
chmod 0644 /etc/session-host/slots.env
# The rules hold every browser user, rendered here (firewall.nft @BROWSER_USERS@).
sed "s/@BROWSER_USERS@/$browser_users/g" "$SRC/firewall.nft" > /etc/session-host/firewall.nft
chmod 0644 /etc/session-host/firewall.nft
# Until 2026-10-02 Chrome ran as session-host with its profile here. Nobody had
# signed in to it; a second profile lying around is one somebody opens by mistake.
rm -rf /var/lib/session-host/profile

# noVNC: upstream at a pinned commit, plus an index that opens the viewer
# already connected, so the owner lands on the screen and not on a file list.
# Not the Debian package (1.3.0) and not release 1.7.0: only upstream master
# after 1.7.0 has core/clipboard.js, which hands the local clipboard to the
# remote screen when it gets focus — Cmd+C on the Mac, click, Cmd+V. Before it,
# a password could only be pasted through the side panel, and on 2026-10-05
# that cost the owner most of forty minutes (CHE-419).
NOVNC_COMMIT=b17d04c1a1a926a59f4a04bb866332b429f2ce37
install -d -m 0755 /opt/session-host
if [ "$(cat /opt/session-host/novnc/INSTALLED_FROM 2>/dev/null | cut -d' ' -f1)" != "$NOVNC_COMMIT" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/novnc/noVNC/archive/${NOVNC_COMMIT}.tar.gz" | tar xz -C "$tmp"
  rm -rf /opt/session-host/novnc
  mv "$tmp/noVNC-${NOVNC_COMMIT}" /opt/session-host/novnc
  echo "$NOVNC_COMMIT $(date -u +%FT%TZ)" > /opt/session-host/novnc/INSTALLED_FROM
  rm -rf "$tmp"
fi
test -f /opt/session-host/novnc/core/clipboard.js || { echo "provision: FAIL — noVNC at $NOVNC_COMMIT has no core/clipboard.js"; exit 1; }
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
for file in session-server.mjs lease.mjs classify.mjs viewer.mjs door.mjs package.json; do
  cmp -s "$SRC/$file" "/opt/session-host/probe/$file" || server_changed=1
done
install -m 0644 "$SRC/probe.mjs" "$SRC/classify.mjs" "$SRC/session-server.mjs" "$SRC/lease.mjs" "$SRC/door.mjs" "$SRC/viewer.mjs" "$SRC/package.json" /opt/session-host/probe/
(cd /opt/session-host/probe && npm install --omit=dev --no-audit --no-fund --silent)
runuser -u session-host -- node /opt/session-host/probe/door.mjs --self-test >/dev/null || { echo "provision: FAIL — door.mjs self-test"; exit 1; }

# CHE-419: x11vnc (as session-browser) writes the door's trigger here on every
# accepted viewer; session-door.path then tidies the person's tab as
# session-host. Its own directory: session-browser may not enter
# /var/lib/session-host.
install -d -o session-browser -g session-browser -m 0755 /var/lib/session-door

# CHE-333: the residential egress. proxy-render.sh reads the upstream from
# Secret Manager (session-host-proxy) and renders tinyproxy; without the secret
# Chrome goes out directly, as before. tinyproxy is started by it (session-
# proxy.service, before Chrome), never at boot with the package's own config —
# and NOT stopped here: a running forwarder is the owner's session's egress.
proxy_changed=0
cmp -s "$SRC/proxy-render.sh" /opt/session-host/proxy-render.sh || proxy_changed=1
install -m 0755 "$SRC/proxy-render.sh" /opt/session-host/proxy-render.sh
systemctl disable tinyproxy 2>/dev/null || true

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
slot_units_changed=()
for unit in "$SRC"/systemd/*.service "$SRC"/systemd/*.timer "$SRC"/systemd/*.path; do
  name="$(basename "$unit")"
  if ! cmp -s "$unit" "/etc/systemd/system/$name"; then
    install -m 0644 "$unit" "/etc/systemd/system/$name"
    # A template (session-slot-chrome@.service) has no unit to restart by that
    # name; its instances are restarted below, one per slot.
    case "$name" in *@.service) slot_units_changed+=("${name%@.service}") ;; *) changed+=("$name") ;; esac
  fi
done
# Drop-ins (session-chrome.service.d/proxy.conf): a changed one restarts its unit.
for dropin in "$SRC"/systemd/*.service.d/*.conf; do
  [ -e "$dropin" ] || continue
  dir="$(basename "$(dirname "$dropin")")"
  install -d -m 0755 "/etc/systemd/system/$dir"
  if ! cmp -s "$dropin" "/etc/systemd/system/$dir/$(basename "$dropin")"; then
    install -m 0644 "$dropin" "/etc/systemd/system/$dir/"
    changed+=("${dir%.d}")
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
systemctl enable session-proxy
# A changed renderer is run again (Codex on #283): session-proxy is a oneshot
# that stays "active", so enabling it alone would leave the old forwarder
# config in place. Re-rendering restarts tinyproxy only — Chrome keeps its
# flag and its session. A render that fails is a failed provision.
if [ "$proxy_changed" = 1 ] || ! systemctl is-active -q session-proxy; then
  systemctl restart session-proxy || { echo "provision: FAIL — proxy-render.sh (journalctl -u session-proxy)"; exit 1; }
fi
systemctl enable --now session-xvfb session-chrome session-x11vnc session-novnc session-probe.timer session-door.path
# CHE-426: each team slot's display and browser. A changed slot template
# restarts that slot's instances — which ends the teams' sign-ins, said aloud.
for n in $(seq 1 "$SLOTS"); do
  systemctl enable --now "session-slot-xvfb@$n" "session-slot-chrome@$n"
  for base in "${slot_units_changed[@]}"; do
    echo "provision: $base@$n changed — restarting it; slot $n's team will have to sign in again."
    systemctl try-restart "$base@$n"
  done
done
if [ ${#changed[@]} -gt 0 ]; then
  echo "provision: unit files changed: ${changed[*]}"
  case " ${changed[*]} " in *" session-chrome.service "*|*" session-chrome "*|*" session-xvfb.service "*|*" session-firewall.service "*|*" session-proxy.service "*)
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
  if [ "$server_changed" = 1 ] || [ "$slots_changed" = 1 ]; then
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
# CHE-426: every browser user, "main"'s and each slot's, is held to the same
# test — and none reaches any browser's DevTools, its own included (the gate is
# the session server, never a page).
users="session-browser"
devtools="http://127.0.0.1:9222/json"
for n in $(seq 1 "$SLOTS"); do
  users="$users sb-$n"
  devtools="$devtools http://127.0.0.1:923$n/json"
  for i in $(seq 1 30); do as session-host curl -s -o /dev/null -m 2 "http://127.0.0.1:923$n/json/version" && break; sleep 1; done
  reach session-host "http://127.0.0.1:923$n/json/version" || { echo "provision: FAIL — session-host cannot reach slot $n's DevTools"; fail=1; }
done
for user in $users; do
  for url in $devtools http://127.0.0.1:6080/ http://127.0.0.1:9090/state http://127.0.0.1:9091/ http://169.254.169.254/computeMetadata/v1/ \
    "http://$(hostname -I | awk '{print $1}'):22/" http://0.0.0.0:9222/json 'http://[::ffff:127.0.0.1]:9222/json' http://localhost:9222/json 'http://[::1]:5900/'; do
    if reach "$user" "$url"; then echo "provision: FAIL — browser user $user can reach $url"; fail=1; fi
  done
  if as "$user" bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900' 2>/dev/null; then echo "provision: FAIL — browser user $user can reach VNC"; fail=1; fi
  reach "$user" https://admin.shopify.com/ || { echo "provision: FAIL — browser user $user cannot reach the public web (DNS or routing)"; fail=1; }
  # CHE-333: with a proxy configured, the browser's user goes out through it —
  # observed, by where the request comes out.
  if [ -s /etc/session-host/proxy.env ]; then
    egress="$(as "$user" curl -s -m 20 --proxy http://127.0.0.1:3128 https://ipinfo.io/org || true)"
    if [ -n "$egress" ]; then echo "provision: $user residential egress — $egress"; else echo "provision: FAIL — browser user $user cannot go out through 127.0.0.1:3128"; fail=1; fi
  fi
done
allowed_uids="$(for user in $users; do id -u "$user"; done | sort -u | tr '\n' ' ')"
chrome_uids="$(ps -o uid= -C chrome | sort -u | tr -d ' ' | tr '\n' ' ')"
for uid in $chrome_uids; do
  case " $allowed_uids " in *" $uid "*) ;; *) echo "provision: FAIL — Chrome runs as uid $uid, not a browser user ($allowed_uids)"; fail=1 ;; esac
done
if [ "$fail" = 0 ]; then echo "provision: isolation holds — every browser user ($users) reaches the public web and nothing on this host or its private network"; fi
exit "$fail"
