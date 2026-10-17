// CHE-96 acceptance: a record the checker left in our own product is removed,
// and the ledger stops reporting it.
//
// The defect this proves gone: run #113 registered an app, "CheckMyApp test
// r113", in checkmyapp.dev under the owner's ordinary account. The janitor
// sweeps only apps of accounts flagged isTestAccount, so nothing ever removed
// it, its CreatedResource row stayed open, and findOrphans() — which lists every
// open row of the app — handed it to fileCapabilityGaps on every later run: the
// same "[Checker gap] Checker leaves test records behind" ticket, re-filed for
// six weeks by runs that had created nothing.
//
// Driven through the real sweepSelfCheckLeftovers and the real findOrphans,
// twice: against an in-memory database that evaluates the `where` clauses used
// (the cases), and against a real D1 (Miniflare, every migration applied) with
// more open ledger rows than one batch holds, the ones not ours sorting first —
// which only a database that really applies `take` and `orderBy` can answer.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-self-check-leftovers.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { findOrphans } from "@/agent/cleanup";
import { REMOVAL_PENDING_NOTE, carriesMarker, leftoverKind, sweepSelfCheckLeftovers } from "@/agent/janitor";
import type { AgentEnv } from "@/agent/env";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const NOW = new Date("2026-10-12T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

interface Ledger {
  id: string;
  runId: string;
  appId: string | null;
  kind: string;
  marker: string;
  locationUrl: string | null;
  cleanupNote: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}
interface AppRow {
  id: string;
  appSlug: string;
  name: string | null;
  ownerId: string;
  teamId: string | null;
}
interface RunRow {
  id: string;
  appId: string | null;
  runNumber: number;
  targetUrl: string;
  ownerId: string | null;
  teamId: string | null;
}

function build() {
  const runs: RunRow[] = [
    // Our own product, checked as the owner's ordinary account.
    { id: "run113", appId: "ours", runNumber: 113, targetUrl: "https://checkmyapp.dev", ownerId: "owner", teamId: "t1" },
    { id: "run11", appId: "ours", runNumber: 11, targetUrl: "https://checkmyapp.dev", ownerId: "owner", teamId: "t1" },
    { id: "run378", appId: "ours", runNumber: 378, targetUrl: "https://checkmyapp.dev", ownerId: "owner", teamId: "t1" },
    // A customer's product: nothing of theirs is ever ours to remove.
    // Runs whose records the agent worded as it liked (#219, #242, #260, #261).
    { id: "run219", appId: "ours", runNumber: 219, targetUrl: "https://checkmyapp.dev", ownerId: "owner", teamId: "t1" },
    { id: "run242", appId: "ours", runNumber: 242, targetUrl: "https://checkmyapp.dev", ownerId: "owner", teamId: "t1" },
    { id: "run260", appId: "ours", runNumber: 260, targetUrl: "https://checkmyapp.dev", ownerId: "owner", teamId: "t1" },
    { id: "run261", appId: "ours", runNumber: 261, targetUrl: "https://checkmyapp.dev", ownerId: "owner", teamId: "t1" },
    { id: "run270", appId: "ours", runNumber: 270, targetUrl: "https://checkmyapp.dev", ownerId: "owner", teamId: "t1" },
    { id: "runCust", appId: "cust", runNumber: 200, targetUrl: "https://joblander.app", ownerId: "owner", teamId: "t1" },
  ];
  const apps: AppRow[] = [
    { id: "ours", appSlug: "checkmyapp.dev", name: null, ownerId: "owner", teamId: "t1" },
    { id: "r113", appSlug: "checkmyapp-test-r113.example.com", name: "CheckMyApp test r113", ownerId: "owner", teamId: "t1" },
    // Same prefix, another run's marker: must survive the sweep of r11.
    { id: "r1130", appSlug: "checkmyapp-test-r1130.example.com", name: null, ownerId: "owner", teamId: "t1" },
    // Someone else's app that happens to carry r113 in its name.
    { id: "other", appSlug: "checkmyapp-test-r113.example.org", name: null, ownerId: "stranger", teamId: "t9" },
    { id: "r219", appSlug: "checkmyapp-test-r219.example.com", name: "CheckMyApp test r219", ownerId: "owner", teamId: "t1" },
    { id: "r260", appSlug: "checkmyapp-test-r260.example.com", name: "CheckMyApp test r260", ownerId: "owner", teamId: "t1" },
    { id: "r261", appSlug: "checkmyapp-test-r261.example.com", name: "CheckMyApp test r261", ownerId: "owner", teamId: "t1" },
    { id: "r270", appSlug: "checkmyapp-test-r270.example.com", name: "CheckMyApp test r270", ownerId: "owner", teamId: "t1" },
    { id: "cust", appSlug: "joblander.app", name: null, ownerId: "owner", teamId: "t1" },
    { id: "custTest", appSlug: "checkmyapp-test-r200.example.com", name: null, ownerId: "owner", teamId: "t1" },
  ];
  const ledger: Ledger[] = [
    { id: "L113", runId: "run113", appId: "ours", kind: "app", marker: "CheckMyApp test r113", locationUrl: "https://checkmyapp.dev/dashboard?added=checkmyapp-test-r113.example.com", cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 44) },
    // r11's app is already gone: nothing matches, the ledger must still close.
    { id: "L11", runId: "run11", appId: "ours", kind: "app", marker: "CheckMyApp test r11", locationUrl: null, cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 50) },
    // A record of a kind we cannot reach from here stays open — it is real.
    { id: "Lstory", runId: "run113", appId: "ours", kind: "story", marker: "CheckMyApp test r113", locationUrl: null, cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 44) },
    // The same records, worded the way the agent worded them in runs #219 and
    // #242: the kind is the product's own phrase, not the word "app".
    { id: "L219", runId: "run219", appId: "ours", kind: "app (monitored site)", marker: "CheckMyApp test r219", locationUrl: "https://checkmyapp.dev/dashboard/r219", cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 20) },
    { id: "L242", runId: "run242", appId: "ours", kind: "app (daily-watch monitored app)", marker: "CheckMyApp test r242", locationUrl: "https://checkmyapp.dev/dashboard", cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 18) },
    // Only sounds like an app: removed when its app is found, left open when not.
    { id: "L260", runId: "run260", appId: "ours", kind: "extension", marker: "CheckMyApp test r260", locationUrl: "https://checkmyapp.dev/dashboard?added=checkmyapp-test-r260.example.com", cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 10) },
    { id: "L261", runId: "run261", appId: "ours", kind: "extension", marker: "CheckMyApp test r261-x", locationUrl: null, cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 10) },
    // Shares run #113's marker and owner with L113, whose app is removed — but
    // nothing on this row says it is that app, so it is not closed on its word.
    { id: "Lext113", runId: "run113", appId: "ours", kind: "extension", marker: "CheckMyApp test r113", locationUrl: "https://checkmyapp.dev/dashboard/extensions", cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 44) },
    // Another word form of the same idea, located by the app's id.
    { id: "L270", runId: "run270", appId: "ours", kind: "site monitoring", marker: "CheckMyApp test r270", locationUrl: "https://checkmyapp.dev/dashboard/r270", cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 10) },
    // "application" is not an app of ours: a job application is someone's record.
    { id: "Ljob", runId: "run113", appId: "ours", kind: "job application", marker: "CheckMyApp test r113", locationUrl: null, cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 44) },
    // Inside the grace period: the run is still inspectable.
    { id: "Lfresh", runId: "run378", appId: "ours", kind: "app", marker: "CheckMyApp test r378", locationUrl: null, cleanupNote: null, deletedAt: null, createdAt: hoursAgo(1) },
    // A customer's run: not ours, whatever the marker says.
    { id: "Lcust", runId: "runCust", appId: "cust", kind: "app", marker: "CheckMyApp test r200", locationUrl: null, cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 5) },
  ];

  // The shapes of the `where` clauses the sweep and the audit actually send.
  type Where = {
    runId?: string | { not: string };
    appId?: string | { in: string[] };
    id?: { in: string[] };
    deletedAt?: null;
    createdAt?: { lt: Date };
    marker?: { startsWith: string };
    ownerId?: { in: string[] };
    kind?: { contains: string };
    OR?: Array<{ kind?: { contains: string }; appSlug?: { contains: string }; name?: { contains: string } }>;
    run?: { ownerId: { not: null } };
  };
  const contains = (v: string | null, p: string) => (v ?? "").toLowerCase().includes(p.toLowerCase());
  const db = {
    createdResource: {
      findMany: async ({ where }: { where: Where }) =>
        ledger
          .filter((r) => (typeof where.runId === "object" ? r.runId !== where.runId.not : true))
          .filter((r) => (typeof where.runId === "string" ? r.runId === where.runId : true))
          .filter((r) => (typeof where.appId === "string" ? r.appId === where.appId : true))
          .filter((r) => ("deletedAt" in where ? r.deletedAt === where.deletedAt : true))
          .filter((r) => (where.createdAt?.lt ? r.createdAt < where.createdAt.lt : true))
          .filter((r) => (where.marker?.startsWith ? r.marker.startsWith(where.marker.startsWith) : true))
          .filter((r) => (where.kind?.contains ? contains(r.kind, where.kind.contains) : true))
          .filter((r) => (where.OR ? where.OR.some((c) => contains(r.kind, c.kind?.contains ?? "\0")) : true))
          .filter((r) => (where.run ? runs.find((x) => x.id === r.runId)!.ownerId !== null : true))
          .map((r) => ({ ...r, run: runs.find((x) => x.id === r.runId)! })),
      updateMany: async ({ where, data }: { where: Where; data: Partial<Ledger> }) => {
        const hit = ledger.filter((r) => (where.id?.in ? where.id.in.includes(r.id) : typeof where.appId === "object" ? where.appId.in.includes(r.appId ?? "") : false));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    app: {
      findMany: async ({ where }: { where: Where }) =>
        apps.filter(
          (a) =>
            Boolean(where.ownerId?.in.includes(a.ownerId)) &&
            Boolean(where.OR?.some((c) => (c.appSlug ? contains(a.appSlug, c.appSlug.contains) : contains(a.name, c.name?.contains ?? "\0")))),
        ),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in) {
          const i = apps.findIndex((a) => a.id === id);
          if (i >= 0) apps.splice(i, 1);
        }
        return { count: where.id.in.length };
      },
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => runs.find((r) => r.id === where.id) ?? null,
      updateMany: async () => ({ count: 0 }),
    },
    issueLink: { deleteMany: async () => ({ count: 0 }) },
    appSnapshot: { deleteMany: async () => ({ count: 0 }) },
    watch: { deleteMany: async () => ({ count: 0 }) },
    ticketPolicy: { deleteMany: async () => ({ count: 0 }) },
    trackerIntegration: { deleteMany: async () => ({ count: 0 }) },
    repoIntegration: { deleteMany: async () => ({ count: 0 }) },
    testAccount: { deleteMany: async () => ({ count: 0 }) },
  };
  const env = { db, bindings: {} } as unknown as AgentEnv;
  return { env, apps, ledger };
}

