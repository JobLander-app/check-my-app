// Pricing hypotheses (CHE-327): is the dollar balance working?
//
// The model shipped 2026-09-28 as a set of guesses the owner said we cannot
// know in advance: that a per-check price with a plan-sized monthly credit is
// flexible enough, that people who run out top up or upgrade rather than
// leave, and that "why did this one cost $0.88?" is answered by the work the
// check did. This file turns each guess into a number, recomputed on demand,
// so a later answer can be compared with an earlier one.
//
// scripts/measure/ is for numbers about the business rather than checks on the
// code (see gate-ready-supply.ts for the conventions this follows): the
// question, the rule and the query travel together here.
//
// Reads production through the wrangler CLI and writes nothing — d1() refuses
// any statement that is not a SELECT. Credentials come from wrangler's own
// resolution (CLOUDFLARE_API_TOKEN from the untracked .env); a git worktree has
// no .env, so run it from a checkout that does, or export the token first.
//
// Usage:
//   npx tsx --tsconfig tsconfig.json scripts/measure/pricing-hypotheses.ts
//   npx tsx --tsconfig tsconfig.json scripts/measure/pricing-hypotheses.ts --since 2026-09-01 --until 2026-10-31
//   … --local     the local D1 replica instead of prod
//   … --json
//
// ─── Who is counted ──────────────────────────────────────────────────────────
//
// Our own apps never enter a customer number (CLAUDE.md §6): a run whose target
// is one of our hosts (isSelfHost, the predicate the silence gate reads) or
// whose owner is a test account is left out of every line below. Anonymous runs
// belong to no balance and are left out too. What remains is "not us" — which
// today is still mostly the owner's own teams (see gate-ready-supply.ts on why
// that is not a customer count); the report prints the teams so nobody quotes
// it as one.
//
// ─── The questions ───────────────────────────────────────────────────────────
//
//   1. Price distribution — per plan and per app: checks, quick-check share,
//      p50 / p90 / max price. Is "typically $X–$Y" still true?
//   2. Monthly spend vs credit per team: what share of the credit a team uses.
//      A plan whose teams all use 10% is priced wrong in one direction; one
//      whose teams all run out in week two, in the other.
//   3. Running out, and what happened within 7 days: a top-up (BalanceTopUp),
//      or nothing visible in D1. Upgrades are not historized in D1 — the join is
//      PostHog's: `balance_exhausted` → `checkout_completed` on the same teamId.
//      "Ran out" is read from D1 as the first moment a team's priced checks in
//      the window reached its credit plus what it had topped up by then.
//   4. What the balance is spent on: scheduled (watch) vs agent (mcp) vs api vs
//      ui, by Run.startedVia (null on runs older than CHE-327).
//   5. Does the explanation explain? Per app, the correlation between a check's
//      price and the journeys / steps it walked. A high r means "walked 7
//      journeys, 48 steps" is the reason for the price; a low one means the
//      work summary is not what drives it and the explanation needs more.

import { execFileSync } from "node:child_process";
import { isSelfHost } from "../../src/agent/self-hosts";
import { PLAN_LIMITS, SMOKE_COST_USD } from "../../src/lib/plans";
import type { UserPlan } from "../../src/lib/enums";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const LOCAL = args.includes("--local");
const JSON_OUT = args.includes("--json");
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const SINCE = flag("--since") ?? daysAgo(30);
const UNTIL = flag("--until") ?? today;
for (const [name, value] of [["--since", SINCE], ["--until", UNTIL]] as const) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    console.error(`${name} must be YYYY-MM-DD, got "${value}"`);
    process.exit(2);
  }
}

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

// Same string-comparison window as gate-ready-supply.ts (createdAt is TEXT in
// two spellings, both sorting correctly against a YYYY-MM-DD prefix).
const WINDOW = (t = "") => `${t}createdAt >= '${SINCE}' AND ${t}createdAt < '${UNTIL}Z'`;

