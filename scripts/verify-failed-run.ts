// CHE-329 verification: a run that fails on our side is on our board, one
// ticket per signature however many runs trip it; a customer's site that is
// simply down is not; and nothing a customer or their agent reads carries the
// raw failure or the retry email that never existed.
//
// The failures are the real ones, byte for byte from prod D1 (`SELECT
// runNumber, errorMessage FROM Run WHERE status='failed' AND createdAt >=
// '2026-09-14'`, read 2026-09-28): #197 and #258 (the model provider's 403 in
// `writing`), #206 (WorkflowInternalError), #198 (a self-check account's
// placeholder host refusing every connection).
//
// Driven through the real code: classifyRunFailure and fileRunFailure →
// fileFindingTicket → dedupKeyForFinding over a prisma-like stub and a stub
// tracker; loadRunStatus (the payload behind GET /api/runs/{id} and the MCP
// status tools); the live-stream route, bundled with only its database mocked;
// the failed-run card, rendered with react-dom/server. No network, no model.
//
// The modules this ticket adds are imported dynamically, so on a checkout
// without them every check that needs them FAILS by name instead of the whole
// script dying at its first import.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-failed-run.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { PrismaClient } from "@/generated/prisma/client";
import type { AgentEnv } from "@/agent/env";
import type { GapBoard } from "@/agent/capability-gaps";
import { loadRunStatus, loadVerdict } from "@/lib/run-read";
import { extensionReportPublished } from "@/lib/extension-target";
import type { CreatedIssue, IssueOutcome, TicketDraft, Tracker } from "@/lib/tracker/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

// ─── The failures, as stored in prod D1 ─────────────────────────────────────

const PROVIDER_403 = '403 {"error":{"type":"forbidden","message":"Request not allowed"}}';
const WORKFLOW_206 = "WorkflowInternalError: Attempt failed due to internal workflows error";
const GOTO_198 =
  'page.goto: net::ERR_CONNECTION_RESET at https://checkmyapp-test-r197.example.com/\nCall log:\n  - navigating to "https://checkmyapp-test-r197.example.com/", waiting until "domcontentloaded"\n';
const GOTO_CUSTOMER =
  'page.goto: net::ERR_CONNECTION_RESET at https://shop.example.org/\nCall log:\n  - navigating to "https://shop.example.org/", waiting until "domcontentloaded"\n';
// Words the raw 403 carries that no customer sentence should.
const RAW = /forbidden|Request not allowed|\b403\b|WorkflowInternalError|ERR_CONNECTION/;

type RunRow = {
  id: string;
  runNumber: number;
  publicId: string;
  startedAt: Date;
  appSlug: string;
  targetUrl: string;
  targetKind: string;
  ownerId: string | null;
  teamId: string | null;
  watchId: string | null;
  owner: { isTestAccount: boolean } | null;
};

