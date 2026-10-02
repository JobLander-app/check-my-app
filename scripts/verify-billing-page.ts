// Billing (CHE-355): the sentences the page says about money, and what it
// must not say.
//
//   1. "Your apps cost", the balance line and "At this pace" — every branch,
//      with the owner's own numbers as the first case.
//   2. The share bar and the count lines.
//   3. The page: the numbers are appHealth's (the same ones the sidebar and All
//      apps show), a price opens into what the check did through the address
//      (a link, no script), prices only (CLAUDE.md §10), money actions only for
//      those who may bill.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-billing-page.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appsCostLine, balanceLine, countLine, daysToNextMonth, daysUntilEmpty, outsideApps, pace, sharePercent } from "../src/lib/billing-page";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);
const usd = (n: number) => `$${n.toFixed(2)}`;

// ── 1. The three tiles ──────────────────────────────────────────────────────
eq("apps cost: the owner's month", appsCostLine({ windowDays: 30, apps: 4, checks: 134, perDayUsd: 2.23, usd }), "Last 30 days, 4 apps, 134 checks. About $2.23 a day.");
eq("apps cost: one app, one check", appsCostLine({ windowDays: 30, apps: 1, checks: 1, perDayUsd: 0.02, usd }), "Last 30 days, 1 app, 1 check. About $0.02 a day.");
eq("apps cost: nothing checked", appsCostLine({ windowDays: 30, apps: 2, checks: 0, perDayUsd: 0, usd }), "No checks of your apps in the last 30 days.");
// Codex P2 on #245: a preview or a one-off address is not what an app costs —
// the tile is the apps' own checks, and the rest is said as its own amount.
eq("apps cost: what was paid outside the apps is said after, not folded in",
  appsCostLine({ windowDays: 30, apps: 4, checks: 134, perDayUsd: 2.15, outsideUsd: 0.87, usd }), "Last 30 days, 4 apps, 134 checks. About $2.15 a day. Plus $0.87 outside your apps.");
eq("apps cost: no saved app, one paid preview", appsCostLine({ windowDays: 30, apps: 0, checks: 0, perDayUsd: 0, outsideUsd: 0.4, usd }),
  "No checks of your apps in the last 30 days. Plus $0.40 outside your apps.");

eq("balance: a monthly plan", balanceLine({ plan: "business", creditUsd: 499, renewsOn: "November 1", topupUsd: 0, usd }), "Business plan adds $499 on November 1.");
eq("balance: with a top-up", balanceLine({ plan: "growth", creditUsd: 99, renewsOn: "November 1", topupUsd: 17.5, usd }),
  "Growth plan adds $99 on November 1. $17.50 of the balance was topped up.");
eq("balance: Free does not renew", balanceLine({ plan: "free", creditUsd: 5, renewsOn: null, topupUsd: 0, usd }), "Free plan: $5 once, it does not renew.");
eq("balance: unlimited", balanceLine({ plan: "enterprise", creditUsd: null, renewsOn: null, topupUsd: 0, usd }), "Enterprise plan: no limit on checks.");

// Unless a case says otherwise: nothing topped up, and a renewing plan's
// amount is added again in 20 days.
type PaceInput = Parameters<typeof pace>[0];
const paceOf = (i: Omit<PaceInput, "topupUsd" | "daysToRenewal"> & Partial<PaceInput>) => pace({ topupUsd: 0, daysToRenewal: i.renews ? 20 : null, ...i });
const owner = paceOf({ creditUsd: 499, renews: true, monthlyUsd: 66.98, balanceUsd: 498.11 });
eq("pace: the owner's plan covers the apps seven times", owner.headline, "The plan covers your apps 7 times over");
eq("pace: …and says against what", owner.detail, "$499 a month against $67 of checks. Top-ups are only needed beyond that.");
eq("pace: covers once", paceOf({ creditUsd: 99, renews: true, monthlyUsd: 62, balanceUsd: 40 }).headline, "The plan covers your apps");
eq("pace: covers exactly", paceOf({ creditUsd: 29, renews: true, monthlyUsd: 29, balanceUsd: 3 }).headline, "The plan covers your apps");
const short = paceOf({ creditUsd: 29, renews: true, monthlyUsd: 58, balanceUsd: 11 });
eq("pace: the plan does not cover the apps → how long the balance lasts ($11 at $58 a month)", short.headline, "The balance lasts about 5 days");
eq("pace: …and where the rest comes from", short.detail, "$29 a month against $58 of checks. The rest comes from top-ups.");
// Codex P2 on #243: $29 of plan against $29.30 of checks is "1.0 times" when
// rounded for display, and is still short.
const barely = paceOf({ creditUsd: 29, renews: true, monthlyUsd: 29.3, balanceUsd: 2 });
check("pace: thirty cents short is short — decided on the amounts, not on a rounded ratio", !/covers/.test(barely.headline), barely.headline);
// Codex P2 r3 on #243: "$29 a month against $29 of checks. The rest comes from
// top-ups." — two amounts that round alike are shown to the cent.
eq("pace: …and the sentence shows why (cents, when whole dollars would look equal)", barely.detail, "$29.00 a month against $29.30 of checks. The rest comes from top-ups.");
eq("pace: the same the other way round, thirty cents to spare",
  paceOf({ creditUsd: 29, renews: true, monthlyUsd: 28.7, balanceUsd: 20 }).detail, "$29.00 a month against $28.70 of checks. Top-ups are only needed beyond that.");
