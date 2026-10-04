// The escalation e-mail is gone (CHE-413).
//
// Until CHE-413 an app on a schedule carried one outside address
// (Watch.notifyEmail — "Escalation email" in its settings, `notify_email` in
// the MCP create_app / update_app tools, a field of the onboarding wizard),
// and the scheduler copied it onto every run. Who hears about a verdict is the
// team's own list (CHE-262, src/lib/recipients.ts): one list, not two.
//
// What is NOT removed: Run.notifyEmail — "where to e-mail the result" of a
// check started without an account (the public form, the $1 check, MCP
// start_check with a url). That is a submission's address, not a setting.
//
//   1. Source: `notifyEmail` appears only in the files that carry a
//      submission's address, and nowhere as the Watch's or the App's. The
//      scheduler names it nowhere; the workflow mails a run of a saved app by
//      its team (run.appId), not by an address.
//   2. The MCP contract: create_app and update_app take no notify_email;
//      start_check still does, for a url check.
//   3. A real D1: creating an app writes no address on its watch, a stray
//      field in a settings patch writes none, and enabling a watch from a check
//      that carried an address carries none onto the watch.
//
// The column itself stays until the code that stopped reading it is in prod
// (two steps, like #196/#197): the schema and the migrations may name it.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-no-escalation-email.ts

process.env.CREDENTIALS_SECRET ??= "verify-no-escalation-email-secret";

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolSchemas } from "../src/lib/mcp/tools";
import { createAppForTeam, updateAppForTeam } from "../src/lib/app-settings";
import { enableWatchForRun } from "../src/lib/watch-enable";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "generated" ? [] : walk(full);
    return /\.(ts|tsx|mjs)$/.test(name) ? [full] : [];
  });
}

// ── 1. Source ───────────────────────────────────────────────────────────────
// Where a submission's address legitimately travels: the form → the run → the
// mail. Anything else naming notifyEmail is reading the Watch's or the App's.
const SUBMISSION_ADDRESS = new Set([
  "src/lib/validation.ts",
  "src/lib/start-check.ts",
  "src/lib/one-check.ts",
  "src/lib/recheck.ts",
  "src/lib/mcp/tools.ts",
  "src/app/api/billing/one-check/route.ts",
  "src/app/run/[id]/page.tsx",
  "src/components/run-live.tsx",
  "src/components/submit-form.tsx",
  "src/agent/notify-verdict.ts",
  "src/agent/workflow.ts",
]);
const naming = walk(path.join(repoRoot, "src"))
  .map((f) => path.relative(repoRoot, f))
  .filter((rel) => /notifyEmail/.test(read(rel)));
