# Shopify session browser (CHE-464)

The Shopify admin's sign-in is behind a captcha, which we never solve. A person
signs in once; checks of their Shopify app then work inside that signed-in
browser. Every team has a browser of its own: a Cloudflare Container
(`SessionRunner`, `src/agent/session-runner.ts`), one Durable Object per team,
named by the team's id. This directory is what runs in it.

History: CHE-378 measured on a GCP VM how long such a sign-in lives (7 days,
zero re-sign-ins); CHE-461 showed the sign-in is three `.shopify.com` cookies
that open the admin in a never-used Chrome on any machine and address; CHE-464
moved every team's browser into containers and retired the VM on 2026-10-13.

## What runs in a team's container

`runner.mjs`, in order:

1. **Xvfb** on `:99`.
2. **`forwarder.mjs`** on `127.0.0.1:3128`: a credential-free forward proxy
   to the residential upstream (IPRoyal, the agent worker's `SESSION_PROXY_URL`,
   Secret Manager `session-host-proxy`). Each team gets its own sticky session
   (`_session-<8>` derived from the team's id). The upstream's own 402/407 is
   passed back, so the probe can tell an outage from an ended sign-in.
3. **google-chrome-stable as a plain process** with the flags the VM ran it
   with, a profile that lives as long as the container, and `about:blank`.
   Chromium launched by Playwright gets Cloudflare's Turnstile; this does not
   (CHE-461 round 2). Playwright only ever attaches over DevTools afterwards.
   Chrome gets an environment of its own: no secret is in it.
4. **`session-server.mjs`** on `:9090` and **`viewer.mjs`** on `:9091`.

The image: `Dockerfile` (the Playwright noble base, Chrome from Google's apt
repository). `.github/workflows/session-runner-image.yml` builds and boots it on
every pull request that changes this directory.

## The team's sign-in is its cookie jar

`jar-rules.mjs` (Shopify's cookies only, never a value said — `describeJar`)
and `jar.mjs` (one DevTools command to the browser for each move). The Durable
Object keeps the jar sealed with `SESSION_JAR_KEY` (AES-GCM, the team's id as
associated data). It goes into every fresh Chrome before the server gives
anything a lease (`PUT /jar`; `/lease` and `/probe` answer 503 until then), and
is read back after every check (`DELETE /lease`), probe and sign-in (`GET
/jar`). A jar without `_merchant_essential` never replaces one that has it.
Values are never logged and never leave the Durable Object and the container.

## Who reaches it

Only the team's Durable Object, with a bearer it makes for each start:

- **A check** (`src/agent/session-browser.ts sessionHost(bindings, teamId)`):
  `POST/DELETE /lease`, then DevTools at `/v1/devtools/browser/<sessionId>` —
  the address shape the extension runner serves, so the Worker's
  `@cloudflare/playwright` `connect` works unchanged.
- **A person on the sign-in page** (`checkmyapp.dev/health/apps/<appId>/sign-in`):
  `wss://live.checkmyapp.dev/session/view` (`src/agent/session-routes.ts`). The
  token is signed with the team's own view key (`src/lib/session-view.ts
  viewKeyFor`, an HMAC of `SESSION_VIEW_SECRET` and the team's id — a container
  never holds the secret), checked by the Worker before anything wakes and
  again by the viewer. The viewer shows one tab (`door.mjs` picks it: the
  admin if signed in, a fresh sign-in otherwise), sends frames out and the
  person's mouse, keys and pasted text in, and suppresses the passkey prompt
  with a keyless virtual authenticator. While a person is in, no check gets the
  lease; while a check holds it, the person is told to come back.
- **Us** (agent worker, `Authorization: Bearer $SESSION_ADMIN_TOKEN`, Secret
  Manager `checkmyapp-session-admin-token`): `GET /session/state?teamId=…` —
  running, when the jar was kept and why, the next probe. Never a value.

## What the server holds a check to

`lease.mjs`, checked by `scripts/verify-session-server.mjs` against a real
Chrome with a persistent profile:

- **One check at a time.** A run takes the lease at each phase; the same run
  taking it again renews it and keeps its session id. Connections for one
  session id are admitted one after another; the latest takes over.
- **A check has its own tabs and nothing else.** It is never told another tab
  exists (no attach event, not in `Target.getTargets`), cannot attach to one,
  and nothing it sends on a DevTools session it was not given is forwarded. At
  the level of the browser it may say `Browser.getVersion` and the `Target.*`
  commands that open, list and close its own tabs and contexts; everything else
  there is refused. `Browser.close` only disconnects it.
- **Inside its own tab a check does what a page can do, and no more.** Refused
  there: the cookie jar under every name (reading as well as writing), every
  DevTools domain outside the page-scope list, the `Browser` domain, and a
  self-written response carrying `Set-Cookie`.
- **The session's cookies never reach a check as values.** `Cookie` and
  `Set-Cookie` headers and the cookie lists DevTools reports beside each
  request are replaced with `[redacted]`, in events and in answers alike.
- **A check leaves nothing behind.** Its tabs — and the tabs those opened, and
  any context it made — are closed when it disconnects, when its connection
  dies or goes silent (two missed 20 s beats), when its lease runs out, and
  when the same run connects again.
- **An address a check asks for must be the web's** (`http(s):`, `data:`,
  `blob:`, `about:blank`), **no file reaches a page** (`DOM.setFileInputFiles`,
  a drop carrying paths), and where downloads go is not the check's to set.

What this layer does not stop, by design: a page can sign itself out. That is
the tool-level guard's rule for a run of this kind (`session-browser.ts`
`signOutIn`), not the gate's.

DevTools listens on loopback only; the server and the viewer, which listen
wider, answer nobody without the bearer or a view token.

## The hourly probe

The Durable Object's `schedule`: wake the browser, give it the jar, `POST
/probe` (`probe.mjs` in a process of its own: one new tab on the team's first
Shopify app, `classify.mjs observe()`, the tab closed), keep the jar, one row
in D1 `SessionProbe`, the browser back to sleep. On the way down from `ok` the
owner hears once (`classify.mjs shouldNotify` over everything since the last
`ok`; `src/agent/session-jar.ts recordProbe`). The scheduler tick re-arms a
lost alarm; a team with no Shopify app left stops its probe and drops its jar.

| state | means |
|---|---|
| `ok` | on `admin.shopify.com` with the embedded app's `iframe[name=app-iframe]` |
| `login_page` | the sign-in form, or any accounts page that is not a challenge |
| `captcha` | a challenge standing on its own (`challenge`: hCaptcha or Turnstile); `url_host` tells the sign-in path from a re-challenge inside the admin |
| `2fa` | a one-time-code step |
| `error` | the probe could not tell (two in a row count as a drop) |
| `proxy` | the residential proxy refused to carry it: 402 out of traffic, 407 credentials |

```
wrangler d1 execute checkmyapp --remote --command \
  "SELECT at, state, urlHost, notified FROM SessionProbe WHERE teamId = '<team>' ORDER BY at DESC LIMIT 24"
```

## When a sign-in has ended

A check that meets the sign-in page ends there — Not verified, nothing spent,
nothing charged (`src/agent/signed-out.ts`) — and the owner's chat is told
once per ended sign-in, with the app's sign-in page. The person signs in there;
the jar is kept while they are in and once after, and the probe sees it back.

## Cost

`standard-3` (2 vCPU, 8 GiB). Billing stops while a team's browser sleeps: a
probe is a minute or two an hour, a check its own length. The residential
traffic is IPRoyal's, topped up through its API (`iproyal-api-token`).
