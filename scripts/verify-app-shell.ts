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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_SHELL_PREFIXES, isAppShellPath } from "../src/lib/app-shell";
import { MOVED_ROUTES } from "../src/lib/moved-routes.mjs";
import { BALANCE_PATH } from "../src/lib/balance-links";
import robots from "../src/app/robots";
import { loadShellData } from "../src/lib/shell-data";
import { appHealth } from "../src/lib/app-health";
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
// caps a statement at 100), and the month equal to appHealth's run rate on
// the same runs — window edges included.

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
  check("verdicts and open findings come in one statement bound to the team alone", raw?.values.length === 1 && raw.values[0] === "team_x", JSON.stringify(raw?.values));
  check(
    "each app gets its latest verdict, an app with none gets none",
    big.apps.find((a) => a.id === "app_0")?.verdict === "broken" &&
      big.apps.find((a) => a.id === "app_2")?.verdict === "all_good" &&
      big.apps.find((a) => a.id === "app_3")?.verdict === null,
  );
  check("open findings add up across apps (a BigInt count included)", big.openIssues === 3, String(big.openIssues));
  check("an extension is named, not shown as a store host", big.apps.find((a) => a.id === "app_1")?.label !== "chromewebstore.google.com", big.apps.find((a) => a.id === "app_1")?.label);
  check("the month is the window's priced runs: $1 + $0.72 + $0.50 + $0.04", small.monthlyCostUsd === 2.26, String(small.monthlyCostUsd));

  const health = await appHealth(stubDb(3, runs).db, "team_x", { now });
  check("…the same number appHealth reports as the run rate", health.monthlyRunRateUsd === small.monthlyCostUsd, `${health.monthlyRunRateUsd} vs ${small.monthlyCostUsd}`);
}

shellChecks().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
