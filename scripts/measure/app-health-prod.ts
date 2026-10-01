// What appHealth (src/lib/app-health.ts, CHE-353) says about a real team, and
// whether plain SQL over the same rows agrees.
//
// The module's rules are asserted on a fixture by scripts/verify-app-health.ts.
// This answers the other half of the ticket: on production, for a real team,
// does it say what the rows say? Two independent paths, side by side:
//
//   module — the real appHealth, fed the team's rows (Team, App, Run and, for
//            the price explanations, Journey / Step / LlmUsage) through the
//            in-memory client from scripts/fixtures/mcp-db.ts, with every
//            DateTime as the text D1 holds, compared and ordered as text
//            (scripts/verify-app-health.ts holds that client to a real local D1);
//   sql    — one aggregate query written straight from the rules in the
//            module's header (same window, same attribution), run by D1.
//
// Any row where the two differ is printed as a MISMATCH and the exit code is 1.
//
// Reads production through the wrangler CLI and writes nothing — d1() refuses
// any statement that is not a SELECT. A git worktree has no .env: export
// CLOUDFLARE_API_TOKEN first, or run it from a checkout that has one.
//
// Usage:
//   npx tsx --tsconfig tsconfig.json scripts/measure/app-health-prod.ts --app-slug joblander.app
//   … --team <teamId>     the team directly
//   … --days 30           the window (default 30)
//   … --local             the local D1 replica instead of prod

import { execFileSync } from "node:child_process";
import { createStubDb } from "../fixtures/mcp-db";
import { appHealth } from "../../src/lib/app-health";
import { utcDayStart } from "../../src/lib/plans";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const LOCAL = args.includes("--local");
const DAYS = Number(flag("--days") ?? 30);

function d1<T = Record<string, unknown>>(sql: string): T[] {
  if (!/^\s*select\b/i.test(sql)) throw new Error("this script only reads");
  const argv = ["wrangler", "d1", "execute", "checkmyapp", LOCAL ? "--local" : "--remote", "--json", "--command", sql];
  let out: string;
  try {
    out = execFileSync("npx", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`wrangler d1 execute failed: ${(e.stdout ?? "").trim() || (e.stderr ?? "").trim() || e.message}`);
  }
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`no JSON in wrangler output: ${out.slice(0, 200)}`);
  const first = JSON.parse(out.slice(start))[0];
  if (!first || first.success === false) throw new Error(`query failed: ${JSON.stringify(first).slice(0, 300)}`);
  return first.results as T[];
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
// Rows go in exactly as D1 returned them: a DateTime is TEXT, in either of its
// two spellings, and the in-memory client compares and orders it as that text,
// as D1 does (CHE-382). Parsing it here would test a friendlier database than
// the one in production.
const rows = (sql: string) => d1(sql);

const teamId =
  flag("--team") ??
  d1<{ teamId: string }>(`SELECT teamId FROM Run WHERE appSlug = ${q(flag("--app-slug") ?? "")} AND teamId IS NOT NULL GROUP BY teamId`)
    .map((r) => r.teamId)
    .find(Boolean);
if (!teamId) {
  console.error("name a team: --team <id> or --app-slug <a host the team checks>");
  process.exit(2);
}

const now = new Date();
// The module's window: the last DAYS UTC days, today included, from midnight
// to the next one. A YYYY-MM-DD prefix sorts correctly against both spellings
// of createdAt.
const sinceDay = new Date(utcDayStart(now).getTime() - (DAYS - 1) * 86400000).toISOString().slice(0, 10);
const untilDay = new Date(utcDayStart(now).getTime() + 86400000).toISOString().slice(0, 10);
const ofTeam = `SELECT id FROM Run WHERE teamId = ${q(teamId)}`;

