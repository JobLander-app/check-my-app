// CHE-193 verification: a request from our own checker never creates, charges
// or marks anything.
//
// On 2026-09-05 the daily self-check of checkmyapp.dev (run #146) walked the
// public example verdict of a third-party site and pressed "Re-check now"
// (twice) and "Looks right ✓". Two real, paid runs of a stranger's site (#147,
// #148) and a lens mark on a public verdict followed, and it would have
// recurred every day. The web half of the fix is the guard in
// src/lib/self-check.ts, applied as the FIRST statement of every
// record-creating or record-mutating handler. Three things must hold:
//   1. isSelfCheckRequest honours exactly the contract — header
//      `x-checkmyapp-checker: 1`, name case-insensitive, value exactly "1";
//      absent, other values, or a similarly named header are not a self-check;
//   2. every listed route handler, called with the header, answers 403
//      `self_check_read_only` without reaching the database, Stripe, Clerk or
//      the Cloudflare context — exercised here through the real exported
//      handlers with a bare Request and no platform at all (a handler that
//      needed any of those would throw, not answer); and, called without the
//      header, never answers that refusal;
//   3. the guard is the first statement of every handler — including the
//      verdict page's server actions, which cannot be called outside a Next
//      request scope (`headers()` throws there), so for them the source is the
//      evidence: the first statement of each exported action is the guard.
//   4. CHE-194: nothing is left off the list. The list above was written by
//      hand, and run #304 (2026-10-02) registered an app through the one form
//      nobody had put on it. So the source tree is read whole: every route
//      handler that takes POST / PUT / PATCH / DELETE and every exported
//      server action under src/app starts with the guard, or is named below
//      with the reason it does not — a new handler or action without either
//      fails here.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-self-check-guard.ts

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  SELF_CHECK_HEADER,
  SELF_CHECK_HEADER_VALUE,
  SELF_CHECK_READ_ONLY,
  isSelfCheckRequest,
  selfCheckRedirectPath,
} from "@/lib/self-check";
import { POST as createCheck } from "@/app/api/checks/route";
import { POST as recheck } from "@/app/api/runs/[id]/recheck/route";
import { PATCH as lens } from "@/app/api/runs/[id]/lens/route";
import { PATCH as markFinding } from "@/app/api/findings/[id]/route";
import { POST as fileTicket } from "@/app/api/findings/[id]/ticket/route";
import { POST as oneCheck } from "@/app/api/billing/one-check/route";
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { POST as enableWatch } from "@/app/api/watch/route";
import { PATCH as updateWatch, DELETE as cancelWatch } from "@/app/api/watch/[slug]/route";
import { POST as exportSpecs } from "@/app/api/runs/[id]/export-specs/route";
import { POST as mcp } from "@/app/api/mcp/route";
import { POST as connectGithub, DELETE as disconnectGithub } from "@/app/api/integrations/github/route";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://checkmyapp.dev";

// 1 — the helper, against the contract.
{
  check("contract: header name and value are what the agent will send",
    SELF_CHECK_HEADER === "x-checkmyapp-checker" && SELF_CHECK_HEADER_VALUE === "1");
  check("contract: the refusal body is stable",
    SELF_CHECK_READ_ONLY.error === "Self-checks are read-only." && SELF_CHECK_READ_ONLY.code === "self_check_read_only");
  check("present: `x-checkmyapp-checker: 1` is a self-check",
    isSelfCheckRequest(new Headers({ "x-checkmyapp-checker": "1" })));
  check("absent: no header is not a self-check", !isSelfCheckRequest(new Headers()));
  check("case: `X-CheckMyApp-Checker` is the same header",
    isSelfCheckRequest(new Headers({ "X-CheckMyApp-Checker": "1" })));
  check("case (plain record): a record keyed in any case is looked up case-insensitively",
    isSelfCheckRequest({ "X-CHECKMYAPP-CHECKER": "1" }) && isSelfCheckRequest({ "x-checkmyapp-checker": "1" }));
  check("record: an array value takes its first entry",
    isSelfCheckRequest({ "x-checkmyapp-checker": ["1"] }) && !isSelfCheckRequest({ "x-checkmyapp-checker": [] }));
  check("value: whitespace around the value is ignored",
    isSelfCheckRequest(new Headers({ "x-checkmyapp-checker": " 1 " })));
  for (const other of ["0", "true", "yes", "", "11", "1;x"]) {
    check(`other value: "${other}" is not the contract`,
      !isSelfCheckRequest(new Headers({ "x-checkmyapp-checker": other })));
  }
  check("other header: a similarly named header does not count",
    !isSelfCheckRequest(new Headers({ "x-checkmyapp-checker-v2": "1", "x-checker": "1", "checkmyapp-checker": "1" })));
  check("request: Request.headers is accepted as-is",
    isSelfCheckRequest(new Request(ORIGIN, { headers: { "x-checkmyapp-checker": "1" } }).headers));
  check("redirect: the flag is appended with ? or & as the path needs",
    selfCheckRedirectPath("/verdict/abc") === "/verdict/abc?self_check=read_only" &&
      selfCheckRedirectPath("/verdict/abc?x=1") === "/verdict/abc?x=1&self_check=read_only",
    selfCheckRedirectPath("/verdict/abc?x=1"));
}

