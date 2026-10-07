# Code standards

Binding for every agent that writes code here and every agent that reviews it
(Codex reads `AGENTS.md`, CodeRabbit reads `.coderabbit.yaml`; both point
here). `CLAUDE.md` is the constitution and `AGENTS.md` the operating detail;
this file does not repeat them — it is how code in this stack is written so
that those rules hold. Every rule carries its **why** and, where one exists,
the **mechanism** that enforces it; a rule with no mechanism yet says so, and
the reviewer is the mechanism until a script is. `scripts/verify-code-standards.ts`
counts the `### R` headings below and prints the count beside its own checks.

Stack: Next.js 16 App Router, React 19, TypeScript (strict), Tailwind, on
Cloudflare Workers through `@opennextjs/cloudflare`; Prisma 6 on D1 through
`@prisma/adapter-d1`; Clerk; PostHog; Playwright inside the agent worker.

## A. React and Next.js in this app

### R1. Server components by default; `"use client"` only where there is interaction

Pages and layouts are server components; a client component exists for state,
event handlers, browser APIs or hooks — and is as small as the interaction,
placed at the leaf, with data passed in as props.
**Why:** Next.js: "By default, layouts and pages are Server Components … When
you need interactivity or browser APIs, you can use Client Components to layer
in functionality"; "add `'use client'` to specific interactive components
instead of marking large parts of your UI as Client Components" ([Server and
Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)).
**Mechanism:** none mechanical; the reviewer asks of every `"use client"` what
the interaction is (`scripts/verify-lens-flags.ts` walks the client module
graph and shows how such a check would be written).

### R2. `useEffect` is the last resort

Owner rule, 2026-09-22, verbatim: **"useEffect — это последний способ что-либо
сделать, когда НИКАКИЕ ДРУГИЕ испробованы и вариантов больше не осталось."**
Event logic goes in the event handler; a reaction to a message or a state
change goes where the state changes (the reducer, the action); a derived value
is computed in render; a subscription uses the hook that already exists for it.
An effect that watches state in order to react to it is forbidden, including
"temporary" and "diagnostic" ones. Before writing one, list the alternatives
tried, in the PR.
**Why:** React's own guidance: "Effects are an escape hatch from the React
paradigm … You don't need Effects to transform data for rendering … You don't
need Effects to handle user events … Code that runs because a component was
*displayed* should be in Effects, the rest should be in events" ([You Might Not
Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)). The
rule was bought by two "diagnostic" effects in the extension's `Extension.tsx`.
**Mechanism:** `react-hooks/rules-of-hooks` and `exhaustive-deps` (ESLint, on)
catch misuse, not use. The reviewer is the mechanism: a new `useEffect` without
the list of alternatives is a P1.

### R3. No `dangerouslySetInnerHTML`, ever

