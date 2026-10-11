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
    eq("the page: the scenario card has the journey and the step reports", page.byScenario.s1?.map((c) => c.kind), ["scenario", "step"]);
    eq("the page: the run's own", page.run.map((c) => c.text), ["The bottom line says checkout works; it was never opened", "No scenario behind this one"]);
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
    eq("no board: nothing filed, every row still open", [none.filed.length, await db.feedback.count({ where: { status: "open" } })], [0, 6]);
    const broken = await fileOpenFeedback(env, { board: board(true) });
    eq("a tracker that fails leaves every row open for the next tick", [broken.failed, await db.feedback.count({ where: { status: "open" } })], [6, 6]);
    console.warn = warn;
    const first = await fileOpenFeedback(env, { board: board() });
    eq("one ticket per report", [first.filed.length, drafts.length], [6, 6]);
    eq("every row is filed with its ticket", await db.feedback.count({ where: { status: "filed", issueIdentifier: { not: null } } }), 6);
    const again = await fileOpenFeedback(env, { board: board() });
    eq("the next tick files nothing twice", [again.filed.length, drafts.length], [0, 6]);
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
    check("report_check_mistake and list_check_mistakes are registered only for a shopify team",
      gate > 0 && reg.indexOf('"report_check_mistake"') > gate && reg.indexOf('"list_check_mistakes"') > gate);
    check("the report tool goes through giveFeedback with the key's own scope and team",
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