const RUNS: Record<string, RunRow> = {
  r197: { id: "r197", runNumber: 197, publicId: "pub197", startedAt: new Date("2026-09-15T17:01:21Z"), appSlug: "checkmyapp.dev", targetUrl: "https://checkmyapp.dev", targetKind: "website", ownerId: "owner", teamId: "team", watchId: "w1", owner: { isTestAccount: false } },
  r258: { id: "r258", runNumber: 258, publicId: "cmuk8awxv0003qz0n3zov7rdy", startedAt: new Date("2026-09-27T19:45:49Z"), appSlug: "joblander.app", targetUrl: "https://joblander.app", targetKind: "website", ownerId: "owner", teamId: "team", watchId: "w2", owner: { isTestAccount: false } },
  r300: { id: "r300", runNumber: 300, publicId: "pub300", startedAt: new Date("2026-09-28T10:00:00Z"), appSlug: "meetbashar.com", targetUrl: "https://meetbashar.com", targetKind: "website", ownerId: "owner", teamId: "team", watchId: "w3", owner: { isTestAccount: false } },
  r206: { id: "r206", runNumber: 206, publicId: "pub206", startedAt: new Date("2026-09-16T13:42:29Z"), appSlug: "joblander.app", targetUrl: "https://joblander.app", targetKind: "website", ownerId: "owner", teamId: "team", watchId: null, owner: { isTestAccount: false } },
  r198: { id: "r198", runNumber: 198, publicId: "pub198", startedAt: new Date("2026-09-15T17:16:09Z"), appSlug: "checkmyapp-test-r197.example.com", targetUrl: "https://checkmyapp-test-r197.example.com", targetKind: "website", ownerId: "test-owner", teamId: "team-test", watchId: null, owner: { isTestAccount: true } },
  rCust: { id: "rCust", runNumber: 301, publicId: "pub301", startedAt: new Date("2026-09-28T11:00:00Z"), appSlug: "shop.example.org", targetUrl: "https://shop.example.org", targetKind: "website", ownerId: "cust", teamId: "team-cust", watchId: null, owner: { isTestAccount: false } },
  rExt: { id: "rExt", runNumber: 207, publicId: "pub207", startedAt: new Date("2026-09-16T14:36:07Z"), appSlug: "extension:hafhjepjihcimcljkdphpinannbdmnhf", targetUrl: "https://chromewebstore.google.com/detail/hafhjepjihcimcljkdphpinannbdmnhf", targetKind: "extension", ownerId: "owner", teamId: "team", watchId: null, owner: { isTestAccount: false } },
};

// ─── A board: stub tracker + the ledger rows fileFindingTicket reads ─────────

function stubBoard() {
  const created: { identifier: string; title: string; body: string }[] = [];
  const comments: { issueId: string; body: string }[] = [];
  const links = new Map<string, { id: string; externalIssueId: string; status: string; occurrences: number; escalatedAt: Date | null; defectClass: null }>();
  let n = 400;
  const tracker: Tracker = {
    async createIssue(draft: TicketDraft): Promise<CreatedIssue> {
      const identifier = `CHE-${++n}`;
      created.push({ identifier, title: draft.title, body: draft.description });
      return { id: identifier, identifier, url: `https://linear.app/x/${identifier}` };
    },
    async addComment(issueId: string, body: string) {
      comments.push({ issueId, body });
    },
    async getIssueOutcome(): Promise<IssueOutcome> {
      return "open";
    },
  };
  const db = {
    run: { findUnique: async ({ where }: { where: { id: string } }) => RUNS[where.id] ?? null },
    issueLink: {
      findUnique: async ({ where }: { where: { appId_dedupKey: { dedupKey: string } } }) =>
        links.get(where.appId_dedupKey.dedupKey) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { occurrences: { increment: number } } }) => {
        const link = [...links.values()].find((l) => l.id === where.id);
        if (!link) throw new Error(`update of unknown link ${where.id}`);
        link.occurrences += data.occurrences.increment;
        return link;
      },
      upsert: async ({ where, create }: { where: { appId_dedupKey: { dedupKey: string } }; create: { externalIssueId: string } }) => {
        const link = { id: `link-${create.externalIssueId}`, externalIssueId: create.externalIssueId, status: "open", occurrences: 1, escalatedAt: null, defectClass: null };
        links.set(where.appId_dedupKey.dedupKey, link);
        return link;
      },
    },
    settledSignature: { findFirst: async () => null, create: async () => ({}) },
    app: { findUnique: async () => ({ teamId: "team-self" }) },
  };
  const self = { id: "app-self", appSlug: "checkmyapp.dev", ownerId: "owner", policy: null, tracker: { teamId: "team" } };
  const board = { self, tracker, baseUrl: "https://checkmyapp.dev" } as unknown as GapBoard;
  const env = { db: db as unknown as PrismaClient, bindings: {} } as unknown as AgentEnv;
  return { env, board, created, comments, links };
}

