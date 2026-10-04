// The Release lens's page (CHE-367). The rules of a release and its delta are
// held by scripts/verify-releases.ts; this holds what reads the database and
// what the page says.
//
//   1. The words: the delta line in every shape, the commit link, the env.
//   2. The loader on a real D1: flat statements, the team's releases only, the
//      delta computed over what was stored.
//   3. The pages: behind the flag, the team's rows, prices only, the flag asked
//      once a request.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-release-page.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitHref, deltaCounts, envLabel, releaseDeltaLine, releasesHref, releasesLine, shortSha } from "../src/lib/release-page";
import { releasesByTeam, type Release, type ReleaseItem } from "../src/lib/releases";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. The words ────────────────────────────────────────────────────────────
const item = (title: string): ReleaseItem => ({ signature: `s:${title}`, title, category: "broken", severity: "high", audience: "unknown" });
const rel = (broke: number, fixed: number, unchanged: number, notCompared = 0, first = false): Pick<Release, "firstRelease" | "delta" | "previous"> => ({
  firstRelease: first,
  previous: first ? null : { publicId: "p", runNumber: 285, sha: "a86bb9e1f00dfeedbeef", completedAt: null },
  delta: first ? null : {
    broke: Array.from({ length: broke }, (_, i) => item(`b${i}`)),
    fixed: Array.from({ length: fixed }, (_, i) => item(`f${i}`)),
    unchanged: Array.from({ length: unchanged }, (_, i) => item(`u${i}`)),
    notCompared: Array.from({ length: notCompared }, (_, i) => item(`n${i}`)),
  },
});
eq("line: no earlier release", releaseDeltaLine(rel(0, 0, 0, 0, true)), "The first release we checked.");
eq("line: the ticket's own example", releaseDeltaLine(rel(1, 2, 3)), "Broke 1, fixed 2, unchanged 3 — against a86bb9e.");
eq("line: only fixes", releaseDeltaLine(rel(0, 2, 0)), "Broke 0, fixed 2, unchanged 0 — against a86bb9e.");
eq("line: what could not be compared is said, not folded into 'fixed' or 'broke'", releaseDeltaLine(rel(0, 1, 0, 2)), "Broke 0, fixed 1, unchanged 0, 2 not compared — against a86bb9e.");
eq("line: nothing on either side", releaseDeltaLine(rel(0, 0, 0)), "No problems before or after, against a86bb9e.");
eq("counts of a first release are zeros", JSON.stringify(deltaCounts(rel(0, 0, 0, 0, true))), '{"broke":0,"fixed":0,"unchanged":0,"notCompared":0}');

eq("sha: seven characters", shortSha("4573391c0ffee0123456789abcdef0123456789a"), "4573391");
eq("commit: a known repository and a commit's sha", commitHref("sorokinvj/check-my-app", "4573391c0ffee"), "https://github.com/sorokinvj/check-my-app/commit/4573391c0ffee");
eq("commit: no repository, no link", commitHref(null, "4573391c0ffee"), null);
eq("commit: a sha that is not one (an experiment's label) is not linked", commitHref("o/r", "e3-batch"), null);
eq("commit: a sha with a path in it is not linked", commitHref("o/r", "abc1234/../../settings"), null);
eq("commit: a repository that is not owner/name is not linked", commitHref("https://evil.example/x", "4573391"), null);
eq("env: production", envLabel("production"), "Production");
eq("env: CI's own word stays as it is", envLabel("experiment"), "experiment");
eq("address: one app", releasesHref("app 1"), "/release?app=app%201");
eq("address: all", releasesHref(null), "/release");
eq("header: none", releasesLine(0, 90), "No release was checked in the last 90 days.");
eq("header: one", releasesLine(1, 90).slice(0, 44), "1 release checked in the last 90 days. Each ");

