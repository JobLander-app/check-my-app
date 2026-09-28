// Run-cost trend (CHE-131): ¢ per walked journey and $ per run, by app and by
// run number.
//
// COSTS.md carries fleet averages and single A/B runs, and every hypothesis
// about run economics ("vision costs 2.5× on full walks", "E3 did not
// generalize") has been argued from one of those. None of them is testable
// against the question that matters — is the SAME app getting cheaper run
// after run? — because nobody has ever joined Run, Journey and LlmUsage per
// app in run order. The rows exist in production D1; this script joins them.
//
// Reads production through the wrangler CLI (this machine is authenticated;
// there is deliberately no other credential path), so it does not run in CI.
// It writes nothing.
//
// Usage:
//   npm run cost:trend                     # Markdown to stdout, since 2026-08-16
//   npm run cost:trend -- --since 2026-08-25 --app joblander.app
//   npm run cost:trend -- --local          # the local D1 replica instead of prod
//   node scripts/cost-trend.mjs --json     # the derived rows instead of Markdown
//     (straight through node: npm run prints its banner ahead of the JSON)

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const SINCE = flag("--since") ?? "2026-08-16";
const APP = flag("--app");
const LOCAL = args.includes("--local");
const JSON_OUT = args.includes("--json");

// SINCE is interpolated into SQL (wrangler's d1 execute takes no parameters),
// so it is the one input that must be shaped before it gets there. --app is
// applied in JS and never reaches SQL.
if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) {
  console.error(`--since must be YYYY-MM-DD, got "${SINCE}"`);
  process.exit(2);
}

// ─── The glm era starts here ─────────────────────────────────────────────────
// Runs before 2026-08-16 were Sonnet/Opus navigation with no LlmUsage rows at
// all; the ¢/journey metric (CHE-58) is defined on the ledger and starts with
// it. The default --since is that date, not "everything".

// Self-check placeholders (CLAUDE.md rule 6): apps the self-check registers
// and the janitor removes. They cost real money, so they stay in the fleet
// totals, but a per-app trend for a throwaway target means nothing.
const PLACEHOLDER = /^(example\.com|your-app\.com|.*\.example\.com|test-app-.*)$/;
const WATCHED = ["checkmyapp.dev", "joblander.app", "meetbashar.com"];

// ─── D1 access ───────────────────────────────────────────────────────────────

function d1(sql) {
  const argv = [
    "wrangler",
    "d1",
    "execute",
    "checkmyapp",
    LOCAL ? "--local" : "--remote",
    "--json",
    "--command",
    sql,
  ];
  let out;
  try {
    out = execFileSync("npx", argv, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // With --json wrangler reports its own failures as JSON on stdout and a
    // non-zero exit; surface the text instead of a bare exit code.
    const text = (err.stdout || "").trim() || (err.stderr || "").trim() || err.message;
    throw new Error(`wrangler d1 execute failed: ${text}`);
  }
  // Update nags and warnings can precede the JSON; the payload starts at the
  // first bracket.
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`no JSON in wrangler output: ${out.slice(0, 200)}`);
  const parsed = JSON.parse(out.slice(start));
  const first = parsed[0];
  if (!first || first.success === false) {
    throw new Error(`query failed: ${JSON.stringify(first ?? parsed).slice(0, 300)}`);
  }
  return first.results;
}

// createdAt is TEXT in D1 and appears in two spellings: Prisma's ISO
// ("2026-08-25T21:47:26.000+00:00") and a plain SQL one ("2026-08-25 21:47:26",
// from rows updated by hand). Both compare correctly as strings against a
// YYYY-MM-DD prefix, which is why the WHERE below is a string comparison.
const runRows = d1(
  `SELECT id, runNumber, appSlug, status, costUsd, forceFull, watchId, ` +
    `baselineRunId, createdAt, completedAt FROM Run WHERE createdAt >= '${SINCE}' ORDER BY runNumber`,
);
const journeyRows = d1(
  `SELECT runId, sum(carriedFromRunId IS NULL) AS walked, sum(carriedFromRunId IS NOT NULL) AS carried ` +
    `FROM Journey WHERE runId IN (SELECT id FROM Run WHERE createdAt >= '${SINCE}') GROUP BY runId`,
);
const usageRows = d1(
  `SELECT runId, phase, journeyId, model, inputTokens, cacheWriteTokens, cacheReadTokens, ` +
    `outputTokens, iterations, costUsd FROM LlmUsage ` +
    `WHERE runId IN (SELECT id FROM Run WHERE createdAt >= '${SINCE}')`,
);
// Journey.replayStatus lands with CHE-129, in parallel with this script. Until
// that migration is deployed the column does not exist and this query fails;
// the audit section says so instead of the whole report dying.
let replayAudit = null;
try {
  replayAudit = d1(
    `SELECT r.appSlug AS app, coalesce(j.replayStatus, '(null)') AS replayStatus, count(*) AS n ` +
      `FROM Journey j JOIN Run r ON r.id = j.runId WHERE r.createdAt >= '${SINCE}' ` +
      `GROUP BY 1, 2 ORDER BY 1, 2`,
  );
} catch {
  replayAudit = null;
}

