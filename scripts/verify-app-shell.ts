// The signed-in app lives in one frame, and every old address still lands
// (CHE-351, direction C of epic CHE-348).
//
// What is held here, each by the code rather than by a reviewer:
//   1. The (app) route group and APP_SHELL_PREFIXES name the same addresses.
//      The group decides which pages get the sidebar; the list decides where
//      the public header hides and what the middleware protects. If they drift,
//      a page gets two menus, or none, or opens without a session.
//   2. Every old address in MOVED_ROUTES is served by next.config.mjs and lands
//      on a page that exists, and its old page is gone (a leftover page behind a
//      redirect is code nobody can reach). The two that need more than a
//      pattern — /watch/[slug] and /dashboard#balance — are handled by a page.
//   3. Nothing in the source still links or redirects to an old address: an
//      internal link that costs a redirect hop is a link that will break the
//      day the redirect is retired.
//   4. Feature flags are read on the server only. The browser's flag client has
//      no overrides (CHE-381 point 4), so a lens decided in a client component
//      could disagree with the page the server rendered. No client module may
//      import the flag modules or name a flag key.
//   5. The shell keeps no effects: the drawer's state changes on events, the
//      active item comes from the URL as it renders.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-app-shell.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_SHELL_PREFIXES, isAppShellPath } from "../src/lib/app-shell";
import { MOVED_ROUTES } from "../src/lib/moved-routes.mjs";
import { BALANCE_PATH } from "../src/lib/balance-links";
import robots from "../src/app/robots";
import { loadShellData } from "../src/lib/shell-data";
import { appHealth, teamSpend } from "../src/lib/app-health";
import { OUR_LEFTOVERS_WHERE } from "../src/lib/finding-signature";
import type { PrismaClient } from "../src/generated/prisma/client";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(repoRoot, "src/app");
const GROUP = path.join(APP_DIR, "(app)");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" ? [] : walk(p);
    return /\.(tsx?|mjs)$/.test(e.name) ? [p] : [];
  });
}

// Resolves an address against the App Router tree the way Next does: route
// groups are transparent, a [param] folder takes any segment.
function pageFor(href: string): string | null {
  const segments = href.split("/").filter(Boolean);
  const expand = (dir: string): string[] => [
    dir,
    ...readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\(.+\)$/.test(e.name))
      .flatMap((e) => expand(path.join(dir, e.name))),
  ];
  let dirs = expand(APP_DIR);
  for (const seg of segments) {
    const isParam = seg.startsWith(":");
    dirs = dirs.flatMap((d) =>
      readdirSync(d, { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            !/^\(.+\)$/.test(e.name) &&
            (/^\[.+\]$/.test(e.name) || (!isParam && e.name === seg)),
        )
        .flatMap((e) => expand(path.join(d, e.name))),
    );
  }
  const hit = dirs.map((d) => path.join(d, "page.tsx")).find((f) => existsSync(f));
  return hit ? path.relative(repoRoot, hit) : null;
}

// ── 1. One list, one group ──────────────────────────────────────────────────

const groupDirs = readdirSync(GROUP, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `/${e.name}`)
  .sort();
check(
  "every top-level folder of (app) is an app-shell prefix, and every prefix has its folder",
  groupDirs.join(",") === [...APP_SHELL_PREFIXES].sort().join(","),
  `(app): ${groupDirs.join(" ")} · prefixes: ${[...APP_SHELL_PREFIXES].join(" ")}`,
);
check("the (app) layout signs the person in", /await requireUser\(\)/.test(read("src/app/(app)/layout.tsx")));
const middleware = read("src/middleware.ts");
for (const p of APP_SHELL_PREFIXES) {
  check(`the middleware protects ${p}`, middleware.includes(`"${p}(.*)"`));
}
const disallow = ([] as string[]).concat((Array.isArray(robots().rules) ? robots().rules[0] : robots().rules).disallow ?? []);
for (const p of APP_SHELL_PREFIXES) {
  check(`robots keeps ${p} out`, disallow.includes(p));
}
const layout = read("src/app/layout.tsx");
check(
  "the public header is wrapped in the gate that hides it inside the app",
  /<SiteHeaderGate>\s*<header/.test(layout) && /<\/header>\s*<\/SiteHeaderGate>/.test(layout),
);
check("isAppShellPath matches the app and not the public site", isAppShellPath("/home") && isAppShellPath("/health/apps/x") && !isAppShellPath("/") && !isAppShellPath("/homepage") && !isAppShellPath("/pricing"));