Owner rule, 2026-10-04, after an inline `<script>` through
`dangerouslySetInnerHTML` passed one Codex round in PR #245. There is no
"trusted" case here: markup is JSX, data is props, scripts are modules.
**Why:** React: "As with the underlying DOM `innerHTML` property, you must
exercise extreme caution! Unless the markup is coming from a completely trusted
source, it is trivial to introduce an XSS vulnerability this way" ([Common
components](https://react.dev/reference/react-dom/components/common#dangerously-setting-the-inner-html)).
A product that reports other apps' defects cannot ship the one class every
scanner looks for first.
**Mechanism:** `scripts/verify-code-standards.ts` fails on the identifier
anywhere under `src/` (read from the syntax tree, so a string or a computed
property does not slip past); `react/no-danger` is an ESLint error.

### R4. No inline scripts

No `<script>` element in any JSX under `src/`, with or without a body.
Behaviour that must run in the browser is a client component (R1) or a module
file; a third-party snippet goes through `next/script` from a file in `public/`.
**Why:** an inline script is R3 by another name — unreviewable text executed
in the customer's browser — and it defeats any content-security policy the app
adopts later.
**Mechanism:** `scripts/verify-code-standards.ts` fails on a JSX element
named `script` anywhere under `src/`.

### R5. Mutations are server actions; redirects happen on the server

A write goes through a `"use server"` function invoked from a `<form action>`
or a transition, never through a client-side `fetch` to our own route handler
for the same thing. After a mutation, `redirect()` is called in the action,
outside any `try` block. Route handlers are for callers that are not our
pages: webhooks, the public API, MCP.
**Why:** Next.js: a Server Action's response carries "the action's return
value … [and] a newly rendered RSC Payload" in one round trip, and "Treat every
action as an untrusted entry point. … Authenticate and authorize" inside it
([Server Actions](https://nextjs.org/docs/app/guides/server-actions)).
`redirect` "throws an error so it should be called outside the `try` block"
([redirect](https://nextjs.org/docs/app/api-reference/functions/redirect)).
**Mechanism:** none mechanical; every action begins by resolving the viewer and
team (`src/lib/auth.ts`) — the reviewer checks it is there.

### R6. Per-request memo with `cache()`, independent reads with `Promise.all`

A loader several components call in one request is wrapped in React `cache()`
at module level (`src/lib/auth.ts`, `src/lib/shell-data.ts` do this). Reads
that do not depend on each other are started together and awaited with
`Promise.all`; a chain of `await`s is a waterfall the customer waits through.
**Why:** React: "React will invalidate the cache for all memoized functions
for each server request"; "Do not call `cache()` inside components"
([cache](https://react.dev/reference/react/cache)). Next.js: "multiple
`async`/`await` requests can still be sequential if placed after the other …
await them with `Promise.all`" ([Fetching Data](https://nextjs.org/docs/app/getting-started/fetching-data)).
**Mechanism:** none mechanical; the reviewer reads a page's `await`s in order.

### R7. No `any`

Explicit `any` is not written; the type is named, `unknown` is narrowed, or a
generic is introduced. Prisma arguments are never wrapped in a generic helper
(`AGENTS.md`, "Do not wrap Prisma arguments in a generic helper").
**Why:** every rule in this file is enforced by something reading the code;
`any` is the one word that switches that reading off for everything it touches.
**Mechanism:** `strict: true` in `tsconfig.json` (implicit `any` is a type
error); `@typescript-eslint/no-explicit-any` is an ESLint error, with the one
legacy file that still carries it named in `eslint.config.mjs`.

## B. Layout

### R8. No horizontal scroll in a table

Owner rule, 2026-10-04. A table fits its container at every width in R9: fewer
columns, a column that wraps, a second line in a cell, a card layout on narrow
screens — never `overflow-x-auto` around a `<table>`.
**Why:** a table that scrolls sideways hides the columns that did not fit,
which on this product are the verdict and the price. What is hidden is not
shown; what is not shown was not built.
**Mechanism:** `scripts/verify-code-standards.ts` fails on `overflow-x-auto`,
`overflow-x-scroll`, `overflow-auto` or `overflow-scroll` — under any Tailwind
variant (`md:`, `!`) — on a `<table>` or any JSX element above it, anywhere
under `src/`, the className read through the constants and imports it refers
to. A `<pre>` or a filmstrip may scroll; a table may not.

### R9. Every page is looked at, at 390, 1000, 1200 and 1440

Owner rule, 2026-10-04. Before a UI PR is called done, its pages are rendered
at those four widths and the screenshots are looked at by the author, not only
produced.
**Why:** pixels are not checked by a type or a lint rule; the owner found the
inline script of R3 and the scrolling tables of R8 by opening the preview,
after CI and one review round had passed them.
**Mechanism:** none mechanical yet; the PR shows the four screenshots.

### R10. Empty states are designed

A list with no rows, an app with no checks, a team with no apps: each has a
sentence that says what will appear and what the person can do now. A blank
card or a bare "No data" is a defect.
**Why:** the first thing every new customer sees is the empty state.
**Mechanism:** the page's own `verify-*` script asserts the empty sentence
(`scripts/verify-journeys-page.ts`, "No journeys of … yet", is the pattern).

### R11. One container width per page family; one cell layout per table

Pages of one family (the app pages, the settings pages, the health pages)
share one `max-w-*`, and a table's cells align the same way across the family
(numbers right, words left, the same column order for the same facts).
**Why:** a width that changes between two sibling pages reads as a page jump;
a cell that aligns differently reads as a different fact.
**Mechanism:** none mechanical; the reviewer compares with the sibling page.

## C. Data on D1

### R12. Every tenant query declares whose rows it may see

Every query for an App, Run, Watch, ApiKey, SettledSignature or TestAccount in
`src/app` and `src/lib` spreads one of the declarations from
`src/lib/tenant-db.ts` (`teamOwned`, `alreadyScoped`, `publicRow`,
`ownerScoped`, `systemWide`, `memberOfRows`); a raw statement binds the team
through `teamRows(...)` in its own arguments.
**Why:** one `findFirst({ where: { appSlug } })` without a team clause serves
another team's app and looks normal in review (CHE-256).
**Mechanism:** `scripts/verify-tenant-db.ts`, over the registry of call sites.

### R13. Histories are read flat

A team's or an app's history (runs → journeys → steps → findings) is read as
flat statements — one per table, joined in code — never as a nested
`select`/`include` over the whole history.
**Why:** the nested shape aborted the query engine on a real team's history
(`src/lib/recurring.ts`, 2026-10-02); `src/lib/journeys-load.ts` and
`src/lib/releases.ts` show the flat shape.
**Mechanism:** the loader's own `verify-*` script runs it at real size (R15).

### R14. A raw statement never binds a list; a model `in` list selects every ordered column

D1 caps a statement at 100 bound parameters ([D1
limits](https://developers.cloudflare.com/d1/platform/limits/)). A raw
statement is not split, so `Prisma.join(ids)` fails at the 101st id: bind the
team and a constant and filter in SQL. A model query's `in` list is split by
Prisma under the cap and the parts merged — and the merge aborts the wasm
engine (`RuntimeError: unreachable`) when the query orders by a column it does
not `select` (real D1, PR #256; CHE-403). So a query with a variable `in` list
and an `orderBy` selects every column it sorts by, or does not sort.
**Why:** both failures appear only on the apps with the most history — the
customers who pay the most — and the second takes the process down.
**Mechanism:** `scripts/verify-agent-id-lists.ts` (for `src/agent`);
`scripts/verify-journeys-page.ts` shows both behaviours on a real D1 with 131
rows; `scripts/verify-tenant-db.ts` refuses `$queryRawUnsafe`.

### R15. Loaders are tested at real size, on a real D1

A new loader lands with a `verify-*` script that runs it through
`scripts/fixtures/real-d1.ts` (Miniflare's D1, every migration applied) with
more rows than the 100-parameter cap, not only against the in-memory client.
**Why:** `scripts/fixtures/real-d1.ts` header: what only D1 can answer — how a
DateTime stored as text compares, what a NULL does in a range, the SQL Prisma
really issues — is answered there and nowhere else.
**Mechanism:** the script is in the acceptance registry (`verify:all`).

### R16. A column is dropped in two deploys

Step 1 removes the field from `prisma/schema.prisma` and every reader; step 2,
a later deploy, drops the column in a new migration file.
**Why:** CI migrates before it deploys, and the live workers' client still
selects every column of the model in that window (#196, #197: `Run.smokeOnly`).
Prisma on D1 has no transaction to hide behind: "Cloudflare D1 currently does
not support transactions … implicit & explicit transactions will be ignored and
run as individual queries" ([Prisma: Cloudflare
D1](https://www.prisma.io/docs/orm/overview/databases/cloudflare-d1)). Never
edit a migration that has shipped (`AGENTS.md`).
**Mechanism:** none mechanical; the PR title says which step it is.

### R17. Dates are UTC

`Date.UTC(...)` in fixtures, UTC in every stored and compared value, no named
timezone anywhere (`AGENTS.md`, "Times are UTC").
**Why:** D1 stores a DateTime as text; two representations of one instant
compare as two instants.
**Mechanism:** a loader's real-D1 test (R15) is where a timezone bug shows.

## D. Customer language

### R18. Sentences the customer reads come from pure, guarded modules

Every string a customer reads is built in a module of pure functions (no I/O,
no React) with a `verify-*` script that asserts the sentences and runs each
through `hasEnvironmentLeak` / `hasHomework` from `src/lib/verdict-language.ts`.
What may be said is `CLAUDE.md` §1 (our machinery is invisible, no homework),
§9 (symptom and evidence, never a fix) and §10 (the price, never our cost).
**Why:** a sentence inside JSX cannot be tested without rendering; one in a
pure function is asserted in one line, and the leak guard runs over it.
**Mechanism:** `src/lib/verdict-language.ts`; `scripts/verify-public-copy.ts`
and `scripts/verify-cost-never-shown.ts` over pages and payloads; the
page's own script (`scripts/verify-journeys-page.ts` §1 is the pattern).

## E. Acceptance

### R19. An invisible fix lands with a verify script, and the script is seen failing first

A change a user cannot see lands with its own `scripts/verify-<name>.ts`
(`AGENTS.md`, "What done means"). The script is run against the code before
the fix, or against a fixture that has the defect, and the red run is shown
in the PR before the green one.
**Why:** a check that was bound to be green proves nothing (2026-09-17, #203).
**Mechanism:** `scripts/verify-all.mjs` discovers every `verify-*` by mask; the
PR carries the red run.

### R20. Screenshots are looked at; the console is clean

A UI PR's screenshots (R9) are opened and read by the author; the browser
console on every changed page shows no error and no React warning.
**Why:** a screenshot that is produced and not looked at is a file, not a
check; a hydration warning is a bug the customer's browser already reported.
**Mechanism:** none mechanical; the PR says "console clean at four widths".

### R21. Codex reviews, up to three rounds

Each PR gets `@codex review` once; P1 and P2 are fixed or declined with a
written reason; three rounds at most, then the PR is split or rethought.
**Why:** a fourth round means the change is too large to review.
**Mechanism:** the comment thread on the PR.
**Exception — Mender's PRs** (`mender/*` branches, CHE-445): the reviewer is
CodeRabbit, asked with `@coderabbitai review`, not Codex — owner, 2026-10-07:
«может запрашивать ревью у coderabbit (codex исключаем)». Same three rounds.

## F. Attitude

### R22. "It was like that before me" is not an argument

What is on the screen after your merge is your decision. A defect you kept is
one you chose; a defect you found and did not fix is reported as yours to fix
or filed as a ticket in the same PR — not mentioned in passing.
**Why:** owner rule, 2026-09-21: what you find during a task is closed inside
that task; "I leave it to you as an observation" moves the queue to the owner.

### R23. No excuses in reports

A report says what was done, what was verified and how, what is broken or
unproven — plainly. Not "the tests pass except", not "should work". If a step
was skipped, the report says it was skipped.
**Why:** `AGENTS.md`: "You may say the work is shipped. You may never say the
problem is fixed." A report that softens a failure costs the owner a second
look at something he was told was done.

### R24. Finish what you find

A defect noticed on the way is fixed in the same PR when it is small, or filed
as a ticket with the evidence when it is not, before the PR is called done. The
one thing handed back is what only the owner can give: access, money, a
decision he asked to make.
**Why:** `CLAUDE.md` §2 applied to ourselves — "we could not" is our defect.
