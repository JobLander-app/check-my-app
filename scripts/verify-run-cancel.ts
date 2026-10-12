// CHE-454 verification: a started check can be stopped, and stays stopped.
//
//   1. on a real D1 (Miniflare): a member stops a running check — canceled,
//      $0, the bought balance a price took goes back, the feed says who, the
//      Workflow is terminated; a reader, another team, a finished check and a
//      second stop are refused and leave the row as it was;
//   2. every write in the workflow that ends a run or moves it on is fenced on
//      "not canceled" (read as syntax): a step that finishes after the stop
//      cannot write a verdict, a phase or a failure over it;
//   3. a stopped Shopify check gives the session host back on the next tick —
//      only runs stopped within one lease, only session runs;
//   4. both doors reach the same cancelRun with a real terminate: MCP
//      cancel_check (every team) and the Stop button, which the page shows to
//      exactly who the server would let stop it.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-run-cancel.ts

import "./fixtures/wasm-module-loader.mjs";
import ts from "typescript";
import { realD1 } from "./fixtures/real-d1";
import { calls, jsx, properties, source } from "./fixtures/ts-source";
import { cancelRun, stoppedLine } from "../src/lib/run-cancel";
import { settleCanceledPrices } from "../src/agent/canceled-leases";
import { releaseCanceledLeases } from "../src/agent/canceled-leases";
import { SESSION_LEASE_SECONDS } from "../src/agent/session-browser";
import type { AgentEnv } from "../src/agent/env";
import { completeSignedOut } from "../src/agent/signed-out";
import { completeClosedDoor } from "../src/agent/closed-door";
import { loadRunStatus, loadVerdict } from "../src/lib/run-read";
import { extensionReportPublished } from "../src/lib/extension-target";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