// ── 2. Every old address lands ──────────────────────────────────────────────

const nextConfig = read("next.config.mjs");
check(
  "next.config.mjs serves MOVED_ROUTES as permanent redirects",
  /import \{ MOVED_ROUTES \} from "\.\/src\/lib\/moved-routes\.mjs"/.test(nextConfig) &&
    /\.\.\.MOVED_ROUTES\.map\(\(r\) => \(\{ source: r\.from, destination: r\.to, permanent: true \}\)\)/.test(nextConfig),
);
for (const { from, to } of MOVED_ROUTES) {
  const target = pageFor(to);
  check(`${from} → ${to} lands on a page`, target !== null, target ?? "no page");
  check(`${from} has no page of its own left behind the redirect`, pageFor(from) === null, pageFor(from) ?? "");
}
// More specific first: Next takes the first match.
const order = MOVED_ROUTES.map((r) => r.from);
check(
  "/dashboard/accuracy is matched before /dashboard/:appId",
  order.indexOf("/dashboard/accuracy") < order.indexOf("/dashboard/:appId"),
);
const watch = read("src/app/watch/[slug]/page.tsx");
check(
  "/watch/[slug] looks the app up and sends it to its schedule",
  /redirect\(appPath\.schedule\(/.test(watch) && pageFor("/health/apps/:appId/settings/schedule") !== null,
);
const home = read("src/app/(app)/home/page.tsx");
check(
  "/dashboard#balance arrives on /home and is sent on to Billing",
  /location\.hash==="#balance"\)location\.replace\(\$\{JSON\.stringify\(BALANCE_PATH\)\}\)/.test(home) && pageFor(BALANCE_PATH) !== null,
  BALANCE_PATH,
);

// ── 3. Nothing links to an old address ──────────────────────────────────────

const OLD = /["'`](\/dashboard(?:[/?#][^"'`]*)?|\/team|\/team[?#][^"'`]*)["'`]/;
// …and inside templates, where a host comes first: `${APP_URL}/team` was the
// Stripe portal's return_url and slipped past the quote-delimited pattern
// (Codex P2 on #230).
const OLD_TEMPLATE = /`\/dashboard\/\$\{|\}\/(dashboard|team)(?=[`/?#"'])/;
const stale: string[] = [];
for (const file of [...walk(path.join(repoRoot, "src")), path.join(repoRoot, "mcp/server.ts")]) {
  const rel = path.relative(repoRoot, file);
  if (rel === "src/lib/moved-routes.mjs" || rel === "src/app/robots.ts" || rel === "src/middleware.ts") continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (OLD.test(line) || OLD_TEMPLATE.test(line)) stale.push(`${rel}:${i + 1}`);
    });
}
check("no link, redirect or revalidation in the source names an old address", stale.length === 0, stale.join(", "));

// ── 4. Flags are a server matter ────────────────────────────────────────────