eq("pace: equal amounts stay whole", paceOf({ creditUsd: 29, renews: true, monthlyUsd: 29, balanceUsd: 20 }).detail, "$29 a month against $29 of checks. Top-ups are only needed beyond that.");
const free = paceOf({ creditUsd: 5, renews: false, monthlyUsd: 8.4, balanceUsd: 4.72 });
eq("pace: Free — the balance in days, never 'covers' ($4.72 at $8.40 a month)", free.headline, "The balance lasts about 16 days");
check("pace: Free says the amount does not renew", /does not renew/.test(free.detail), free.detail);
check("pace: Free never 'covers', even when its one-time amount is larger than a month of checks",
  !/covers/.test(paceOf({ creditUsd: 5, renews: false, monthlyUsd: 1.2, balanceUsd: 4.5 }).headline));
// Codex P2 r2 on #243: three cents in thirty days is "$0.00 a day" when
// rounded, and the balance is still being spent.
const trickle = paceOf({ creditUsd: 5, renews: false, monthlyUsd: 0.03, balanceUsd: 4.97 });
eq("pace: a trickle of spending is still spending — said from the month's amount, capped at a year", trickle.headline, "The balance lasts more than a year");
check("pace: no branch says the balance is not being spent while a month has a price",
  [0.01, 0.03, 0.3, 3].every((monthlyUsd) => !/not being spent/.test(paceOf({ creditUsd: 5, renews: false, monthlyUsd, balanceUsd: 4 }).headline)));
eq("pace: an empty balance", paceOf({ creditUsd: 29, renews: true, monthlyUsd: 140, balanceUsd: 0 }).headline, "The balance runs out today");
eq("pace: one day left ($5 at $140 a month)", paceOf({ creditUsd: 29, renews: true, monthlyUsd: 140, balanceUsd: 5 }).headline, "The balance lasts about 1 day");
// Codex P2 on #245: the day before the plan's amount is added again, "$11 at
// $58 a month" is not five days — $29 arrives tomorrow and lasts fifteen more.
eq("pace: the plan's amount arrives before the balance runs out → the days after it count ($11, $29 tomorrow)",
  paceOf({ creditUsd: 29, renews: true, monthlyUsd: 58, balanceUsd: 11, daysToRenewal: 1 }).headline, "The balance lasts about 16 days");
eq("pace: …and when it runs out before the amount arrives, it runs out", paceOf({ creditUsd: 29, renews: true, monthlyUsd: 58, balanceUsd: 11, daysToRenewal: 20 }).headline, "The balance lasts about 5 days");
// The balance's own order (src/lib/plans.ts): the plan's amount first, then the
// top-up; on renewal the plan's amount is whole again and the top-up stays.
// $50 topped up, nothing left of $29, $58 a month, renewal in 10 days: the
// top-up pays 10 days ($19.33), then each month the plan pays 15 days and the
// top-up the other 15 ($29) — it is gone on day 55.
eq("days until empty: plan first, then the top-up, month after month", daysUntilEmpty({ planLeftUsd: 0, topupUsd: 50, creditUsd: 29, dailyUsd: 58 / 30, daysToRenewal: 10 }), 55);
eq("days until empty: what is left of the plan's amount does not carry over a renewal",
  daysUntilEmpty({ planLeftUsd: 20, topupUsd: 0, creditUsd: 29, dailyUsd: 58 / 30, daysToRenewal: 2 }), 17);
eq("days until empty: nothing spent is not a countdown", daysUntilEmpty({ planLeftUsd: 5, topupUsd: 0, creditUsd: 29, dailyUsd: 0, daysToRenewal: 3 }), 366);
eq("pace: a top-up large enough for a year says so", paceOf({ creditUsd: 29, renews: true, monthlyUsd: 58, balanceUsd: 500, topupUsd: 500 }).headline, "The balance lasts more than a year");
eq("renewal: 2 October → 30 days to 1 November", daysToNextMonth(new Date("2026-10-02T04:00:00Z")), 30);
eq("renewal: the last evening of a month → 1 day", daysToNextMonth(new Date("2026-10-31T23:30:00Z")), 1);
eq("renewal: across a year's end", daysToNextMonth(new Date("2026-12-15T12:00:00Z")), 17);
eq("pace: nothing spent", paceOf({ creditUsd: 99, renews: true, monthlyUsd: 0, balanceUsd: 99 }).headline, "Nothing spent yet");
eq("pace: unlimited", paceOf({ creditUsd: null, renews: true, monthlyUsd: 300, balanceUsd: null }).headline, "No limit on this plan");
check("pace: no branch promises 'covers' when it does not",
  [29.01, 100, 1000].every((monthlyUsd) => !/covers/.test(paceOf({ creditUsd: 29, renews: true, monthlyUsd, balanceUsd: 10 }).headline)));