// 2 — every mutating route handler, with and without the header.
//
// The handlers are the real exports. No Cloudflare context, no D1, no Stripe,
// no Clerk session exists in this process: a handler that touched any of them
// before the guard would throw here instead of answering. So a 403 with our
// body is proof the guard ran first, and "without the header it never
// answers our refusal" is the control (it may throw for lack of a platform —
// that is the platform being reached, which is the point).
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Row = {
  name: string;
  file: string;
  fn: string;
  method: string;
  path: string;
  handler: Handler;
  params: Record<string, string>;
  next?: boolean; // handler is typed NextRequest
};
const rows: Row[] = [
  { name: "POST /api/checks", file: "src/app/api/checks/route.ts", fn: "POST", method: "POST", path: "/api/checks",
    handler: createCheck as unknown as Handler, params: {} },
  { name: "POST /api/runs/{id}/recheck", file: "src/app/api/runs/[id]/recheck/route.ts", fn: "POST", method: "POST",
    path: "/api/runs/run_1/recheck", handler: recheck as unknown as Handler, params: { id: "run_1" } },
  { name: "PATCH /api/runs/{id}/lens", file: "src/app/api/runs/[id]/lens/route.ts", fn: "PATCH", method: "PATCH",
    path: "/api/runs/run_1/lens", handler: lens as unknown as Handler, params: { id: "run_1" } },
  { name: "PATCH /api/findings/{id}", file: "src/app/api/findings/[id]/route.ts", fn: "PATCH", method: "PATCH",
    path: "/api/findings/f_1", handler: markFinding as unknown as Handler, params: { id: "f_1" } },
  { name: "POST /api/findings/{id}/ticket", file: "src/app/api/findings/[id]/ticket/route.ts", fn: "POST", method: "POST",
    path: "/api/findings/f_1/ticket", handler: fileTicket as unknown as Handler, params: { id: "f_1" } },
  { name: "POST /api/billing/one-check", file: "src/app/api/billing/one-check/route.ts", fn: "POST", method: "POST",
    path: "/api/billing/one-check", handler: oneCheck as unknown as Handler, params: {} },
  { name: "POST /api/billing/checkout", file: "src/app/api/billing/checkout/route.ts", fn: "POST", method: "POST",
    path: "/api/billing/checkout", handler: checkout as unknown as Handler, params: {} },
  { name: "POST /api/watch", file: "src/app/api/watch/route.ts", fn: "POST", method: "POST",
    path: "/api/watch", handler: enableWatch as unknown as Handler, params: {} },
  { name: "PATCH /api/watch/{slug}", file: "src/app/api/watch/[slug]/route.ts", fn: "PATCH", method: "PATCH",
    path: "/api/watch/target.test", handler: updateWatch as unknown as Handler, params: { slug: "target.test" } },
  { name: "DELETE /api/watch/{slug}", file: "src/app/api/watch/[slug]/route.ts", fn: "DELETE", method: "DELETE",
    path: "/api/watch/target.test", handler: cancelWatch as unknown as Handler, params: { slug: "target.test" } },
  { name: "POST /api/runs/{id}/export-specs", file: "src/app/api/runs/[id]/export-specs/route.ts", fn: "POST", method: "POST",
    path: "/api/runs/run_1/export-specs", handler: exportSpecs as unknown as Handler, params: { id: "run_1" }, next: true },
  // CHE-315: the remote MCP server starts checks, adds apps and switches
  // watches — every one of them a record our checker must never create.
  { name: "POST /mcp", file: "src/app/api/mcp/route.ts", fn: "POST", method: "POST",
    path: "/api/mcp", handler: mcp as unknown as Handler, params: {} },
  // CHE-194: connecting a repository stores a token and can register an app.
  { name: "POST /api/integrations/github", file: "src/app/api/integrations/github/route.ts", fn: "POST", method: "POST",
    path: "/api/integrations/github", handler: connectGithub as unknown as Handler, params: {} },
  { name: "DELETE /api/integrations/github", file: "src/app/api/integrations/github/route.ts", fn: "DELETE", method: "DELETE",
    path: "/api/integrations/github?runId=run_1", handler: disconnectGithub as unknown as Handler, params: {} },
];