// The sweep is cut short between removing the app and closing the row. The
// app is gone, so the next sweep cannot find it; the row must still close.
async function interrupted() {
  const { env, apps, ledger } = build();
  const real = env.db.createdResource.updateMany;
  let armed = true;
  (env.db.createdResource as { updateMany: typeof real }).updateMany = async (args: Parameters<typeof real>[0]) => {
    if (armed && (args.data as { deletedAt?: Date }).deletedAt) throw new Error("ledger write failed");
    return real(args);
  };
  let threw = false;
  await sweepSelfCheckLeftovers(env, NOW).catch(() => { threw = true; });
  const l260 = ledger.find((r) => r.id === "L260")!;
  check("interrupted: the sweep failed at the ledger write", threw);
  check("interrupted: the extension's app is already gone", !apps.some((a) => a.id === "r260"));
  check("interrupted: its row is open and carries the pending note", l260.deletedAt === null && l260.cleanupNote === REMOVAL_PENDING_NOTE);
  check("interrupted: a row with no proof carries no note", ledger.find((r) => r.id === "Lext113")!.cleanupNote === null);
  armed = false;
  await sweepSelfCheckLeftovers(env, NOW);
  check("interrupted: the next sweep closes it though its app can no longer be found", l260.deletedAt !== null);
  check("interrupted: and still leaves the row with no proof open", ledger.find((r) => r.id === "Lext113")!.deletedAt === null);
}

