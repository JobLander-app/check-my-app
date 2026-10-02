# Shopify admin session host (CHE-378)

Phase B of CHE-333. The Shopify admin sign-in is behind a captcha, which we
never solve. A human signs in once on a host we own; agents then work inside
that session. Whether that is a product depends on one number nobody knows yet:
**how long the session lives, and how often Shopify challenges it again.** This
directory is the instrument that measures it.

## What runs where

| Piece | Where | What |
|---|---|---|
| `checkmyapp-session-host` | GCP `meet-assistant-6d8ad`, `europe-west1-b`, e2-medium, Debian 12, static IP `checkmyapp-session-host-ip` | Xvfb `:99` → Chrome with a persistent profile → x11vnc → noVNC |
| `session.checkmyapp.dev` | Cloudflare tunnel `checkmyapp-session-host` → `http://127.0.0.1:6080` | noVNC for the owner, behind Cloudflare Access (one-time PIN, `sorokinvj@gmail.com` only) |
| `session-api.checkmyapp.dev` | same tunnel → `http://127.0.0.1:9090` | the session server for checks (CHE-389), behind a Cloudflare Access service token — no person signs in there |
| `probe.mjs` | on the host, `session-probe.timer`, hourly | opens the app in one new tab of that Chrome, classifies, appends to `/var/lib/session-host/probe.jsonl` |
| `portability.mjs` | our side (an agent's machine), daily | copies the host's admin cookies into a fresh Cloudflare Browser Run session, appends to `/var/lib/session-host/portability.jsonl` |

Nothing on the host listens on a public address: Chrome DevTools (`9222`),
VNC (`5900`) and noVNC (`6080`) are bound to `127.0.0.1`. The project's
`default-allow-ssh`/`default-allow-rdp` rules apply to every VM in the network,
so this host carries the tag `checkmyapp-session-host`, which
`checkmyapp-session-host-deny-ingress` (priority 1000, deny all) and
`allow-iap-ssh` (priority 900, `35.235.240.0/20` tcp:22) apply to. SSH works
through IAP only (`gcloud compute ssh … --tunnel-through-iap`).

The VM's service account `checkmyapp-session-host@meet-assistant-6d8ad` has one
binding: `roles/secretmanager.secretAccessor` on the single secret
`checkmyapp-telegram-bot-token`. No project role. It cannot read the Shopify
login secrets — those are for the owner to type, never a script.

## Signing in (the owner, once)

Open https://session.checkmyapp.dev, get the PIN by mail, and you are looking at
the host's Chrome. Shopify may first show a Cloudflare "Verify you are human"
box; tick it yourself. Sign in as `vladislav@otp.plus`. Leave the tab open.
The probe opens a second tab for a few seconds every hour and closes it.

## The hourly probe

`playwright-core` attaches to the host's Chrome over CDP, opens one new tab on
`https://admin.shopify.com/store/prod-release-1/apps/easy-block-customer-ip-country`,
waits for the page to settle, closes that tab and only that tab. It never
closes or navigates the browser — that is the owner's session.

One JSON line per run:

```json
{"at":"2026-10-01T21:59:32.007Z","state":"captcha","url_host":"accounts.shopify.com","url_path":"/session-service/login","ms":5043,"challenge":"turnstile"}
```

| state | means |
|---|---|
| `ok` | still on `admin.shopify.com` and the embedded app's `iframe[name=app-iframe]` is there |
| `login_page` | on `accounts.shopify.com` with the sign-in form, or any accounts page that is not a challenge |
| `captcha` | a challenge standing on its own: hCaptcha or Cloudflare Turnstile (`challenge` says which). On `accounts.shopify.com` it stands in front of the sign-in; on `admin.shopify.com` it is a re-challenge inside a live session — `url_host` keeps those apart |
| `2fa` | a one-time-code step |
| `error` | the probe could not tell (Chrome down, timeout, anything unexpected); `detail` has the first line of the error |

The query string is never logged (it can carry tokens), and neither is any
page text.

**Telegram.** On the way down from `ok` the probe sends the owner one message
through `@checkmyapp_bot` (chat `101333337`) with the link to sign in again,
and records `"notified": true` on that line. No message for the state the host
starts in (nobody has signed in yet), none for a single `error` (two in a row
count), and none again until the session has been `ok` again. A failed send is
recorded as `"notified": false` with `notify_error` and retried next hour. The
rules are pure functions in `classify.mjs`, checked by
`npm run verify:shopify-session`.

The message goes straight to the Bot API from the VM, so it is not recorded in
D1 `TelegramMessage` the way `npm run tg:send` messages are.

## The daily portability probe

```
node --env-file=.env spikes/shopify-session/portability.mjs
```

from the check-my-app checkout (it needs `CLOUDFLARE_API_TOKEN` with Browser
Rendering - Edit, and `gcloud` signed in with IAP access to the VM). It opens
an IAP SSH tunnel to the host's DevTools, reads the cookies `admin.shopify.com`
would be sent with one raw `Storage.getCookies` call, closes the tunnel, and
opens the same URL in a new context of a Cloudflare Browser Run session
(`wss://api.cloudflare.com/client/v4/accounts/{id}/browser-run/devtools/browser`)
holding those cookies. The cookies stay in that process's memory: they are not
written to disk off the VM and not logged — the line carries a count.

```json
{"at":"2026-10-01T22:02:27.746Z","kind":"portability","state":"login_page","accepted":false,"cookies":2,"url_host":"accounts.shopify.com","url_path":"/lookup","ms":10925}
```

`accepted` is meaningful only for an hour in which the host's own probe line is
`ok`.

The host side deliberately does not use Playwright: `connectOverCDP` turns on
target auto-attach with `waitForDebuggerOnStart`, and the IAP tunnel's sshd
kept that connection open after the script exited — every tab opened afterwards
sat paused at `about:blank`, and the hourly probe logged `page.goto: Timeout`
twice before this was found. `provision.sh` also sets sshd `ClientAlive*` so a
dead tunnel is dropped within ~45 s.

The agent's Mac runs it daily from cron (10:17 local; `crontab -l`), from the
main checkout, once this directory is on `main` there. Output goes to
`~/Library/Logs/checkmyapp-session-portability.log`.

## The session server (CHE-389)

Phase C's host half: the way a check gets to work inside this Chrome.
`session-server.mjs` runs as `session-server.service`, listens on
`127.0.0.1:9090`, and is published as `session-api.checkmyapp.dev` through the
same tunnel, behind a Cloudflare Access application that admits one **service
token** and no person. Past Access, every request also needs the server's own
bearer token. The agent Worker holds both; nobody types either.

| | |
|---|---|
| `GET /state` | who holds the lease, whether a check is connected, Chrome's version, the last probe line (`at`, `state`) |
| `POST /lease` `{ownerRunId, maxDurationSeconds}` | take or renew (60–1800 s) → `{sessionId, expiresAt, browser}`; `409` with `heldUntil` while another run holds it; `503` if Chrome is down |
| `DELETE /lease` `{ownerRunId}` | give it back; the tabs the check opened are closed before the answer |
| `WS /v1/devtools/browser/<sessionId>` | DevTools — the address shape the extension runner serves, so `@cloudflare/playwright`'s `connect({fetch}, {sessionId})` works unchanged |

What the server holds a check to (`lease.mjs`, checked by
`scripts/verify-session-server.mjs` against a real Chrome with a persistent
profile):

- **One check at a time.** A run takes the lease at each phase; the same run
  taking it again renews it and keeps its session id.
- **A check ends nothing it did not start.** `Browser.close` only disconnects
  the check. Closing a tab the check did not open, disposing a context it did
  not make, and anything that clears or rewrites cookies or site storage are
  refused with a DevTools error. Reading is not restricted.
- **A check leaves nothing behind.** Its tabs — and the tabs those opened — are
  closed when it disconnects, when its connection dies or goes silent (two
  missed 20 s beats), when its lease runs out, and when the same run connects
  again. This is not tidiness: an abandoned Playwright connection leaves every
  new tab paused at `about:blank` (see the portability note above).

A check works in the profile's own context and its own new tab. It can see the
person's tab — Playwright attaches to every tab, as the hourly probe already
does — and must not drive it; the Worker side never takes a page it did not
open.

**Secrets** (GCP Secret Manager, project `meet-assistant-6d8ad`; on the host
only the first, in `/etc/session-host/server.env`, root, 0600):
`checkmyapp-session-server-token`, `checkmyapp-session-access-client-id`,
`checkmyapp-session-access-client-secret`. The Access service token
(`checkmyapp-agent-session`) **expires 2027-10-02**; Access answers 401 after
that, and every check of a signed-in app would stop at our own door.

Proven through the tunnel on 2026-10-02, from outside Cloudflare: no token →
Access 401; the bearer alone → Access 401; the Access token alone → the
server's 401; both → a lease, a second run refused with 409, Playwright
connected in 0.4 s, its own tab opened on the admin (and, nobody being signed
in yet, landed on `accounts.shopify.com`), a screenshot came back, clearing
cookies was refused, and after the check left the host had the one tab it
started with.

A look from a desk, without the tunnel:

```
gcloud compute ssh checkmyapp-session-host --tunnel-through-iap --zone europe-west1-b \
  --project meet-assistant-6d8ad --command \
  'sudo bash -c ". /etc/session-host/server.env; curl -s -H \"Authorization: Bearer \$SESSION_SERVER_TOKEN\" http://127.0.0.1:9090/state"'
```

## Reading the result

```
gcloud compute ssh checkmyapp-session-host --zone europe-west1-b \
  --project meet-assistant-6d8ad --tunnel-through-iap \
  --command 'sudo cat /var/lib/session-host/probe.jsonl /var/lib/session-host/portability.jsonl'
```

Session lifetime is the span of consecutive `ok` lines after a sign-in;
re-challenges are `captcha`/`2fa` lines with `url_host` `admin.shopify.com`, or
a drop to `accounts.shopify.com` while nobody signed out. Two things can
disturb the measurement, and the log keeps what is needed to see them: the
portability probe presents the same cookies from a Cloudflare IP once a day (a
drop within the hour after a portability line is suspect), and the hourly probe
itself drives the browser over CDP.

Gate for Phase C (CHE-333): at least 7 days with at most one re-challenge a
week → build the runner, in our cloud if the cookies are portable, otherwise on
this host.

## Setting it up again

```
gcloud compute scp --recurse --tunnel-through-iap --zone europe-west1-b \
  --project meet-assistant-6d8ad spikes/shopify-session checkmyapp-session-host:~/
gcloud compute ssh checkmyapp-session-host --tunnel-through-iap --zone europe-west1-b \
  --project meet-assistant-6d8ad --command 'sudo bash ~/shopify-session/provision.sh'
```

`provision.sh` is idempotent: packages (Chrome, Xvfb, x11vnc, noVNC/websockify,
Node 22, cloudflared), the `session-host` user, the noVNC index, the probe and
its `playwright-core`, every unit in `systemd/`.

**Tunnel token.** The tunnel is remotely managed (ingress
`session.checkmyapp.dev` → `http://127.0.0.1:6080`, then `http_status:404`). Its
token is fetched from the Cloudflare API
(`GET /accounts/{id}/cfd_tunnel/{tunnel}/token`) and piped over SSH straight
into `/etc/cloudflared/tunnel.env` (`TUNNEL_TOKEN=…`, root, 0600) — never
printed, never in this repo, never in a unit file.

## Cost

e2-medium in europe-west1 ≈ $26.9/month ($0.0369/h on demand), 30 GB balanced
disk ≈ $3.3, static IP in use ≈ $3.6 → about **$34/month**. Cloudflare Tunnel and Access (Zero Trust
free plan) cost nothing; one Browser Run session a day is a minute of browser
time.

## Taking it down

Delete the VM, the address `checkmyapp-session-host-ip`, the firewall rules
`allow-iap-ssh` and `checkmyapp-session-host-deny-ingress`, the service
account; in Cloudflare the tunnel, the `session` and `session-api` CNAMEs, both
Access applications and the service token `checkmyapp-agent-session`; the three
`checkmyapp-session-*` secrets; and the cron line on the agent's Mac.