// ─── Derivation ──────────────────────────────────────────────────────────────

function parseDate(s) {
  if (!s) return null;
  let iso = s.replace(" ", "T");
  if (!/([+-]\d\d:\d\d|Z)$/.test(iso)) iso += "Z";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoWeek(d) {
  // ISO-8601 week, computed in UTC (the owner reads UTC — AGENTS.md).
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const journeysByRun = new Map(journeyRows.map((j) => [j.runId, j]));
const usageByRun = new Map();
for (const u of usageRows) {
  if (!usageByRun.has(u.runId)) usageByRun.set(u.runId, []);
  usageByRun.get(u.runId).push(u);
}

const rows = runRows
  .filter((r) => !APP || r.appSlug === APP)
  .map((r) => {
    const j = journeysByRun.get(r.id) ?? { walked: 0, carried: 0 };
    const walked = Number(j.walked) || 0;
    const carried = Number(j.carried) || 0;
    const journeys = walked + carried;
    const usage = usageByRun.get(r.id) ?? [];
    const phase = (name) => usage.filter((u) => u.phase === name);
    const sum = (list, key) => list.reduce((acc, u) => acc + (Number(u[key]) || 0), 0);
    const walking = phase("walking");
    const discUsd = sum(phase("discovery"), "costUsd");
    const walkUsd = sum(walking, "costUsd");
    const synthUsd = sum(phase("synthesis"), "costUsd");
    // CHE-169: the second opinion on negative steps, its own phase so its
    // price sits next to the walk it adjudicated. Blank until a run under
    // HARNESS_TIER=judge exists.
    const judgeUsd = sum(phase("judge"), "costUsd");
    const walkCalls = sum(walking, "iterations");
    const walkOut = sum(walking, "outputTokens");
    const usd = r.costUsd == null ? null : Number(r.costUsd);

    // Mode ladder as the workflow runs it (src/agent/workflow.ts), read back
    // from what the run left behind rather than from a column that does not
    // exist: a smoke pass writes no journeys and no LlmUsage row and books
    // SMOKE_COST_USD; a partial carries journeys forward; a full walks all of
    // its own. "empty" is the discovery-found-nothing case that CHE-107 and
    // run #19 made expensive: completed, paid for, zero journeys.
    let mode;
    if (r.status === "failed") mode = "failed";
    else if (journeys === 0 && (usd ?? 0) <= 0.02) mode = "smoke";
    else if (carried > 0) mode = "partial";
    else if (walked > 0) mode = "full";
    else if (r.status === "completed" && journeys === 0 && (usd ?? 0) > 0.02) mode = "empty";
    else mode = r.status;

    // The nav model is whatever walked; discovery is the fallback for runs
    // that never reached a walk. Vision = a glm-5v variant or any Claude model
    // (both take screenshots into context — COSTS.md, CHE-70).
    const navModel = walking[0]?.model ?? phase("discovery")[0]?.model ?? null;
    const vision = navModel ? /glm-5v/.test(navModel) || navModel.startsWith("claude") : false;

    const created = parseDate(r.createdAt);
    return {
      run: r.runNumber,
      id: r.id,
      app: r.appSlug,
      placeholder: PLACEHOLDER.test(r.appSlug),
      date: created ? created.toISOString().slice(0, 10) : null,
      week: created ? isoWeek(created) : null,
      status: r.status,
      mode,
      forceFull: Boolean(r.forceFull),
      watch: Boolean(r.watchId),
      walked,
      carried,
      usd,
      ledgerUsd: sum(usage, "costUsd"),
      discUsd,
      walkUsd,
      synthUsd,
      judgeUsd,
      walkCalls,
      walkRows: walking.length,
      walkOutputTokens: walkOut,
      // Blank, not 0.0, when nothing was walked by the model: run #76 recorded
      // five journeys and zero walking calls (every walk died on an upstream
      // 402 and the run still completed), and a 0¢ journey would read as a win.
      centsPerJourney: walked > 0 && walkCalls > 0 ? (walkUsd * 100) / walked : null,
      callsPerJourney: walked > 0 && walkCalls > 0 ? walkCalls / walked : null,
      outTokPerCall: walkCalls > 0 ? walkOut / walkCalls : null,
      navModel,
      vision,
    };
  });

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  process.exit(0);
}

// ─── Markdown ────────────────────────────────────────────────────────────────

const money = (v) => (v == null ? "" : v.toFixed(2));
const cents = (v) => (v == null ? "" : v.toFixed(1));
const one = (v) => (v == null ? "" : v.toFixed(1));
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const pct = (from, to) =>
  from == null || to == null || from === 0 ? "" : `${to >= from ? "+" : ""}${(((to - from) / from) * 100).toFixed(0)}%`;
const defined = (list, key) => list.map((r) => r[key]).filter((v) => v != null);

function table(header, body) {
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((cells) => `| ${cells.join(" | ")} |`),
  ];
  return lines.join("\n");
}