async function main() {
  // The marker must end where a word ends: r11 is not r113.
  check("marker r11 is not found in an r113 slug", !carriesMarker("checkmyapp-test-r113.example.com", "CheckMyApp test r11"));
  check("marker r113 is found in its slug", carriesMarker("checkmyapp-test-r113.example.com", "CheckMyApp test r113"));
  check("marker r113 is found in the app's name", carriesMarker("CheckMyApp test r113", "CheckMyApp test r113"));

  // The kind is judged by its words, not compared to one of them.
  check("kind 'app' names an app", leftoverKind("app") === "app");
  check("kind 'app (monitored site)' names an app", leftoverKind("app (monitored site)") === "app");
  check("kind 'daily-watch monitored app' names an app", leftoverKind("daily-watch monitored app") === "app");
  check("kind 'extension' only sounds like one", leftoverKind("extension") === "app-like");
  for (const k of ["monitoring", "site monitoring", "monitors", "extensions", "watches", "websites"]) {
    check(`kind '${k}' only sounds like an app`, leftoverKind(k) === "app-like");
  }
  check("kind 'job application' is not an app", leftoverKind("job application") === null);
  check("kind 'story' is not an app", leftoverKind("story") === null);

  const { env, apps, ledger } = build();

  // Before: the next run of our own product still sees run #113's record.
  const before = await findOrphans(env, "run378");
  check("before the sweep, a later run is handed run #113's record", before.older >= 1 && before.lines.some((l) => l.includes("CheckMyApp test r113")), before.lines.join(" | "));

  const result = await sweepSelfCheckLeftovers(env, NOW);
  const row = (id: string) => ledger.find((r) => r.id === id)!;

  check("the app the checker registered is removed", !apps.some((a) => a.id === "r113"));
  check("its ledger row is closed, with a note", row("L113").deletedAt !== null && Boolean(row("L113").cleanupNote));
  check("a record whose app is already gone is closed too", row("L11").deletedAt !== null);
  check("the sweep of r11 did not remove r113's neighbour r1130", apps.some((a) => a.id === "r1130"));
  check("another account's app is never removed", apps.some((a) => a.id === "other"));
  check("our own app row survives", apps.some((a) => a.id === "ours"));
  check("a customer's app and test-shaped app survive", apps.some((a) => a.id === "cust") && apps.some((a) => a.id === "custTest"));
  check("a customer's run's ledger row stays open", row("Lcust").deletedAt === null);
  check("a record inside the grace period stays open", row("Lfresh").deletedAt === null);
  check("a record of a kind we cannot reach stays open", row("Lstory").deletedAt === null);
  check("a 'job application' record stays open", row("Ljob").deletedAt === null);
  check("run #219's app, worded 'app (monitored site)', is removed", !apps.some((a) => a.id === "r219"));
  check("its ledger row is closed", row("L219").deletedAt !== null && Boolean(row("L219").cleanupNote));
  check("run #242's 'daily-watch monitored app' row is closed though its app is gone", row("L242").deletedAt !== null);
  check("an extension record whose app was found is removed and closed", !apps.some((a) => a.id === "r260") && row("L260").deletedAt !== null);
  check("an extension record with no app found stays open", row("L261").deletedAt === null);
  check("r261's neighbour app survives r260's sweep", apps.some((a) => a.id === "r261"));
  check("an extension row that shares an app's marker, but does not name the app, stays open", row("Lext113").deletedAt === null);
  check("a 'site monitoring' row whose location names the app is removed and closed", !apps.some((a) => a.id === "r270") && row("L270").deletedAt !== null);
  check("counts: four apps removed, six rows closed", result.appsRemoved === 4 && result.ledgerClosed === 6, JSON.stringify(result));

  // After: the same later run is handed only what is really still there.
  const after = await findOrphans(env, "run378");
  check("after the sweep, run #113's app is no longer reported", !after.lines.some((l) => l.startsWith('app "CheckMyApp test r113"')), after.lines.join(" | "));

  const again = await sweepSelfCheckLeftovers(env, NOW);
  check("a second sweep changes nothing", again.appsRemoved === 0 && again.ledgerClosed === 0, JSON.stringify(again));
}

