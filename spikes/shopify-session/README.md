# Shopify admin session host (CHE-378)

Phase B of CHE-333. The Shopify admin sign-in is behind a captcha, which we
never solve. A human signs in once on a host we own; agents then work inside
that session. Whether that is a product depends on one number nobody knows yet:
**how long the session lives, and how often Shopify challenges it again.** This
directory is the instrument that measures it.

## What runs where

| Piece | Where | What |
|---|---|---|
| `checkmyapp-session-host` | GCP `meet-assistant-6d8ad`, `europe-west1-b`, e2-medium, Debian 12, static IP `checkmyapp-session-host-ip` | Xvfb `:99` → Chrome with a persistent profile (`/var/lib/session-browser/profile`) → x11vnc → noVNC. The first three run as `session-browser`, which `firewall.nft` keeps off the host's own ports; the rest as `session-host` |
| `session.checkmyapp.dev` | Cloudflare tunnel `checkmyapp-session-host` → `http://127.0.0.1:6080` | noVNC for the owner, behind Cloudflare Access (one-time PIN; policy "Owner only": `sorokinvj@gmail.com`, `vladislav@otp.plus`) |
| `session-api.checkmyapp.dev` | same tunnel → `http://127.0.0.1:9090` | the session server for checks (CHE-389), behind a Cloudflare Access service token — no person signs in there |
| `probe.mjs` | on the host, `session-probe.timer`, hourly | opens the app in one new tab of that Chrome, classifies, appends to `/var/lib/session-host/probe.jsonl` |
| `portability.mjs` | our side (an agent's machine), daily | copies the host's admin cookies into a fresh Cloudflare Browser Run session, appends to `/var/lib/session-host/portability.jsonl` |
| `door.mjs` | on the host, `session-door.path` → `session-door.service`, on every accepted VNC viewer | leaves the person one live tab: the admin if signed in, a sign-in form younger than 20 min if they are mid-sign-in, otherwise a fresh tab on the store (CHE-419); appends to `/var/lib/session-host/door.jsonl`; does nothing while a check holds the lease |
| `proxy-render.sh` | on the host, `session-proxy.service`, before Chrome | residential egress (CHE-333): reads `session-host-proxy` from Secret Manager, renders tinyproxy on `127.0.0.1:3128` forwarding everything upstream, and hands Chrome `--proxy-server` through `/etc/session-host/proxy.env` (`session-chrome.service.d/proxy.conf`). No secret → direct egress |

The VM's own address is Google Cloud's, and Cloudflare challenges it on
accounts.shopify.com in a loop — for a person as much as for a script
(2026-10-04). Through the residential egress (IPRoyal, Germany, sticky 7 days,
bought by the owner) the plain sign-in form appears.

It is this machine's egress, so everything in this Chrome goes through it: the
person's sign-in and the checks that run inside the signed-in session (CHE-389
— a session check opens its tab in this same browser, and a Shopify session is
used from the network it lives on). That is the same as the PoC on the owner's
Mac, where the checks went out through his home connection. What never uses a
proxy is the checker's own browser: Cloudflare Browser Rendering contexts, for
every ordinary check, are refused one in code. The firewall lets
`session-browser` open exactly one local port, `3128`, and tinyproxy forwards
nothing locally.

Switching the mode — adding the secret or removing it — restarts Chrome
(`proxy-render.sh`): a running Chrome keeps the `--proxy-server` it started
with. That ends the sign-in. A new upstream URL in the same mode does not.

Nothing on the host listens on a public address: Chrome DevTools (`9222`),
VNC (`5900`) and noVNC (`6080`) are bound to `127.0.0.1`. The project's
`default-allow-ssh`/`default-allow-rdp` rules apply to every VM in the network,
so this host carries the tag `checkmyapp-session-host`, which
`checkmyapp-session-host-deny-ingress` (priority 1000, deny all) and
`allow-iap-ssh` (priority 900, `35.235.240.0/20` tcp:22) apply to. SSH works
through IAP only (`gcloud compute ssh … --tunnel-through-iap`).