const clientFiles = walk(path.join(repoRoot, "src")).filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
const flagLeaks = clientFiles.filter((f) => {
  const src = readFileSync(f, "utf8");
  return /from ["']@\/lib\/(viewer-flags|feature-flags)["']|from ["']\.\/(viewer-flags|feature-flags)["']|["']lens-(product|marketing|release)["']/.test(src);
});
check(`no client module reads a feature flag (${clientFiles.length} client modules)`, flagLeaks.length === 0, flagLeaks.map((f) => path.relative(repoRoot, f)).join(", "));
const appLayout = read("src/app/(app)/layout.tsx");
check(
  "the lenses are decided in the server layout",
  !/^\s*["']use client["']/.test(appLayout) && /productLensFor\(user\)/.test(appLayout) && /releaseLensFor\(user\)/.test(appLayout),
);
check("the sidebar takes booleans, not flag keys", !/lens-|evaluateFlag|viewer-flags/.test(read("src/components/shell/sidebar.tsx")));

// ── 5. No effects in the shell ──────────────────────────────────────────────

const shellFiles = [...walk(path.join(repoRoot, "src/components/shell")), path.join(repoRoot, "src/components/site-header-gate.tsx")];
const effects = shellFiles.filter((f) => /\buse(Layout)?Effect\b/.test(readFileSync(f, "utf8")));
check("the shell has no useEffect", effects.length === 0, effects.map((f) => path.relative(repoRoot, f)).join(", "));

// ── 6. The sidebar costs the same whatever the team's size ──────────────────
// Every signed-in page renders it (Codex P1 on #230: the first version ran the
// whole appHealth report, ~5 queries per app, on every page). Over a stub
// database that counts calls: three queries for one app and for sixty, the
// verdicts and open findings in one statement with one bound parameter (D1
// caps a statement at 100), and the month equal to what appHealth says the
// apps cost on the same runs — window edges included, the team's spending
// outside its apps left out.

type Call = { op: string; args: unknown };
function stubDb(appCount: number, runs: { appId: string | null; appSlug: string; watchId: string | null; priceUsd: number | null; createdAt: Date }[]) {
  const calls: Call[] = [];
  const apps = Array.from({ length: appCount }, (_, i) => ({
    id: `app_${i}`,
    appSlug: i === 1 ? "chromewebstore.google.com" : `app${i}.example`,
    targetKind: i === 1 ? "extension" : "website",
    targetUrl: i === 1 ? "https://chromewebstore.google.com/detail/x/abcdefghijklmnopabcdefghijklmnop" : `https://app${i}.example`,
  }));
  const latest = [
    { appId: "app_0", verdict: "broken", open: BigInt(2) },
    ...(appCount > 2 ? [{ appId: "app_2", verdict: "all_good", open: 1 }] : []),
  ];
  const db = {
    team: { findUnique: async (args: unknown) => (calls.push({ op: "team.findUnique", args }), { plan: "growth" }) },
    app: { findMany: async (args: unknown) => (calls.push({ op: "app.findMany", args }), apps) },
    run: {
      findMany: async (args: { where?: { OR?: unknown } }) => {
        calls.push({ op: "run.findMany", args });
        // appHealth's per-app "finished" query carries an OR; the window query does not.
        return args.where?.OR ? [] : runs;
      },
    },
    $queryRaw: async (sql: { values: unknown[] }) => (calls.push({ op: "$queryRaw", args: sql }), latest),
  };
  return { db: db as unknown as PrismaClient, calls };
}

async function shellChecks() {
  const shellSrc = read("src/lib/shell-data.ts");
  check(
    "the shell's data does not run the full health report or explain prices",
    !/from ["']@\/lib\/app-health["']|explainPrice|from ["']@\/lib\/check-price["']/.test(shellSrc),
  );
  check(
    "it is cached per request, and the layout reads it through the cache",
    /export const shellData = cache\(/.test(shellSrc) && /shellData\(db, team\.id\)/.test(read("src/app/(app)/layout.tsx")),
  );

  const now = new Date("2026-10-01T12:00:00.000Z");
  const runs = [
    { appId: "app_0", appSlug: "app0.example", watchId: null, priceUsd: 5, createdAt: new Date("2026-09-01T23:00:00.000Z") }, // day before the window
    { appId: "app_0", appSlug: "app0.example", watchId: "w", priceUsd: 1, createdAt: new Date("2026-09-02T00:30:00.000Z") }, // first day
    { appId: "app_2", appSlug: "app2.example", watchId: null, priceUsd: 0.72, createdAt: new Date("2026-09-20T09:00:00.000Z") },
    { appId: null, appSlug: "preview.example", watchId: null, priceUsd: 0.5, createdAt: new Date("2026-09-25T09:00:00.000Z") }, // the team's, in no app
    { appId: "app_0", appSlug: "app0.example", watchId: null, priceUsd: null, createdAt: new Date("2026-09-30T09:00:00.000Z") }, // failed: $0
    { appId: "app_0", appSlug: "app0.example", watchId: null, priceUsd: 0.04, createdAt: new Date("2026-10-01T23:59:00.000Z") }, // last minute
    { appId: "app_0", appSlug: "app0.example", watchId: null, priceUsd: 9, createdAt: new Date("2026-10-02T00:10:00.000Z") }, // after
  ];

  const one = stubDb(1, runs);
  const sixty = stubDb(60, runs);
  const small = await loadShellData(one.db, "team_x", now);
  const big = await loadShellData(sixty.db, "team_x", now);
  check("the sidebar's data is three queries for one app", one.calls.length === 3, one.calls.map((c) => c.op).join(", "));
  check("…and three for sixty", sixty.calls.length === 3, sixty.calls.map((c) => c.op).join(", "));
  const raw = sixty.calls.find((c) => c.op === "$queryRaw")?.args as { values: unknown[]; sql?: string } | undefined;
  // Two bound values whatever the team's size: the team, and the constant that
  // names our own leftovers finding — never a list of app ids.
  check("verdicts and open findings come in one statement bound to the team alone",
    raw?.values.length === 2 && raw.values.includes("team_x") && raw.values.includes(`%"where":"${OUR_LEFTOVERS_WHERE}"%`), JSON.stringify(raw?.values));
  check(
    "each app gets its latest verdict, an app with none gets none",
    big.apps.find((a) => a.id === "app_0")?.verdict === "broken" &&
      big.apps.find((a) => a.id === "app_2")?.verdict === "all_good" &&
      big.apps.find((a) => a.id === "app_3")?.verdict === null,
  );
  check("open findings add up across apps (a BigInt count included)", big.openIssues === 3, String(big.openIssues));
  check("an extension is named, not shown as a store host", big.apps.find((a) => a.id === "app_1")?.label !== "chromewebstore.google.com", big.apps.find((a) => a.id === "app_1")?.label);
  // "Your apps cost" is the saved apps' checks. The $0.50 preview is the
  // team's spending and belongs to no app; with one app saved, neither does
  // the $0.72 check of an address that is not (yet) an app.
  check("the month is the window's priced checks of the saved apps: $1 + $0.04 with one app", small.monthlyCostUsd === 1.04, String(small.monthlyCostUsd));
  const three = await loadShellData(stubDb(3, runs).db, "team_x", now);
  check("…$1 + $0.72 + $0.04 with three — never the $0.50 preview", three.monthlyCostUsd === 1.76, String(three.monthlyCostUsd));

  const health = await appHealth(stubDb(3, runs).db, "team_x", { now });
  check("…the same number appHealth reports as what the apps cost", health.appsMonthlyUsd === three.monthlyCostUsd, `${health.appsMonthlyUsd} vs ${three.monthlyCostUsd}`);
  check("…while the run rate the plan is measured against is everything the balance paid for", health.monthlyRunRateUsd === 2.26, String(health.monthlyRunRateUsd));
  // The totals alone (Health → Checks) are the report's totals: one pass, the
  // same edges, and one query instead of several per app.
  const lean = stubDb(3, runs);
  const totals = await teamSpend(lean.db, "team_x", { now });
  check("teamSpend is appHealth's totals", totals.totalSpendUsd === health.totalSpendUsd && totals.totalChecks === health.totalChecks && totals.windowDays === health.windowDays,
    `${totals.totalChecks} checks, $${totals.totalSpendUsd} vs ${health.totalChecks}, $${health.totalSpendUsd}`);
  check("…in one query", lean.calls.length === 1 && lean.calls[0].op === "run.findMany", lean.calls.map((c) => c.op).join(", "));
}

// ── 7. The statement itself, in a real D1 ───────────────────────────────────
// The stub above answers $queryRaw with canned rows, so it cannot say whether
// the SQL picks the right check. A local D1 with every migration applied can:
// which check is an app's latest, whose check an unattached one is (Codex P2 on
// #230: a check that predates its app left the dot grey), that another team's
// rows stay out, and that each lookup seeks on the index instead of reading the
// team's history.

async function realChecks() {
  const real = await realD1();
  try {
    const T = "tr";
    const at = (s: string) => new Date(s);
    await real.db.user.create({ data: { id: "ur", clerkUserId: "ck_ur", email: "shell@example.test" } });
    await real.db.team.create({ data: { id: T, name: "Shell", plan: "business" } });
    await real.db.team.create({ data: { id: "to", name: "Other", plan: "business" } });
    await real.db.user.create({ data: { id: "ur2", clerkUserId: "ck_ur2", email: "shell2@example.test" } });
    const app = (id: string, slug = `${id}.test`, ownerId = "ur") =>
      real.db.app.create({ data: { id, teamId: T, ownerId, appSlug: slug, targetUrl: `https://${slug}`, targetKind: "website" } });
    for (const id of ["own", "loose", "both", "failed", "none", "mixed", "mixedloose"]) await app(id);
    // One slug, two apps in the team: two teammates each added it (an owner has one app per slug).
    await app("twin1", "twin.test");
    await app("twin2", "twin.test", "ur2");

    let n = 0;
    const run = async (
      appId: string | null, slug: string, completedAt: string, verdict: string | null,
      over: { teamId?: string; status?: string; priceUsd?: number | null; marks?: string[] } = {},
    ) => {
      const id = `r${++n}`;
      await real.db.run.create({
        data: {
          id, publicId: `p${n}`, runNumber: n, teamId: over.teamId ?? T, appId, appSlug: slug, targetUrl: `https://${slug}`,
          targetKind: "website", status: over.status ?? "completed", verdict,
          priceUsd: over.priceUsd === undefined ? 0.5 : over.priceUsd,
          createdAt: at(completedAt), completedAt: at(completedAt),
        } as never,
      });
      for (const [i, mark] of (over.marks ?? []).entries()) {
        await real.db.finding.create({ data: { runId: id, number: i + 1, title: `f${i}`, category: "bug", severity: "high", mark } });
      }
      return id;
    };
    // own: the newer attached check wins; of its four findings two are open.
    await run("own", "own.test", "2026-09-20T10:00:00Z", "broken", { marks: ["none", "none", "none"] });
    const ownLatest = await run("own", "own.test", "2026-09-28T10:00:00Z", "all_good", { marks: ["none", "watch", "known", "false_positive"] });
    // …and a fifth that is about US — test records our check left behind. It
    // is unanswered and is not a problem of the app (CHE-360).
    await real.db.finding.create({
      data: { runId: ownLatest, number: 9, title: "Test records we created are still in your app", category: "bug", severity: "medium", mark: "none", detail: JSON.stringify({ where: OUR_LEFTOVERS_WHERE, whatHappened: "2 records" }) },
    });
    // loose: its only check predates the app. Another team's newer check of the
    // same slug is not its check.
    await run(null, "loose.test", "2026-09-10T10:00:00Z", "mostly_ok", { marks: ["none"] });
    await run(null, "loose.test", "2026-09-29T10:00:00Z", "broken", { teamId: "to", marks: ["none", "none"] });
    // both: an attached check, and a newer unattached one — the newer wins.
    await run("both", "both.test", "2026-09-12T10:00:00Z", "all_good");
    await run(null, "both.test", "2026-09-14T10:00:00Z", "broken", { marks: ["none"] });
    // failed: the newest check failed and has no verdict; the one before stands.
    await run("failed", "failed.test", "2026-09-15T10:00:00Z", "broken");
    await run("failed", "failed.test", "2026-09-30T10:00:00Z", null, { status: "failed", priceUsd: null });
    // twins: two apps share a slug, so an unattached check is neither's.
    await run(null, "twin.test", "2026-09-16T10:00:00Z", "broken", { marks: ["none"] });
    // mixed: two checks on one day in the two spellings prod holds. The later
    // one (23:30) is in the hand-written spelling, which text puts BEFORE the
    // 22:00 one — the latest is the 23:30 check only if time decides (Codex P2
    // on #230). An older day's check must not come back through the day edge.
    await run("mixed", "mixed.test", "2026-09-13T23:59:00Z", "needs_attention", { marks: ["none", "none", "none"] });
    await run("mixed", "mixed.test", "2026-09-14T22:00:00Z", "all_good");
    const late = await run("mixed", "mixed.test", "2026-09-14T23:30:00Z", "broken", { marks: ["none"] });
    await real.exec(`UPDATE Run SET completedAt = '2026-09-14 23:30:00' WHERE id = ?`, late);
    // mixedloose: the same day, the two spellings split between an attached
    // check and an unattached one — the comparison between the two candidates.
    await run("mixedloose", "mixedloose.test", "2026-09-14T22:00:00Z", "all_good");
    const lateLoose = await run(null, "mixedloose.test", "2026-09-14T23:30:00Z", "broken", { marks: ["none"] });
    await real.exec(`UPDATE Run SET completedAt = '2026-09-14 23:30:00' WHERE id = ?`, lateLoose);

    // carry: its latest check walked journey 0 and carried journey 1 forward.
    // A finding on the walked one is open; the one it only restated on the
    // carried journey is not counted — recurrence does not call that seeing
    // the problem again, so Issues does not list it under the latest checks
    // (Codex on #249).
    await app("carry");
    const carried = await run("carry", "carry.test", "2026-09-27T10:00:00Z", "mostly_ok");
    await real.db.journey.createMany({
      data: [
        { id: "cj0", runId: carried, order: 0, title: "Walked", status: "ok" },
        { id: "cj1", runId: carried, order: 1, title: "Carried", status: "ok", carriedFromRunId: "r1" },
      ],
    });
    await real.db.finding.createMany({
      data: [
        { runId: carried, number: 1, title: "seen in this check", category: "bug", severity: "high", mark: "none", anchor: JSON.stringify({ stepRef: { journeyIndex: 0, stepIndex: 0 } }) },
        { runId: carried, number: 2, title: "restated from an earlier check", category: "bug", severity: "high", mark: "none", anchor: JSON.stringify({ stepRef: { journeyIndex: 1, stepIndex: 0 } }) },
      ],
    });

    const shell = await loadShellData(real.db, T, new Date("2026-10-01T12:00:00.000Z"));
    const verdict = (id: string) => shell.apps.find((a) => a.id === id)?.verdict;
    check("real D1: an app's latest attached check gives its verdict", verdict("own") === "all_good", String(verdict("own")));
    check("real D1: a check that predates its app is that app's check", verdict("loose") === "mostly_ok", String(verdict("loose")));
    check("real D1: a newer unattached check outranks an older attached one", verdict("both") === "broken", String(verdict("both")));
    check("real D1: a failed check does not take the verdict away", verdict("failed") === "broken", String(verdict("failed")));
    check("real D1: two apps sharing a slug claim no unattached check", verdict("twin1") === null && verdict("twin2") === null, `${verdict("twin1")} / ${verdict("twin2")}`);
    check("real D1: an app never checked has no verdict", verdict("none") === null, String(verdict("none")));
    check("real D1: of two same-day checks in two spellings, the later by time is the latest", verdict("mixed") === "broken", String(verdict("mixed")));
    check("real D1: …also when one of the two is attached and the other is not", verdict("mixedloose") === "broken", String(verdict("mixedloose")));
    check("real D1: open findings are the latest checks' unanswered ones: 2 + 1 + 1 + 1 + 1 + 1 — not our own leftovers, not a finding restated on a carried journey",
      shell.openIssues === 7, String(shell.openIssues));
    const latestRun = (id: string) => shell.apps.find((a) => a.id === id)?.latestRunNumber;
    check("real D1: each app carries the number of the check its dot and its count come from (Issues reads it)",
      latestRun("own") === 2 && latestRun("loose") === 3 && latestRun("both") === 6 && latestRun("none") === null,
      `${latestRun("own")} / ${latestRun("loose")} / ${latestRun("both")} / ${latestRun("none")}`);
    const health = await appHealth(real.db, T, { now: new Date("2026-10-01T12:00:00.000Z") });
    const differ = health.apps.filter((a) => (a.latest?.verdict ?? null) !== (verdict(a.appId) ?? null)).map((a) => `${a.appId}: ${a.latest?.verdict} vs ${verdict(a.appId)}`);
    check("real D1: the sidebar and appHealth name the same latest verdict for every app", differ.length === 0, differ.join("; "));

    const shellSrc = read("src/lib/shell-data.ts");
    const sql = shellSrc.slice(shellSrc.indexOf("Prisma.sql`") + "Prisma.sql`".length, shellSrc.indexOf("`;", shellSrc.indexOf("Prisma.sql`")));
    const plan = (await real.db.$queryRawUnsafe(
      `EXPLAIN QUERY PLAN ${sql.replace("${teamId}", "'tr'").replace("${OUR_LEFTOVERS}", `'%"where":"${OUR_LEFTOVERS_WHERE}"%'`)}`,
    )) as { detail: string }[];
    // `o` and `l` are the statement's two lookups (attached, unattached); no
    // table of the statement may be read whole.
    const details = plan.map((p) => p.detail);
    const seeks = (alias: string) =>
      details.some((d) => d.startsWith(`SEARCH ${alias} USING INDEX Run_teamId_appId_completedAt_idx (teamId=? AND appId=?`));
    // `d` and `e` find the newest day (a seek, newest first); `o` and `l` then
    // read that day only (appId and a completedAt range).
    check(
      "real D1: each latest-check lookup seeks on Run(teamId, appId, completedAt), and no table is read whole",
      ["o", "l", "d", "e"].every(seeks) && !details.some((d) => /^SCAN [a-z]\b/.test(d)),
      details.join(" | "),
    );
  } finally {
    await real.dispose();
  }
}

shellChecks().then(realChecks).then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
