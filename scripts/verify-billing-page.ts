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
import { appsCostLine, balanceLine, countLine, outsideApps, pace, sharePercent } from "../src/lib/billing-page";

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
eq("apps cost: nothing checked", appsCostLine({ windowDays: 30, apps: 2, checks: 0, perDayUsd: 0, usd }), "No checks in the last 30 days.");

eq("balance: a monthly plan", balanceLine({ plan: "business", creditUsd: 499, renewsOn: "November 1", topupUsd: 0, usd }), "Business plan adds $499 on November 1.");
eq("balance: with a top-up", balanceLine({ plan: "growth", creditUsd: 99, renewsOn: "November 1", topupUsd: 17.5, usd }),
  "Growth plan adds $99 on November 1. $17.50 of the balance was topped up.");
eq("balance: Free does not renew", balanceLine({ plan: "free", creditUsd: 5, renewsOn: null, topupUsd: 0, usd }), "Free plan: $5 once, it does not renew.");
eq("balance: unlimited", balanceLine({ plan: "enterprise", creditUsd: null, renewsOn: null, topupUsd: 0, usd }), "Enterprise plan: no limit on checks.");

const owner = pace({ creditUsd: 499, renews: true, monthlyUsd: 66.98, balanceUsd: 498.11 });
eq("pace: the owner's plan covers the apps seven times", owner.headline, "The plan covers your apps 7 times over");
eq("pace: …and says against what", owner.detail, "$499 a month against $67 of checks. Top-ups are only needed beyond that.");
eq("pace: covers once", pace({ creditUsd: 99, renews: true, monthlyUsd: 62, balanceUsd: 40 }).headline, "The plan covers your apps");
eq("pace: covers exactly", pace({ creditUsd: 29, renews: true, monthlyUsd: 29, balanceUsd: 3 }).headline, "The plan covers your apps");
const short = pace({ creditUsd: 29, renews: true, monthlyUsd: 58, balanceUsd: 11 });
eq("pace: the plan does not cover the apps → how long the balance lasts ($11 at $58 a month)", short.headline, "The balance lasts about 5 days");
eq("pace: …and where the rest comes from", short.detail, "$29 a month against $58 of checks. The rest comes from top-ups.");
// Codex P2 on #243: $29 of plan against $29.30 of checks is "1.0 times" when
// rounded for display, and is still short.
const barely = pace({ creditUsd: 29, renews: true, monthlyUsd: 29.3, balanceUsd: 2 });
check("pace: thirty cents short is short — decided on the amounts, not on a rounded ratio", !/covers/.test(barely.headline), barely.headline);
const free = pace({ creditUsd: 5, renews: false, monthlyUsd: 8.4, balanceUsd: 4.72 });
eq("pace: Free — the balance in days, never 'covers' ($4.72 at $8.40 a month)", free.headline, "The balance lasts about 16 days");
check("pace: Free says the amount does not renew", /does not renew/.test(free.detail), free.detail);
check("pace: Free never 'covers', even when its one-time amount is larger than a month of checks",
  !/covers/.test(pace({ creditUsd: 5, renews: false, monthlyUsd: 1.2, balanceUsd: 4.5 }).headline));
// Codex P2 r2 on #243: three cents in thirty days is "$0.00 a day" when
// rounded, and the balance is still being spent.
const trickle = pace({ creditUsd: 5, renews: false, monthlyUsd: 0.03, balanceUsd: 4.97 });
eq("pace: a trickle of spending is still spending — said from the month's amount, capped at a year", trickle.headline, "The balance lasts more than a year");
check("pace: no branch says the balance is not being spent while a month has a price",
  [0.01, 0.03, 0.3, 3].every((monthlyUsd) => !/not being spent/.test(pace({ creditUsd: 5, renews: false, monthlyUsd, balanceUsd: 4 }).headline)));
eq("pace: an empty balance", pace({ creditUsd: 29, renews: true, monthlyUsd: 140, balanceUsd: 0 }).headline, "The balance runs out today");
eq("pace: one day left ($5 at $140 a month)", pace({ creditUsd: 29, renews: true, monthlyUsd: 140, balanceUsd: 5 }).headline, "The balance lasts about 1 day");
eq("pace: nothing spent", pace({ creditUsd: 99, renews: true, monthlyUsd: 0, balanceUsd: 99 }).headline, "Nothing spent yet");
eq("pace: unlimited", pace({ creditUsd: null, renews: true, monthlyUsd: 300, balanceUsd: null }).headline, "No limit on this plan");
check("pace: no branch promises 'covers' when it does not",
  [29.01, 100, 1000].every((monthlyUsd) => !/covers/.test(pace({ creditUsd: 29, renews: true, monthlyUsd, balanceUsd: 10 }).headline)));

// What the team paid for outside its apps (Codex P2 on #243).
const twoApps = [{ spendUsd: 2.03, checks: 8 }, { spendUsd: 1, checks: 4 }];
check("outside the apps: a PR preview's check and its price are their own row",
  JSON.stringify(outsideApps({ usd: 3.43, checks: 13 }, twoApps)) === JSON.stringify({ usd: 0.4, checks: 1 }), JSON.stringify(outsideApps({ usd: 3.43, checks: 13 }, twoApps)));
check("outside the apps: nothing outside → no row", outsideApps({ usd: 3.03, checks: 12 }, twoApps) === null);
check("outside the apps: a free check outside (a failed preview) is still counted",
  JSON.stringify(outsideApps({ usd: 3.03, checks: 13 }, twoApps)) === JSON.stringify({ usd: 0, checks: 1 }));
eq("apps cost: money spent only outside the apps is not 'no checks'", appsCostLine({ windowDays: 30, apps: 0, checks: 2, perDayUsd: 0.03, usd }), "Last 30 days, 0 apps, 2 checks. About $0.03 a day.");

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
check("the tile counts every check the total was spent on, and the table has a row for what was outside the apps",
  /checks: health\.totalChecks/.test(page) && /outsideApps\(\{ usd: health\.totalSpendUsd, checks: health\.totalChecks \}, apps\)/.test(page) && /Outside your apps/.test(page));
check("the table is drawn for a team with no saved app when something was paid for outside the apps", /\{\(apps\.length > 0 \|\| outside\) && \(/.test(page));
check("the old #balance anchor still lands on the balance", /id="balance"/.test(page));
check("the table scrolls inside its card", /className="card overflow-x-auto"/.test(page));
check("nothing in src still calls the old per-app spend helper", !/spendByApp/.test(read("src/lib/plans.ts")));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