const out = [];
const say = (s = "") => out.push(s);

const apps = [...new Set(rows.map((r) => r.app))];
say(`# Run-cost trend — since ${SINCE}${APP ? ` · ${APP}` : ""}`);
say();
say(
  `${rows.length} runs · ${apps.length} apps · source: production D1 (Run, Journey, LlmUsage) ` +
    `via \`npx wrangler d1 execute checkmyapp --remote\` · regenerate with \`npm run cost:trend\`.`,
);
say(
  `Definitions (CHE-58): ¢/journey = walking $ × 100 / journeys walked this run; ` +
    `calls/journey = Σ walking iterations / walked. Averages are means of per-run values.`,
);
say();

// Fleet by mode.
say(`## Fleet by mode`);
say();
const MODES = ["full", "partial", "smoke", "empty", "failed"];
const modes = [...MODES, ...new Set(rows.map((r) => r.mode).filter((m) => !MODES.includes(m)))];
say(
  table(
    ["mode", "runs", "total $", "avg $", "avg ¢/journey", "avg calls/journey"],
    modes
      .map((m) => rows.filter((r) => r.mode === m))
      .filter((list) => list.length)
      .map((list) => [
        list[0].mode,
        list.length,
        money(defined(list, "usd").reduce((a, b) => a + b, 0)),
        money(mean(defined(list, "usd"))),
        cents(mean(defined(list, "centsPerJourney"))),
        one(mean(defined(list, "callsPerJourney"))),
      ]),
  ),
);
say();

// Fleet by ISO week.
say(`## Fleet by ISO week`);
say();
const weeks = [...new Set(rows.map((r) => r.week).filter(Boolean))].sort();
say(
  table(
    ["week", "runs", "smoke", "partial", "full", "total $", "avg full $"],
    weeks.map((w) => {
      const list = rows.filter((r) => r.week === w);
      const count = (m) => list.filter((r) => r.mode === m).length;
      return [
        w,
        list.length,
        count("smoke"),
        count("partial"),
        count("full"),
        money(defined(list, "usd").reduce((a, b) => a + b, 0)),
        money(mean(defined(list.filter((r) => r.mode === "full"), "usd"))),
      ];
    }),
  ),
);
say();

// Spend by app — placeholders collapsed to one line so their money is counted
// without pretending they are a product anyone watches.
say(`## Spend by app`);
say();
const spendLines = apps
  .filter((a) => !PLACEHOLDER.test(a) || APP === a)
  .map((a) => rows.filter((r) => r.app === a))
  .map((list) => [
    list[0].app,
    list.length,
    list.filter((r) => r.mode === "full").length,
    list.filter((r) => r.mode === "partial").length,
    list.filter((r) => r.mode === "smoke").length,
    money(defined(list, "usd").reduce((a, b) => a + b, 0)),
  ])
  .sort((a, b) => Number(b[5]) - Number(a[5]));
const placeholders = rows.filter((r) => r.placeholder && APP !== r.app);
if (placeholders.length) {
  spendLines.push([
    `self-check placeholders (${[...new Set(placeholders.map((r) => r.app))].length} slugs)`,
    placeholders.length,
    placeholders.filter((r) => r.mode === "full").length,
    placeholders.filter((r) => r.mode === "partial").length,
    placeholders.filter((r) => r.mode === "smoke").length,
    money(defined(placeholders, "usd").reduce((a, b) => a + b, 0)),
  ]);
}
say(table(["app", "runs", "full", "partial", "smoke", "total $"], spendLines));
say();

