// CHE-434 verification: comments on an app, a scenario and a run, through the
// one module the page and MCP share, on a real D1 (Miniflare), and their filing
// onto our board through a stub tracker.
//
//   1. each target resolves inside the caller's team — another team's id is
//      not_found; a reader and a team without `shopify` are refused;
//   2. a run is addressed by its id, a finding by number, a journey and a step
//      by position; each lands on the right row;
//   3. the page's grouping (run / finding / scenario) and the threads' reads;
//   4. filing: one ticket per row, claimed first, never twice; a tracker that
//      fails leaves the row open for the next tick; no board, nothing moves;
//   5. the MCP tools exist only for a `shopify` team.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-feedback.ts

process.env.CREDENTIALS_SECRET ??= "verify-feedback-secret";

import "./fixtures/wasm-module-loader.mjs";
import { readFileSync } from "node:fs";
import { realD1 } from "./fixtures/real-d1";
import { FEEDBACK_REASONS, feedbackForRun, giveFeedback, listFeedback, type FeedbackActor } from "../src/lib/feedback";
import { CLAIM_LEASE_MS, fileOpenFeedback } from "../src/agent/feedback-filing";
import { createRemoteTools } from "../src/lib/mcp/tools";
import type { GapBoard } from "../src/agent/capability-gaps";
import type { AgentEnv } from "../src/agent/env";
import type { TicketDraft } from "../src/lib/tracker/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

