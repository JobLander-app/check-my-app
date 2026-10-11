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
import { feedbackForRun, giveFeedback, listFeedback, type FeedbackActor } from "../src/lib/feedback";
import { fileOpenFeedback } from "../src/agent/feedback-filing";
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

    // 1–2. Targets.
    const say = (actor: FeedbackActor, target: Parameters<typeof giveFeedback>[2]["target"], text = "x", reason?: string) =>
      giveFeedback(db, actor, { target, text, reason });
    const kinds = [
      await say(member, { app_id: "a1" }, "The app list misses our staging store"),
      await say(member, { scenario_id: "s1" }, "This is really 'block an IP'", "scenario_wrong"),
      await say(member, { run_id: "pubA", finding: 1 }, "The list is empty only for us", "wrong"),
      await say(member, { run_id: "pubA", journey: 1 }, "Walked the wrong page"),
      await say(member, { run_id: "pubA", journey: 1, step: 2 }, "Germany can be added fine", "not_checked"),
      await say(member, { run_id: "pubA" }, "Overall fine"),
      await say(member, { run_id: "pubA", journey: 2 }, "No scenario behind this one"),
    ].map((r) => (r.ok ? r.kind : r.code));
    eq("app, scenario, finding, journey, step, run, journey without a scenario", kinds, ["app", "scenario", "finding", "scenario", "step", "run", "run"]);

    const step = await db.feedback.findFirst({ where: { kind: "step" } });
    eq("a step comment names its step, its scenario and its run", [step?.stepId, step?.appJourneyId, step?.runId], ["st2", "s1", "r1"]);
    const viaRun = await db.feedback.findFirst({ where: { kind: "scenario", runId: "r1" } });
    eq("a journey of a run comments on the scenario, from that run", viaRun?.appJourneyId, "s1");

    eq("another team's app is not found", (await say(stranger, { app_id: "a1" })).ok ? "ok" : (await say(stranger, { app_id: "a1" }) as { code: string }).code, "not_found");
    eq("another team's scenario is not found", ((await say(stranger, { scenario_id: "s1" })) as { code?: string }).code, "not_found");
    eq("another team's run is not found", ((await say(stranger, { run_id: "pubA" })) as { code?: string }).code, "not_found");
    eq("a finding that is not in the run is not found", ((await say(member, { run_id: "pubA", finding: 9 })) as { code?: string }).code, "not_found");
    eq("a step past the journey's end is not found", ((await say(member, { run_id: "pubA", journey: 1, step: 5 })) as { code?: string }).code, "not_found");
    eq("a reader is refused", ((await say(reader, { app_id: "a1" })) as { code?: string }).code, "forbidden");
    eq("a team without the shopify feature is refused", ((await say(unflagged, { app_id: "a1" })) as { code?: string }).code, "forbidden");
    eq("an empty comment is refused", ((await say(member, { app_id: "a1" }, "   ")) as { code?: string }).code, "invalid_input");
    eq("a reason that does not fit the target is refused", ((await say(member, { app_id: "a1" }, "x", "wrong")) as { code?: string }).code, "invalid_input");
    eq("nothing refused was written", await db.feedback.count(), 7);
    eq("another team wrote nothing anywhere", await db.feedback.count({ where: { teamId: "tb" } }), 0);

    // 3. Reads.
    eq("the app's thread holds everything said about it", (await listFeedback(db, "ta", { app_id: "a1" }))?.length, 7);
    eq("the scenario's thread: the scenario and its step", (await listFeedback(db, "ta", { scenario_id: "s1" }))?.map((c) => c.kind), ["scenario", "scenario", "step"]);
    // Five of the seven name the run; the app's and the scenario's own (by
    // scenario_id) belong to no run.
    eq("the run's thread: everything said about this run", (await listFeedback(db, "ta", { run_id: "pubA" }))?.length, 5);
    eq("another team cannot read the thread", await listFeedback(db, "tb", { app_id: "a1" }), null);
    const page = await feedbackForRun(db, "ta", "r1");
    eq("the page: finding #1 has its comment", page.byFinding[1]?.map((c) => c.text), ["The list is empty only for us"]);
    eq("the page: the scenario card has the journey and the step comments", page.byScenario.s1?.map((c) => c.kind), ["scenario", "step"]);
    eq("the page: the run's own thread", page.run.map((c) => c.text), ["Overall fine", "No scenario behind this one"]);
    eq("an item names its author and finding", [page.byFinding[1]?.[0]?.author, page.byFinding[1]?.[0]?.findingNumber], ["member@securify.test", 1]);

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
    eq("no board: nothing filed, every row still open", [none.filed.length, await db.feedback.count({ where: { status: "open" } })], [0, 7]);
    const broken = await fileOpenFeedback(env, { board: board(true) });
    eq("a tracker that fails leaves every row open for the next tick", [broken.failed, await db.feedback.count({ where: { status: "open" } })], [7, 7]);
    console.warn = warn;
    const first = await fileOpenFeedback(env, { board: board() });
    eq("one ticket per comment", [first.filed.length, drafts.length], [7, 7]);
    eq("every row is filed with its ticket", await db.feedback.count({ where: { status: "filed", issueIdentifier: { not: null } } }), 7);
    const again = await fileOpenFeedback(env, { board: board() });
    eq("the next tick files nothing twice", [again.filed.length, drafts.length], [0, 7]);
    const stepDraft = drafts.find((d) => d.description.includes("Germany can be added fine"))!;
    check("a ticket carries the words verbatim, the author and the verdict", Boolean(stepDraft) &&
      stepDraft.description.includes("> Germany can be added fine") &&
      stepDraft.description.includes("member@securify.test") &&
      stepDraft.description.includes("https://checkmyapp.dev/verdict/pubA"), stepDraft?.description.slice(0, 120));
    check("…names the step, its scenario and that the step was ours to verify",
      stepDraft.title.startsWith("[Pilot feedback] shop.securify.test · step “Add Germany” of “Block a country”") &&
      stepDraft.description.includes("unverified: our_capability"), stepDraft.title);
    check("…and a 'got it wrong' comes in at High", drafts.find((d) => d.description.includes("empty only for us"))?.priority === 2);

    // 5. MCP: the two tools are the pilot's.
    const tools = readFileSync("src/lib/mcp/tools.ts", "utf8");
    const reg = tools.slice(tools.indexOf("export function registerRemoteTools"));
    const gate = reg.lastIndexOf('if (hasFeature(features, "shopify"))');
    check("comment and list_comments are registered only for a shopify team",
      gate > 0 && reg.indexOf('"comment"') > gate && reg.indexOf('"list_comments"') > gate);
    check("the comment tool goes through giveFeedback with the key's own scope and team",
      /giveFeedback\(\s*db,\s*\{ userId: caller\.user\.id, teamId: team\.id, scope: caller\.scope, features: team\.features \}/.test(tools));
    check("get_review gives every journey its scenario_id", /scenario_id: j\.appJourneyId \?\? null/.test(readFileSync("src/lib/review.ts", "utf8")));
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