async function main() {
  const now = new Date("2026-10-12T16:00:00Z");
  const real = await realD1();
  const { db } = real;
  try {
    await db.user.create({ data: { id: "ann", clerkUserId: "ck_ann", email: "ann@a.test" } });
    await db.team.create({ data: { id: "ta", name: "A", plan: "business", topupUsd: 10 } });
    await db.team.create({ data: { id: "tb", name: "B", plan: "business" } });
    const run = (id: string, n: number, teamId: string, status: string, extra: Record<string, unknown> = {}) =>
      db.run.create({ data: { id, publicId: `p_${id}`, runNumber: n, ownerId: "ann", teamId, targetUrl: "https://a.test/", appSlug: "a.test", status, ...extra } as never });
    await run("r1", 1, "ta", "walking", { events: JSON.stringify([{ at: now.toISOString(), phase: "walking", icon: "info", text: "Walking" }]) });
    await run("r2", 2, "ta", "completed");
    await db.watch.create({ data: { id: "w1", ownerId: "ann", teamId: "ta", appSlug: "a.test", targetUrl: "https://a.test/" } as never });
    const accounts = JSON.stringify([{ label: "admin", email: "a@a.test", passwordEnc: "enc-admin" }]);
    await run("r5", 5, "ta", "walking", { testPasswordEnc: "enc-default", storePasswordEnc: "enc-store", testAccounts: accounts });
    await run("r6", 6, "ta", "walking", { watchId: "w1", testPasswordEnc: "enc-default", testAccounts: accounts });
    await run("r3", 3, "tb", "walking");
    // Priced already, part of it from the bought balance (a step priced it, then the stop came).
    await run("r4", 4, "ta", "writing", { priceUsd: 1.2, priceFromTopupUsd: 1.2 });
    await db.team.update({ where: { id: "ta" }, data: { topupUsd: 8.8 } });

    const terminated: string[] = [];
    const terminate = async (id: string) => void terminated.push(id);
    const member = { userId: "ann", teamId: "ta", scope: "member" as const, name: "Ann" };

    // 1. The row.
    const reader = await cancelRun(db, { ...member, scope: "reader" }, "p_r1", terminate, now);
    eq("a reader is refused", [reader.ok, !reader.ok && reader.code], [false, "forbidden"]);
    eq("…and the check runs on, nothing terminated", [(await db.run.findUnique({ where: { id: "r1" } }))?.status, terminated], ["walking", []]);

    const stopped = await cancelRun(db, member, "p_r1", terminate, now);
    const r1 = await db.run.findUnique({ where: { id: "r1" } });
    eq("a member stops a running check", [stopped.ok, r1?.status, r1?.completedAt?.toISOString()], [true, "canceled", now.toISOString()]);
    eq("…it costs $0", r1?.priceUsd, 0);
    const feed = JSON.parse(r1?.events ?? "[]") as { text: string }[];
    eq("…the feed keeps what was there and says who stopped it", [feed.length, feed.at(-1)?.text], [2, stoppedLine("Ann")]);
    eq("…and the Workflow is terminated, under the run's own id", terminated, ["r1"]);

    const again = await cancelRun(db, member, "p_r1", terminate, now);
    eq("a second stop is refused, nothing terminated twice", [again.ok, terminated.length], [false, 1]);
    const finished = await cancelRun(db, member, "p_r2", terminate, now);
    eq("a finished check cannot be stopped", [finished.ok, (await db.run.findUnique({ where: { id: "r2" } }))?.status], [false, "completed"]);
    const other = await cancelRun(db, member, "p_r3", terminate, now);
    eq("another team's check is not found", [other.ok, !other.ok && other.code, (await db.run.findUnique({ where: { id: "r3" } }))?.status], [false, "not_found", "walking"]);

    await cancelRun(db, member, "p_r4", terminate, now);
    const r4 = await db.run.findUnique({ where: { id: "r4" } });
    eq("a check priced before the stop is zeroed", [r4?.status, r4?.priceUsd, r4?.priceFromTopupUsd], ["canceled", 0, 0]);
    eq("…and the bought balance it took goes back", (await db.team.findUnique({ where: { id: "ta" } }))?.topupUsd, 10);

    await cancelRun(db, member, "p_r5", terminate, now);
    const r5 = await db.run.findUnique({ where: { id: "r5" } });
    eq(
      "a stopped one-off check forgets every password — its workflow never reaches its own cleanup",
      [r5?.testPasswordEnc, r5?.storePasswordEnc, (JSON.parse(r5?.testAccounts ?? "[]") as { passwordEnc: string | null; email: string }[]).map((a) => [a.email, a.passwordEnc])],
      [null, null, [["a@a.test", null]]],
    );
    await cancelRun(db, member, "p_r6", terminate, now);
    eq("…a watch's check keeps them for the watch's next one", (await db.run.findUnique({ where: { id: "r6" } }))?.testPasswordEnc, "enc-default");

    // The early endings (a signed-out store, a closed door) are fenced too: a
    // check stopped while they ran is not turned into "Not verified" (Codex on #329).
    await run("e1", 21, "ta", "canceled", { completedAt: now });
    const signedOut = await completeSignedOut({ db } as never, { id: "e1", targetUrl: "https://a.test/" }, "admin.shopify.com").then(() => "wrote", (e: Error) => e.name);
    const door = await completeClosedDoor({ db } as never, { id: "e1", targetUrl: "https://a.test/" }, "forbidden").then(() => "wrote", (e: Error) => e.name);
    const e1 = await db.run.findUnique({ where: { id: "e1" } });
    eq("the signed-out and closed-door endings refuse a stopped check and leave it stopped", [signedOut, door, e1?.status, e1?.verdict], ["RunCanceled", "RunCanceled", "canceled", null]);

    // What a stopped check wrote before the stop is not a result.
    await db.journey.create({ data: { id: "j1", runId: "r1", order: 0, title: "Sign up", status: "ok" } as never });
    await db.finding.create({ data: { id: "f1", runId: "r1", number: 1, title: "Half-written", category: "broken", severity: "high", detail: "{}" } as never });
    const read = await loadVerdict(db, "p_r1");
    eq("a stopped check publishes nothing it wrote before the stop", [extensionReportPublished({ targetKind: "website", status: "canceled", verdict: null }), read?.journeys.length, read?.findings.length], [false, 0, 0]);

    // Checks that clean up after themselves at their end run to it (Codex on #329).
    await db.app.create({ data: { id: "app_w", teamId: "ta", ownerId: "ann", appSlug: "w.test", targetUrl: "https://w.test/", writeMode: "create_cleanup" } as never });
    await run("x1", 31, "ta", "walking", { targetKind: "extension" });
    await run("x2", 32, "ta", "walking", { appId: "app_w" });
    const ext = await cancelRun(db, member, "p_x1", terminate, now);
    const writes = await cancelRun(db, member, "p_x2", terminate, now);
    eq("an extension check and a check that may create records are not stopped midway, and say why",
      [ext.ok, writes.ok, (await db.run.findUnique({ where: { id: "x1" } }))?.status, (await db.run.findUnique({ where: { id: "x2" } }))?.status, terminated.includes("x1") || terminated.includes("x2")],
      [false, false, "walking", "walking", false]);
    check("…in a sentence each", !ext.ok && /extension/.test(ext.error) && !writes.ok && /test records/.test(writes.error));

    // The run's own ledger decides too: a check that has created a record is
    // not cut short, even if its app's setting was changed since (Codex on #329).
    await run("x3", 33, "ta", "walking");
    await db.createdResource.create({ data: { runId: "x3", kind: "story", marker: "CheckMyApp test 1" } as never });
    const made = await cancelRun(db, member, "p_x3", terminate, now);
    eq("a check that has created a record runs to its cleanup", [made.ok, (await db.run.findUnique({ where: { id: "x3" } }))?.status], [false, "walking"]);

    // A stopped check's status carries no verdict, whatever a step wrote first.
    await db.run.update({ where: { id: "r1" }, data: { verdict: "broken" } });
    eq("get_check_status of a stopped check names no verdict, and keeps its feed", [(await loadRunStatus(db, "p_r1"))?.verdict, ((await loadRunStatus(db, "p_r1"))?.events ?? []).length > 0], [null, true]);

    // The refund does not hang on the stop's own request.
    await db.run.update({ where: { id: "r4" }, data: { priceUsd: 0.9, priceFromTopupUsd: 0.9 } });
    await db.team.update({ where: { id: "ta" }, data: { topupUsd: 9.1 } });
    const settled = await settleCanceledPrices(db);
    const r4b = await db.run.findUnique({ where: { id: "r4" } });
    eq("the tick zeroes a stopped check still priced, and the bought balance goes back", [settled.includes("r4"), r4b?.priceUsd, (await db.team.findUnique({ where: { id: "ta" } }))?.topupUsd], [true, 0, 10]);
    eq("…and has nothing to do the next time", await settleCanceledPrices(db), []);

    // 3. The session host.
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    await run("s1", 11, "ta", "canceled", { targetKind: "session", completedAt: minutesAgo(5) });
    await run("s2", 12, "ta", "canceled", { targetKind: "session", completedAt: minutesAgo(SESSION_LEASE_SECONDS / 60 + 5) });
    await run("s3", 13, "ta", "canceled", { targetKind: "url", completedAt: minutesAgo(5) });
    await run("s4", 14, "ta", "walking", { targetKind: "session" });
    await run("s5", 15, "ta", "failed", { targetKind: "session", completedAt: minutesAgo(5) });
    const asked: string[] = [];
    const env = {
      db,
      bindings: { SESSION_HOST_URL: "https://host.test", SESSION_ACCESS_CLIENT_ID: "id", SESSION_ACCESS_CLIENT_SECRET: "secret", SESSION_SERVER_TOKEN: "token" },
    } as unknown as AgentEnv;
    const released = await releaseCanceledLeases(env, now, async (host, id) => {
      asked.push(`${host.url}:${id}`);
      return true;
    });
    eq("a session check stopped within one lease is released — and nothing else", [released, asked], [["s1"], ["https://host.test:s1"]]);
    eq("nothing stopped, nothing asked — and no host needed", await releaseCanceledLeases({ db: { run: { findMany: async () => [] } }, bindings: {} } as unknown as AgentEnv, now), []);
  } finally {
    await real.dispose();
  }

  // 2. The fence, every write that ends a run or moves it on.
  const wf = source("src/agent/workflow.ts");
  const writes = calls(wf).filter((c) => /\.run\.(update|updateMany)$/.test(c.callee));
  const ending = writes.filter((c) => {
    const data = prop(c.node.arguments[0], "data", wf);
    return ["status", "verdict"].some((k) => data && objectHas(data, k, wf));
  });
  const unfenced = ending.filter((c) => {
    const where = prop(c.node.arguments[0], "where", wf);
    return c.callee.endsWith(".updateMany") === false || !where || prop(where, "status", wf)?.getText(wf).replace(/\s+/g, " ") !== '{ not: "canceled" }';
  });
  check(
    `every status or verdict write in the workflow is fenced on "not canceled" (${ending.length} writes)`,
    ending.length >= 4 && unfenced.length === 0,
    unfenced.map((c) => `line ${wf.getLineAndCharacterOfPosition(c.node.getStart(wf)).line + 1}`).join(", "),
  );
  const fail = calls(wf).find((c) => c.callee === "step.do" && c.args[0] === '"fail"');
  check(
    "a failure noticed after the stop records nothing over it",
    Boolean(fail) && calls(wf, fail!.node).some((c) => c.callee === "env.db.run.findUnique") && fail!.node.getText(wf).includes('before?.status === "canceled"'),
  );

  // 4. The doors.
  const scheduler = source("src/agent/scheduler.ts");
  const endings = calls(wf).filter((c) => c.callee === "completeSignedOut" || c.callee === "completeClosedDoor");
  check(
    "…and the workflow turns those helpers' refusal into the non-retryable stop, at every call",
    endings.length === 2 && endings.every((c) => ts.isPropertyAccessExpression(c.node.parent) && c.node.parent.name.text === "catch" && ts.isCallExpression(c.node.parent.parent) && c.node.parent.parent.arguments[0]?.getText(wf) === "stopIfCanceled"),
    String(endings.length),
  );
  check("the scheduler tick releases stopped session checks", calls(scheduler).some((c) => c.callee === "releaseCanceledLeases" && c.args.join(",") === "env,now"));
  const tools = source("src/lib/mcp/tools.ts");
  check("MCP cancel_check goes through cancelRun with the route's terminate", calls(tools).some((c) => c.callee === "cancelRun" && c.args[3]?.includes("terminate")));
  const route = source("src/app/api/mcp/route.ts");
  eq("…which the route wires to the Workflow's terminate", properties(route, "terminate"), ["terminateRun"]);
  const actions = source("src/app/run/actions.ts");
  check("the Stop button goes through cancelRun with the Workflow's terminate", calls(actions).some((c) => c.callee === "cancelRun" && c.args[3] === "terminateRun"));
  const page = source("src/app/run/[id]/page.tsx");
  const live = jsx(page).find((e) => e.tag === "RunLive");
  check("the live page is told who may stop", Boolean(live?.props.mayStop?.includes("mayStopRun")));
  check("…by the same permission the server asks for", calls(page).some((c) => c.callee === "can" && c.args[1] === '"run.start"'));
  const runLive = source("src/components/run-live.tsx");
  eq("…and shows Stop only then", jsx(runLive).filter((e) => e.tag === "StopRun").map((e) => e.guard), ["mayStop"]);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

// `{ key: value }` → value, when the node is that object literal.
function prop(node: ts.Node | undefined, key: string, sf: ts.SourceFile): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const p of node.properties) if (ts.isPropertyAssignment(p) && p.name.getText(sf) === key) return p.initializer;
  return undefined;
}
// Does the object literal (spreads included, as written) set `key`?
function objectHas(node: ts.Node, key: string, sf: ts.SourceFile): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === key);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
