# CheckMyApp MCP server

CheckMyApp is managed from your coding agent. The MCP server at
**`https://checkmyapp.dev/mcp`** adds apps, stores their test login, starts
checks after a deploy, switches recurring checks on and off, and hands the
agent every finding in the shape it fixes from. The dashboard is for creating
the API key; after that, the agent is the interface.

## Install

With an API key (dashboard → **API keys**, https://checkmyapp.dev/dashboard —
every plan can create one, Free included; checks started with it count against
the team's plan exactly as a check started from the dashboard):

```bash
claude mcp add --transport http checkmyapp https://checkmyapp.dev/mcp \
  --header "Authorization: Bearer cma_xxxxxxxx"
```

Any MCP client that speaks Streamable HTTP connects the same way: POST to
`/mcp` with `Authorization: Bearer cma_…`. The server is stateless — every
request stands alone, there is no session, and `GET`/`DELETE` answer `405`.

The raw key is shown once at creation; only its SHA-256 hash is stored, and
revoking deletes it immediately. The key belongs to a **team** and carries a
**scope** (admin / member / reader): every tool acts on that team's apps only,
and a reader key reads but never starts or changes anything.

### Fallback: stdio

For a client that only speaks stdio, or to point at a local stack, run the
bridge from a checkout of this repo:

```bash
claude mcp add checkmyapp -e CHECKMYAPP_API_KEY=cma_xxxxxxxx -- npx tsx mcp/server.ts
```

| Variable             | Default                  | Purpose |
|----------------------|--------------------------|---------|
| `CHECKMYAPP_URL`     | `https://checkmyapp.dev` | Where the remote server is; `http://localhost:3000` for a local stack |
| `CHECKMYAPP_API_KEY` | —                        | The API key. Required: without it the bridge does not start |

`mcp/server.ts` has no tools of its own. It lists the remote server's tools and
forwards every call, so both doors behave identically. The one thing it adds is
the long wait: see [Long waits](#long-waits).

## When the agent connects

The server's `instructions` are written for the key's team at connect time:
each app with the verdict of its latest check and how many findings are new
since the check before, then what to do — if something is new, tell the person
at the start of the session and offer to fix it with `get_review`. Under 1500
characters, apps with news first.

## Results pushed into a running session (channel)

The server above answers when the agent asks. `checkmyapp-watch` is the
other half: when a recurring check finishes, a running Claude Code session
hears about it without anyone asking. It is a Claude Code
[channel](https://code.claude.com/docs/en/channels-reference) — a
**research preview**: a custom channel loads only with the development flag,
and on Team and Enterprise plans an admin must enable channels
(`channelsEnabled`) first.

```bash
claude mcp add checkmyapp-watch -e CHECKMYAPP_API_KEY=cma_xxxxxxxx \
  -- npx -y https://checkmyapp.dev/mcp/checkmyapp-watch-1.0.0.tgz
claude --dangerously-load-development-channels server:checkmyapp-watch
```

Add the `checkmyapp` server too (above): the channel only announces, and
fixing goes through `get_review`.

What it does, in `mcp/channel/`:

- Polls `latest_results` on `/mcp` over HTTPS every `CHECKMYAPP_POLL_SECONDS`
  (default 300, never under 60). It opens no port and has no tools.
- When an app has a finished run it has not told the session about, it pushes
  one event: `<channel source="checkmyapp-watch" app="…" run_id="…"
  verdict="…">` with the host, the verdict, the bottom line, each **new**
  finding (title and severity) and "call get_review with run_id …".
- Opening a session replays nothing — except a result with new findings that
  finished in the last 24 hours, which is pushed once: the watch ran
  overnight, and the agent says so first.
- Its instructions tell Claude to tell the person and offer to fix, never to
  start changing anything because an event arrived.
- A network error is logged to stderr and retried on the next tick; a refused
  key (401/403) is one stderr line and exit 1. `claude --debug` shows its
  stderr, including `connected: N app(s), … waiting` after the first poll.

| Variable                  | Default                  | Purpose |
|---------------------------|--------------------------|---------|
| `CHECKMYAPP_API_KEY`      | —                        | Required; a reader key is enough |
| `CHECKMYAPP_URL`          | `https://checkmyapp.dev` | Where `/mcp` is |
| `CHECKMYAPP_POLL_SECONDS` | `300`                    | How often it looks; minimum 60 |

**Distribution.** No npm registry: `npm run build:channel` bundles the channel
and the MCP SDK into one dependency-free file and packs it as
`public/mcp/checkmyapp-watch-<version>.tgz`, served by the site. The version
is in the URL because `npx` installs a tarball URL once and reuses that
install while the URL answers — a new tarball under the same URL never
reaches someone who already has it, and a removed one breaks them. So a change
to `mcp/channel/` bumps `CHANNEL_VERSION` (the build refuses to overwrite a
published version), the guide and this README get the new URL, and old
tarballs stay in `public/mcp/`.

## Tools

Every successful result carries `ok: true`. Ids: `app_id` from `list_apps` /
`create_app`; `run_id` from `start_check` / `latest_results`.

**Apps**

- **`list_apps`** `{}` — the team's apps: `app_id`, `app`, `url`, `kind`,
  `scenarios` (what must keep working — checked on every run), `limits` (where
  the check may not go), `notes`, `may_create_test_records`,
  `has_test_account` and `test_email`, `test_accounts` (`label`, `email`,
  `has_password` for every account a check signs in as — the password itself
  is never returned), `has_store_password`, `watch` (`state`: active / paused / trial_ended / off /
  on_demand, `frequency`, `next_run_at`, `trial_days_left`), `last_run`
  (`run_id`, `status`, `verdict`, `finished_at`).
- **`create_app`** `{url, scenarios?, limits?, notes?, test_email?,
  test_password?, test_accounts?, store_password?, frequency?}` — add an app,
  exactly as the onboarding form does: passwords are stored encrypted, and a
  website gets a recurring check (daily by default) within the team's plan —
  the first one is scheduled automatically. Its verdicts go to the team members
  chosen in the app's settings on the site (the team's admins until someone is
  chosen). `test_email`/`test_password` is the
  `default` account; `test_accounts: [{label, email, password}]` adds named
  ones (`admin`, `free user`), and a scenario that names one ("As admin:
  refunds work") is checked signed in as it. `store_password` is the
  storefront password of a password-protected store (Shopify's "Enter store
  password" page); every check enters it, and it is never returned.
- **`update_app`** `{app_id, scenarios?, limits?, notes?, test_email?,
  test_password?, test_accounts?, remove_test_accounts?, store_password?}` —
  only the fields passed change; `""` clears a field, and
  `test_password: ""` / `store_password: ""` removes the stored password. `test_accounts` adds a named account or updates
  the one stored under that label (a password left out is kept);
  `remove_test_accounts: ["admin"]` deletes one.

**Checks**

- **`start_check`** `{app_id}` **or** `{url}`, plus `notes?`, `deploy_sha?`,
  `deploy_env?`; with `url` also `scope_hints?`, `notify_email?`,
  `ephemeral?`.
  - By `app_id`: the saved app with its stored test login, scenarios and
    limits — what the dashboard's Run button does. `notes` are added after the
    app's own for this run. If a check of the app is already running you get
    that run back with `already_running: true` (and `deploy: null` — it is not
    bound to the build you named).
  - By `url`: a one-off check of any address; `ephemeral: true` for a PR
    preview (see [Ephemeral runs](#ephemeral-runs-pr-previews)).
  - Returns `run_id`, `deploy`, `live_url`, `verdict_url`. A check takes about
    20–40 minutes.
- **`get_check_status`** `{run_id}` — status (`queued`, `connecting`,
  `surface_scan`, `discovery`, `walking`, `anatomy`, `writing`, then
  `completed` / `partial` / `failed`), `terminal`, the verdict when done, the
  latest progress events.
- **`wait_for_run`** `{run_id}` — waits up to **45 seconds**; when the run has
  finished, returns its verdict, bottom line, `findings_by_severity`, a
  findings summary, the deploy it was bound to and the verdict URL. Still
  running → `timed_out: true` with the status: call it again. A `failed`
  status is CheckMyApp not finishing, not the app being broken — and it costs
  nothing.
  Finished runs also carry their **price**: `price_usd`, `journeys_walked`,
  `steps_walked` and `price_explanation` (`work`, `comparison` with the app's
  usual price, `usual_price_usd`, and `parts` — what each part's share of the
  price was, summing to `price_usd`; each part has a `section`, `before` the
  walk (mapping the app), `journeys` (one per journey, with its `steps`) or
  `after` it (writing the verdict)). The same fields are on
  `wait_for_review`, `get_review` and each app in `latest_results`; `list_apps`
  and the connection instructions carry the team's balance and each app's
  `usual_price_usd`.
- **`wait_for_review`** `{run_id}` — the same wait, answering with the review:
  a head (`verdict`, `findings_by_severity`, `next_actions_count`) and the whole
  review under `review`.

**Results**

- **`latest_results`** `{}` — for every app: the latest finished run, its
  verdict and findings by severity, and **`new_findings`** — the ones the
  app's previous finished run did not have (compared by the same signature a
  ticket is deduplicated by, so a regression worded differently on two days is
  not "new" twice); plus `in_flight`, the checks still running.
- **`get_verdict`** `{domain_or_run_id}` — the structured verdict (bottom line,
  journeys, findings, `deploy`). A domain resolves to the team's latest
  finished check of that app.
- **`get_review`** `{run_id}` — the result in the shape you act on; see
  [The review](#the-review).

**Recurring checks**

- **`enable_watch`** `{app_id, frequency}` — turn on or resume (`daily`,
  `every_6h`, `manual`). Every tick spends the team's balance at the check's
  own price; a watch pauses by itself while the balance cannot cover a check
  (`list_apps` shows `paused_balance`) and resumes after a top-up or the plan's
  next credit. On Free, one app, daily, on a trial.
- **`disable_watch`** `{app_id}` — pause it. History and settings stay;
  `enable_watch` resumes.

## The review

`get_verdict` answers *is the deploy fine?* — a verdict, a bottom line, finding
titles. `get_review` answers *what do I do about it?*:

| Field | What it holds |
|-------|---------------|
| `run` | `{id, status, verdict, deploy, startedAt, completedAt, appSlug}` |
| `bottom_line` | The verdict in a sentence |
| `journeys[]` | `{title, status, summary, steps[]}` — every step as walked: `order`, `label`, `attempted`, `observed`, `status`, `unverified_reason` |
| `findings[]` | `{number, title, category, severity, priority, where, what_we_tried[], what_happened, why_it_matters, evidence[]}`; evidence URLs are absolute. `priority` is P0–P3, the same scale as Health → Issues: P0 existing users cannot pay, sign in or reach their data; P1 broken or exposed, or existing users at risk; P2 new visitors meet something risky or confusing; P3 polish |
| `plan_results` | Always `[]` today; reserved for the plan-driven check |
| `next_actions[]` | `{finding, symptom, how_to_know_it_is_gone}` — per finding, the sentence the next check must be able to say |
| `coverage` | `{pages_not_opened[], unverified[]}` — what this run did **not** establish |
| `urls` | `{verdict, live}` |

Two habits make it useful. Act on `next_actions`: each one names the symptom
and the sentence that means it is gone, and deliberately names no file, cause
or fix — what to change is yours to decide. And read `coverage` before you call
a deploy clean: a page nobody opened is not a page that works.

## Refusals and error codes

A refusal is never an exception. It is a tool result with `isError: true` and
a JSON body `{ ok: false, code, error, hint? }`:

| `code` | Meaning | What to do |
|--------|---------|------------|
| `not_found` | No such app or run **in this key's team** (another team's ids look exactly like missing ones) | `list_apps` / `latest_results` |
| `forbidden` | The key's scope does not allow this (a reader key starting a check, adding an app, changing a watch) | An admin can issue a member key |
| `plan_limit` | The team's plan does not allow it (Free's one trial watch, its daily cadence) | Do not retry; tell the person what the plan allows and give them `upgrade_url` |
| `quota_balance` | The team's balance is too low for another check of this app | Do not retry; give the person `buy_url` (top up) and `upgrade_url` |
| `quota_free` | The Free plan's one-time credit is used | Do not retry; give the person `buy_url` (top up) and `upgrade_url` |
| `quota_site` | Today's site-wide free checks are used | Do not retry |
| `ephemeral_requires_owner` | `ephemeral` without an account (cannot happen with a key) | — |
| `invalid_input` | An argument was rejected (the message names it), `app_id` and `url` together, or the app already exists | Fix the argument |

An HTTP-level refusal — a missing or unknown key — is a `401` with a JSON-RPC
error body, before any tool runs.

## Long waits

A check runs 20–40 minutes; a remote request should not be held open that
long. The remote `wait_for_run` / `wait_for_review` return within 45 seconds
with `timed_out: true` while the run is still going: call again.

The stdio bridge does the calling-again for you: it repeats the remote call
until the run finishes or 45 minutes pass, and sends a
`notifications/progress` per round when the client passes a progress token, so
a client that resets its timeout on progress (Claude Code does;
the TypeScript SDK's `resetTimeoutOnProgress: true`) can block for the whole
run in one call.

## Post-deploy recipe

```
1. deploy finishes → agent calls
   start_check{ app_id: "<from list_apps>",
                notes: "PR #123 changed the checkout flow — verify checkout first",
                deploy_sha: "<sha>", deploy_env: "production" }
2. wait_for_run{ run_id }        # repeat while timed_out
3. verdict all_good / mostly_ok  → done, release stands
   verdict needs_attention / broken → get_review, fix what next_actions names
   isError with a quota code     → stop; the hint says what unblocks it
```

As a Claude Code prompt:

> Deploy is out. Use the checkmyapp MCP: start_check on our app with notes
> about what this PR changed and deploy_sha, then wait_for_run until it
> finishes. If the verdict is worse than mostly_ok, get_review and fix what
> next_actions names.

## Ephemeral runs (PR previews)

`start_check{ url, ephemeral: true }` is for a hostname that will not outlive
the pull request. The run stays private, creates no app (no watch, no ticket
history), and is deleted after about 7 days — the result carries `expires_at`.
Everything else is an ordinary run: same quota, same tools, same review.

```
1. preview is up → start_check{ url: "https://pr-123.preview.example.com",
                                notes: "PR #123 rewrote the checkout form",
                                ephemeral: true, deploy_sha: "<PR head sha>",
                                deploy_env: "preview" }
2. wait_for_review{ run_id }     # repeat while timed_out
3. work the next_actions; read coverage before calling the PR clean.
```

## Deploy identity

`deploy_sha` (plus `deploy_env`) is stored on the run and echoed back by
`wait_for_run`, `get_verdict`, the verdict page header and the outbound webhook
as `deploy: { sha, env }` (`null` when the run named no build). It turns "the
app is fine" into "**this build** is fine". `sha` is 7–64 characters of
`[A-Za-z0-9._-]`; `env` is free text up to 40 characters.

## CI gate without an agent

The same checks are curl-able from CI:

```yaml
- name: Start the check, bound to this commit
  run: |
    RESPONSE=$(curl -s -X POST "https://checkmyapp.dev/api/checks" \
      -H "Authorization: Bearer $CHECKMYAPP_API_KEY" -H "Content-Type: application/json" \
      -d "{\"url\":\"$DEPLOY_URL\",\"deploy\":{\"sha\":\"$SHA\",\"env\":\"production\"}}")
    RUN_ID=$(jq -r '.id // empty' <<<"$RESPONSE")
    test -n "$RUN_ID" || { echo "::error::CheckMyApp did not start a run: $RESPONSE"; exit 1; }
    echo "run_id=$RUN_ID" >> "$GITHUB_OUTPUT"
- name: Wait for the verdict and gate on it
  run: |
    for _ in $(seq 1 90); do          # 90 × 30s = 45 min
      STATUS=$(curl -s "https://checkmyapp.dev/api/runs/$RUN_ID" | jq -r '.status // empty')
      case "$STATUS" in completed|partial|failed) break ;; esac
      sleep 30
    done
    VERDICT=$(curl -s "https://checkmyapp.dev/api/runs/$RUN_ID/verdict" | jq -r '.verdict // empty')
    # Pass-list, not a fail-list: timeout, `unverified` or a value added later
    # fails the gate rather than sneaking through.
    case "$VERDICT" in all_good|mostly_ok) exit 0 ;; *) echo "::error::verdict '$VERDICT'"; exit 1 ;; esac
```

HTTP endpoints: `POST /api/checks`, `GET /api/runs/{id}`,
`GET /api/runs/{id}/verdict`, `GET /api/runs/{id}/review`,
`GET /api/checks/lookup?url=…`, `POST /api/runs/{id}/recheck`
(`?full=1` for a full walk, metered per plan and UTC month).

## Claude Code skill

[`.claude/skills/app-review/SKILL.md`](../.claude/skills/app-review/SKILL.md)
teaches an agent when to reach for each tool and how to read what comes back.
Claude Code picks it up in a checkout of this repo; elsewhere, copy the folder
to `~/.claude/skills/app-review/`.

## Verifying the server

- `npm run verify:mcp-remote` — the remote server, driven by a real MCP client
  over Streamable HTTP against the handler in-process (stub database, no
  network): authentication, the tool list, the instructions, team scoping
  (a key of one team gets `not_found` for every app and run of another), the
  password never returned and stored encrypted, start by app with its stored
  login, quotas and scopes, the watch cap on resume, new-vs-known findings,
  and the 45-second wait.
- `npm run verify:mcp` — the stdio bridge with the remote handler on its far
  end: same tool list, calls and refusals pass through, the long wait loops
  with progress and stops at 45 minutes, no key → no start.
- `npm run verify:all -- --only mcp-channel` (scripts/verify-mcp-channel.ts)
  — the channel against the remote handler in-process: a quiet start pushes
  nothing, a new finished run is one push with the right content and meta,
  never twice, the waiting result on startup, a refused key; the committed
  tarball is exactly what the source builds; and its bin, run as a process
  over stdio against a local HTTP server, handshakes and pushes.
- `npm run mcp:smoke` — the live smoke through the stdio bridge: **one**
  owner-attributed check of `https://checkmyapp.dev` (the target is fixed),
  then status, wait and verdict. Needs `CHECKMYAPP_API_KEY` in `.env`. Costs a
  real run; never in CI.