// Trend per app: first k vs last k runs of a mode, k ≤ 3 and never overlapping.
function trendLine(list, label) {
  const sorted = [...list].sort((a, b) => a.run - b.run);
  const n = sorted.length;
  if (n < 2) return `${label}: n=${n} — no trend yet`;
  const k = Math.min(3, Math.floor(n / 2));
  const head = sorted.slice(0, k);
  const tail = sorted.slice(-k);
  const c0 = mean(defined(head, "centsPerJourney"));
  const c1 = mean(defined(tail, "centsPerJourney"));
  const d0 = mean(defined(head, "usd"));
  const d1 = mean(defined(tail, "usd"));
  const span = `#${head[0].run}–#${head[k - 1].run} → #${tail[0].run}–#${tail[k - 1].run}`;
  return (
    `${label}: n=${n}, first ${k} vs last ${k} (${span}): ` +
    `¢/journey ${cents(c0)} → ${cents(c1)} (${pct(c0, c1) || "n/a"}), ` +
    `$/run ${money(d0)} → ${money(d1)} (${pct(d0, d1) || "n/a"})`
  );
}

say(`## Trend per app`);
say();
for (const a of apps) {
  if (PLACEHOLDER.test(a) && APP !== a) continue;
  const list = rows.filter((r) => r.app === a);
  const full = list.filter((r) => r.mode === "full");
  const partial = list.filter((r) => r.mode === "partial");
  if (full.length + partial.length === 0) continue;
  say(`- **${a}** — ${trendLine(full, "full")}; ${trendLine(partial, "partial")}`);
}
say();

// Per-app tables. Without --app: every non-placeholder app, watched ones first.
say(`## Per app`);
say();
const order = [...apps].sort((a, b) => {
  const wa = WATCHED.indexOf(a);
  const wb = WATCHED.indexOf(b);
  if (wa !== wb) return (wa < 0 ? 99 : wa) - (wb < 0 ? 99 : wb);
  return a.localeCompare(b);
});
for (const a of order) {
  if (PLACEHOLDER.test(a) && APP !== a) continue;
  const list = rows.filter((r) => r.app === a).sort((x, y) => x.run - y.run);
  say(`### ${a}`);
  say();
  say(
    table(
      [
        "run",
        "date",
        "mode",
        "walked/carried",
        "$",
        "disc$",
        "walk$",
        "synth$",
        "judge$",
        "¢/journey",
        "calls/journey",
        "vision",
      ],
      list.map((r) => [
        `#${r.run}`,
        r.date ?? "",
        r.mode + (r.forceFull ? " (forced)" : ""),
        `${r.walked}/${r.carried}`,
        money(r.usd),
        money(r.discUsd || null),
        money(r.walkUsd || null),
        money(r.synthUsd || null),
        money(r.judgeUsd || null),
        cents(r.centsPerJourney),
        one(r.callsPerJourney),
        r.navModel ? (r.vision ? "yes" : "no") : "",
      ]),
    ),
  );
  say();
}

// Replay audit (CHE-129).
say(`## Replay audit`);
say();
if (!replayAudit) {
  say(`replay audit: column not deployed yet`);
} else {
  const audit = replayAudit.filter((r) => !APP || r.app === APP);
  say(table(["app", "replayStatus", "journeys"], audit.map((r) => [r.app, r.replayStatus, r.n])));
}
say();

// Ledger drift. Run.costUsd is what the customer-facing pages show; the
// LlmUsage sum is what was actually spent. They disagree on two known counts
// (execution.ts books the forced-spec call only in the ledger; a retried walk
// step leaves its first attempt's row behind under a journey id that no longer
// exists). Reported so the reader knows which number they are looking at.
const drift = rows.filter((r) => r.usd != null && Math.abs(r.ledgerUsd - r.usd) > 0.02);
const retried = rows.filter((r) => r.walkRows > r.walked);
say(`## Ledger drift`);
say();
say(
  `Run.costUsd below Σ LlmUsage by more than $0.02 on ${drift.length} of ${rows.length} runs; ` +
    `Σ Run.costUsd = $${money(defined(rows, "usd").reduce((a, b) => a + b, 0))}, ` +
    `Σ LlmUsage = $${money(rows.reduce((a, r) => a + r.ledgerUsd, 0))}. ` +
    `${retried.length} runs carry more walking rows than walked journeys (retried walk steps): ` +
    `${retried.map((r) => `#${r.run}`).join(", ") || "none"}.`,
);

process.stdout.write(out.join("\n") + "\n");