The VM's service account `checkmyapp-session-host@meet-assistant-6d8ad` has two
bindings, both `roles/secretmanager.secretAccessor` on a single secret:
`checkmyapp-telegram-bot-token` (the probe's message) and `session-host-proxy`
(the residential egress, read by `proxy-render.sh`). No project role. It cannot
read the Shopify login secrets — those are for the owner to type, never a
script. A host rebuilt from scratch needs the second binding again:

```bash
gcloud secrets add-iam-policy-binding session-host-proxy --project meet-assistant-6d8ad \
  --member serviceAccount:checkmyapp-session-host@meet-assistant-6d8ad.iam.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor
```

Without it `proxy-render.sh` fails loudly (HTTP 403) and `provision.sh` fails
with it; a missing secret (404) means direct egress on purpose.

## Signing in (the owner, once)

Open https://session.checkmyapp.dev, get the PIN by mail, and you are looking at
the host's Chrome — on a fresh sign-in form (`door.mjs` replaces a stale one
when you connect). Sign in as `vladislav@otp.plus`:

- Shopify offers a passkey first ("Insert your security key"). There is no key
  on this machine: **Cancel**, then **Log in using a different method** →
  password.
- Paste works as on the Mac: copy the password locally, click into the screen,
  **Cmd+V**. x11vnc maps Cmd to Ctrl (`-remap`), and noVNC (pinned upstream
  commit with `core/clipboard.js`) hands the local clipboard to the screen when
  it gets focus. The side panel's clipboard box still works as a fallback.
- If Shopify shows a Cloudflare "Verify you are human" box, tick it yourself —
  through the residential egress it has not appeared since 2026-10-05.

Leave the tab open. The probe opens a second tab for a few seconds every hour
and closes it.

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
  taking it again renews it and keeps its session id. Connections for one
  session id are admitted one after another; the latest takes over.
- **A check has its own tabs and nothing else.** It is never told the person's
  tab exists (no attach event, not in `Target.getTargets`), cannot attach to
  it, and nothing it sends on a DevTools session it was not given is forwarded.
  At the level of the browser it may say `Browser.getVersion` and the
  `Target.*` commands that open, list and close its own tabs and contexts;
  everything else there is refused. `Browser.close` only disconnects it.
- **Inside its own tab a check does what a page can do, and no more.** Refused
  there: the cookie jar under every name (reading as well as writing), every
  DevTools domain outside the page-scope list below, the `Browser` domain, and
  a self-written response carrying `Set-Cookie`.
- **The session's cookies never leave the host as values.** The `Cookie` and
  `Set-Cookie` headers and the cookie lists DevTools reports beside each request
  are replaced with `[redacted]` before they reach the check — in events and in
  the answers to `Network.*` / `Fetch.*` commands alike.
- **The server watches tabs come and go itself.** Target discovery is switched
  on by the server on every connection and is not the check's to switch off
  (its own `Target.setDiscoverTargets` only decides what it is told): that
  watch is how a tab opened by a check's tab is known to be the check's.
- **A check leaves nothing behind.** Its tabs — the tabs those opened, and any
  browser context it made — are closed when it disconnects, when its connection
  dies or goes silent (two missed 20 s beats), when its lease runs out, and when
  the same run connects again. This is not tidiness: an abandoned Playwright
  connection leaves every new tab paused at `about:blank` (see the portability
  note above). A tab that is not the check's and opens while it is connected is
  started and let go at once.

- **A page in this Chrome cannot reach this host.** Chrome, its display and
  the VNC server that reads the display run as `session-browser`; `firewall.nft`
  refuses that user every connection it opens to loopback, link-local (the
  metadata server, except its DNS port) and private addresses. Without it any
  page — a check's or the person's — could open `127.0.0.1:9222/json/close/<id>`
  and close the person's tab past the gate, drive the screen through the
  passwordless VNC, or read the VM's service-account token. The probe, the
  session server and websockify run as `session-host` and are not restricted.
  `provision.sh` ends by trying each of these as the browser's user and fails
  if any is reachable (or if the public web is not).
- **An address a check asks for must be the web's.** Any command's `url` —
  `Page.navigate`, `Target.createTarget`, `Network.loadNetworkResource`,
  `Fetch.continueRequest` — is `http(s):`, `data:`, `blob:` or `about:blank`.
  A navigation asked for through DevTools is the browser's own and would
  otherwise open `chrome://quit`, `chrome://settings/clearBrowserData` or
  `file:///…`.
- **No file from this host reaches a page** (`DOM.setFileInputFiles`, a drop
  carrying file paths): the profile's own cookie database is a file. Where
  downloads go is not the check's to set (`Page.setDownloadBehavior` is
  answered and not passed on, like its browser-level twin).
- **Page scope is a list of domains, not of forbidden methods**: `Page`,
  `Runtime`, `DOM`, `DOMSnapshot`, `CSS`, `Input`, `Emulation`, `Network`,
  `Fetch`, `Log`, `Console`, `Accessibility`, `Overlay`, `Performance`, `IO`.
  `DOMStorage`, `IndexedDB`, `CacheStorage`, `ServiceWorker`, `Storage`,
  `Security` and the rest take an origin by name or act on the profile, and are
  refused.