// ── 2. The loader ───────────────────────────────────────────────────────────
async function loader() {
  const real = await realD1();
  try {
    const { db } = real;
    await db.user.create({ data: { id: "u", clerkUserId: "ck_u", email: "rel@example.test" } });
    await db.team.createMany({ data: [{ id: "t", name: "T", plan: "business" }, { id: "o", name: "Other", plan: "business" }] });
    await db.app.createMany({
      data: [
        { id: "a", teamId: "t", ownerId: "u", appSlug: "a.test", targetUrl: "https://a.test", targetKind: "website" },
        { id: "x", teamId: "o", ownerId: "u", appSlug: "x.test", targetUrl: "https://x.test", targetKind: "website" },
      ],
    });
    const at = (d: number) => new Date(Date.UTC(2026, 8, d, 10));
    const run = (id: string, n: number, appId: string, teamId: string, sha: string | null, day: number, over: object = {}) => ({
      id, publicId: `p_${id}`, runNumber: n, teamId, appId, appSlug: `${appId}.test`, targetUrl: `https://${appId}.test`, targetKind: "website",
      status: "completed", verdict: "mostly_ok", priceUsd: 0.5, deploySha: sha, deployEnv: sha ? "production" : null,
      startedAt: at(day), createdAt: at(day), completedAt: at(day), ...over,
    });
    await db.run.createMany({
      data: [
        run("r1", 1, "a", "t", "1111111aaaa", 10),
        run("r2", 2, "a", "t", null, 11), // an ordinary check between two releases: not a release
        run("r3", 3, "a", "t", "3333333cccc", 12),
        run("r4", 4, "a", "t", "4444444dddd", 13, { status: "failed", verdict: null, priceUsd: null }), // did not finish: says nothing
        run("y1", 5, "x", "o", "9999999ffff", 12), // another team's release
        // A release with no App row (Codex on #255): the team's only app of that
        // address owns it — the rule the app's page counts by too.
        { ...run("r6", 6, "a", "t", "6666666eeee", 14), appId: null },
        // …and one of an address two of the team's apps share: neither's.
        { ...run("w1", 7, "tw", "t", "7777777ffff", 14), appId: null },
      ] as never,
    });
    await db.user.create({ data: { id: "u2", clerkUserId: "ck_u2", email: "rel2@example.test" } });
    await db.app.createMany({
      data: [
        { id: "tw1", teamId: "t", ownerId: "u", appSlug: "tw.test", targetUrl: "https://tw.test", targetKind: "website" },
        { id: "tw2", teamId: "t", ownerId: "u2", appSlug: "tw.test", targetUrl: "https://tw.test", targetKind: "website" },
      ],
    });
    const journeys = ["r1", "r2", "r3", "y1"].flatMap((r) => [0, 1].map((k) => ({ id: `${r}_j${k}`, runId: r, order: k, title: `Journey ${k}`, status: "ok", journeyKey: `journey-${k}` })));
    await db.journey.createMany({ data: journeys });
    await db.step.createMany({ data: journeys.flatMap((j) => [0, 1].map((s) => ({ id: `${j.id}_s${s}`, journeyId: j.id, order: s, label: `step ${s}`, status: "ok" }))) });
    const finding = (id: string, runId: string, title: string, where: string, journeyIndex: number) => ({
      id, runId, number: Number(id.replace(/\D/g, "")) || 1, title, category: "broken", severity: "high",
      detail: JSON.stringify({ where }), anchor: JSON.stringify({ stepRef: { journeyIndex, stepIndex: 1 } }),
    });
    await db.finding.createMany({
      data: [
        finding("f1", "r1", "Invoice download returns an empty file", "/invoices", 0),
        finding("f2", "r1", "Checkout button does nothing", "/checkout", 1),
        finding("f3", "r3", "Checkout button does nothing when clicked", "/checkout", 1),
        finding("f4", "r3", "Profile photo upload fails", "/profile", 0),
        finding("f5", "y1", "Their sign-in page shows a blank screen", "/login", 0),
      ],
    });

    const releases = await releasesByTeam(db, "t", { days: 30, now: at(20) });
    eq("real D1: the team's finished checks that carry a commit, newest first — not the plain check, the failed one, another team's, or one of an address two apps share",
      releases.map((r) => r.runNumber).join(","), "6,3,1");
    const [loose, latest, first] = releases;
    eq("real D1: a release with no App row is its address's only app's", loose.appId, "a");
    eq("real D1: …and what it did not look at is not compared, not 'fixed'", releaseDeltaLine(loose), "Broke 0, fixed 0, unchanged 0, 2 not compared — against 3333333.");
    check("real D1: the first one says so", first.firstRelease && first.delta === null);
    eq("real D1: the delta is computed over what was stored (journeys, steps, findings stitched back to their check)",
      releaseDeltaLine(latest), "Broke 1, fixed 1, unchanged 1 — against 1111111.");
    eq("real D1: …the fixed one by name", latest.delta?.fixed.map((i) => i.title).join("|"), "Invoice download returns an empty file");
    eq("real D1: …the broken one by name", latest.delta?.broke.map((i) => i.title).join("|"), "Profile photo upload fails");
    check("real D1: nothing of another team's is in it", !JSON.stringify(releases).includes("Their sign-in"));
    eq("real D1: another team, asked by its own id, gets its own", (await releasesByTeam(db, "o", { days: 30, now: at(20) })).map((r) => r.runNumber).join(","), "5");
    eq("real D1: the window", (await releasesByTeam(db, "t", { days: 5, now: at(20) })).length, 0);
  } finally {
    await real.dispose();
  }
}

