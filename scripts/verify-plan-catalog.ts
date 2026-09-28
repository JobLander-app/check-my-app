// /pricing, PLAN_LIMITS and the owner's Notion page say the same thing (CHE-326).
//
// Before this, /pricing was a hand-typed array: Business sold "checks every 6h,
// on the paths you nominate" although every plan sets its own scenarios, the
// tracker was listed from Growth although PLAN_LIMITS turns it on at Starter,
// and seats appeared nowhere. The owner found out by reading the code. Now the
// cards are src/lib/plan-catalog.ts, built from PLAN_LIMITS, and the Notion page
// is rendered from the same two files by scripts/sync-plans-notion.ts.
//
// What this proves, without a network:
//   1. The pricing page types nothing plan-shaped itself — no price, no count
//      of checks/apps/re-checks/days/people in its source. It reads the
//      catalog. (On origin/main this is where it fails: the page holds $29,
//      "3 checks total", "up to 5 full re-checks" and "nominate".)
//   2. Every number in a catalog feature line is a number PLAN_LIMITS or the
//      run quotas hold for that plan, and planCatalogDrift() is empty.
//   3. The drift check has teeth: the origin/main cards, replayed as a
//      fixture, produce the three contradictions the owner's page listed.
//   4. The rendered Notion blocks carry every plan, every price and every
//      limit, the "generated, don't edit" callout with the commit, and no
//      "Расхождения" section while there is no drift.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-plan-catalog.ts

