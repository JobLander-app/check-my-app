# CheckMyApp

> Paste a link. We'll show you your app.

**Prod: https://checkmyapp.dev**

CheckMyApp takes the URL of a (often vibe-coded) web app plus optional test
credentials and, within ~20–30 minutes, returns a **product mirror**: the user
journeys it discovered, the app anatomy it mapped, and the bugs/risks/exposures
it found along the way — on a shareable verdict page. Optionally, **Daily
Watch** re-runs on a schedule and alerts on regressions.

It is **not** a generic QA tool. It's a *product mirror with QA fallout* — that
distinction drives every UI decision. Evidence is first-class: a step or
finding without verifiable artifacts isn't trusted.

## The three loops

- **Loop A — One-off Check:** submit URL → agent maps the app → walks
  discovered journeys → produces a verdict page (App Lens + User Journeys +
  App Anatomy + Findings + generated Playwright specs).
- **Loop B — Daily Check:** after the first run, enable "Watch this app daily";
  the agent re-runs the same journeys and diffs against the baseline.
- **Loop C — Feedback:** mark findings (known / fixed / false positive) and
  edit the App Lens; Daily Check uses these to filter noise.

## Screens

| # | Route            | Screen           | Notes |
|---|------------------|------------------|-------|
| 1 | `/`              | Submit           | test creds + notify email behind "Add login & notes" |
| 2 | `/run/{id}`      | In-progress      | live SSE theatre: feed + agent's browser screenshot |
| 3 | `/verdict/{id}`  | Verdict          | App Lens, journeys, anatomy, findings, specs |
| 4 | `/watch/{slug}`  | Watch settings   | history, frequency, notify, pause |
| 5 | `/dashboard`     | Owner home       | Clerk-protected; apps under daily QA |
| 6 | `/onboarding`    | Add app wizard   | target + creds + urgent journeys + Linear |

## Architecture (Cloudflare, two workers)

```
Browser ──POST /api/checks──▶ checkmyapp-web (Next.js via OpenNext)
   ▲                              │ CHECK_RUN.create()  (cross-worker binding)
   │  SSE /api/runs/{id}/stream   ▼
   └───────────────────── checkmyapp-agent · CheckRunWorkflow (durable)
                                  │
             6 phases: connecting → surface_scan → discovery
                       → walking (per journey) → anatomy → writing
                                  │            │             │
                          Browser Rendering   R2 (evidence) Anthropic /
                          (@cloudflare/       screenshots/  OpenRouter, see
                           playwright)        transcripts   model-tier.
                                                             recommended.json
                                  │
                                 D1 (Prisma, workerd client, adapter-d1)
```

- **Web worker** (`src/app`) — Next.js App Router + Tailwind + Clerk. Thin:
  accept submissions, stream progress, render verdicts from D1, proxy evidence
  from private R2 (`/api/evidence`).
- **Agent worker** (`src/agent`) — the durable `CheckRunWorkflow`:
  `workflow.ts` orchestrates phases; `discovery.ts` / `execution.ts` /
  `synthesis.ts` do the work; `tools.ts` owns the Playwright toolbelt
  (hydration-robust click/fill, network-delta feedback, secret scrubbing);
  `browser.ts` owns Browser Rendering sessions.
- **Data model** (`prisma/schema.prisma`) — `Run` → `Journey` → `Step` +
  `Finding` (+ `Evidence` on both), `Watch` for recurring runs; M3 adds
  `User`/`App`/`TrackerIntegration`/`TicketPolicy`/`IssueLink` for owner
  accounts and per-owner QA→Linear. D1/SQLite: JSON columns are TEXT
  (parse on read — `src/lib/json.ts`), enums are strings (`src/lib/enums.ts`).

## Getting started (local)

```bash
cp .env.example .env        # fill ANTHROPIC_API_KEY, CREDENTIALS_SECRET, Clerk keys
npm install
npx prisma generate
npm run db:migrate:local    # D1 (miniflare) schema in .wrangler/state
npm run db:seed:local       # optional demo data
```

Two ways to run:

**Testing / prod-like (recommended): one wrangler runtime, both workers**

```bash
npm run dev:cf              # opennextjs build + wrangler dev -c web -c agent
```

Web app on **http://localhost:8787** (wrangler's port). Real cross-worker
`CHECK_RUN` binding, no proxy sockets. No HMR — rebuild to pick up changes.

**UI development (HMR): two processes**

```bash
npm run agent:dev           # wrangler dev, MUST own port 8787
npm run dev                 # next dev on :3000
```

In `next dev` there is no cross-worker binding — `src/lib/trigger.ts` falls
back to POST `localhost:8787/trigger` (override: `AGENT_DEV_URL`). Known traps:

- If something stale holds 8787, wrangler silently takes 8788 and every submit
  hangs. `lsof -nP -iTCP:8787 -sTCP:LISTEN` before starting.
- The platform-proxy D1 socket (`initOpenNextCloudflareForDev`) can die
  (Prisma `WASM_ERROR: ECONNRESET` on every query) — restart `next dev`.
- Locally-run Workflows do **not** resume after the agent process restarts —
  an in-flight run dies with its wrangler session. Prod Workflows are durable.

## Configuration

