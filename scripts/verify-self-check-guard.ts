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
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-self-check-guard.ts

import { readFileSync } from "node:fs";
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

// The first statement of `export async function NAME(...) {`, comments
// stripped. Ends at the first `;` — enough to see one call.
function firstStatement(source: string, fn: string): string | null {
  const head = source.indexOf(`export async function ${fn}(`);
  if (head < 0) return null;
  const open = source.indexOf("{", source.indexOf(")", head));
  if (open < 0) return null;
  let body = source.slice(open + 1);
  body = body.replace(/^\s*\/\/[^\n]*\n/gm, ""); // whole-line comments
  const end = body.indexOf(";");
  return body.slice(0, end < 0 ? undefined : end).trim();
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
  for (const file of ["src/app/verdict/[id]/page.tsx", "src/components/verdict-view.tsx"]) {
    check(`${file}: shows nothing for ?self_check=read_only`, !readFileSync(path.join(repoRoot, file), "utf8").includes("self_check"));
  }
}

async function main() {
  await handlers();
  sourceChecks();
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
