#!/bin/bash
# Residential egress for the session browser (CHE-333, 2026-10-04).
#
# The session host's own address is Google Cloud's, and Cloudflare challenges
# it on accounts.shopify.com — for a person at the noVNC screen as much as for
# anyone, in a loop. The sign-in cannot be carried over from elsewhere (the
# session is not in cookies DevTools can read), so the sign-in happens here,
# and here must look like a home: an upstream residential proxy, bought by the
# owner, whose URL lives in Secret Manager as `session-host-proxy`
# (http://user:pass@host:port).
#
# This renders tinyproxy to forward EVERYTHING to that upstream — no local
# exceptions, so a page inside the browser cannot reach this host's own ports
# through the forwarder — and hands session-chrome the --proxy-server flag
# through /etc/session-host/proxy.env. Without the secret: no proxy, direct
# egress, as before. Run by session-proxy.service before session-chrome.
set -u
umask 077
url="$(gcloud secrets versions access latest --secret=session-host-proxy --project=meet-assistant-6d8ad 2>/dev/null || true)"
if [ -z "$url" ]; then
  rm -f /etc/session-host/proxy.env
  systemctl stop tinyproxy 2>/dev/null || true
  echo "[proxy-render] no secret: direct egress"
  exit 0
fi
case "$url" in
  http://*) ;;
  *) echo "[proxy-render] the secret is not an http://user:pass@host:port URL; direct egress"; rm -f /etc/session-host/proxy.env; exit 0 ;;
esac
rest="${url#http://}"
cat >/etc/tinyproxy/tinyproxy.conf <<CONF
User tinyproxy
Group tinyproxy
Port 3128
Listen 127.0.0.1
Timeout 600
LogLevel Warning
MaxClients 64
Allow 127.0.0.1
ConnectPort 443
ConnectPort 80
DisableViaHeader Yes
upstream http ${rest}
CONF
chmod 0600 /etc/tinyproxy/tinyproxy.conf
printf 'CHROME_PROXY_ARGS=--proxy-server=http://127.0.0.1:3128\n' >/etc/session-host/proxy.env
chmod 0644 /etc/session-host/proxy.env
systemctl restart tinyproxy
echo "[proxy-render] upstream ${rest##*@}; chrome goes through 127.0.0.1:3128"