What this layer does not stop, by design: a page can sign itself out. A check
that walks its own tab to the logout address, or clicks "Log out", ends the
session like any visitor would. That is the tool-level guard's rule for a run
of this kind (the Worker half of CHE-389), not the gate's.

Every refusal is logged by method and scope (`journalctl -u session-server`) —
the first place to look when a client that worked stops working.

**Secrets** (GCP Secret Manager, project `meet-assistant-6d8ad`; on the host
only the first, in `/etc/session-host/server.env`, root, 0600):
`checkmyapp-session-server-token`, `checkmyapp-session-access-client-id`,
`checkmyapp-session-access-client-secret`. The Access service token
(`checkmyapp-agent-session`) **expires 2027-10-02**; Access answers 401 after
that, and every check of a signed-in app would stop at our own door.

Proven through the tunnel on 2026-10-02, from outside Cloudflare: no token →
Access 401; the bearer alone → Access 401; the Access token alone → the
server's 401; both → a lease, a second run refused with 409, Playwright
connected, saw no tab but its own, its own tab opened on the admin (and, nobody
being signed in yet, landed on `accounts.shopify.com`), a screenshot came back,
reading and clearing cookies were refused, and after the check left the host
had the one tab it started with.

A look from a desk, without the tunnel:

```
gcloud compute ssh checkmyapp-session-host --tunnel-through-iap --zone europe-west1-b \
  --project meet-assistant-6d8ad --command \
  'sudo bash -c ". /etc/session-host/server.env; curl -s -H \"Authorization: Bearer \$SESSION_SERVER_TOKEN\" http://127.0.0.1:9090/state"'
```

## A run through the session (CHE-389, Worker half)

An app whose kind is `session` is checked in this browser: every phase of its
run takes the lease (`POST /lease` under the run's id), connects, opens tabs of
its own in the profile's context and closes them; the run gives the lease back
at its end (`src/agent/session-browser.ts`, `browser.ts`, `workflow.ts`). Such
a run takes no shortcut that looks at the app from outside the session — no
page survey, no smoke replay, no replay audit — because from outside it is a
sign-in page.

The agent Worker reaches the server with `SESSION_HOST_URL` (a var in
`wrangler-agent.jsonc`) and three secrets — `SESSION_ACCESS_CLIENT_ID`,
`SESSION_ACCESS_CLIENT_SECRET`, `SESSION_SERVER_TOKEN` — copied from Secret
Manager with `wrangler secret put … --config wrangler-agent.jsonc`. **Putting
a secret is a rollout of the Worker: only with no run in flight.**

Marking an app (there is no public switch for this yet — one statement on our
own app's row):

```
wrangler d1 execute checkmyapp --remote --command \
  "UPDATE App SET targetKind='session' WHERE id='<app id>' AND teamId='<our team>'"
```

`scripts/verify-session-browser.ts` runs the Worker's `SessionBrowser` and the
`browser.ts` helpers against this directory's real server and a real Chrome;
the one thing it cannot run is `@cloudflare/playwright`'s own transport, which
is proven by the first live run (watch `journalctl -u session-server` for a
refused DevTools method).

### When the sign-in has ended

A sign-in does not last: the product expires it or asks again. The app's
address then leads to the product's sign-in on another host, and a run that
went on would map and walk that page as if it were the app. So the surface scan
decides it (`src/agent/signed-out.ts`): in a session, an address that ends on an
origin that is neither the app's nor one allowed for it ends the run there —
Not verified, nothing spent, nothing charged, access named as what is missing.

The person who signs in is told **once per ended sign-in**, in the owner's
chat, however many runs meet the same sign-in page; the message's id is the
app and the last run of it that got in. That needs two secrets on the agent
Worker, `TELEGRAM_BOT_TOKEN` and `OWNER_TELEGRAM_CHAT_ID` (Secret Manager:
`checkmyapp-telegram-bot-token`; the chat id is in the owner-channel skill).
Without them nothing is sent and the run ends the same way. Where to sign in is
the var `SESSION_SIGN_IN_URL`. Guard: `npm run verify:signed-out`, and the
scan on a real browser in `verify:session-browser`.

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
Node 22, cloudflared, nftables), the `session-host` and `session-browser` users,
the firewall rules, the noVNC index, the probe and
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
