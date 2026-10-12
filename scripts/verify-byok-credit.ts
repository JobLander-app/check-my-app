// CHE-458 verification: a team's own OpenRouter key with no credit pauses the
// team's checks, and every place says why.
//
//   1. the probe: OpenRouter's 402 is "no credit", a 200 is "credit", anything
//      else proves nothing — one token on a cheap paid model;
//   2. on a real D1 (Miniflare): a key saved on an account with no credit is
//      paused at once; while paused, the one gate every start goes through
//      refuses with the sentence; a key that can pay clears it; the hourly
//      re-check un-pauses a key topped up since, and leaves a recent one alone;
//   3. MCP on the same rows: start_check is refused with byok_no_credit,
//      list_apps says no app can run, the plan block and the instructions name
//      the reason;
//   4. wiring, read as syntax: the workflow treats a 402 on the team's key as
//      the team's (marks it, files nothing, no watch retry), the scheduler
//      neither pauses the watch nor mails a balance notice for it and re-checks
//      paused keys, and every signed-in page shows the banner.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-byok-credit.ts

process.env.CREDENTIALS_SECRET ??= "verify-byok-credit-secret";

import "./fixtures/wasm-module-loader.mjs";
import ts from "typescript";
import { realD1 } from "./fixtures/real-d1";
import { calls, jsx, source } from "./fixtures/ts-source";
import { BYOK_NO_CREDIT, PROBE_MODEL, byokRefusal, probeKeyCredit, recheckPausedKeys } from "../src/lib/byok-credit";
import { saveTeamKey } from "../src/lib/byok";
import { admitTeamCheck } from "../src/lib/plans";
import { keyStatusLine } from "../src/lib/byok-copy";
import { createRemoteTools } from "../src/lib/mcp/tools";
import { buildInstructions } from "../src/lib/mcp/instructions";
import { loadPlanStatus } from "../src/lib/plan-status";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

