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
// against an in-memory database that evaluates the `where` clauses used.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-self-check-leftovers.ts

import { findOrphans } from "@/agent/cleanup";
import { carriesMarker, sweepSelfCheckLeftovers } from "@/agent/janitor";
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
    { id: "runCust", appId: "cust", runNumber: 200, targetUrl: "https://joblander.app", ownerId: "owner", teamId: "t1" },
  ];
  const apps: AppRow[] = [
    { id: "ours", appSlug: "checkmyapp.dev", name: null, ownerId: "owner", teamId: "t1" },
    { id: "r113", appSlug: "checkmyapp-test-r113.example.com", name: "CheckMyApp test r113", ownerId: "owner", teamId: "t1" },
    // Same prefix, another run's marker: must survive the sweep of r11.
    { id: "r1130", appSlug: "checkmyapp-test-r1130.example.com", name: null, ownerId: "owner", teamId: "t1" },
    // Someone else's app that happens to carry r113 in its name.
    { id: "other", appSlug: "checkmyapp-test-r113.example.org", name: null, ownerId: "stranger", teamId: "t9" },
    { id: "cust", appSlug: "joblander.app", name: null, ownerId: "owner", teamId: "t1" },
    { id: "custTest", appSlug: "checkmyapp-test-r200.example.com", name: null, ownerId: "owner", teamId: "t1" },
  ];
  const ledger: Ledger[] = [
    { id: "L113", runId: "run113", appId: "ours", kind: "app", marker: "CheckMyApp test r113", locationUrl: "https://checkmyapp.dev/dashboard?added=checkmyapp-test-r113.example.com", cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 44) },
    // r11's app is already gone: nothing matches, the ledger must still close.
    { id: "L11", runId: "run11", appId: "ours", kind: "app", marker: "CheckMyApp test r11", locationUrl: null, cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 50) },
    // A record of a kind we cannot reach from here stays open — it is real.
    { id: "Lstory", runId: "run113", appId: "ours", kind: "story", marker: "CheckMyApp test r113", locationUrl: null, cleanupNote: null, deletedAt: null, createdAt: hoursAgo(24 * 44) },
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
    OR?: Array<{ appSlug?: { startsWith: string }; name?: { startsWith: string } }>;
  };
  const startsWith = (v: string | null, p: string) => (v ?? "").toLowerCase().startsWith(p.toLowerCase());
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
            Boolean(where.OR?.some((c) => (c.appSlug ? startsWith(a.appSlug, c.appSlug.startsWith) : startsWith(a.name, c.name?.startsWith ?? "\0")))),
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

async function main() {
  // The marker must end where a word ends: r11 is not r113.
  check("marker r11 is not found in an r113 slug", !carriesMarker("checkmyapp-test-r113.example.com", "CheckMyApp test r11"));
  check("marker r113 is found in its slug", carriesMarker("checkmyapp-test-r113.example.com", "CheckMyApp test r113"));
  check("marker r113 is found in the app's name", carriesMarker("CheckMyApp test r113", "CheckMyApp test r113"));

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
  check("counts: one app removed, two rows closed", result.appsRemoved === 1 && result.ledgerClosed === 2, JSON.stringify(result));

  // After: the same later run is handed only what is really still there.
  const after = await findOrphans(env, "run378");
  check("after the sweep, run #113's app is no longer reported", !after.lines.some((l) => l.startsWith('app "CheckMyApp test r113"')), after.lines.join(" | "));

  const again = await sweepSelfCheckLeftovers(env, NOW);
  check("a second sweep changes nothing", again.appsRemoved === 0 && again.ledgerClosed === 0, JSON.stringify(again));
}

main().then(
  () => {
    console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