async function main() {
  const team = d1(`SELECT id, plan FROM Team WHERE id = ${q(teamId!)}`);
  const app = rows(`SELECT id, teamId, appSlug, targetKind, createdAt FROM App WHERE teamId = ${q(teamId!)}`);
  const run = rows(
    `SELECT id, publicId, runNumber, teamId, appId, appSlug, targetKind, status, verdict, watchId, priceUsd,
            priceFromTopupUsd, quickPagesOpened, costUsd, createdAt, completedAt
       FROM Run WHERE teamId = ${q(teamId!)}`,
  );
  const journey = rows(`SELECT id, runId, "order", title, carriedFromRunId FROM Journey WHERE runId IN (${ofTeam})`);
  const step = rows(
    `SELECT s.id, s.journeyId, s.status FROM Step s JOIN Journey j ON j.id = s.journeyId WHERE j.runId IN (${ofTeam})`,
  );
  const llmUsage = rows(`SELECT id, runId, phase, journeyId, costUsd FROM LlmUsage WHERE runId IN (${ofTeam})`);
  const { db } = createStubDb({ team, app, run, journey, step, llmUsage });

  const report = await appHealth(db, teamId!, { days: DAYS, now });

  // The same numbers, by SQL alone: a run belongs to its appId, else to the
  // team's one app with its host.
  const sql = d1<{ appId: string | null; usd: number; checks: number; sched_n: number; sched_usd: number }>(`
    SELECT COALESCE(r.appId, solo.id) appId,
           ROUND(SUM(COALESCE(r.priceUsd, 0)), 2) usd, COUNT(*) checks,
           SUM(r.watchId IS NOT NULL) sched_n,
           ROUND(SUM(CASE WHEN r.watchId IS NOT NULL THEN COALESCE(r.priceUsd, 0) ELSE 0 END), 2) sched_usd
      FROM Run r
      LEFT JOIN (SELECT appSlug, MIN(id) id FROM App WHERE teamId = ${q(teamId!)} GROUP BY appSlug HAVING COUNT(*) = 1) solo
        ON r.appId IS NULL AND solo.appSlug = r.appSlug
     WHERE r.teamId = ${q(teamId!)} AND r.createdAt >= ${q(sinceDay)} AND r.createdAt < ${q(untilDay)}
     GROUP BY COALESCE(r.appId, solo.id)`);
  const bySql = new Map(sql.map((r) => [r.appId, r]));
  const sqlTotal = Math.round(sql.reduce((s, r) => s + r.usd * 100, 0)) / 100;

  console.log(`team ${teamId} · plan ${team[0]?.plan} · ${DAYS} days from ${sinceDay} to ${now.toISOString()}\n`);
  const table = report.apps.map((a) => {
    const s = bySql.get(a.appId);
    const agree =
      (s?.usd ?? 0) === a.spendUsd && (s?.checks ?? 0) === a.checks &&
      (s?.sched_n ?? 0) === a.scheduled.count && (s?.sched_usd ?? 0) === a.scheduled.usd;
    return {
      app: a.appSlug,
      spend: a.spendUsd,
      checks: a.checks,
      scheduled: `${a.scheduled.count} / ${a.scheduled.usd.toFixed(2)}`,
      onRequest: `${a.onRequest.count} / ${a.onRequest.usd.toFixed(2)}`,
      perDay: a.perDayUsd,
      latest: a.latest ? `#${a.latest.runNumber} ${a.latest.verdict} $${a.latest.priceUsd.toFixed(2)}` : "—",
      strip: a.verdicts.length,
      sql: s ? `${s.usd} / ${s.checks} (${s.sched_n} / ${s.sched_usd})` : "0 / 0",
      agree: agree ? "yes" : "MISMATCH",
    };
  });
  console.table(table);
  const unowned = bySql.get(null);
  console.log(`total ${report.totalSpendUsd} (sql ${sqlTotal})` +
    (unowned ? ` — of which ${unowned.usd} over ${unowned.checks} checks belongs to no app` : ""));
  console.log(`per day ${report.perDayUsd} · a month at this rate ${report.monthlyRunRateUsd} · the plan covers it ${report.planCoversTimes ?? "—"} times`);
  for (const a of report.apps.filter((x) => x.latest)) {
    console.log(`  ${a.appSlug} latest: ${a.latest!.price.work} — ${a.latest!.price.comparison ?? "no usual yet"}`);
  }

  const bad = table.filter((t) => t.agree !== "yes").length + (report.totalSpendUsd === sqlTotal ? 0 : 1);
  console.log(bad === 0 ? "\nmodule and SQL agree" : `\n${bad} MISMATCH`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("app-health-prod: crashed:", err);
  process.exit(1);
});
