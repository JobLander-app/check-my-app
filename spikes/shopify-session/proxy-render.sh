#!/bin/bash
# Residential egress for the session browser (CHE-333, 2026-10-04).
#
# The session host's own address is Google Cloud's, and Cloudflare challenges
# it on accounts.shopify.com — for a person at the noVNC screen as much as for
# anyone, in a loop. The sign-in cannot be carried over from elsewhere (the
# session is not in cookies DevTools can read), so the sign-in happens here,
# and here must look like a home: an upstream residential proxy, bought by the
# owner, whose URL lives in Secret Manager as `session-host-proxy`
# (http://user:pass@host:port). The VM's service account holds
# roles/secretmanager.secretAccessor on that one secret (README, "Residential
# egress").
#
# This renders tinyproxy to forward EVERYTHING to that upstream — no local
# exceptions, so a page inside the browser cannot reach this host's own ports
# through the forwarder — and hands session-chrome the --proxy-server flag
# through /etc/session-host/proxy.env. Run by session-proxy.service before
# session-chrome.
#
# Read with the metadata server's token and Secret Manager's REST API, the
# probe's way — no gcloud CLI needed on the host (Codex on #283). Three answers,
# kept apart (the first version folded all three into "direct egress"):
#   200 — render and start the forwarder;
#   404 — there is no proxy secret: direct egress, on purpose;
#   anything else (no permission, no network) — FAIL loudly and change
#   nothing: the last good forwarder and flag stay in place.
set -u
umask 077
MD=http://metadata.google.internal/computeMetadata/v1
fail() { echo "[proxy-render] FAIL: $1 — the current egress is left as it was" >&2; exit 1; }

token="$(curl -fsS -m 10 -H Metadata-Flavor:Google "$MD/instance/service-accounts/default/token" | jq -r .access_token)" || fail "no service-account token"
project="$(curl -fsS -m 10 -H Metadata-Flavor:Google "$MD/project/project-id")" || fail "no project id"
response="$(curl -sS -m 20 -w '\n%{http_code}' -H "Authorization: Bearer $token" \
  "https://secretmanager.googleapis.com/v1/projects/$project/secrets/session-host-proxy/versions/latest:access")" || fail "Secret Manager unreachable"
code="${response##*$'\n'}"
body="${response%$'\n'*}"

# Chrome takes --proxy-server at start only. When the mode flips — a proxy
# added, or removed — a Chrome already running keeps the old flag and either
# bypasses the new egress or points at a forwarder that is gone (Codex on
# #283). It is restarted then, and only then: that ends the person's sign-in,
# so it happens only on the deliberate change of mode, never on a rerender with
# the same mode. --no-block: session-chrome is ordered after this unit, and
# waiting for its restart from inside this unit's start would deadlock.
before="$(cat /etc/session-host/proxy.env 2>/dev/null || true)"
restart_chrome_if_mode_changed() {
  after="$(cat /etc/session-host/proxy.env 2>/dev/null || true)"
  if [ "$before" != "$after" ] && systemctl is-active -q session-chrome; then
    echo "[proxy-render] egress mode changed while Chrome ran: restarting Chrome — the sign-in must be done again"
    systemctl --no-block try-restart session-chrome
  fi
}

case "$code" in
  200) ;;
  404)
    rm -f /etc/session-host/proxy.env
    systemctl stop tinyproxy 2>/dev/null || true
    echo "[proxy-render] no session-host-proxy secret: direct egress"
    restart_chrome_if_mode_changed
    exit 0 ;;
  *) fail "Secret Manager answered HTTP $code (is roles/secretmanager.secretAccessor granted on session-host-proxy?)" ;;
esac

url="$(printf '%s' "$body" | jq -r '.payload.data' | base64 -d | tr -d '\r\n')"
case "$url" in
  http://*@*:*) ;;
  *) fail "the secret is not an http://user:pass@host:port URL" ;;
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
restart_chrome_if_mode_changed