interface RunRow {
  id: string;
  teamId: string;
  plan: string;
  teamName: string;
  appSlug: string;
  ownerId: string | null;
  status: string;
  costUsd: number | null;
  priceUsd: number | null;
  startedVia: string | null;
  createdAt: string;
  journeys: number;
  steps: number;
}

const runs = d1<RunRow>(
  `SELECT r.id, r.teamId, t.plan, t.name AS teamName, r.appSlug, r.ownerId, r.status, r.costUsd, r.priceUsd, ` +
    `r.startedVia, r.createdAt, ` +
    `(SELECT COUNT(*) FROM Journey j WHERE j.runId = r.id AND j.carriedFromRunId IS NULL) AS journeys, ` +
    `(SELECT COUNT(*) FROM Step s JOIN Journey j ON j.id = s.journeyId WHERE j.runId = r.id AND j.carriedFromRunId IS NULL AND s.status <> 'skipped') AS steps ` +
    `FROM Run r JOIN Team t ON t.id = r.teamId WHERE r.priceUsd IS NOT NULL AND ${WINDOW("r.")}`,
);
const testAccounts = new Set(d1<{ id: string }>(`SELECT id FROM User WHERE isTestAccount = 1`).map((u) => u.id));
const topUps = d1<{ teamId: string; amountUsd: number; createdAt: string }>(
  `SELECT teamId, amountUsd, createdAt FROM BalanceTopUp WHERE credited = 1`,
);

// Our own apps and test accounts never enter these numbers (CLAUDE.md §6).
const counted = runs.filter(
  (r) => !isSelfHost(r.appSlug, process.env.SELF_CHECK_HOSTS) && !(r.ownerId && testAccounts.has(r.ownerId)),
);
const excluded = runs.length - counted.length;

