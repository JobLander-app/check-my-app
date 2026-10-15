// Every sentence about the issue tracker names Linear and Jira, and says only
// what the code does (CHE-438).
//
// The owner, 2026-10-13: "why should Jira be different?" Jira shipped as a
// tracker while the app page said "Connect Linear", the FAQ "Linear today
// (GitHub next), on Growth and above" (Starter has the tracker too), a guide
// "tickets in Linear", and the integrations row "Linear" for a Jira tracker.
//
//   1. The sentences of src/lib/tracker-copy.ts: each passes the
//      customer-language gate and names both trackers; the FAQ answer is the
//      plans' own limits; the offer promises automatic filing only where a
//      scheduled check does it.
//   2. The pages say them through the module, not in their own words.
//   3. Nothing else in the product names Linear alone: every non-comment line
//      of src/app, src/components and src/lib that says "Linear" says "Jira"
//      too, except the places that are Linear's own, each with its reason.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-tracker-copy.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ONBOARDING_TRACKER_STEP, ONBOARDING_URGENT_LABEL, TRACKER_GUIDE_LINE, trackerFaqAnswer, trackerOffer } from "../src/lib/tracker-copy";
import { TRACKER_LINE } from "../src/lib/plan-catalog";
import { PLAN_LIMITS } from "../src/lib/plans";
import { MACHINERY_TERMS, hasEnvironmentLeak } from "../src/lib/verdict-language";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. The sentences ────────────────────────────────────────────────────────
const SENTENCES = [trackerOffer(true), trackerOffer(false), trackerFaqAnswer(PLAN_LIMITS), TRACKER_GUIDE_LINE, ONBOARDING_TRACKER_STEP, ONBOARDING_URGENT_LABEL, TRACKER_LINE];
const leaky = SENTENCES.filter((s) => MACHINERY_TERMS.test(s) || hasEnvironmentLeak(s));
check("every tracker sentence names none of our machinery and gives no homework", leaky.length === 0, leaky.join(" | "));
const oneSided = SENTENCES.filter((s) => !/\bLinear\b/.test(s) || !/\bJira\b/.test(s));
check("every tracker sentence names both Linear and Jira", oneSided.length === 0, oneSided.join(" | "));
check("…and the gate catches the wording it replaced", MACHINERY_TERMS.test("set them now so your self-healing automation picks the tickets up"));

eq("FAQ: the tracker is on every paid plan, as PLAN_LIMITS has it", trackerFaqAnswer(PLAN_LIMITS), "Linear or Jira, on every paid plan.");
eq("FAQ: a plan without it is left out by name", trackerFaqAnswer({ ...PLAN_LIMITS, starter: { ...PLAN_LIMITS.starter, trackerIntegration: false } }), "Linear or Jira, on Growth, Business, Enterprise.");
eq("FAQ: on every plan when Free has it too", trackerFaqAnswer({ free: { trackerIntegration: true }, starter: { trackerIntegration: true } }), "Linear or Jira, on every plan.");

// Codex P2 on #337: autofile and reconcile return early for a check no watch
// scheduled, so only that offer may promise tickets and re-verification.
check("the offer promises automatic tickets only where a scheduled check files them",
  /becomes one ticket/.test(trackerOffer(true)) && /confirms the fix/.test(trackerOffer(true)) && !/becomes one ticket|confirms the fix/.test(trackerOffer(false)));
check("…which is what the agent does: no watch, no filing, no re-verification",
  /if \(!run\?\.watchId \|\| !run\.appId\) return \[\];/.test(read("src/agent/autofile.ts")) &&
    (read("src/agent/reconcile.ts").match(/if \(!run\??\.watchId \|\| !run\.appId\) return/g) ?? []).length === 2);
check("the urgent label names each tracker's own word for priority 1", /Urgent in Linear/.test(ONBOARDING_URGENT_LABEL) && /Highest in Jira/.test(ONBOARDING_URGENT_LABEL) &&
  /1: "Highest"/.test(read("src/lib/tracker/jira.ts")));

// ── 2. The pages say them through the module ────────────────────────────────
const appPage = read("src/app/(app)/health/apps/[appId]/page.tsx");
check("the app page offers through trackerOffer, scheduled = an active watch whose trial has not ended",
  /\{trackerOffer\(Boolean\(watch\?\.active && !watch\.trialEnded\)\)\}/.test(appPage) && /Connect a tracker/.test(appPage));
check("the FAQ answers from the plans' limits", /a: <>\{trackerFaqAnswer\(PLAN_LIMITS\)\}<\/>/.test(read("src/app/faq/page.tsx")));
check("the guide says the module's line", /<p>\{TRACKER_GUIDE_LINE\}<\/p>/.test(read("src/app/guides/results-in-your-agent/page.tsx")));
const wizard = read("src/components/onboarding-wizard.tsx");
check("onboarding says the module's step and label", /\{ONBOARDING_TRACKER_STEP\}/.test(wizard) && /\{ONBOARDING_URGENT_LABEL\}/.test(wizard));

// ── 3. Nothing names Linear alone ───────────────────────────────────────────
// Linear's own places: they are about Linear and nothing else.
const LINEAR_OWN: Record<string, string> = {
  "src/app/(app)/health/apps/[appId]/settings/[section]/page.tsx": "the tracker card's Linear row and the Linear token it renews",
  "src/lib/integration-notice.ts": "the outcomes of Linear's own connect flow; Jira's are beside them",
};
const SKIP_DIRS = ["src/lib/tracker", "src/app/api/integrations/linear", "src/generated"];
function files(dir: string): string[] {
  return readdirSync(path.join(repoRoot, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (SKIP_DIRS.includes(rel)) return [];
    return statSync(path.join(repoRoot, rel)).isDirectory() ? files(rel) : /\.(ts|tsx)$/.test(name) ? [rel] : [];
  });
}
const uncommented = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
function linearAlone(src: string): string[] {
  return uncommented(src).split("\n").filter((line) => /\bLinear\b/.test(line) && !/\bJira\b/.test(line)).map((l) => l.trim());
}
const offenders = ["src/app", "src/components", "src/lib"].flatMap(files)
  .filter((f) => !(f in LINEAR_OWN))
  .flatMap((f) => linearAlone(read(f)).map((line) => `${f}: ${line}`));
check("no line of the product names Linear without Jira, outside Linear's own places", offenders.length === 0, offenders.join(" | "));
const stale = Object.keys(LINEAR_OWN).filter((f) => linearAlone(read(f)).length === 0);
check("…and each of Linear's own places still is one", stale.length === 0, stale.join(", "));
// Teeth: the lines origin/main shipped before this change.
check("…the scan catches the FAQ, the guide and the app page as they were",
  linearAlone("    a: <>Linear today (GitHub next), on Growth and above.</>,").length === 1 &&
    linearAlone("          can become tickets in Linear, and results can go to email, Slack or your own webhook.").length === 1 &&
    linearAlone("    i.tracker ? \"Linear\" : null,").length === 1 &&
    linearAlone("// Linear alone in a comment is not a sentence").length === 0);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