See `.env.example` (Cloudflare runtime gets these as worker secrets/vars, not
.env — see DEPLOY.md). Key vars: `ANTHROPIC_API_KEY`,
`ANTHROPIC_NAV_MODEL`/`ANTHROPIC_SYNTH_MODEL`/`ANTHROPIC_JUDGE_MODEL` — the
recommended tier is `src/agent/model-tier.recommended.json`, checked against
`.env.example` by `scripts/verify-model-config.mjs`; see COSTS.md
"Recommended tier config" for how it's decided — `CREDENTIALS_SECRET`
(AES-256-GCM for test creds at rest), Clerk keys,
`LINEAR_CLIENT_ID/SECRET` (per-owner tickets), `EMAIL_API_KEY`/`EMAIL_FROM`
(Resend; unset = log-only), Turnstile keys (bot protection, enforced when set).

## Deploy

See `DEPLOY.md`. Short version: `wrangler d1 migrations apply checkmyapp
--remote` → deploy agent (defines the Workflow) → OpenNext build + deploy web.
CF account: 491c3148 (workers.dev subdomain `frosty-fog-32a2`); prod domain
`checkmyapp.dev` is a custom domain on `checkmyapp-web`.

## Privacy & safety

Test credentials: encrypted at rest, substituted server-side (the LLM only sees
`{{TEST_EMAIL}}`/`{{TEST_PASSWORD}}` placeholders), scrubbed from logs and
transcripts, blurred in screenshots, refused off the target origin, cleared
after terminal runs unless a Watch retains them. Evidence R2 is private and
proxied through the web worker; verdict permalinks are unguessable.

## MCP — checks from agentic frameworks

The agent is CheckMyApp's primary interface (CHE-315). A hosted, stateless
Streamable-HTTP MCP server at `https://checkmyapp.dev/mcp` manages everything
an owner does on the dashboard — apps, test logins, scenarios, checks,
recurring checks, results — scoped to the API key's team:

```bash
claude mcp add --transport http checkmyapp https://checkmyapp.dev/mcp \
  --header "Authorization: Bearer cma_…"
```

Tools: `list_apps`, `create_app`, `update_app`, `start_check` (by `app_id` or
`url`), `get_check_status`, `wait_for_run`, `wait_for_review`, `get_verdict`,
`get_review`, `latest_results` (what is new since the previous check),
`enable_watch`, `disable_watch`. `mcp/server.ts` is a stdio bridge to the same
server for clients without HTTP transport. Details in
[mcp/README.md](mcp/README.md).

The canonical post-deploy loop: your agent calls
`start_check{app_id, deploy_sha, notes: "PR #123 touched checkout — verify it first"}`
→ `wait_for_run` (repeat while `timed_out`) → on a `needs_attention`/`broken`
verdict, `get_review` and fix what it names. The same API is curl-able without
MCP: `POST /api/checks`, `GET /api/runs/{id}`, `GET /api/runs/{id}/verdict`.

App review on a PR preview — the agent-facing loop (`get_review` /
`wait_for_review`, `ephemeral: true`) — ships as a Claude Code skill in
[.claude/skills/app-review/SKILL.md](.claude/skills/app-review/SKILL.md).

## Webhooks — plug into any monitoring stack

Per-app outbound integrations (CHE-53), configured on the dashboard app card:
a generic webhook and/or a Slack incoming webhook. Both fire after **every**
completed watch run — not just on change — because a monitoring feed that
skips quiet runs is indistinguishable from a dead one. Consumers filter on
`changed`. Delivery is best-effort (10s timeout, one retry on network error);
outcomes land in the run's event feed.

Payload (`POST`, `Content-Type: application/json`):

```json
{
  "event": "run.completed",
  "app": "joblander.app",
  "runNumber": 42,
  "verdict": "needs_attention",
  "previousVerdict": "all_good",
  "changed": true,
  "bottomLine": "Login works, but checkout 500s on mobile Safari.",
  "findings": [
    { "title": "Checkout 500s on mobile Safari", "category": "broken", "severity": "high" }
  ],
  "verdictUrl": "https://checkmyapp.dev/verdict/cmf1abc…",
  "completedAt": "2026-08-22T09:15:00.000Z"
}
```

`findings` is capped at the 10 worst (severity-first). If you set a signing
secret, each request carries `X-CheckMyApp-Signature: sha256=<hex>` — the
HMAC-SHA256 of the raw body. Verify it:

```js
// Node
const crypto = require("node:crypto");
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
```

```js
// Cloudflare Workers / anything with Web Crypto
const key = await crypto.subtle.importKey(
  "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
const hex = signature.replace(/^sha256=/, "");
const sig = new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));
const ok = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(rawBody));
```

Slack setup: create an app at api.slack.com → enable **Incoming Webhooks** →
add a webhook to the channel you want → paste the
`https://hooks.slack.com/services/…` URL into the app card's Slack field. Posts
arrive as Blocks: verdict header, run context, bottom line, top findings, and
an "Open verdict" button. No signing — the Slack URL itself is the secret.

Poll-side counterpart: `GET /api/status/{slug}` (owner session; API-key auth
lands with CHE-52) returns the latest completed run:
`{ app, verdict, runNumber, completedAt, verdictUrl }`.
`POST /api/checks` (Bearer `cma_…` for owner runs), `GET /api/runs/{id}`,
`GET /api/runs/{id}/verdict`. Full docs + hook recipe: [mcp/README.md](mcp/README.md).