// What the team paid for outside its apps (Codex P2 on #243).
const twoApps = [{ spendUsd: 2.03, checks: 8 }, { spendUsd: 1, checks: 4 }];
check("outside the apps: a PR preview's check and its price are their own row",
  JSON.stringify(outsideApps({ usd: 3.43, checks: 13 }, twoApps)) === JSON.stringify({ usd: 0.4, checks: 1 }), JSON.stringify(outsideApps({ usd: 3.43, checks: 13 }, twoApps)));
check("outside the apps: nothing outside → no row", outsideApps({ usd: 3.03, checks: 12 }, twoApps) === null);
check("outside the apps: a free check outside (a failed preview) is still counted",
  JSON.stringify(outsideApps({ usd: 3.03, checks: 13 }, twoApps)) === JSON.stringify({ usd: 0, checks: 1 }));

// ── 2. The table's small parts ──────────────────────────────────────────────
eq("share: the owner's biggest app", sharePercent(27.91, 66.98), 42);
eq("share: a sliver is still visible", sharePercent(0.38, 66.98), 1);
eq("share: nothing spent → no bar", sharePercent(0, 66.98), 0);
eq("share: an empty window", sharePercent(0, 0), 0);
eq("share: never more than the whole", sharePercent(70, 66.98), 100);
eq("count: several", countLine(31, "not scheduled"), "31 checks");
eq("count: one", countLine(1, "none"), "1 check");
eq("count: none scheduled", countLine(0, "not scheduled"), "not scheduled");

// ── 3. The page ─────────────────────────────────────────────────────────────
const page = read("src/app/(app)/settings/billing/page.tsx");
check("the numbers are appHealth's — the same ones the sidebar and All apps show", /appHealth\(db, team\.id\)/.test(page) && !/spendByApp/.test(page));
check("a price opens what the check did through the address: a link, no client code",
  /href=\{`\/settings\/billing\?check=\$\{app\.appId\}#check`\}/.test(page) && !/^"use client"/.test(page) && !/useState|useEffect/.test(page));
check("the opened check says what it did, how that compares, and its parts",
  /opened\.latest\.price\.work/.test(page) && /opened\.latest\.price\.comparison/.test(page) && /opened\.latest\.price\.parts\.map/.test(page));
check("prices only: the page names no cost, token or margin field", !/costUsd|cost_usd|tokens|multiplier|margin/i.test(page));
check("top-ups and the Stripe portal are offered only to those who may bill",
  /mayBill \? \(\s*<TopUpCta/.test(page) && /mayBill \? \(\s*<>\s*<ManageBillingButton \/>/.test(page));
check("'Your apps cost' is the apps' own checks; the plan is measured against everything the balance paid for",
  /usd\(health\.appsMonthlyUsd\)/.test(page) && /checks: apps\.reduce\(\(n, a\) => n \+ a\.checks, 0\)/.test(page) && /outsideUsd: outside\?\.usd/.test(page) &&
    /monthlyUsd: health\.monthlyRunRateUsd/.test(page));
check("the renewal the pace counts with is the balance's own (the 1st of next month, or never)",
  /daysToRenewal: balance\.renewsOn !== null \? daysToNextMonth\(new Date\(\)\) : null/.test(page) && /topupUsd: balance\.topupUsd/.test(page));
check("the table has a row for what was outside the apps, from the total and its count of checks",
  /checks: health\.totalChecks/.test(page) && /outsideApps\(\{ usd: health\.totalSpendUsd, checks: health\.totalChecks \}, apps\)/.test(page) && /Outside your apps/.test(page));
// Codex P2 r3 on #243: removing an app detaches its checks and their schedule
// (deleteApp: appId and watchId go null), so the row cannot say "on request".
const outsideRow = page.slice(page.indexOf("Outside your apps"), page.indexOf("</tr>", page.indexOf("Outside your apps")));
check("the outside row is a total with its count, not split into scheduled and on request",
  /usd\(outside\.usd\)/.test(outsideRow) && (outsideRow.match(/usd\(outside\.usd\)/g) ?? []).length === 1 && /countLine\(outside\.checks, "none"\)/.test(outsideRow) && /removed apps/.test(outsideRow),
  `${(outsideRow.match(/usd\(outside\.usd\)/g) ?? []).length} amount(s)`);
check("…and removing an app is what makes that so (the action still clears both)",
  /data: \{ appId: null, watchId: null \}/.test(read("src/app/dashboard/actions.ts")));
check("the table is drawn for a team with no saved app when something was paid for outside the apps", /\{\(apps\.length > 0 \|\| outside\) && \(/.test(page));
check("the old #balance anchor still lands on the balance", /id="balance"/.test(page));
check("the table scrolls inside its card", /className="card overflow-x-auto"/.test(page));
check("nothing in src still calls the old per-app spend helper", !/spendByApp/.test(read("src/lib/plans.ts")));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