async function main() {
  const real = await realD1();
  const { db } = real;
  try {
    await db.user.create({ data: { id: "ua", clerkUserId: "ck_a", email: "member@securify.test" } });
    await db.user.create({ data: { id: "ur", clerkUserId: "ck_r", email: "reader@securify.test" } });
    await db.user.create({ data: { id: "ub", clerkUserId: "ck_b", email: "other@else.test" } });
    await db.team.create({ data: { id: "ta", name: "Securify", plan: "business", features: '["shopify"]' } });
    await db.team.create({ data: { id: "tb", name: "Else", plan: "business", features: '["shopify"]' } });
    await db.app.create({ data: { id: "a1", teamId: "ta", ownerId: "ua", appSlug: "shop.securify.test", targetUrl: "https://shop.securify.test", targetKind: "website" } });
    await db.app.create({ data: { id: "b1", teamId: "tb", ownerId: "ub", appSlug: "else.test", targetUrl: "https://else.test", targetKind: "website" } });
    await db.appJourney.create({ data: { id: "s1", appId: "a1", key: "block-country", title: "Block a country" } });
    await db.run.create({
      data: {
        id: "r1", publicId: "pubA", runNumber: 1, teamId: "ta", ownerId: "ua", appId: "a1",
        appSlug: "shop.securify.test", targetUrl: "https://shop.securify.test", status: "completed",
      },
    });
    await db.journey.create({ data: { id: "j1", runId: "r1", order: 0, title: "Block a country", status: "ok", appJourneyId: "s1" } });
    await db.journey.create({ data: { id: "j2", runId: "r1", order: 1, title: "Visit the store", status: "ok" } });
    await db.step.create({ data: { id: "st1", journeyId: "j1", order: 0, label: "Open Block Countries", status: "ok" } });
    await db.step.create({ data: { id: "st2", journeyId: "j1", order: 1, label: "Add Germany", status: "skipped", unverifiedReason: "our_capability" } });
    await db.finding.create({ data: { id: "f1", runId: "r1", number: 1, title: "Rules list is empty", category: "broken", severity: "high" } });

    const member: FeedbackActor = { userId: "ua", teamId: "ta", scope: "member", features: ["shopify"] };
    const reader: FeedbackActor = { userId: "ur", teamId: "ta", scope: "reader", features: ["shopify"] };
    const stranger: FeedbackActor = { userId: "ub", teamId: "tb", scope: "admin", features: ["shopify"] };
    const unflagged: FeedbackActor = { ...member, features: [] };

    // 0. The point (owner, 2026-10-11): a report is the CHECK's mistake, never a chat.
    eq("there is no free 'comment' — every reason names a mistake of the check", [...FEEDBACK_REASONS], ["not_checked", "wrong", "scenario_wrong", "other"]);

    // 1–2. Targets.
    const say = (actor: FeedbackActor, target: Parameters<typeof giveFeedback>[2]["target"], reason: string, text = "x") =>
      giveFeedback(db, actor, { target, text, reason });
    const code = async (p: ReturnType<typeof say>) => ((await p) as { code?: string }).code;
    const kinds = [
      await say(member, { scenario_id: "s1" }, "scenario_wrong", "This is really 'block an IP'"),
      await say(member, { run_id: "pubA", finding: 1 }, "wrong", "The list is empty only for us"),
      await say(member, { run_id: "pubA", journey: 1 }, "not_checked", "Walked the wrong page"),
      await say(member, { run_id: "pubA", journey: 1, step: 2 }, "not_checked", "Germany can be added fine"),
      await say(member, { run_id: "pubA" }, "wrong", "The bottom line says checkout works; it was never opened"),
      await say(member, { run_id: "pubA", journey: 2 }, "other", "No scenario behind this one"),
    ].map((r) => (r.ok ? r.kind : r.code));
    eq("scenario, finding, journey, step, run, journey without a scenario", kinds, ["scenario", "finding", "scenario", "step", "run", "run"]);

    const step = await db.feedback.findFirst({ where: { kind: "step" } });
    eq("a step report names its step, its scenario and its run", [step?.stepId, step?.appJourneyId, step?.runId], ["st2", "s1", "r1"]);
    const viaRun = await db.feedback.findFirst({ where: { kind: "scenario", runId: "r1" } });
    eq("a journey of a run reports on the scenario, from that run", viaRun?.appJourneyId, "s1");

    eq("nothing is reported on an app as a whole", await code(say(member, { app_id: "a1" }, "other")), "invalid_input");
    eq("another team's scenario is not found", await code(say(stranger, { scenario_id: "s1" }, "wrong")), "not_found");
    eq("another team's run is not found", await code(say(stranger, { run_id: "pubA" }, "wrong")), "not_found");
    eq("a finding that is not in the run is not found", await code(say(member, { run_id: "pubA", finding: 9 }, "wrong")), "not_found");
    eq("a step past the journey's end is not found", await code(say(member, { run_id: "pubA", journey: 1, step: 5 }, "wrong")), "not_found");
    eq("a reader is refused", await code(say(reader, { run_id: "pubA" }, "wrong")), "forbidden");
    eq("a team without the shopify feature is refused", await code(say(unflagged, { run_id: "pubA" }, "wrong")), "forbidden");
    eq("an empty report is refused", await code(say(member, { run_id: "pubA" }, "wrong", "   ")), "invalid_input");
    eq("a report with no reason is refused", await code(say(member, { run_id: "pubA" }, "")), "invalid_input");
    eq("the old free 'comment' is refused", await code(say(member, { run_id: "pubA" }, "comment")), "invalid_input");
    eq("only a scenario can be the wrong scenario", await code(say(member, { run_id: "pubA", finding: 1 }, "scenario_wrong")), "invalid_input");
    eq("nothing refused was written", await db.feedback.count(), 6);
    eq("another team wrote nothing anywhere", await db.feedback.count({ where: { teamId: "tb" } }), 0);

    // 3. Reads.
    eq("the app's reports: everything on its checks and scenarios", (await listFeedback(db, "ta", { app_id: "a1" }))?.length, 6);
    eq("the scenario's reports: the scenario and its step", (await listFeedback(db, "ta", { scenario_id: "s1" }))?.map((c) => c.kind), ["scenario", "scenario", "step"]);
    // Five of the six name the run; the one by scenario_id belongs to no run.
    eq("the run's reports: everything on this run", (await listFeedback(db, "ta", { run_id: "pubA" }))?.length, 5);
    eq("another team cannot read them", await listFeedback(db, "tb", { app_id: "a1" }), null);
    const page = await feedbackForRun(db, "ta", "r1");
    eq("the page: finding #1 has its report", page.byFinding[1]?.map((c) => c.text), ["The list is empty only for us"]);
    eq("the page: the first journey's card has its journey and step reports", page.byJourney.j1?.map((c) => c.kind), ["scenario", "step"]);
    eq("the page: a journey with no scenario keeps its report on its own card", page.byJourney.j2?.map((c) => c.text), ["No scenario behind this one"]);
    eq("the page: the run's own", page.run.map((c) => c.text), ["The bottom line says checkout works; it was never opened"]);
    eq("an item names its author and finding", [page.byFinding[1]?.[0]?.author, page.byFinding[1]?.[0]?.findingNumber], ["member@securify.test", 1]);
    const appList = (await listFeedback(db, "ta", { app_id: "a1" })) ?? [];
    check("an app's list says where each report was made, by the outside's ids",
      appList.every((c) => c.runPublicId === "pubA" || c.scenarioId === "s1") &&
        appList.find((c) => c.kind === "finding")?.runPublicId === "pubA" &&
        appList.find((c) => c.kind === "scenario" && c.runPublicId === null)?.scenarioId === "s1",
      JSON.stringify(appList.map((c) => [c.kind, c.runPublicId, c.scenarioId])));

    // 4. Filing.
    const drafts: TicketDraft[] = [];
    let n = 0;
    const board = (fail = false) =>
      ({
        self: {},
        baseUrl: "https://checkmyapp.dev",
        tracker: {
          createIssue: async (d: TicketDraft) => {
            if (fail) throw new Error("Linear is down");
            drafts.push(d);
            n++;
            return { id: `i${n}`, identifier: `CHE-9${n}`, url: "" };
          },
          addComment: async () => {},
          getIssueOutcome: async () => "open" as const,
        },
      }) as unknown as GapBoard;
    const env = { db, bindings: {} } as unknown as AgentEnv;
    const warn = console.warn;
    console.warn = () => {};
    const none = await fileOpenFeedback(env, { board: null });
    eq("no board: nothing filed, every row still open", [none.filed.length, await db.feedback.count({ where: { status: "open" } })], [0, 6]);
    const broken = await fileOpenFeedback(env, { board: board(true) });
    eq("a tracker that fails leaves every row open for the next tick", [broken.failed, await db.feedback.count({ where: { status: "open" } })], [6, 6]);
    console.warn = warn;
    const first = await fileOpenFeedback(env, { board: board() });
    eq("one ticket per report", [first.filed.length, drafts.length], [6, 6]);
    eq("every row is filed with its ticket", await db.feedback.count({ where: { status: "filed", issueIdentifier: { not: null } } }), 6);
    const again = await fileOpenFeedback(env, { board: board() });
    eq("the next tick files nothing twice", [again.filed.length, drafts.length], [0, 6]);

    // A tick that died: a claim inside the lease is left alone, an expired one is filed.
    const fresh = await say(member, { run_id: "pubA" }, "other", "Claimed by a tick that died");
    const freshId = (fresh as { id: string }).id;
    const t0 = new Date("2026-10-11T12:00:00.000Z");
    await db.feedback.update({ where: { id: freshId }, data: { status: "filing", claimedAt: t0 } });
    const inLease = await fileOpenFeedback(env, { board: board(), now: new Date(t0.getTime() + CLAIM_LEASE_MS - 60_000) });
    eq("a claim inside its lease is not filed again", [inLease.filed.length, drafts.length], [0, 6]);
    const pastLease = await fileOpenFeedback(env, { board: board(), now: new Date(t0.getTime() + CLAIM_LEASE_MS + 60_000) });
    eq("an expired claim is filed once", [pastLease.filed.length, drafts.length], [1, 7]);

    // The ticket exists but recording it fails: the row must never go back to open.
    const late = await say(member, { run_id: "pubA" }, "other", "Ticket made, row not updated");
    const lateId = (late as { id: string }).id;
    const realUpdateMany = db.feedback.updateMany.bind(db.feedback);
    let blocked = 0;
    (db.feedback as unknown as { updateMany: unknown }).updateMany = (args: { data: { status?: string } }) => {
      if (args.data.status === "filed") { blocked++; return Promise.reject(new Error("D1 hiccup")); }
      return realUpdateMany(args as never);
    };
    console.warn = () => {};
    await fileOpenFeedback(env, { board: board(), now: new Date(t0.getTime() + 2 * CLAIM_LEASE_MS) });
    console.warn = warn;
    (db.feedback as unknown as { updateMany: unknown }).updateMany = realUpdateMany;
    const lateRow = await db.feedback.findUnique({ where: { id: lateId } });
    eq("a ticket that exists never sends its report back to open", [lateRow?.status, blocked, drafts.length], ["filing", 2, 8]);

    // A tick slower than its lease: while its tracker call hangs, another tick
    // takes the row over. The slow one failing must not undo that claim.
    const slow = await say(member, { run_id: "pubA" }, "other", "Slow tick");
    const slowId = (slow as { id: string }).id;
    const takeover = new Date(t0.getTime() + 10 * CLAIM_LEASE_MS);
    const slowBoard = {
      self: {}, baseUrl: "https://checkmyapp.dev",
      tracker: {
        createIssue: async () => {
          await db.feedback.update({ where: { id: slowId }, data: { claimedAt: takeover } });
          throw new Error("Linear timed out");
        },
        addComment: async () => {}, getIssueOutcome: async () => "open" as const,
      },
    } as unknown as GapBoard;
    console.warn = () => {};
    await fileOpenFeedback(env, { board: slowBoard, now: new Date(t0.getTime() + 3 * CLAIM_LEASE_MS) });
    console.warn = warn;
    const slowRow = await db.feedback.findUnique({ where: { id: slowId } });
    eq("a slow tick's failure leaves the claim of the tick that took over", [slowRow?.status, slowRow?.claimedAt?.toISOString()], ["filing", takeover.toISOString()]);
    const stepDraft = drafts.find((d) => d.description.includes("Germany can be added fine"))!;
    check("a ticket carries the words verbatim, the author and the verdict", Boolean(stepDraft) &&
      stepDraft.description.includes("> Germany can be added fine") &&
      stepDraft.description.includes("member@securify.test") &&
      stepDraft.description.includes("https://checkmyapp.dev/verdict/pubA"), stepDraft?.description.slice(0, 120));
    check("…names the step, its scenario and that the step was ours to verify",
      stepDraft.title.startsWith("[Pilot feedback] shop.securify.test · step “Add Germany” of “Block a country”") &&
      stepDraft.description.includes("unverified: our_capability"), stepDraft.title);
    check("…and a 'got it wrong' comes in at High", drafts.find((d) => d.description.includes("empty only for us"))?.priority === 2);

    // 5. MCP, called for real: the key's own team and scope decide.
    // (Which teams are shown the tools is verify-mcp-remote's: twelve without `shopify`.)
    const deps = { db, origin: "https://checkmyapp.dev", trigger: async () => {}, siteCap: () => 1000, ephemeralTtlDays: () => 7, sleep: async () => {}, now: () => Date.now() };
    const as = (scope: "member" | "reader", teamId = "ta") =>
      createRemoteTools({ user: { id: scope === "member" ? "ua" : "ur", email: "x@x.test", name: null }, team: { id: teamId, name: "T", plan: "business", features: ["shopify"] }, scope, door: "mcp" } as never, deps as never);
    const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
    const made = parse(await as("member").report_check_mistake({ run_id: "pubA", finding: 1, reason: "wrong", text: "Through MCP" }));
    eq("report_check_mistake: a member's key reports on its own run", [made.ok, made.about], [true, "finding"]);
    eq("…a reader's key is refused", parse(await as("reader").report_check_mistake({ run_id: "pubA", reason: "wrong", text: "x" })).code, "forbidden");
    eq("…another team's key does not find the run", parse(await as("member", "tb").report_check_mistake({ run_id: "pubA", reason: "wrong", text: "x" })).code, "not_found");
    eq("…an app is not a place to report on", parse(await as("member").report_check_mistake({ app_id: "a1", reason: "other", text: "x" } as never)).code, "invalid_input");
    const listed = parse(await as("reader").list_check_mistakes({ app_id: "a1" }));
    check("list_check_mistakes: a reader reads them, each with its run_id or scenario_id",
      listed.ok && listed.reports.length === 10 && listed.reports.every((r: { run_id: string | null; scenario_id: string | null }) => r.run_id || r.scenario_id),
      `${listed.reports?.length} reports`);
    const review = parse(await as("reader").get_review({ run_id: "pubA" }));
    eq("get_review: each journey carries its scenario_id, null without one",
      (review.journeys ?? []).map((j: { scenario_id: string | null }) => j.scenario_id), ["s1", null]);
  } finally {
    await real.dispose();
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall pass");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