import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PAGE = "src/app/pricing/page.tsx";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// Same comment strip as verify-public-copy: comments are ours, not the page's.
function stripComments(source: string): string {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

// Plan-shaped text: a price, or a count of something a plan meters.
const PLAN_SHAPED: { name: string; pattern: RegExp }[] = [
  { name: "price", pattern: /\$\d/ },
  {
    name: "metered count",
    pattern: /\b\d+\s*(-day|days?\b|checks?\b|check\/day|apps?\b|full re-checks?|people\b|person\b|seats?\b|h\b)/i,
  },
  { name: "Business-only scenarios", pattern: /nominat/i },
];

function scanPage(): string[] {
  const lines = stripComments(readFileSync(path.join(repoRoot, PAGE), "utf8")).split("\n");
  const hits: string[] = [];
  lines.forEach((text, i) => {
    for (const { name, pattern } of PLAN_SHAPED) {
      if (pattern.test(text)) hits.push(`${PAGE}:${i + 1} [${name}] ${text.trim()}`);
    }
  });
  return hits;
}

// The origin/main cards (2026-09-28, 6d786ca), word for word — the fixture the
// drift check must reject.
const MAIN_CARDS = [
  {
    id: "free" as const, name: "Free", price: "$0", blurb: "See what the agent sees. No card, no signup.",
    features: [
      "1 check/day without signup", "3 checks total with a free account",
      "7-day Daily Watch trial on one app — no card",
      "Evidence on every verdict — screenshots, network logs", "Agent-written Playwright specs",
    ],
    cta: { label: "Check your app", href: "/" },
  },
  {
    id: "starter" as const, name: "Starter", price: "$29", blurb: "Your app, watched every day.",
    features: [
      "Daily Watch — a full journey check every 24h",
      "Re-check after a deploy, any time — up to 5 full re-checks a month",
      "Regression alerts by email", "Every verdict kept, with its evidence — nothing expires",
      "Export Playwright specs to GitHub as a PR",
    ],
    cta: { label: "Start free", href: "/sign-in" },
  },
  {
    id: "growth" as const, name: "Growth", price: "$99", blurb: "For teams shipping more than one thing.",
    features: [
      "Up to 5 apps",
      "Checks every 6h — uptime and page health each cycle, one deep journey walk a day per app",
      "Re-check after a deploy, any time — up to 20 full re-checks a month",
      "Findings auto-filed to your tracker — Linear now, GitHub next — with dedup & escalation",
      "Fixes verified from the outside: close a ticket and the next run confirms it",
    ],
    cta: { label: "Start free", href: "/sign-in" },
  },
  {
    id: "business" as const, name: "Business", price: "from $499", blurb: "Compliance-grade checking, on your terms.",
    features: [
      "Checks every 6h, on the paths you nominate",
      "Re-check after a deploy, any time — 100 full re-checks a month",
      "SSO", "SLA", "Priority support from the person who builds it",
    ],
    cta: { label: "Talk to us", href: "mailto:sorokinvj@gmail.com" },
  },
];

async function main() {
  // 1. The page reads the catalog and types no plan itself. Static first, so a
  // tree without the catalog still reports what is wrong with the page.
  const pageSource = readFileSync(path.join(repoRoot, PAGE), "utf8");
  check("pricing page imports PLAN_CATALOG", /from "@\/lib\/plan-catalog"/.test(pageSource));
  const hits = scanPage();
  for (const h of hits) console.log(`FAIL  ${h}`);
  check("pricing page source types no price, count or Business-only claim", hits.length === 0, `${hits.length} hits`);

  let catalogMod: typeof import("@/lib/plan-catalog");
  let syncMod: typeof import("./sync-plans-notion");
  try {
    catalogMod = await import("@/lib/plan-catalog");
    syncMod = await import("./sync-plans-notion");
  } catch (err) {
    check("src/lib/plan-catalog.ts and scripts/sync-plans-notion.ts load", false, String(err));
    return finish();
  }
  const { PLAN_CATALOG, TRACKER_LINE } = catalogMod;
  const { planCatalogDrift, renderPlanBlocks } = syncMod;
  const plans = await import("@/lib/plans");
  const { PLAN_LIMITS } = plans;

  // 2. Every number on a card is one the code holds for that plan.
  check("catalog covers free, starter, growth, business", PLAN_CATALOG.map((p) => p.id).join(",") === "free,starter,growth,business");
  for (const plan of PLAN_CATALOG) {
    const l = PLAN_LIMITS[plan.id];
    // CHE-327: a card's numbers are its balance, its typical price range,
    // the top-up amounts, its seats and the 6-hour cadence — nothing else.
    const range = plans.typicalPriceRange(plan.id);
    const allowed = new Set<number>([l.creditUsd ?? -1, l.includedSeats ?? -1, range.low, range.high, 6, ...plans.TOPUP_AMOUNTS_USD]);
    if (plan.id === "free") [plans.ANON_RUNS_PER_DAY, plans.WATCH_TRIAL_DAYS].forEach((n) => allowed.add(n));
    const stray = plan.features.flatMap((f) => (f.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)).filter((n) => !allowed.has(n));
    check(`${plan.name}: every number on the card is in PLAN_LIMITS`, stray.length === 0, stray.join(", "));
    check(
      `${plan.name}: tracker line ${l.trackerIntegration ? "present" : "absent"} (trackerIntegration=${l.trackerIntegration})`,
      plan.features.includes(TRACKER_LINE) === l.trackerIntegration,
    );
  }
  const drift = planCatalogDrift();
  check("planCatalogDrift() is empty", drift.length === 0, drift.join(" | "));

  // 3. Teeth: the origin/main cards are caught.
  const mainDrift = planCatalogDrift(MAIN_CARDS);
  check("origin/main cards: Business «nominate» caught", mainDrift.some((d) => d.startsWith("Business") && d.includes("nominate")), mainDrift.join(" | "));
  check("origin/main cards: Starter tracker missing caught", mainDrift.some((d) => d.startsWith("Starter") && d.includes("трекер")));
  check("origin/main cards: seats missing caught", mainDrift.some((d) => d.includes("мест")));
  // CHE-327: the old cards sold full re-checks and app counts, and no balance.
  check("origin/main cards: a missing balance line caught", mainDrift.some((d) => d.startsWith("Starter") && d.includes("баланс")));
  check("origin/main cards: full re-checks / app caps caught", mainDrift.some((d) => d.includes("полные перепроверки")));

  // 4. The Notion page.
  const blocks = renderPlanBlocks({ sha: "abcdef0123456", date: "2026-09-28" });
  const text = JSON.stringify(blocks);
  check("callout says generated and names the commit", blocks[0]?.type === "callout" && text.includes("руками не править") && text.includes("abcdef0"));
  for (const plan of PLAN_CATALOG) {
    check(`Notion: ${plan.name} and its price`, text.includes(`${plan.name} ${plan.price}${plan.priceNote ?? ""}`));
    for (const f of plan.features) check(`Notion: ${plan.name} line «${f.slice(0, 40)}…»`, text.includes(JSON.stringify(f).slice(1, -1)));
  }
  const table = blocks.find((b) => b.type === "table") as { table: { children: { table_row: { cells: { text: { content: string } }[][] } }[] } } | undefined;
  const rows = table?.table.children.map((r) => r.table_row.cells.map((c) => c[0].text.content)) ?? [];
  const cell = (label: string, col: number) => rows.find((r) => r[0].startsWith(label))?.[col];
  PLAN_CATALOG.forEach((plan, i) => {
    const l = PLAN_LIMITS[plan.id];
    const col = i + 1;
    const n = (x: number | null) => (x === null ? "без лимита" : String(x));
    check(`Notion table: ${plan.name} balance`, (cell("Баланс", col) ?? "").startsWith(plans.usd(l.creditUsd ?? 0)), cell("Баланс", col));
    // The Notion page is ours: it may, and must, show the multiplier.
    check(`Notion table: ${plan.name} multiplier (internal)`, cell("Множитель", col) === `×${l.priceMultiplier}`, cell("Множитель", col));
    const r = plans.typicalPriceRange(plan.id);
    check(`Notion table: ${plan.name} typical price`, cell("Типичная цена", col) === `${plans.usd(r.low)}–${plans.usd(r.high)}`, cell("Типичная цена", col));
    check(`Notion table: ${plan.name} seats`, cell("Места", col) === n(l.includedSeats), cell("Места", col));
    check(`Notion table: ${plan.name} tracker`, cell("Трекер", col) === (l.trackerIntegration ? "да" : "нет"), cell("Трекер", col));
  });
  check("Notion: free is once, and anon/day", (cell("Баланс", 1) ?? "").includes("один раз") && (cell("Баланс", 1) ?? "").includes(`${plans.ANON_RUNS_PER_DAY} проверка/день`));
  check("Notion: trial days", (cell("Daily Watch", 1) ?? "").includes(`${plans.WATCH_TRIAL_DAYS} дней`));
  check("Notion: no full re-checks or daily budget rows", !rows.some((r) => /Полные перепроверки|Бюджет агента/.test(r[0])));
  check("Notion: site cap", text.includes(`${plans.ANON_RUNS_PER_DAY_SITE} бесплатных анонимных`));
  check("Notion: 'not gated by plan' section", text.includes("Что НЕ зависит от тарифа"));
  check("Notion: no «Расхождения» while there is no drift", !text.includes("Расхождения"));
  check("Notion: no «nominate» anywhere", !/nominat/i.test(text));

  finish();
}

function finish() {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