async function main() {
  // 1. The probe.
  const asked: { url: string; body: { model: string; max_tokens: number } }[] = [];
  const answering = (status: number) => (async (url: string, init?: RequestInit) => {
    asked.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  eq("402 → no credit, 200 → credit, 500 → unknown", [await probeKeyCredit("sk-or-x", answering(402)), await probeKeyCredit("sk-or-x", answering(200)), await probeKeyCredit("sk-or-x", answering(500))], ["no_credit", "credit", "unknown"]);
  eq("…a network failure proves nothing either", await probeKeyCredit("sk-or-x", (async () => { throw new Error("down"); }) as unknown as typeof fetch), "unknown");
  eq("…asked as one token of a cheap paid model", [asked[0].url, asked[0].body.model, asked[0].body.max_tokens], ["https://openrouter.ai/api/v1/chat/completions", PROBE_MODEL, 1]);

  // 2. The rows.
  const real = await realD1();
  const { db } = real;
  const t0 = new Date("2026-10-12T18:00:00Z");
  try {
    await db.user.create({ data: { id: "u", clerkUserId: "ck", email: "vladislav@securify.test" } });
    await db.team.create({ data: { id: "ts", name: "Securify", plan: "business", features: '["shopify"]' } });
    await db.app.create({ data: { id: "eb", teamId: "ts", ownerId: "u", appSlug: "securification.ai", targetUrl: "https://securification.ai/", targetKind: "website" } });
    const accepted = async () => ({ ok: true as const });

    const saved = await saveTeamKey(db, "ts", "sk-or-v1-securify-key-0001", { check: accepted, encrypt: encryptSecret, probe: async () => "no_credit", now: t0 });
    eq("a key saved on an account with no credit is paused the moment it is saved", [saved.ok && saved.noCredit, (await db.team.findUnique({ where: { id: "ts" } }))?.openrouterKeyNoCreditAt?.toISOString()], [true, t0.toISOString()]);
    const gate = await admitTeamCheck(db, { id: "ts", plan: "business" }, "securification.ai", t0);
    eq("the gate every start goes through refuses, with the sentence", gate, { ok: false, code: "byok_no_credit", reason: BYOK_NO_CREDIT });
    eq("the Team page's line says it first", keyStatusLine({ masked: "sk-or-…0001" }, true), { text: `${BYOK_NO_CREDIT} The key is sk-or-…0001.`, tone: "broken" });

    // MCP on the same rows.
    const deps = { db, origin: "https://checkmyapp.dev", trigger: async () => {}, siteCap: () => 1000, ephemeralTtlDays: () => 7, sleep: async () => {}, now: () => t0.getTime() };
    const tools = createRemoteTools({ user: { id: "u", email: "vladislav@securify.test", name: null }, team: { id: "ts", name: "Securify", plan: "business", features: ["shopify"] }, scope: "admin", door: "mcp" } as never, deps as never);
    const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
    const start = parse(await tools.start_check({ app_id: "eb" }));
    eq("MCP start_check is refused with byok_no_credit and the sentence", [start.code, start.error], ["byok_no_credit", BYOK_NO_CREDIT]);
    const byUrl = parse(await tools.start_check({ url: "https://securification.ai/pricing" }));
    eq("…and so is a check of an address", byUrl.code, "byok_no_credit");
    const listed = parse(await tools.list_apps());
    eq("list_apps: no app can be checked now, and the plan names the reason", [listed.apps[0].can_check_now, listed.plan.paused_by_team_key], [false, BYOK_NO_CREDIT]);
    const plan = await loadPlanStatus(db, { id: "ts", plan: "business" }, "https://checkmyapp.dev", t0);
    check("the MCP instructions name the reason", buildInstructions("Securify", { apps: [], in_flight: [] } as never, plan, true).includes(BYOK_NO_CREDIT));
    eq("no run was started by any of it", await db.run.count(), 0);

    // The hourly re-check.
    const probes: string[] = [];
    const tenMinutes = new Date(t0.getTime() + 10 * 60_000);
    eq("a key asked ten minutes ago is not asked again", [await recheckPausedKeys(db, tenMinutes, decryptSecret, async (k) => (probes.push(k), "credit")), probes.length], [[], 0]);
    const twoHours = new Date(t0.getTime() + 2 * 3600_000);
    eq("an hour on, still no credit: still paused, and the time it was asked is kept", [await recheckPausedKeys(db, twoHours, decryptSecret, async () => "no_credit"), Boolean(await byokRefusal(db, "ts")), (await db.team.findUnique({ where: { id: "ts" } }))?.openrouterKeyCheckedAt?.toISOString()], [[], true, twoHours.toISOString()]);
    const fourHours = new Date(t0.getTime() + 4 * 3600_000);
    eq("topped up since: the re-check finds it can pay, and the pause is gone", [await recheckPausedKeys(db, fourHours, decryptSecret, async (k) => (probes.push(k), "credit")), await byokRefusal(db, "ts"), probes], [["ts"], null, ["sk-or-v1-securify-key-0001"]]);
    eq("…so the gate admits a check again", (await admitTeamCheck(db, { id: "ts", plan: "business" }, "securification.ai", fourHours)).ok, true);

    await saveTeamKey(db, "ts", "sk-or-v1-securify-key-0001", { check: accepted, encrypt: encryptSecret, probe: async () => "no_credit", now: fourHours });
    await saveTeamKey(db, "ts", "sk-or-v1-securify-key-0002", { check: accepted, encrypt: encryptSecret, probe: async () => "credit", now: fourHours });
    eq("a new key that can pay clears the pause an old one left", await byokRefusal(db, "ts"), null);
  } finally {
    await real.dispose();
  }

  // 4. Wiring.
  const wf = source("src/agent/workflow.ts");
  const dry = initializer(wf, "teamKeyDry");
  check("the workflow tells the team's key from ours by the run's own key", Boolean(dry && /budget/.test(dry) && /run\.byokKeyEnc/.test(dry)), dry ?? "");
  const branch = ifWith(wf, "teamKeyDry", (n) => calls(wf, n.thenStatement).some((c) => c.callee === "markKeyNoCredit"));
  check("…marks the key and says why in the feed, without a watch retry", Boolean(branch) && calls(wf, branch!.thenStatement).some((c) => c.callee === "appendEvent" && c.args[3] === "{ icon: \"warn\", text: BYOK_NO_CREDIT_STOP }") && !calls(wf, branch!.thenStatement).some((c) => /watch\.update/.test(c.callee)));
  const filing = calls(wf).find((c) => c.callee === "step.do" && c.args[0] === '"file-failure"');
  check("…and files nothing on our board for it", Boolean(filing) && /if \(teamKeyDry\) return null;/.test(filing!.node.getText(wf)));
  const sched = source("src/agent/scheduler.ts");
  const skip = ifWith(sched, 'admitted.code === "byok_no_credit"', () => true);
  const pause = calls(sched).find((c) => c.callee === "pauseBalanceUsedUp");
  check("the scheduler skips the watch without pausing it or mailing a balance notice", Boolean(skip && pause) && skip!.getStart(sched) < pause!.node.getStart(sched) && skip!.thenStatement.getText(sched).trim() === "continue;");
  check("…and re-checks paused keys on its tick", calls(sched).some((c) => c.callee === "recheckPausedKeys"));
  const layout = source("src/app/(app)/layout.tsx");
  check("every signed-in page shows the banner while paused", jsx(layout).some((e) => e.tag === "KeyPausedBanner" && e.guard === "paused") && calls(layout).some((c) => c.callee === "byokPaused"));
  const teamPage = source("src/app/(app)/settings/team/page.tsx");
  check("the Team page's key line is told", jsx(teamPage).some((e) => e.tag === "TeamModelKey" && e.props.noCredit === "byokPaused(keyRow)"));

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

function initializer(sf: ts.SourceFile, name: string): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (!found && ts.isVariableDeclaration(n) && n.name.getText(sf) === name && n.initializer) found = n.initializer.getText(sf);
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}
function ifWith(sf: ts.SourceFile, condition: string, also: (n: ts.IfStatement) => boolean): ts.IfStatement | null {
  let found: ts.IfStatement | null = null;
  const visit = (n: ts.Node) => {
    if (!found && ts.isIfStatement(n) && n.expression.getText(sf) === condition && also(n)) found = n;
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
