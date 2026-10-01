// CHE-277 verification: a setting is where it belongs, and the pages cannot
// drift into each other.
//
// The boundary was agreed between the two sessions that own these surfaces,
// because the owner asked for it to be settled before either page existed. It
// is written down in src/lib/settings-boundary.ts as three questions:
//
//   1. does changing this alter what a colleague sees?
//   2. does it survive me leaving?
//   3. who pays for the consequence?
//
// A rule written down and not checked is a rule that survives exactly as long
// as the person who wrote it is the one adding features. So the pages are
// checked against it:
//
//   - the PERSONAL page may not carry an action that spends the team's money,
//     access or credibility — that is the whole definition of the other page;
//   - the TEAM page may not carry a per-app setting — "anything about one app
//     lives on that app", which is the rule that stops this being
//     re-litigated every time somebody adds an integration;
//   - every setting named in the boundary has a home and a reason, because a
//     classification without a reason is a preference nobody can argue with.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-settings-boundary.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SETTINGS, homeOf } from "@/lib/settings-boundary";
import { ADMIN_ONLY, SPENDS_MONEY, type TeamAction } from "@/lib/scopes";
import { ACTION_RULES, ROUTE_RULES, type RouteRule } from "@/lib/route-scopes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// CHE-351: the team page is the people page that was /team; the plan and the
// Stripe portal moved to Billing, each its own item in the sidebar.
const TEAM_PAGE = "src/app/(app)/settings/team/page.tsx";
const ACCOUNT_PAGE = "src/app/(app)/settings/account/page.tsx";
const BILLING_PAGE = "src/app/(app)/settings/billing/page.tsx";

// ─── The boundary itself ─────────────────────────────────────────────────────

check("every setting has a home", SETTINGS.every((s) => s.home), `${SETTINGS.length} settings`);
check(
  "every setting carries a reason, not just a verdict",
  SETTINGS.every((s) => s.because.length > 15),
  SETTINGS.filter((s) => s.because.length <= 15).map((s) => s.key).join(", ") || "all reasoned",
);
check("no setting is listed twice", new Set(SETTINGS.map((s) => s.key)).size === SETTINGS.length);
check(
  "all three homes are used — a boundary with an empty side is not a boundary",
  (["team", "personal", "the app itself"] as const).every((h) => SETTINGS.some((s) => s.home === h)),
);

// The case that decides the rule: an API key looks personal by the first two
// questions and is obviously the team's by the third.
check(
  "api keys are the team's — a key is spending authority in an envelope",
  homeOf("api keys") === "team",
);
check(
  "which apps notify me is mine — it changes nobody's mail but mine",
  homeOf("which apps notify me") === "personal",
);
check(
  "a per-app integration is neither: it belongs to the app",
  homeOf("the app's analytics project") === "the app itself" &&
    homeOf("the app's tracker project") === "the app itself",
);

// ─── The personal page spends nothing ────────────────────────────────────────
// Actions are found by name and looked up in the route registry, so this reads
// the same answer the server does rather than a second opinion.

const accountSource = read(ACCOUNT_PAGE);
const teamSource = read(TEAM_PAGE);

function actionsUsedIn(source: string): TeamAction[] {
  const used: TeamAction[] = [];
  for (const [key, rule] of Object.entries(ACTION_RULES) as [string, RouteRule][]) {
    const fn = key.split("#")[1];
    if (!new RegExp(`\\b${fn}\\b`).test(source)) continue;
    if (rule.kind === "team") used.push(rule.action);
  }
  return used;
}

const personalActions = actionsUsedIn(accountSource);
check(
  "the personal page calls only actions everyone on a team may take",
  personalActions.every((a) => !ADMIN_ONLY.includes(a) && !SPENDS_MONEY.includes(a)),
  personalActions.join(", ") || "none",
);
check(
  "…which today means `read`, the scope a reader has",
  personalActions.every((a) => a === "read"),
  personalActions.join(", ") || "none",
);

// ─── Neither page hides an app's own settings ────────────────────────────────

const PER_APP_MARKERS = [
  "testPassword",
  "writeMode",
  "posthogProjectId",
  "setTrackerTeam",
  "updateAppSettings",
];
for (const [label, source] of [["team", teamSource], ["personal", accountSource]] as const) {
  const found = PER_APP_MARKERS.filter((m) => source.includes(m));
  check(
    `the ${label} settings page carries no per-app setting — those live on the app`,
    found.length === 0,
    found.join(", ") || "clean",
  );
}

// ─── Each page points at the other ───────────────────────────────────────────
// Someone who opens the wrong one must be told where the right one is, in a
// sentence rather than by being made to look.

check(
  "the team page points at the personal one",
  teamSource.includes("/settings/account") && /only affects you|affects you/i.test(teamSource),
);
check(
  "the personal page points at the team one",
  accountSource.includes("/settings/team") && /colleagues see|your colleagues/i.test(accountSource),
);

// ─── Billing is an admin's, on the page and on the server ────────────────────

const billingSource = read(BILLING_PAGE);
check(
  "Billing offers the portal and top-ups only to someone who may manage them",
  /const mayBill = can\(scope, "billing\.manage"\)/.test(billingSource) &&
    /mayBill \? \(\s*<TopUpCta/.test(billingSource) &&
    /mayBill \? \(\s*<>\s*<ManageBillingButton/.test(billingSource),
);
check(
  "Billing carries no per-app setting either",
  PER_APP_MARKERS.every((m) => !billingSource.includes(m)),
);
const portal = ROUTE_RULES["POST /api/billing/portal"];
check(
  "…and the route behind it agrees",
  portal?.kind === "team" && portal.action === "billing.manage",
  JSON.stringify(portal),
);

// The button is a real one: a control that silently does nothing is the defect
// this product flags on other people's apps (CHE-108).
const billingButton = read("src/components/manage-billing-button.tsx");
check(
  "the billing button shows what the server said when it refuses",
  /body\?\.error/.test(billingButton) && /text-status-broken/.test(billingButton),
);

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