function makeRequest(row: Row, withHeader: boolean): Request {
  const init: RequestInit = {
    method: row.method,
    headers: {
      "content-type": "application/json",
      ...(withHeader ? { "X-CheckMyApp-Checker": "1" } : {}),
    },
    // A body every schema would accept, so a handler that reads it before the
    // guard cannot hide behind a 400.
    body: row.method === "DELETE" ? undefined : JSON.stringify({
      url: "https://target.test/", runId: "run_1", plan: "pro", mark: "known", feedback: "confirmed", frequency: "daily",
    }),
  };
  const url = `${ORIGIN}${row.path}`;
  return row.next ? new NextRequest(url, init) : new Request(url, init);
}

async function callRow(row: Row, withHeader: boolean): Promise<{ status: number; body: unknown } | { threw: string }> {
  try {
    const res = await row.handler(makeRequest(row, withHeader), { params: Promise.resolve(row.params) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    return { threw: err instanceof Error ? err.message.split("\n").find((l) => l.trim()) ?? "" : String(err) };
  }
}

function isRefusal(r: { status: number; body: unknown } | { threw: string }): boolean {
  if ("threw" in r) return false;
  const body = r.body as { error?: string; code?: string } | null;
  return r.status === 403 && body?.code === SELF_CHECK_READ_ONLY.code && body?.error === SELF_CHECK_READ_ONLY.error;
}

async function handlers() {
  for (const row of rows) {
    const yes = await callRow(row, true);
    check(`${row.name}: with the header → 403 self_check_read_only, no platform touched`,
      isRefusal(yes), "threw" in yes ? `threw: ${yes.threw.slice(0, 100)}` : `${yes.status} ${JSON.stringify(yes.body)}`);
    const no = await callRow(row, false);
    check(`${row.name}: without the header → never our refusal`,
      !isRefusal(no), "threw" in no ? `threw: ${no.threw.slice(0, 100)}` : `${no.status} ${JSON.stringify(no.body)}`);
  }
}

// 3 — the guard is the first statement. Source is read from the repo the
// script runs in, so a later edit that slides something above the guard
// (a body read, a Turnstile call, an auth lookup) is caught here.
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// Where the body of the function declared at `head` opens: past its parameter
// list and past a return type. `Promise<{ id: string }>` and
// `{ error: string } | null` both carry braces that are not the body's — the
// first brace after the first `)` (what this did before CHE-194) lands inside
// createApiKey's return type and reads a type as the function's first statement.
function bodyOpen(source: string, head: number): number {
  let i = source.indexOf("(", head);
  if (i < 0) return -1;
  for (let depth = 0; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) break;
  }
  let angle = 0;
  let typed = "";
  for (i++; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      // A brace that opens the body: outside any <…>, and not where a type is
      // expected (after `:`, `|` or `&`).
      if (angle === 0 && !/[:|&]\s*$/.test(typed)) return i;
      for (let braces = 0; i < source.length; i++) {
        if (source[i] === "{") braces++;
        else if (source[i] === "}" && --braces === 0) break;
      }
      typed += "{}";
      continue;
    }
    if (ch === "<") angle++;
    else if (ch === ">" && source[i - 1] !== "=") angle--;
    typed += ch;
  }
  return -1;
}

