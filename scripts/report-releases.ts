// CHE-367: what the Release lens would show a team today, read from production
// D1 through wrangler (SELECT only) and computed by the same code the product
// runs (src/lib/releases.ts: releaseInputs → computeReleases).
//
// Usage (CLOUDFLARE_API_TOKEN exported):
//   npx tsx --tsconfig tsconfig.json scripts/report-releases.ts <teamId> [days]

import { execFileSync } from "node:child_process";
import { computeReleases, releaseInputs, type ReleaseRow } from "@/lib/releases";

function query<T>(sql: string): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "checkmyapp", "--remote", "--json", "--command", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out)[0].results as T[];
}

const teamId = process.argv[2];
const days = Number(process.argv[3] ?? 30);
if (!teamId || !/^[a-z0-9_]+$/i.test(teamId)) throw new Error("usage: report-releases.ts <teamId> [days]");

const apps = query<{ id: string; appSlug: string }>(`SELECT id, appSlug FROM App WHERE teamId = '${teamId}'`);
const runs = query<Omit<ReleaseRow, "journeys" | "findings" | "ephemeral" | "completedAt"> & { id: string; ephemeral: number; completedAt: string | null }>(
  `SELECT id, publicId, runNumber, appId, appSlug, targetKind, deploySha, deployEnv, ephemeral, status, verdict, priceUsd, completedAt
   FROM Run WHERE teamId = '${teamId}' AND deploySha IS NOT NULL AND status IN ('completed','partial') ORDER BY runNumber`,
);
const ids = runs.map((r) => `'${r.id}'`).join(",") || "''";
const journeys = query<ReleaseRow["journeys"][number] & { id: string; runId: string; order: number }>(
  `SELECT id, runId, "order", appJourneyId, journeyKey, title, carriedFromRunId, status FROM Journey WHERE runId IN (${ids}) ORDER BY runId, "order"`,
);
const jids = journeys.map((j) => `'${j.id}'`).join(",") || "''";
const steps = query<{ journeyId: string; order: number; status: string; actions: string | null }>(
  `SELECT journeyId, "order", status, actions FROM Step WHERE journeyId IN (${jids}) ORDER BY journeyId, "order"`,
);
let findings: Array<ReleaseRow["findings"][number] & { runId: string; number: number }>;
const cols = `id, runId, number, title, category, severity, mark, detail, anchor`;
try {
  findings = query(`SELECT ${cols}, signature FROM Finding WHERE runId IN (${ids}) ORDER BY runId, number`);
} catch {
  // Before migration 0053 reaches prod the column does not exist.
  findings = query<Omit<(typeof findings)[number], "signature">>(`SELECT ${cols} FROM Finding WHERE runId IN (${ids}) ORDER BY runId, number`)
    .map((f) => ({ ...f, signature: null }));
}

const rows: ReleaseRow[] = runs.map((r) => ({
  ...r,
  ephemeral: Boolean(r.ephemeral),
  completedAt: r.completedAt ? new Date(r.completedAt) : null,
  journeys: journeys
    .filter((j) => j.runId === r.id)
    .map((j) => ({ ...j, steps: steps.filter((s) => s.journeyId === j.id).map((s) => ({ status: s.status, actions: s.actions })) })),
  findings: findings.filter((f) => f.runId === r.id),
}));

const now = new Date();
const since = new Date(now.getTime() - days * 86_400_000);
const all = computeReleases(releaseInputs(rows, apps));
console.log(`runs with a deploy sha in this team: ${runs.length} · releases of the team's apps: ${all.length} · in the last ${days} days: ` +
  `${all.filter((r) => r.completedAt && r.completedAt >= since).length}`);
for (const r of all) {
  const inWindow = r.completedAt && r.completedAt >= since ? "" : "  (outside the window)";
  console.log(`\n#${r.runNumber} ${r.appSlug} · ${r.env} · ${r.sha.slice(0, 7)} · ${r.verdict} · $${r.priceUsd ?? "—"} · ${r.completedAt?.toISOString()}${inWindow}`);
  if (r.firstRelease) {
    console.log("   first release we checked");
    continue;
  }
  console.log(`   vs #${r.previous!.runNumber} (${r.previous!.sha.slice(0, 7)})`);
  for (const k of ["broke", "fixed", "unchanged", "notCompared"] as const) {
    for (const i of r.delta![k]) console.log(`   ${k.padEnd(11)} [${i.audience}] ${i.title}`);
  }
  console.log(`   summary ${JSON.stringify(r.summary)}`);
}