const outside = naming.filter((rel) => !SUBMISSION_ADDRESS.has(rel));
check("notifyEmail is named only where a submission's address travels", outside.length === 0, outside.join(", "));
// `input.notifyEmail` in start-check / one-check is the submission's (CreateCheckInput), and stays.
const ofWatchOrApp = naming.filter((rel) => /\b(watch|app|seed|Watch|App)\??\.notifyEmail\b|notifyEmail:\s*(watch|seed|patch)\./.test(read(rel)));
check("nowhere is it read off a Watch, an App or a settings patch", ofWatchOrApp.length === 0, ofWatchOrApp.join(", "));
const scheduler = read("src/agent/scheduler.ts");
check("the scheduler names no address: a scheduled run carries none", !/notifyEmail/.test(scheduler));
check("…and its own two mails (balance used up, trial paused) go to the app's recipients, each on their own, under a key",
  (scheduler.match(/eachRecipient\(env, watch\.appId, \(to\) =>/g) ?? []).length === 2 && /recipientsForApp\(env\.db, appId\)/.test(scheduler) &&
    /noticeIdempotencyKey\(`balance-used-up\/\$\{watch\.teamId\}\/\$\{windowStart\.toISOString\(\)\}`, to\)/.test(scheduler) && /noticeIdempotencyKey\(`trial-paused\/\$\{watch\.id\}`, to\)/.test(scheduler));
const workflow = read("src/agent/workflow.ts");
check("every notify gate in the workflow opens for a run of a saved app, address or not",
  (workflow.match(/if \(run\.notifyEmail \|\| run\.appId\)/g) ?? []).length === 4 && !/if \(run\.notifyEmail\)/.test(workflow));
const settings = read("src/lib/app-settings.ts");
check("the shared create/update rule has no address field", !/notifyEmail/.test(settings));
check("the settings page and the onboarding wizard offer none", !/notifyEmail|scalation/.test(read("src/app/(app)/health/apps/[appId]/settings/[section]/page.tsx")) && !/notifyEmail|scalation/.test(read("src/components/onboarding-wizard.tsx")));
check("the schema still names the column — it goes in its own step once this is in prod", /notifyEmail\s+String\?/.test(read("prisma/schema.prisma")));

// ── 2. The MCP contract ─────────────────────────────────────────────────────
check("create_app takes no notify_email", !("notify_email" in toolSchemas.create_app));
check("update_app takes no notify_email", !("notify_email" in toolSchemas.update_app));
check("start_check still does — for a url check, the verdict-ready notice", "notify_email" in toolSchemas.start_check);
check("the agent's README says the same", !/create_app\*\*[^\n]*\n[^\n]*notify_email|update_app\*\*[^\n]*\n[^\n]*notify_email/.test(read("mcp/README.md")));

// ── 3. A real D1 ────────────────────────────────────────────────────────────
async function realRows() {
  const real = await realD1();
  try {
    await real.db.user.create({ data: { id: "u", clerkUserId: "ck_u", email: "owner@example.test" } });
    await real.db.team.create({ data: { id: "t", name: "T", plan: "business" } });
    await real.db.membership.create({ data: { teamId: "t", userId: "u", scope: "admin" } as never });
    const actor = { userId: "u", teamId: "t", plan: "business" as const };

    const created = await createAppForTeam(real.db, actor, { targetUrl: "https://a.test", frequency: "daily" });
    check("real D1: an app is created with a watch", "ok" in created, JSON.stringify(created));
    const appId = "ok" in created ? created.app.id : "";
    const watchOf = async () => real.db.watch.findUnique({ where: { appId }, select: { notifyEmail: true, frequency: true } });
    check("real D1: the new watch carries no address", (await watchOf())?.notifyEmail === null, JSON.stringify(await watchOf()));

    // A stray address in a patch — an old client, a hand-written request — is
    // not a field and writes nothing.
    await updateAppForTeam(real.db, actor, appId, { frequency: "every_6h", ...({ notifyEmail: "x@example.test" } as object) });
    const after = await watchOf();
    check("real D1: a settings patch with a stray address changes the cadence and writes no address", after?.frequency === "every_6h" && after?.notifyEmail === null, JSON.stringify(after));

    // Enabling a watch from a check that was submitted with an address: the
    // address was that check's, and stays that check's.
    await real.db.run.create({
      data: {
        id: "r1", publicId: "p1", runNumber: 1, appSlug: "b.test", targetUrl: "https://b.test", targetKind: "website",
        status: "completed", notifyEmail: "visitor@example.test", ownerId: null, teamId: null,
      } as never,
    });
    const enabled = await enableWatchForRun(real.db, { id: "u", teamId: "t", plan: "business" }, { runPublicId: "p1", frequency: "daily", notifyOnChangeOnly: true });
    check("real D1: enabling a watch from a check works", enabled.kind === "ok", JSON.stringify(enabled));
    const b = await real.db.watch.findFirst({ where: { appSlug: "b.test" }, select: { notifyEmail: true } });
    const run = await real.db.run.findUnique({ where: { id: "r1" }, select: { notifyEmail: true } });
    check("real D1: the watch carries no address; the check keeps the one it was submitted with", b?.notifyEmail === null && run?.notifyEmail === "visitor@example.test", JSON.stringify({ watch: b, run }));
  } finally {
    await real.dispose();
  }
}

realRows().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