// The first statement of `export [async] function NAME(...) {`, comments
// stripped. Ends at the first `;` — enough to see one call.
function firstStatement(source: string, fn: string): string | null {
  const head = source.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\s*\\(`));
  if (head < 0) return null;
  const open = bodyOpen(source, head);
  if (open < 0) return null;
  let body = source.slice(open + 1);
  body = body.replace(/^\s*\/\/[^\n]*\n/gm, ""); // whole-line comments
  const end = body.indexOf(";");
  return body.slice(0, end < 0 ? undefined : end).trim();
}

// ── 4 — nothing is left off the list (CHE-194) ─────────────────────────────
//
// The three webhooks are called by Clerk, Stripe and Telegram, each proving
// who it is with its own signature; our checker cannot make such a request.
const WEBHOOKS = "src/app/api/webhooks/";
// An exported server action that does NOT start with the guard, and why. A
// name here is a decision; an action missing from here and from the guard is
// a failure. Empty, and meant to stay so: the one name it held, the team
// switch, "stored nothing" — and began with requireUser(), which can create a
// user, a personal team and a membership on the way in (Codex on #262). An
// action has no "stores nothing" until the guard is its first line.
const UNGUARDED_ACTIONS: Record<string, string> = {};
// GET handlers (Codex on #262). The checker's browser never announces itself
// on a GET — a GET goes out byte-identical to a visitor's, by design
// (src/agent/self-hosts.ts shouldAnnounceSelfCheck) — so a GET cannot be
// guarded by the header. It has to be safe for our checker to load. Every GET
// handler is therefore named here as one of three things, and a new one fails
// until somebody names it:
//   "reads"        — the handler writes nothing (checked below: no write call
//                    in the file);
//   "browser-only" — it stores nothing on our side: a short-lived cookie in the
//                    caller's own browser, then a redirect to the provider;
//   { writes, needs } — it can write, and only after something our checker
//                    cannot produce. `needs` says what.
//
// What none of the three is a claim about (Codex on #262, round 3): being
// signed in. requireUser() and getOptionalUser() keep the signed-in person's
// own mirror row current on every signed-in request — a page, a handler, an
// action alike — and give an account its personal team the first time it is
// seen (src/lib/auth.ts, src/lib/users.ts). That is what signing in does, for
// the account that signed in, and the self-check signs in as an ordinary
// account by design (CLAUDE.md §6); no header could refuse it without refusing
// the sign-in. It is pinned below instead: the mirror writes the email and the
// name of the row keyed by the signed-in identity, and nothing else.
type GetKind = "reads" | "browser-only" | { writes: string; needs: string };
const GET_HANDLERS: Record<string, GetKind> = {
  "src/app/.well-known/posthog-client.json/route.ts": "reads",
  "src/app/api/checks/lookup/route.ts": "reads",
  "src/app/api/checks/today/route.ts": "reads",
  "src/app/api/evidence/[...path]/route.ts": "reads",
  "src/app/api/runs/[id]/review/route.ts": "reads",
  "src/app/api/runs/[id]/route.ts": "reads",
  "src/app/api/runs/[id]/stream/route.ts": "reads",
  "src/app/api/runs/[id]/verdict/route.ts": "reads",
  "src/app/api/status/[slug]/route.ts": "reads",
  "src/app/api/tests/[id]/route.ts": "reads",
  "src/app/api/integrations/linear/start/route.ts": "browser-only",
  "src/app/api/integrations/posthog/start/route.ts": "browser-only",
  "src/app/api/billing/one-check/route.ts": {
    writes: "starts the run of a paid $1 check when the webhook has not arrived yet",
    needs: "a Stripe Checkout session that Stripe reports as paid — parking one is the POST above it, which is guarded, and paying it is a card at Stripe",
  },
  "src/app/api/integrations/linear/callback/route.ts": {
    writes: "stores the tracker connection",
    needs: "the nonce cookie its start route set AND a code Linear's token endpoint accepts — issued only after a person consents at Linear, off our origin",
  },
  "src/app/api/integrations/posthog/callback/route.ts": {
    writes: "stores the analytics connection",
    needs: "the nonce and verifier cookies its start route set AND a code PostHog's token endpoint accepts — issued only after a person consents at PostHog, off our origin",
  },
};
const WRITE_CALL = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
const WRITE_CALL_ALL = new RegExp(WRITE_CALL.source, "g");

const ROUTE_GUARD = /^if \(isSelfCheckRequest\((_?req)\.headers\)\) return selfCheckReadOnlyResponse\(\)$/;
const ACTION_GUARD = /^(await refuseSelfCheck\(|if \(isSelfCheckRequest\(await headers\(\)\)\) redirect\()/;
const FILE_LEVEL_DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use server["']/;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(rel));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function inventory() {
  const files = filesUnder("src/app").map((file) => ({ file, src: readFileSync(path.join(repoRoot, file), "utf8") }));
  const bare: string[] = [];
  const seenRoutes: string[] = [];
  const seenActions: string[] = [];
  const guardedActions = new Set<string>();
  const excepted: string[] = [];

  for (const { file, src } of files) {
    if (file.endsWith("/route.ts") && !file.startsWith(WEBHOOKS)) {
      for (const m of src.matchAll(/export\s+(?:async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b/g)) {
        seenRoutes.push(`${file} ${m[2]}`);
        const first = m[1] === "function" ? firstStatement(src, m[2]) : null;
        if (!first || !ROUTE_GUARD.test(first)) bare.push(`${file} ${m[2]}() — ${first === null ? "not a function declaration this guard can read" : first.slice(0, 60)}`);
      }
    }
    if (!FILE_LEVEL_DIRECTIVE.test(src)) continue;
    // In a "use server" file every export is an action a browser can call.
    for (const m of src.matchAll(/export\s+(?:async\s+)?(function|const)\s+(\w+)/g)) {
      const key = `${file} ${m[2]}`;
      seenActions.push(key);
      if (UNGUARDED_ACTIONS[key]) {
        excepted.push(key);
        continue;
      }
      const first = m[1] === "function" ? firstStatement(src, m[2]) : null;
      if (first && ACTION_GUARD.test(first)) guardedActions.add(m[2]);
      else bare.push(`${key}() — ${first === null ? "not a function declaration this guard can read" : first.slice(0, 60)}`);
    }
    // `refuseSelfCheck` is the real one: the shared helper, or the verdict
    // page's own (checked above).
    if (/await refuseSelfCheck\(/.test(src) && !src.includes('from "@/lib/self-check-action"') && file !== "src/app/verdict/actions.ts") {
      bare.push(`${file}: calls a refuseSelfCheck that is not the one in src/lib/self-check-action.ts`);
    }
  }
  // An action written inline in a page ("use server" inside a function) may
  // only hand over to a guarded action.
  const inline: string[] = [];
  for (const { file, src } of files) {
    if (FILE_LEVEL_DIRECTIVE.test(src)) continue;
    for (const m of src.matchAll(/["']use server["'];?\s*([^}]*)\}/g)) {
      inline.push(file);
      const call = m[1].trim().match(/^await (\w+)\([^;]*\);?$/);
      if (!call || !guardedActions.has(call[1])) bare.push(`${file}: an inline action that does more than call a guarded one — ${m[1].trim().slice(0, 60)}`);
    }
  }

  check("inventory: every POST / PUT / PATCH / DELETE handler outside the webhooks starts with the guard, and every exported server action does or is named with its reason",
    bare.length === 0, bare.join(" ¦ "));
  check("inventory: it read the tree — the handlers listed above, the onboarding form's action and the invitation page's inline action are among what it saw",
    rows.every((row) => seenRoutes.includes(`${row.file} ${row.fn}`)) && seenActions.includes("src/app/onboarding/actions.ts createApp") &&
      seenActions.includes("src/app/dashboard/actions.ts createApiKey") && inline.includes("src/app/invite/[token]/page.tsx"),
    `${seenRoutes.length} handlers, ${seenActions.length} actions, ${inline.length} inline`);
  check("inventory: every named exception still exists — a stale name is a rule nobody can read",
    Object.keys(UNGUARDED_ACTIONS).every((key) => excepted.includes(key)), Object.keys(UNGUARDED_ACTIONS).filter((key) => !excepted.includes(key)).join(", "));
  check("inventory: the webhooks are the only handlers left out, and there are three of them",
    files.filter(({ file }) => file.startsWith(WEBHOOKS) && file.endsWith("/route.ts")).map(({ file }) => file.slice(WEBHOOKS.length).split("/")[0]).sort().join() === "clerk,stripe,telegram");

  // GET handlers: each one named, none stale, and "reads" means what it says.
  const gets = files.filter(({ file, src }) => file.endsWith("/route.ts") && /export\s+(?:async\s+)?(?:function|const)\s+GET\b/.test(src));
  const unnamed = gets.filter(({ file }) => !(file in GET_HANDLERS)).map(({ file }) => file);
  const stale = Object.keys(GET_HANDLERS).filter((file) => !gets.some((g) => g.file === file));
  check("inventory: every GET handler is named as one that reads, one that only sets a cookie in the caller's browser, or one that writes after something our checker cannot produce",
    unnamed.length === 0 && stale.length === 0, [...unnamed.map((f) => `not named: ${f}`), ...stale.map((f) => `no such GET handler: ${f}`)].join(" ¦ "));
  const notJustReading = gets.filter(({ file, src }) => GET_HANDLERS[file] === "reads" && (WRITE_CALL.test(src) || /cookies\(\)/.test(src))).map(({ file }) => file);
  const notJustCookies = gets.filter(({ file, src }) => GET_HANDLERS[file] === "browser-only" && (WRITE_CALL.test(src) || !/\.set\(/.test(src) || !/NextResponse\.redirect\(/.test(src))).map(({ file }) => file);
  check("inventory: a GET handler named \"reads\" has no write call and touches no cookie; one named \"browser-only\" sets a cookie, redirects, and has no write call",
    notJustReading.length === 0 && notJustCookies.length === 0, [...notJustReading, ...notJustCookies].join(" ¦ "));
  const writers = Object.entries(GET_HANDLERS).filter((entry): entry is [string, { writes: string; needs: string }] => typeof entry[1] === "object");
  check("inventory: a GET handler that can write says what it needs first — and its own source shows the gate",
    writers.length > 0 && writers.every(([, kind]) => kind.writes.length > 20 && kind.needs.length > 40) &&
      // The paid check: the state is asked of Stripe, by the session id.
      /paidCheckState\(db, stripe, sessionId\)/.test(readFileSync(path.join(repoRoot, "src/app/api/billing/one-check/route.ts"), "utf8")) &&
      // The callbacks: the nonce is compared before anything, and the code is exchanged before the write.
      ["linear", "posthog"].every((provider) => {
        const src = readFileSync(path.join(repoRoot, `src/app/api/integrations/${provider}/callback/route.ts`), "utf8");
        const nonceAt = src.search(/[nN]once[^\n]*!== nonce/);
        const exchangeAt = src.indexOf("exchangeCode(");
        const writeAt = src.search(/\.upsert\(/);
        return nonceAt > 0 && exchangeAt > nonceAt && writeAt > exchangeAt;
      }));

  // What signing in keeps current, and only that: one upsert, keyed by the
  // signed-in identity, writing the email and the name.
  const users = readFileSync(path.join(repoRoot, "src/lib/users.ts"), "utf8");
  const mirrorAt = users.indexOf("export async function upsertUserFromClerk(");
  const mirror = mirrorAt < 0 ? "" : users.slice(mirrorAt, users.indexOf("\n}\n", mirrorAt)).replace(/\s+/g, " ");
  check("src/lib/users.ts upsertUserFromClerk: the one write signing in makes on every request touches the signed-in identity's own row — its email and name — and nothing else",
    /return db\.user\.upsert\(\{ where: \{ clerkUserId: u\.clerkUserId \}, create: \{ clerkUserId: u\.clerkUserId, email: u\.email, name: u\.name \?\? undefined, \}, update: \{ email: u\.email, name: u\.name \?\? undefined, \}, \}\);?\s*$/.test(mirror) &&
      (mirror.match(WRITE_CALL_ALL) ?? []).length === 1,
    mirror.slice(0, 200));

  // The shared helper: reads the request, redirects with the flag, and is not
  // itself an action.
  const helper = readFileSync(path.join(repoRoot, "src/lib/self-check-action.ts"), "utf8");
  check("src/lib/self-check-action.ts: reads next/headers, redirects with ?self_check=read_only, and is not a \"use server\" file",
    /export async function refuseSelfCheck\(path: string\): Promise<void> \{\s*if \(isSelfCheckRequest\(await headers\(\)\)\) redirect\(selfCheckRedirectPath\(path\)\);\s*\}/.test(helper) &&
      !FILE_LEVEL_DIRECTIVE.test(helper));

  // The reader itself, on the shapes that fooled the old one.
  const shapes = `
export async function a(x: string): Promise<{ id: string; raw: string }> {
  await refuseSelfCheck("/a");
  return { id: x, raw: x };
}
export async function b(
  _prev: { error: string } | null,
  form: FormData,
): Promise<{ error: string } | null> {
  // a comment first
  const first = 1;
  return null;
}
export async function c(x = fn(1, (2))): { error: string } | null {
  return null;
}`;
  check("reader: a return type's braces are not the body — Promise<{…}>, { … } | null, a default with brackets",
    firstStatement(shapes, "a") === 'await refuseSelfCheck("/a")' && firstStatement(shapes, "b") === "const first = 1" && firstStatement(shapes, "c") === "return null",
    [firstStatement(shapes, "a"), firstStatement(shapes, "b"), firstStatement(shapes, "c")].join(" ¦ "));
}

function sourceChecks() {
  for (const row of rows) {
    const src = readFileSync(path.join(repoRoot, row.file), "utf8");
    const first = firstStatement(src, row.fn);
    check(`${row.file} ${row.fn}(): the guard is the first statement`,
      first !== null && /^if \(isSelfCheckRequest\((_?req)\.headers\)\) return selfCheckReadOnlyResponse\(\)$/.test(first),
      first ?? "function not found");
  }
  const savedAction = readFileSync(path.join(repoRoot, 'src/app/dashboard/actions.ts'), 'utf8');
  check('Saved-app Run refuses self-checks before auth and database work', firstStatement(savedAction, 'runSavedApp')?.startsWith('if (isSelfCheckRequest(await headers())) redirect(') === true);
  // Server actions. `headers()` from next/headers throws outside a request
  // scope, so these cannot be called here; the source is the evidence. Each
  // exported action's first statement is `await refuseSelfCheck(publicId)`,
  // and that helper is `if (isSelfCheckRequest(await headers())) redirect(...)`.
  const actionsFile = "src/app/verdict/actions.ts";
  const actions = readFileSync(path.join(repoRoot, actionsFile), "utf8");
  for (const fn of ["recheckRunAction", "fullRecheckRunAction", "retryFailedRunAction", "enableWatchAction"]) {
    const first = firstStatement(actions, fn);
    check(`${actionsFile} ${fn}(): the guard is the first statement`,
      first === "await refuseSelfCheck(publicId)", first ?? "function not found");
  }
  const helperHead = actions.indexOf("async function refuseSelfCheck(");
  const helper = helperHead < 0 ? "" : actions.slice(helperHead, actions.indexOf("}\n}", helperHead) + 3);
  check(`${actionsFile} refuseSelfCheck(): reads next/headers and redirects with ?self_check=read_only`,
    helper.includes("isSelfCheckRequest(await headers())") &&
      helper.includes("redirect(selfCheckRedirectPath(`/verdict/${publicId}`))"),
    helper.replace(/\s+/g, " ").slice(0, 160));
  check(`${actionsFile}: the action helper is not itself exported as an action`,
    !/export\s+async\s+function\s+refuseSelfCheck/.test(actions));
  // The page must not grow copy for the flag: the verdict page reads only the
  // params it already did.
  const page = readFileSync(path.join(repoRoot, "src/app/verdict/[id]/page.tsx"), "utf8");
  check("src/app/verdict/[id]/page.tsx: shows nothing for ?self_check=read_only", !page.includes("self_check"));
}

async function main() {
  await handlers();
  sourceChecks();
  inventory();
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