async function importOrFail<T>(name: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (err) {
    check(`${name} exists`, false, err instanceof Error ? err.message.split("\n")[0] : String(err));
    return null;
  }
}

async function main() {
  // ─── 1. Whose failure it is ────────────────────────────────────────────────
  const rf = await importOrFail("src/agent/run-failures.ts", () => import("@/agent/run-failures"));
  if (rf) {
    const facts = { budget: false, isExtension: false, afterVerdict: false, ourTarget: false, targetAnswers: null };
    const c258 = rf.classifyRunFailure({ ...facts, message: PROVIDER_403 });
    check("#258's provider 403, with no route-refusal ticket behind it → ours", c258.kind === "ours" && c258.signature === "Model provider answered HTTP 403", JSON.stringify(c258));
    // CHE-330 files a refusal that ended synthesis itself (fileRouteRefusal)
    // and, when that filing landed, the failure says so. One failure, one
    // ticket — and a filing that failed leaves the message bare, so the
    // run-failure ticket still catches it (Codex on #204, round 4).
    const cg0 = await import("@/agent/capability-gaps");
    const marked = "ROUTE_REFUSAL_FILED" in cg0 ? `${cg0.ROUTE_REFUSAL_FILED}CHE-777: ${PROVIDER_403}` : PROVIDER_403;
    check("a refusal fileRouteRefusal filed is not filed twice", rf.classifyRunFailure({ ...facts, message: marked }).kind === "filed_elsewhere", marked);
    if ("routeRefusalFiledAs" in cg0) {
      check("fileRouteRefusal's result: created/commented/suppressed → filed", cg0.routeRefusalFiledAs("created CHE-777") === "CHE-777" && cg0.routeRefusalFiledAs("commented CHE-777") === "CHE-777" && cg0.routeRefusalFiledAs("suppressed CHE-777") === "CHE-777");
      check("…a filing that failed, or found no board, → not filed", cg0.routeRefusalFiledAs("filing failed: Linear 503") === null && cg0.routeRefusalFiledAs("no tracker on our own app") === null && cg0.routeRefusalFiledAs("run r1 is gone") === null);
    } else {
      check("capability-gaps exports routeRefusalFiledAs", false);
    }
    check(
      "the synthesis catch marks the failure only when routeRefusalFiledAs found a ticket",
      /const identifier = routeRefusalFiledAs\(filed\);\s*if \(identifier && !\(err instanceof LlmBudgetError\)\) \{[\s\S]{0,200}throw new Error\(`\$\{ROUTE_REFUSAL_FILED\}\$\{identifier\}: \$\{message\}`\);/.test(source("src/agent/workflow.ts")),
    );
    const c500 = rf.classifyRunFailure({ ...facts, message: '500 {"error":{"type":"api_error"}}' });
    check("a provider 500 is a different signature from a 403", c500.kind === "ours" && c500.signature !== (c258 as { signature?: string }).signature);
    check("#206 WorkflowInternalError → ours", rf.classifyRunFailure({ ...facts, message: WORKFLOW_206 }).kind === "ours");
    check("runaway fuse → ours", rf.classifyRunFailure({ ...facts, message: "internal: runaway fuse — the check cost more than any check should; stopped, nothing was published" }).kind === "ours");
    check("our budget → ours, even on an extension run", rf.classifyRunFailure({ ...facts, isExtension: true, budget: true, message: "402 would exceed your available credits" }).kind === "ours");
    check("an extension runtime failure is left to the extension gap it already files", rf.classifyRunFailure({ ...facts, isExtension: true, message: "ExtensionRuntimeError: The container just exited" }).kind === "filed_elsewhere");
    check("#198 our placeholder host refusing connections → ours", rf.classifyRunFailure({ ...facts, ourTarget: true, message: GOTO_198 }).kind === "ours");
    check("a customer's site that answers nobody → theirs, not filed", rf.classifyRunFailure({ ...facts, targetAnswers: false, message: GOTO_CUSTOMER }).kind === "theirs");
    check("a customer's site that answers a plain request but not our browser → ours", rf.classifyRunFailure({ ...facts, targetAnswers: true, message: GOTO_CUSTOMER }).kind === "ours");
    const u1 = rf.classifyRunFailure({ ...facts, message: "Unable to create new browser: code: 429 session cm8x2k1v0003qz0n3zov7rdy https://a.test/x" });
    const u2 = rf.classifyRunFailure({ ...facts, message: "Unable to create new browser: code: 429 session cmzz9q7w0001ab0c1dzov8xyz https://b.test/y" });
    check("an unrecognised failure is still ours", u1.kind === "ours", JSON.stringify(u1));
    check("…under one signature whatever ids and URLs it carried", u1.kind === "ours" && u2.kind === "ours" && u1.signature === u2.signature, `${JSON.stringify(u1)} vs ${JSON.stringify(u2)}`);
    check("…and the signature holds none of the customer's URL", u1.kind === "ours" && !u1.signature.includes("a.test"));

    // ─── 2. Filing: one ticket per signature across N failures ──────────────
    const w = stubBoard();
    const probes: string[] = [];
    const probe = async (url: string) => {
      probes.push(url);
      return false;
    };
    for (const id of ["r197", "r258", "r300"]) {
      await rf.fileRunFailure(w.env, id, { message: PROVIDER_403, budget: false, phase: "walking" }, { board: w.board, probe });
    }
    const on403 = w.created.filter((c) => c.title.includes("Model provider answered HTTP 403"));
    check("three 403 failures on three apps → exactly one ticket", on403.length === 1, w.created.map((c) => c.title).join(" | "));
    check("…titled as ours: [Checker failure]", on403[0]?.title.startsWith("[Checker failure]") === true, on403[0]?.title);
    check("…the first run's link and message in the body", (on403[0]?.body ?? "").includes("https://checkmyapp.dev/run/pub197") && (on403[0]?.body ?? "").includes("Request not allowed"));
    const link = [...w.links.values()].find((l) => l.externalIssueId === on403[0]?.identifier);
    check("…counted to three", link?.occurrences === 3, String(link?.occurrences));
    check(
      "…each recurrence comment carries its own run link and step",
      w.comments.some((c) => c.body.includes("run/cmuk8awxv0003qz0n3zov7rdy") && c.body.includes("(walking)")) &&
        w.comments.some((c) => c.body.includes("run/pub300")),
      w.comments.map((c) => c.body).join(" || "),
    );

    await rf.fileRunFailure(w.env, "r206", { message: WORKFLOW_206, budget: false, phase: "walking" }, { board: w.board, probe });
    check("a different signature → its own ticket", w.created.length === 2, w.created.map((c) => c.title).join(" | "));

    await rf.fileRunFailure(w.env, "r198", { message: GOTO_198, budget: false, phase: "connecting" }, { board: w.board, probe });
    check("#198 (self-check account's placeholder) files, without asking the placeholder anything", w.created.length === 3 && probes.length === 0, `${w.created.length} tickets, ${probes.length} probes`);

    const before = w.created.length + w.comments.length;
    const note = await rf.fileRunFailure(w.env, "rCust", { message: GOTO_CUSTOMER, budget: false, phase: "connecting" }, { board: w.board, probe });
    check("a customer's site that is down is asked once, plainly", probes.length === 1 && probes[0] === "https://shop.example.org", probes.join(", "));
    check("…and files nothing on our board", w.created.length + w.comments.length === before && note === null);

    const beforeExt = w.created.length + w.comments.length;
    await rf.fileRunFailure(w.env, "rExt", { message: "ExtensionRuntimeError: internal: the extension's core result and cleanup were not established; no verdict may be published", budget: false, phase: "walking" }, { board: w.board, probe });
    check("an extension failure is not filed a second time here", w.created.length + w.comments.length === beforeExt);
    // Codex on #204, round 3: after its verdict was written, an extension
    // run's throw takes the branch that files no extension gap.
    await rf.fileRunFailure(w.env, "rExt", { message: "D1_ERROR: cleanup write failed", budget: false, phase: "partial, after the verdict was written", afterVerdict: true }, { board: w.board, probe });
    check("an extension run that threw after its verdict IS filed here", w.created.length + w.comments.length === beforeExt + 1, w.created.map((c) => c.title).join(" | "));

    const broken = stubBoard();
    broken.env.db.run.findUnique = (async () => {
      throw new Error("D1 went away");
    }) as never;
    let threw = false;
    try {
      await rf.fileRunFailure(broken.env, "r258", { message: PROVIDER_403, budget: false, phase: "writing" }, { board: broken.board, probe });
    } catch {
      threw = true;
    }
    check("filing never throws — one failure must not become two", !threw);
  }

  // The workflow calls it from the failure path, in its own step.
  const wf = source("src/agent/workflow.ts");
  check(
    "workflow.ts files every failure from its catch, in a step of its own",
    /step\.do\("file-failure"[\s\S]{0,200}fileRunFailure\(env, runId, \{ message: msg, budget, \.\.\.ended \}\)/.test(wf),
  );

  // Codex on #204, round 2: notify runs before cleanup, so a throw after the
  // verdict was written may follow a delivered email. Such a run stays
  // finished (not failed, not re-priced to 0) and the throw is still filed.
  check(
    "a throw after the verdict was written keeps the run finished, clears credentials, keeps its price",
    /if \(before\?\.status === "completed" \|\| before\?\.status === "partial"\) \{[\s\S]{0,700}\.\.\.cleared,[\s\S]{0,300}priceRun\(env\.db, runId\)\.catch[\s\S]{0,300}return \{ phase: `\$\{before\.status\}, after the verdict was written`, afterVerdict: true \};/.test(wf),
  );

  // ─── 3. What a customer's agent reads: GET /api/runs/{id}, MCP status ─────
  const failedRow = {
    publicId: "cmuk8awxv0003qz0n3zov7rdy",
    appSlug: "joblander.app",
    targetUrl: "https://joblander.app",
    targetKind: "website",
    status: "failed",
    verdict: null,
    events: "[]",
    errorMessage: PROVIDER_403,
    startedAt: new Date("2026-09-27T19:45:49Z"),
    completedAt: null,
  };
  const statusDb = { run: { findUnique: async () => failedRow } } as unknown as PrismaClient;
  const payload = await loadRunStatus(statusDb, failedRow.publicId);
  check("run #258's status payload carries no raw failure", !RAW.test(JSON.stringify(payload)), String(payload?.errorMessage));
  // Codex on #204: a step after synthesis (pricing, cleanup) can throw once a
  // verdict is written, and the run then ends failed with that verdict on the
  // row. And a budget failure recorded before this change left our provider's
  // name in the feed. A failed run publishes neither.
  const halfWritten = {
    ...failedRow,
    verdict: "broken",
    bottomLine: "PRIVATE_BOTTOM_LINE",
    events: JSON.stringify([{ at: "2026-09-27T19:40:00Z", phase: "connecting", icon: "warn", text: "Internal error on our side (LLM provider budget) — this run published no verdict and sent no notifications." }]),
    runNumber: 258,
    deploySha: null,
    deployEnv: null,
    ephemeral: false,
    expiresAt: null,
    journeys: [{ title: "PRIVATE_JOURNEY", status: "broken", summary: "PRIVATE_SUMMARY" }],
    findings: [{ number: 1, title: "PRIVATE_FINDING", category: "broken", severity: "high", mark: null }],
  };
  const halfDb = { run: { findUnique: async () => halfWritten } } as unknown as PrismaClient;
  const halfStatus = await loadRunStatus(halfDb, halfWritten.publicId);
  check("a failed run's status carries no verdict, even one written before it failed", halfStatus?.verdict === null, String(halfStatus?.verdict));
  check("…and no feed — the legacy provider line included", JSON.stringify(halfStatus?.events) === "[]" && !/LLM provider/.test(JSON.stringify(halfStatus)));
  const halfVerdict = await loadVerdict(halfDb, halfWritten.publicId);
  check("loadVerdict (GET …/verdict, get_verdict, wait_for_run) publishes nothing of a failed run", !/PRIVATE_/.test(JSON.stringify(halfVerdict)) && halfVerdict?.verdict === null, JSON.stringify(halfVerdict).slice(0, 160));

  // Codex on #204: our board is found by the board, not by the hostname. On
  // 2026-09-28 prod held two checkmyapp.dev apps — ours with the CHE tracker,
  // and the self-check account's, newer, with none.
  const cg = await import("@/agent/capability-gaps");
  if ("ourApp" in cg && typeof cg.ourApp === "function") {
    const rows = [
      { id: "ours", appSlug: "checkmyapp.dev", createdAt: new Date("2026-07-25"), tracker: { teamId: "b9503451-107e-41b6-a933-5959324a72af" } },
      { id: "customer", appSlug: "checkmyapp.dev", createdAt: new Date("2026-09-28T17:00:00Z"), tracker: { teamId: "their-linear-team" } },
      { id: "selfcheck", appSlug: "checkmyapp.dev", createdAt: new Date("2026-09-28T16:06:45Z"), tracker: null },
    ];
    const appDb = {
      app: {
        findFirst: async ({ where }: { where: { appSlug: string; tracker?: { is?: { teamId?: string } } } }) =>
          rows
            .filter((r) => r.appSlug === where.appSlug && (!where.tracker || r.tracker?.teamId === where.tracker.is?.teamId))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
      },
    };
    const found = await (cg.ourApp as (env: AgentEnv) => Promise<{ id: string } | null>)({ db: appDb, bindings: {} } as unknown as AgentEnv);
    check("our board is the app on our own Linear team, not the newest checkmyapp.dev row", found?.id === "ours", String(found?.id));
  } else {
    check("capability-gaps exports ourApp for the board check", false);
  }

  const lib = await importOrFail("src/lib/failed-run.ts", () => import("@/lib/failed-run"));
  if (lib) {
    check("…it carries the one plain sentence", payload?.errorMessage === lib.FAILED_RUN_LINE, String(payload?.errorMessage));
    check("the plain sentence is machinery-free", !RAW.test(lib.FAILED_RUN_LINE) && !/email|retry link|our side|provider|browser/i.test(lib.FAILED_RUN_LINE));
    check("a failed team run priced 0 → 'not charged' may be said", lib.failedRunWasFree({ status: "failed", teamId: "t", priceUsd: 0 }));
    check("…and in the instant before it is priced", lib.failedRunWasFree({ status: "failed", teamId: "t", priceUsd: null }));
    check("…not on a run that belongs to no balance (free or $1 check)", !lib.failedRunWasFree({ status: "failed", teamId: null, priceUsd: null }));
    check("…not on a run that somehow kept a price", !lib.failedRunWasFree({ status: "failed", teamId: "t", priceUsd: 0.4 }));
  }

  // The live stream, the route itself, with only its database mocked.
  try {
    const bundled = await build({
      entryPoints: [path.join(repoRoot, "src/app/api/runs/[id]/stream/route.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      plugins: [{
        name: "db-mock",
        setup(b) {
          b.onResolve({ filter: /^@\/lib\/db$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const getDbFromContext = async () => fixture.db;", loader: "js" }));
        },
      }],
    });
    const mod = { exports: {} as { GET(req: Request, a: { params: Promise<{ id: string }> }): Promise<Response> } };
    const fixture = { db: { run: { findUnique: async () => ({ ...failedRow, currentAction: null, liveScreenshotUrl: null }) } } };
    new Function("module", "exports", "fixture", "require", bundled.outputFiles[0].text)(mod, mod.exports, fixture, require);
    const res = await mod.exports.GET(new Request("https://example.test/api/runs/x/stream"), { params: Promise.resolve({ id: "x" }) });
    const streamed = await res.text();
    check("the live stream of run #258 carries no raw failure", !RAW.test(streamed), streamed.slice(0, 200));
  } catch (err) {
    check("the live stream route bundles and answers", false, err instanceof Error ? err.message.split("\n")[0] : String(err));
  }

  // ─── 4. What a person reads: the failed-run page ──────────────────────────
  const card = await importOrFail("src/components/run-failed.tsx", () => import("@/components/run-failed"));
  if (card) {
    const html = (props: Parameters<typeof card.RunFailed>[0]) => renderToString(createElement(card.RunFailed, props));
    const owner = html({ free: true, retry: { runId: "cmuk8awxv0003qz0n3zov7rdy", appSlug: "joblander.app" } });
    check("owner's card: says it didn't finish", owner.includes("didn&#x27;t finish"));
    check("owner's card: says it wasn't charged", owner.includes("wasn&#x27;t charged"));
    check("owner's card: offers Run it again", owner.includes("Run it again"));
    check("owner's card: no raw failure, no promise of an email", !RAW.test(owner) && !/email/i.test(owner));
    const stranger = html({ free: false, retry: null });
    check("a card with no balance and no rights: no charge claim, no button", !stranger.includes("charged") && !stranger.includes("Run it again"));
    const refused = html({ free: true, retry: null, notice: "Your balance is empty.", balanceRefused: true });
    check("a refused retry says why, with the two doors", refused.includes("Your balance is empty.") && refused.includes("Top up") && refused.includes("Upgrade"));
  }

  const page = source("src/app/run/[id]/page.tsx");
  check("/run/{id} renders the failed card for a failed run", /run\.status === "failed"[\s\S]{0,600}<RunFailed/.test(page));
  check("/run/{id} decides 'not charged' from the row, and the button from canMutateOwned", /failedRunWasFree\(run\)/.test(page) && /canMutateOwned\(prisma, run\.ownerId\)/.test(page));
  const live = source("src/components/run-live.tsx");
  check("the live screen never renders an error message", !/errorMessage/.test(live));
  check(
    "/verdict/{id} of a failed run goes to its run page (the publication gate says no, the page redirects on it)",
    !extensionReportPublished({ targetKind: "website", status: "failed", verdict: "broken" }) &&
      /if \(!extensionReportPublished\(run\)\) redirect\(`\/run\/\$\{run\.publicId\}`\)/.test(source("src/components/verdict-view.tsx")),
  );
  // CHE-371: both routes that show a verdict render that one component, so the
  // redirect holds on each — neither has a body of its own to forget it in.
  check(
    "…and both the permalink and the in-app check page render that component and nothing of their own from the run",
    /<VerdictView id=/.test(source("src/app/verdict/[id]/page.tsx")) &&
      /<VerdictView\s+id=\{run\.publicId\}/.test(source("src/app/(app)/health/apps/[appId]/checks/[runNumber]/page.tsx")) &&
      !/bottomLine|findings|journeys/.test(source("src/app/(app)/health/apps/[appId]/checks/[runNumber]/page.tsx")),
  );

  // The promise nobody kept, anywhere in what we ship.
  const walk = (rel: string): string[] => {
    const abs = path.join(repoRoot, rel);
    if (statSync(abs).isFile()) return /\.(ts|tsx)$/.test(rel) ? [rel] : [];
    return readdirSync(abs).flatMap((e) => walk(path.join(rel, e)));
  };
  // Comments are ours to read (the incident is quoted in two of them); the
  // same strip verify-public-copy.ts uses.
  const code = (s: string) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
      .join("\n");
  const promising = walk("src").filter((f) => !f.startsWith("src/generated") && /retry link/i.test(code(source(f))));
  check("no source file promises 'an email with a retry link'", promising.length === 0, promising.join(", "));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