// ── 3. The pages ────────────────────────────────────────────────────────────
const lib = read("src/lib/releases.ts");
const loaderSrc = lib.slice(lib.indexOf("export async function releasesByTeam"), lib.indexOf("export interface ReleaseRow"));
check("the loader holds no nested run → journey → step select", !/journeys:\s*\{/.test(loaderSrc) && !/steps:\s*\{\s*orderBy/.test(loaderSrc));
check("each of its raw statements binds the team", (loaderSrc.match(/releaseChecksOf\(teamRows\(teamId\)\)/g) ?? []).length === 3 && /\.\.\.teamOwned\(teamId\), deploySha: \{ not: null \}/.test(loaderSrc));

const page = read("src/app/(app)/release/page.tsx");
check("the page does not exist for whoever lacks the lens", /if \(!\(await releaseLensFor\(user\)\)\) notFound\(\);/.test(page) && page.indexOf("releaseLensFor(user)") < page.indexOf("releasesByTeam("));
check("an app from the address that is not the team's is no filter", /appParam && nameOf\.has\(appParam\) \? appParam : null/.test(page));
check("a commit is linked only through commitHref", /commitHref\(r\.appId \? repoOf\.get\(r\.appId\) : null, r\.sha\)/.test(page) && !/github\.com/.test(page));
check("a release opens its check inside the app (its permalink when it has no app)", /href=\{checkHref\(r\)\}/.test(page));
check("prices only: the page names no cost, token or margin field", !/costUsd|cost_usd|tokens|multiplier|margin/i.test(page));

const flags = read("src/lib/viewer-flags.ts");
check("a flag is asked once a request, however many places ask", /const flagOnce = cache\(\(key: string, distinctId: string, email: string, isTestAccount: boolean\) =>\s*evaluateFlag\(key, \{ distinctId, email, isTestAccount \}\),?\s*\);/.test(flags));
check("…and nobody signed in is still answered without a request", /user \? flagOnce\(key, user\.clerkUserId, user\.email, user\.isTestAccount\) : evaluateFlag\(key, null\)/.test(flags));

const appPage = read("src/app/(app)/health/apps/[appId]/page.tsx");
check("the app's page counts its releases by the rule its timeline and the feed use (attached, or the only app of the address)",
  /OR: \[\{ appId: app\.id \}, \.\.\.\(onlyOneWithSlug \? \[\{ appId: null, appSlug: app\.appSlug \}\] : \[\]\)\],\s*deploySha: \{ not: null \}, status: \{ in: FINISHED \},/.test(appPage) &&
    /appBySlug = new Map\(apps\.filter\(\(a\) => slugCount\.get\(a\.appSlug\) === 1\)/.test(lib));
check("the app's page offers its releases only with the lens", /\{releaseLens && \(\s*<Row href=\{releasesHref\(app\.id\)\} label="Releases"/.test(appPage) && /releaseLensFor\(user\),/.test(appPage));
const checkPage = read("src/app/(app)/health/apps/[appId]/checks/[runNumber]/page.tsx");
check("a check that is a release says what it broke or fixed — read only for such a check, and only with the lens",
  /run\.deploySha && \(await releaseLensFor\(user\)\)/.test(checkPage) && /<ReleaseDelta release=\{release\} open \/>/.test(checkPage));
const delta = read("src/components/release-delta.tsx");
check("the delta block is server-rendered: no client code, no effect", !/^"use client"/.test(delta) && !/useEffect|useState/.test(delta));

loader().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