// The ledger at real size. 250 open rows, older than the one that is ours, all
// of them rows the sweep must leave alone: a customer's run (kind "app", a
// marker, an owner — everything but our own host) and records of another kind.
// A sweep that reads only the first batch of 200 sees none of ours and closes
// nothing, every tick, for as long as those rows stay open.
async function atRealSize() {
  const real = await realD1();
  try {
    const { db } = real;
    const day = (d: number) => new Date(Date.UTC(2026, 8, d, 10));
    await db.user.create({ data: { id: "u", clerkUserId: "ck_u", email: "leftovers@example.test" } });
    await db.team.create({ data: { id: "t", name: "T", plan: "business" } });
    const app = (id: string, appSlug: string, over: object = {}) => ({ id, teamId: "t", ownerId: "u", appSlug, targetUrl: `https://${appSlug}`, targetKind: "website", ...over });
    await db.app.createMany({
      data: [
        app("ours", "checkmyapp.dev"),
        app("cust", "joblander.app"),
        app("leftA", "checkmyapp-test-r900.example.com"),
        // Named as the agent liked, not starting with the marker; its slug is
        // not marker-shaped at all.
        app("leftB", "shop.example.com", { name: "My CheckMyApp test r901" }),
        app("leftC", "checkmyapp-test-r902.example.com", { name: "CheckMyApp test r902" }),
        app("keep", "checkmyapp-test-r9000.example.com"),
        app("leftD", "checkmyapp-test-r903.example.com"),
      ] as never,
    });
    const run = (id: string, n: number, appId: string, targetUrl: string) => ({
      id, publicId: `p_${id}`, runNumber: n, teamId: "t", ownerId: "u", appId, appSlug: `${appId}.test`, targetUrl, targetKind: "website",
      status: "completed", verdict: "mostly_ok", priceUsd: 0.5, startedAt: day(1), createdAt: day(1), completedAt: day(1),
    });
    await db.run.createMany({
      data: [
        run("rCust", 1, "cust", "https://joblander.app"),
        run("rA", 2, "ours", "https://checkmyapp.dev"),
        run("rB", 3, "ours", "https://checkmyapp.dev"),
        run("rC", 4, "ours", "https://checkmyapp.dev"),
      ] as never,
    });
    const row = (id: string, runId: string, kind: string, marker: string, d: Date, locationUrl: string | null = null) => ({ id, runId, kind, marker, createdAt: d, locationUrl });
    const ineligible = Array.from({ length: 250 }, (_, i) =>
      i % 5 === 0 ? row(`n${i}`, "rA", "story", `CheckMyApp test r${i}`, day(2)) : row(`n${i}`, "rCust", "app", `CheckMyApp test r${i}`, day(2)),
    );
    await db.createdResource.createMany({
      data: [...ineligible, row("eA", "rA", "app", "CheckMyApp test r900", day(3)), row("eB", "rB", "app", "CheckMyApp test r901", day(3)), row("eC", "rC", "app (monitored site)", "CheckMyApp test r902", day(3)),
        // One run, one marker, two records: the one that names the app is closed with it.
        row("eD", "rC", "site monitoring", "CheckMyApp test r903", day(3), "https://checkmyapp.dev/dashboard/leftD"),
        row("eE", "rC", "extension", "CheckMyApp test r903", day(3))],
    });

    const env = { db, bindings: {} } as unknown as AgentEnv;
    const open = (id: string) => db.createdResource.findUnique({ where: { id }, select: { deletedAt: true } }).then((r) => r?.deletedAt ?? null);
    const stillThere = async (id: string) => (await db.app.findUnique({ where: { id }, select: { id: true } })) !== null;

    const result = await sweepSelfCheckLeftovers(env, NOW);
    check("real D1: 250 rows of someone else's sort before ours, and ours is still found", (await open("eA")) !== null && (await open("eB")) !== null, JSON.stringify(result));
    check("real D1: the apps of those rows are removed", !(await stillThere("leftA")) && !(await stillThere("leftB")));
    check("real D1: a row worded 'app (monitored site)' is found and its app removed", (await open("eC")) !== null && !(await stillThere("leftC")));
    check("real D1: an app named around the marker, not starting with it, is removed", !(await stillThere("leftB")));
    check("real D1: r900 does not take r9000 with it", await stillThere("keep"));
    check("real D1: our own app and a customer's survive", (await stillThere("ours")) && (await stillThere("cust")));
    const stillOpen = await db.createdResource.count({ where: { id: { startsWith: "n" }, deletedAt: null } });
    check("real D1: none of the 250 rows that are not ours was closed", stillOpen === 250, `${stillOpen} open`);
    check("real D1: a 'site monitoring' row that names its app closes with it", (await open("eD")) !== null && !(await stillThere("leftD")));
    check("real D1: a row sharing its marker without naming the app stays open", (await open("eE")) === null);
    check("real D1: counts: four apps removed, four rows closed", result.appsRemoved === 4 && result.ledgerClosed === 4, JSON.stringify(result));
    const again = await sweepSelfCheckLeftovers(env, NOW);
    check("real D1: a second sweep changes nothing", again.appsRemoved === 0 && again.ledgerClosed === 0, JSON.stringify(again));
  } finally {
    await real.dispose();
  }
}

main().then(interrupted).then(atRealSize).then(
  () => {
    console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