const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const money = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((100 * n) / d)}%`);
const isQuick = (r: RunRow) => r.journeys === 0 && (r.costUsd ?? 0) <= SMOKE_COST_USD * 1.1;
const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};
const pearson = (xs: number[], ys: number[]) => {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
};

// 1 — price distribution.
const distribution = (rows: RunRow[]) => {
  const priced = rows.filter((r) => r.status !== "failed" && r.status !== "canceled");
  const prices = priced.map((r) => r.priceUsd ?? 0);
  return {
    checks: priced.length,
    quickShare: pct(priced.filter(isQuick).length, priced.length),
    p50: quantile(prices, 0.5),
    p90: quantile(prices, 0.9),
    max: prices.length ? Math.max(...prices) : null,
    total: prices.reduce((s, p) => s + p, 0),
  };
};
const byPlan = [...groupBy(counted, (r) => r.plan)].map(([plan, rows]) => ({ plan, ...distribution(rows) }));
const byApp = [...groupBy(counted, (r) => r.appSlug)].map(([app, rows]) => ({ app, ...distribution(rows) }));

// 2 — monthly spend vs credit per team.
const month = (s: string) => s.slice(0, 7);
const spend = [...groupBy(counted, (r) => `${r.teamId}|${month(r.createdAt)}`)].map(([key, rows]) => {
  const [teamId, m] = key.split("|");
  const plan = rows[0].plan as UserPlan;
  const credit = PLAN_LIMITS[plan]?.creditUsd ?? null;
  const spent = rows.reduce((s, r) => s + (r.priceUsd ?? 0), 0);
  return { team: rows[0].teamName, teamId, plan, month: m, spent, credit, share: credit ? spent / credit : null };
});

// 3 — running out, and the next 7 days.
const ranOut = [...groupBy(counted, (r) => r.teamId)].flatMap(([teamId, rows]) => {
  const plan = rows[0].plan as UserPlan;
  const credit = PLAN_LIMITS[plan]?.creditUsd;
  if (credit === null || credit === undefined) return [];
  let spent = 0;
  for (const r of [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    spent += r.priceUsd ?? 0;
    const bought = topUps.filter((t) => t.teamId === teamId && t.createdAt <= r.createdAt).reduce((s, t) => s + t.amountUsd, 0);
    if (spent >= credit + bought) {
      const at = r.createdAt;
      const until = new Date(Date.parse(at.replace(" ", "T")) + 7 * 86400000).toISOString();
      const topped = topUps.some((t) => t.teamId === teamId && t.createdAt > at && t.createdAt <= until);
      return [{ team: rows[0].teamName, plan, at, within7d: topped ? "top-up" : "nothing in D1 (check PostHog for an upgrade)" }];
    }
  }
  return [];
});

// 4 — what the balance is spent on.
const bySource = [...groupBy(counted, (r) => r.startedVia ?? "(before CHE-327)")].map(([source, rows]) => ({
  source,
  checks: rows.length,
  spent: rows.reduce((s, r) => s + (r.priceUsd ?? 0), 0),
}));
const totalSpent = bySource.reduce((s, x) => s + x.spent, 0);

// 5 — does the work explain the price?
const explains = [...groupBy(counted.filter((r) => !isQuick(r) && r.status !== "failed"), (r) => r.appSlug)].map(([app, rows]) => ({
  app,
  checks: rows.length,
  rJourneys: pearson(rows.map((r) => r.journeys), rows.map((r) => r.priceUsd ?? 0)),
  rSteps: pearson(rows.map((r) => r.steps), rows.map((r) => r.priceUsd ?? 0)),
}));

if (JSON_OUT) {
  console.log(JSON.stringify({ window: { since: SINCE, until: UNTIL }, excluded, byPlan, byApp, spend, ranOut, bySource, explains }, null, 2));
} else {
  const r2 = (n: number | null) => (n === null ? "—" : n.toFixed(2));
  console.log(`## Pricing hypotheses, ${SINCE} → ${UNTIL}\n`);
  console.log(`${counted.length} priced checks counted; ${excluded} left out (our own hosts, test accounts).\n`);
  console.log(`### 1. Price per check\n\n| plan | checks | quick | p50 | p90 | max | total |\n|---|---:|---:|---:|---:|---:|---:|`);
  for (const p of byPlan) console.log(`| ${p.plan} | ${p.checks} | ${p.quickShare} | ${money(p.p50)} | ${money(p.p90)} | ${money(p.max)} | ${money(p.total)} |`);
  console.log(`\n| app | checks | quick | p50 | p90 | max | total |\n|---|---:|---:|---:|---:|---:|---:|`);
  for (const a of byApp.sort((x, y) => y.total - x.total)) console.log(`| ${a.app} | ${a.checks} | ${a.quickShare} | ${money(a.p50)} | ${money(a.p90)} | ${money(a.max)} | ${money(a.total)} |`);
  console.log(`\n### 2. Monthly spend vs credit\n\n| team | plan | month | spent | credit | used |\n|---|---|---|---:|---:|---:|`);
  for (const s of spend) console.log(`| ${s.team} | ${s.plan} | ${s.month} | ${money(s.spent)} | ${s.credit === null ? "unlimited" : money(s.credit)} | ${s.share === null ? "—" : pct(s.share, 1)} |`);
  console.log(`\n### 3. Ran out, and the next 7 days\n`);
  if (ranOut.length === 0) console.log("No counted team ran out in this window.");
  for (const o of ranOut) console.log(`- ${o.team} (${o.plan}) ran out ${o.at.slice(0, 16)} → ${o.within7d}`);
  console.log(`\n### 4. What the balance is spent on\n\n| started via | checks | spent | share |\n|---|---:|---:|---:|`);
  for (const s of bySource.sort((a, b) => b.spent - a.spent)) console.log(`| ${s.source} | ${s.checks} | ${money(s.spent)} | ${pct(s.spent, totalSpent)} |`);
  console.log(`\n### 5. Does the work explain the price? (Pearson r, walking checks)\n\n| app | checks | r(price, journeys) | r(price, steps) |\n|---|---:|---:|---:|`);
  for (const e of explains) console.log(`| ${e.app} | ${e.checks} | ${r2(e.rJourneys)} | ${r2(e.rSteps)} |`);
}
