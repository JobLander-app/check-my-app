---
name: app-review
description: Have CheckMyApp use a deployed app as a real visitor would and return findings you can act on — app review, the way code review works for a diff. Use when verifying a deployed app or a PR preview URL before merging, when checking whether a UI flow actually works for a visitor, when asked "does it actually work?", or when a task says to test the deployed change end to end. Requires a URL reachable on the internet; not for localhost.
---

# App review of a deployed app

You describe what a visitor should be able to do. CheckMyApp goes to the URL,
does it, and returns findings with evidence. You decide what to change.

## When to use this

- A PR preview is up and you want to know whether the change works for a visitor.
- A deploy landed and you want the real flows exercised before you call it done.
- A task was written as user behaviour ("a visitor can sign up and see the dashboard").

## When not to use this

- **localhost or a private host.** The target must be reachable on the public
  internet. A preview URL behind deployment protection will not open either.
- **Instead of unit tests, type checks or a linter.** This is not faster than
  running the test suite, and it does not read code.
- **On a site you do not own.** Only point it at your own app or your team's.

## Setup

The server is hosted; no checkout is needed:

```bash
claude mcp add --transport http checkmyapp https://checkmyapp.dev/mcp \
  --header "Authorization: Bearer cma_xxxxxxxx"
```

(A client that only speaks stdio can run the bridge from a checkout of the
CheckMyApp repository instead: `claude mcp add checkmyapp -e
CHECKMYAPP_API_KEY=cma_xxxxxxxx -- npx tsx /path/to/check-my-app/mcp/server.ts`.)

The key comes from the dashboard at https://checkmyapp.dev/dashboard → **API
keys**, and is shown once. Every plan can create one, Free included; checks
started with it count against the team's plan like any other. Every call needs
it: the key names the team whose apps and plan the tools act on.

The remote `wait_for_review` / `wait_for_run` answer within 45 seconds; while
the run is still going they return `timed_out: true` — call again.

To have this skill in every project, copy `.claude/skills/app-review/` from the
checkout to `~/.claude/skills/app-review/`.

## The loop

1. **Write the test plan first.** Turn the task or PR description into plain
   user steps: "add an item to the cart, check out with a test card, see the
   order in history." No selectors, no endpoints, no file names — steps a
   person could follow. A check by `url` carries no sign-in credentials, so
   write a plan a signed-out visitor can follow; anything behind a login will
   come back under `coverage.unverified`. A saved app (`start_check{app_id}`)
   signs in with the test login stored on it (`update_app` sets one). Never put
   a password in `notes`.

2. **`start_check`** with:
   - `url` — the preview or production URL.
   - `notes` — the plan, plus what changed and what to look at first. This is
     the only place the plan goes; there is no separate plan argument today.
   - `scope_hints` — hard limits: "Do not touch /admin. Do not delete anything.
     Do not submit a real payment."
   - `ephemeral: true` — for a preview hostname. The run stays private, no app
     is kept for the hostname, and it is deleted after about 7 days.
   - `deploy_sha` and `deploy_env` — the PR head sha and `preview`. This binds
     the result to the build, so you can tell a stale answer from a fresh one.

   A refusal comes back with `isError` and a `code`. On any `quota_*`, stop —
   do not retry; the `hint` says what unblocks it.

3. **`wait_for_review{run_id}`** — if it returns `timed_out: true`, call it
   again (or poll `get_check_status`) until the run finishes.

4. **Act on the result**, in this order: `next_actions`, then `findings`, then
   `coverage`.

## Reading the result

- **`next_actions[]`** — per finding, a `symptom` and `how_to_know_it_is_gone`.
  This is your work list. It deliberately names no file, cause or fix.
- **`findings[]`** — each has `where`, `what_we_tried[]`, `what_happened`,
  `why_it_matters`, `evidence[]` (absolute URLs, open them). A finding is a
  **symptom with evidence, not a diagnosis.** Nothing in it tells you the cause.
  Finding the cause and choosing the fix is your job — you have the code, the
  history and the logs, and the review deliberately does not.
- **`journeys[].steps[]`** — every step as walked, with `attempted` and
  `observed`. Read these when a finding's `where` is not enough to reproduce it.
- **`coverage.pages_not_opened[]` and `coverage.unverified[]`** — what this run
  did **not** establish. `unverified` means a step was not checked. It is never
  a claim that something is broken, and it is not a task for you: it is a gap on
  the CheckMyApp side. Read it only to know how far the result reaches.
- **`all_good` with a non-empty `coverage` is not full coverage.** Say what was
  established and what was not, rather than reporting a clean sweep.

## What each verdict means for you

| `verdict` | What to do |
|-----------|-----------|
| `all_good` | Nothing found. Check `coverage` before calling the PR clean. |
| `mostly_ok` | Minor findings. Decide whether they block this merge; say which you are deferring. |
| `needs_attention` | Real findings a visitor would hit. Work `next_actions` before merging. |
| `broken` | A core flow does not work. Fix before merging. |
| `unverified` | The check established nothing. No signal either way — never treat it as a pass. |

A `status` of `failed` means the check itself did not finish. It says nothing
about the app: no verdict was published. Start another check; do not report it
as a problem with the app.

## Timing and discipline

- A check takes tens of minutes. Start it, then go do other work in the same
  session, and come back to `wait_for_review`. Do not idle on it.
- **One check per preview, not per commit.** Push your fixes, then check the
  updated preview once to prove the symptom is gone.
- Every run is metered against the key owner's plan. Do not start a second run
  to "see if it comes out different" — it is the same app.
- Never point a check at a URL that is not yours.

## Worked example

A PR that rewrote the checkout form, with a three-item plan:

```
start_check{
  url: "https://pr-482.preview.example.com",
  notes: "PR #482 rewrote the checkout form (address + card fields now one step).
          Check, in this order:
          1. As a signed-out visitor, add any item to the cart and reach checkout.
          2. Fill the checkout form with the test card 4242 4242 4242 4242 and submit.
          3. After submitting, the confirmation page shows the order and the right total.",
  scope_hints: "Do not touch /admin. Do not delete an existing order.
                Do not use a real card.",
  ephemeral: true,
  deploy_sha: "9f3c1ab",
  deploy_env: "preview"
}
→ { ok: true, run_id: "cmf…", expires_at: "…", verdict_url: "…" }

wait_for_review{ run_id: "cmf…" }
→ { verdict: "needs_attention", findings_by_severity: { high: 1 },
    next_actions_count: 1, review: { … } }

Then:
- read review.next_actions[0].symptom and open review.findings[0].evidence[]
- diagnose it in the code yourself, fix, push
- start_check the new preview to prove next_actions[0].how_to_know_it_is_gone
- report what review.coverage says this run did not establish
```
