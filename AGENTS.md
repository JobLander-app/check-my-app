# Working in this repository

For an implementing agent. `CLAUDE.md` is the constitution — read it first and
treat it as binding. This file is the operating detail underneath it.

## Commands

Run these before you finish. They are what CI runs, in this order:

```
npx prisma generate      # the workerd client; its output is gitignored
npm run typecheck        # web app
npm run agent:typecheck  # agent worker — a separate tsconfig, easy to forget
npm run lint
npm run verify:all       # every scripts/verify-*.{ts,mjs}, found by mask
```

**`npx opennextjs-cloudflare build` will fail for you and that is expected.** It
needs deploy-time environment this checkout does not carry. CI builds it; do not
chase that failure, and do not invent values to get past it.

Every `npm run verify:*` script is part of the acceptance registry — the closed
set of commands this project treats as proof. The registry is the set of files
matching `scripts/verify-*.{ts,mjs}`; a new script is picked up by
`verify:all` and CI automatically — do not edit `ci.yml` for it. Add a
`verify:<name>` entry to package.json so it can be run by hand, and keep the
file self-contained: it must pass with no arguments and no environment, or CI
fails on it (CHE-183). A tool that needs inputs is a `replay-*`, not a
`verify-*`.

## What "done" means

- The commands above pass.
- The change is the ticket and nothing else. No drive-by refactors.
- **If the fix is not visible to a user, it lands with a `verify:` script of its
  own.** A clean review proves the code is well written; it says nothing about
  whether this is the thing that was asked for.
- You may say the work is shipped. You may never say the problem is fixed —
  that is decided by a later run of this product walking the deployed site from
  outside (`src/agent/reconcile.ts`), and by nothing else.

## Boundaries

- Never push to `main`, never merge. Commit on the branch you were given.
- Never edit `CLAUDE.md`. Those rules are the owner's; each was written after a
  failure that cost trust, and a change that edits the rules it is judged
  against is not a change.
- Never edit `.github/workflows/` unless the ticket names it.
- Never put a real secret anywhere, including as a placeholder that looks real.

## Conventions that are not style

These are the ones worth stating, because guessing them wrongly is expensive.

**Anything a customer reads describes their product only.** Never our cost,
tokens, model names, browser, or environment — and never homework for them
("verify this yourself"). Enforced in `src/lib/verdict-language.ts`; add new
phrasings there rather than to a prompt.

**A rule needs a mechanism, not an instruction to a model.** If a ticket asks
for a behaviour, the answer is code that makes the wrong behaviour impossible,
not a sentence added to a prompt asking for the right one.

**"Broken" requires positive evidence** a real user would hit: an error
response, a console exception, wrong data. Silence is not evidence.

**Comments carry the why, not the what.** The code says what it does. A comment
earns its place by recording the incident or the constraint behind a decision —
several refusals in `src/agent/tools.ts` look arbitrary until you read why they
exist. A ticket number goes in a comment only after that ticket exists.

**Times are UTC.** Do not introduce a named timezone; the owner reads UTC.

**A tenant query says whose rows it may see.** Every query for an App, Run,
Watch, ApiKey, SettledSignature or TestAccount in `src/app` and `src/lib` carries one of the
five declarations in `src/lib/tenant-db.ts` — `teamOwned`, `alreadyScoped`,
`publicRow`, `ownerScoped`, `systemWide` — and `scripts/verify-tenant-db.ts`
fails the build for one that carries none (CHE-256). Write the declaration when
you write the query; it is checked over the registry of call sites, so the first
one without it is caught, not the hundredth.

**A GET that changes state is a GET a scanner will press.** An email security
scanner follows every link in a message it inspects, so a link whose *load*
performs the action is consumed by a machine before the person sees it — and
they are then told it was already used. Invitations (CHE-257) accept on a
button for this reason, and the same holds for any one-click link we put in an
email later: unsubscribe, "that's fine" on a finding, a re-check link in a
verdict mail. The load must be safe; the button is the act.

**Do not wrap Prisma arguments in a generic helper.** Prisma computes its types
from the exact argument object, so a helper of the shape `f<T>(args: T): T`
re-infers them and `orderBy: { createdAt: "desc" }` widens to `string`. The
danger is not the widening — it is that **the compiler goes quiet**: nothing
fails, the query keeps working, and type checking is silently off everywhere the
helper is used. A helper that makes the type checker less able to help is worse
than no helper. Spread a small object into `where` instead, which keeps every
type intact (this is why the declarations above are spreads, and the wrapper
version of them was written first and reverted).

**Several sessions work in this repo at once, and they share one deployed
worker.** Files answer "will this rebase cleanly"; the worker answers "will
this kill something that is running". Only the second one has cost a run.

If you were given the right to merge (most sessions are not — see Boundaries),
a push to `main` deploys both workers immediately, and that lands on whatever is
running in production right now:

- a **website** check re-executes the Workflow step it was in, so the run's cost
  roughly doubles;
- an **extension** check *dies*. Every deploy rebuilds and rolls the container
  image, and the run inside it is killed — "Runtime signalled the container to
  exit due to a new version rollout: 143" ended run #195 mid-discovery. Worse
  when it holds a paid session: that session is left with nobody to stop it.

**Waiting for the rollout to say `completed` is not enough, and this is
measured, not suspected (CHE-272).** Run #202 was evicted at 01:21:39 by a
rollout that had been marked `completed` at 01:11:05 — ten minutes earlier,
with no later rollout in the API. `completed` marks the end of the *rollout*,
not the end of *instance replacement*: a container started long after every
visible signal said "quiet" can still land on an instance that is then drained.
Run #195 died the same way five minutes after its own rollout completed. Both
times the person had waited deliberately for the signal this file recommended.
So the window is invisible to whoever is merging, and the real fix is the
executor surviving an eviction we caused rather than a longer wait — until then,
leave more distance than looks necessary after a deploy before starting a paid
extension run.

So before `gh pr merge`, check what is in flight:

```
npx wrangler d1 execute checkmyapp --remote --json --config wrangler.jsonc \
  --command "select count(*) as n from Run where status not in ('completed','partial','failed','canceled')"
```

Merge at `n = 0`. Note `partial` is terminal (`TERMINAL_STATUSES` in
`src/agent/scheduler.ts`) — a row sitting at `partial` is a finished run, not a
stuck one.

`n = 0` is necessary and not sufficient: a scheduled watch tick can start a
minute later. Daily ticks are checkmyapp.dev 17:00, joblander 18:15,
meetbashar 21:30 UTC, each 25-40 minutes. Another session's on-demand run does
not appear on any schedule, so **say what you are about to merge** to the other
sessions (`ListAgents`, then `SendMessage`) and wait for an answer when someone
is mid-run. This has been done by hand between two sessions all of 2026-09-15
and it is the only thing that has kept two deploys off one worker.

## Shape of the codebase

- `src/app` — Next.js App Router, deployed to Cloudflare via OpenNext.
- `src/agent` — the checking agent, a separate Cloudflare Worker on workerd.
  It has its own tsconfig; `npm run typecheck` alone does not cover it.
- `src/lib` — shared by both, so it must not import anything Next-only.
- `prisma/` — schema plus hand-written SQL migrations in `prisma/migrations/`,
  applied by CI. Add a new numbered file; never edit one that has shipped.

## If you cannot do it

Say so in a comment and change nothing. An honest refusal with the commands you
ran is worth more here than a plausible diff — this project exists because a
confident wrong answer costs more than no answer.
