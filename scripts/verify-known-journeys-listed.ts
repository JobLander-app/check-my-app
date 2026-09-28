// CHE-331 verification: a check lists every journey the app is known to have,
// not only the ones it walked.
//
// Production, checkmyapp.dev: run #247 (2026-09-23) showed 10 journeys — a
// partial run, 5 walked and 5 carried. Runs #257 and #260 showed 5 and run #261
// showed 3, none carried, while the app's catalog held 12 live journeys. No
// journey had been retired: only a partial run ever copied anything forward,
// and a partial run happens only on a watch run of an app the survey saw
// unchanged. A full check after a deploy (#260: "16 pages changed") and every
// on-demand or MCP check (#257, #261: no mode ladder at all) listed what it
// walked and nothing else.
//
// What this holds, against the real planKnownJourneys → carryJourney →
// loadVerdict / buildReview path over an in-memory database shaped like #261:
//   1. a run that walked k of N live journeys lists N, N−k of them carried;
//   2. each carried one names the run that really walked it, and is dated;
//   3. a retired journey is not resurrected, and one nothing has walked is not
//      invented;
//   4. a copy never takes the slot of a journey this run walked, and the walk
//      it copies is the walk itself, never an earlier copy of it;
//   5. the bottom line counts them before its opinion, and a run that walked
//      every known journey says nothing extra;
//   6. what an agent reads (the verdict API, the review) marks them as carried,
//      and the review's coverage does not claim a carried journey's pages or
//      gaps as this run's.
//
// Fails on the code before CHE-331: planKnownJourneys does not exist there, so
// nothing lists an unwalked journey and #261's verdict keeps 3 of 12.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-known-journeys-listed.ts

import Module from "node:module";

// partial.ts reaches replay.ts → browser.ts, whose @cloudflare/playwright
// requires the `cloudflare:workers` builtin at load time. Nothing here touches a
// browser, so that one module is answered with an empty object and partial.ts is
// imported inside main(), after the hook is in place.
const moduleLoader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = moduleLoader._load;
moduleLoader._load = function (request: string, ...rest: unknown[]) {
  if (request === "cloudflare:workers") return {};
  return realLoad.call(this, request, ...rest);
};

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ─── A small in-memory Prisma: only the calls this path makes ───────────────

type Row = Record<string, unknown>;
let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key] ?? null;
    if (cond === null) {
      if (value !== null) return false;
    } else if (typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown };
      if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
      if ("not" in c && (c.not === null ? value === null : value === c.not)) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function sortBy<T extends Row>(rows: T[], orderBy?: Record<string, "asc" | "desc">): T[] {
  if (!orderBy) return rows;
  const [[key, dir]] = Object.entries(orderBy);
  return [...rows].sort((a, b) => ((a[key] as number) - (b[key] as number)) * (dir === "desc" ? -1 : 1));
}

function makeDb() {
  const tables = {
    run: [] as Row[],
    journey: [] as Row[],
    step: [] as Row[],
    evidence: [] as Row[],
    appJourney: [] as Row[],
    finding: [] as Row[],
  };
  const stepsOf = (journeyId: string) =>
    sortBy(tables.step.filter((s) => s.journeyId === journeyId), { order: "asc" }).map((s) => ({
      ...s,
      evidence: tables.evidence.filter((e) => e.stepId === s.id),
    }));
  const db = {
    run: {
      findMany: async ({ where }: { where?: Row }) => tables.run.filter((r) => matches(r, where)),
      findUnique: async ({ where }: { where: Row }) => {
        const run = tables.run.find((r) => matches(r, where));
        if (!run) return null;
        return {
          ...run,
          journeys: sortBy(tables.journey.filter((j) => j.runId === run.id), { order: "asc" }).map((j) => ({
            ...j,
            steps: stepsOf(j.id as string),
          })),
          findings: tables.finding.filter((f) => f.runId === run.id),
        };
      },
    },
    appJourney: {
      findMany: async ({ where }: { where?: Row }) => tables.appJourney.filter((r) => matches(r, where)),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = tables.appJourney.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    journey: {
      findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Record<string, "asc" | "desc"> }) =>
        sortBy(tables.journey.filter((r) => matches(r, where)), orderBy),
      findUnique: async ({ where }: { where: Row }) => {
        const j = tables.journey.find((r) => r.id === where.id);
        return j ? { ...j, steps: stepsOf(j.id as string) } : null;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const gone = tables.journey.filter((r) => matches(r, where));
        tables.journey = tables.journey.filter((r) => !gone.includes(r));
        return { count: gone.length };
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: id("j"), carriedFromRunId: null, ...data };
        tables.journey.push(row);
        return row;
      },
    },
    step: {
      create: async ({ data }: { data: Row & { evidence?: { create: Row[] } } }) => {
        const { evidence, ...rest } = data;
        const row = { id: id("s"), ...rest };
        tables.step.push(row);
        for (const e of evidence?.create ?? []) tables.evidence.push({ ...e, id: id("e"), stepId: row.id });
        return row;
      },
    },
  };
  return { db, tables };
}

// ─── The fixture: checkmyapp.dev as #261 found it ───────────────────────────

const day = (d: string) => new Date(`${d}T23:50:00.000Z`);

async function main() {
  const partial = (await import("@/agent/partial")) as Record<string, unknown>;
  const planKnownJourneys = partial.planKnownJourneys as
    | ((env: unknown, args: { runId: string; appId: string; startOrder: number }) => Promise<Array<Record<string, unknown>>>)
    | undefined;
  const fullBottomLine = partial.fullBottomLine as
    | ((planned: number, synthesized: string | null, walked: number, listed: unknown[]) => string | null)
    | undefined;
  const carryJourney = partial.carryJourney as (env: unknown, runId: string, entry: unknown, runNumber?: number) => Promise<void>;
  const partialBottomLine = partial.partialBottomLine as (plan: unknown, s: string | null, n: number, listed?: unknown[]) => string;
  const { loadVerdict } = await import("@/lib/run-read");
  const { buildReview } = await import("@/lib/review");

  if (typeof planKnownJourneys !== "function" || typeof fullBottomLine !== "function") {
    check(
      "a check has a way to list the known journeys it did not walk",
      false,
      "planKnownJourneys / fullBottomLine are not in src/agent/partial.ts — a full or on-demand check lists only what it walked (#261: 3 of 12)",
    );
    return;
  }

  const { db, tables } = makeDb();
  const env = { db };
  const APP = "app-cma";

  // The runs that did the walking, each a completed run of the app.
  const runs: Record<number, Row> = {};
  for (const [n, at] of [
    [242, "2026-09-22"],
    [247, "2026-09-23"],
    [260, "2026-09-27"],
    [261, "2026-09-28"],
  ] as const) {
    runs[n] = {
      id: `run-${n}`,
      publicId: `pub-${n}`,
      runNumber: n,
      appId: APP,
      appSlug: "checkmyapp.dev",
      targetKind: "website",
      status: "completed",
      verdict: "needs_attention",
      completedAt: day(at),
    };
    tables.run.push(runs[n]);
  }

  // One real walk: a Journey row with two steps and a screenshot.
  const walk = (runN: number, ajId: string, title: string, status: string, order: number, opts: Row = {}) => {
    const j = {
      id: id("j"),
      runId: `run-${runN}`,
      order,
      title,
      status,
      summary: `${title}: ${status}`,
      videoUrl: null,
      appJourneyId: ajId,
      journeyKey: ajId,
      carriedFromRunId: null,
      ...opts,
    };
    tables.journey.push(j);
    for (let i = 0; i < 2; i++) {
      const s = {
        id: id("s"),
        journeyId: j.id,
        order: i,
        label: `${title} step ${i + 1}`,
        status: i === 1 && status === "partial" ? "skipped" : "ok",
        screenshotUrl: `/api/evidence/${j.id}-${i}.png`,
        attempted: "Opened it",
        observed: `${title} page ${i + 1} answered`,
        consoleLog: null,
        networkLog: `GET /${ajId}/${i} 200`,
        unverifiedReason: i === 1 && status === "partial" ? "our_capability" : null,
      };
      tables.step.push(s);
      tables.evidence.push({ id: id("e"), stepId: s.id, type: "screenshot", storageUrl: s.screenshotUrl, sha256: "x", capturedAt: day("2026-09-20") });
    }
    return j;
  };

  const catalog = (key: string, over: Row) => {
    const row = {
      id: `aj-${key}`,
      appId: APP,
      key,
      title: key,
      aliases: JSON.stringify([key]),
      surface: null,
      plan: "[]",
      status: "ok",
      lastWalkedAt: null,
      lastWalkedRunId: null,
      consecutiveBad: 0,
      retiredAt: null,
      ...over,
    };
    tables.appJourney.push(row);
    return row;
  };

  // The twelve live journeys, as production held them on 2026-09-28.
  const walkedBy261 = ["view-start-verdict", "signup", "login"];
  const walkedBy260 = ["first-visit-verdict", "quick-start", "view-public-market", "signup-pricing-sign-up", "start-free-land"];
  const walkedBy247 = ["start-target-url", "start-anonymously", "billing"];
  const walkedBy242 = ["start-chrom-extension"];
  const statusOf: Record<string, string> = {
    "view-start-verdict": "confusing",
    login: "partial",
    "signup-pricing-sign-up": "partial",
    "start-free-land": "partial",
    billing: "partial",
    "start-chrom-extension": "partial",
  };
  for (const [runN, keys] of [[260, walkedBy260], [247, walkedBy247], [242, walkedBy242]] as const) {
    keys.forEach((key, i) => {
      const status = statusOf[key] ?? "ok";
      walk(runN, `aj-${key}`, key, status, i);
      catalog(key, { status, lastWalkedAt: runs[runN].completedAt, lastWalkedRunId: `run-${runN}` });
    });
  }
  // #247 was a partial run: it also holds a COPY of start-chrom-extension from
  // #242. The copy must never be what a later run copies — #242 walked it.
  walk(247, "aj-start-chrom-extension", "start-chrom-extension", "partial", 9, { carriedFromRunId: "run-242" });
  // Two journeys retired on 2026-09-18, and one discovery proposed that nothing
  // has walked yet.
  walk(211, "aj-dashboard", "dashboard", "partial", 0);
  catalog("dashboard", { status: "partial", lastWalkedAt: day("2026-09-16"), lastWalkedRunId: "run-211", retiredAt: day("2026-09-18") });
  catalog("support", { status: "skipped", lastWalkedAt: day("2026-08-28"), lastWalkedRunId: "run-108", retiredAt: day("2026-09-18") });
  catalog("web", { status: null });

  // Run #261 walked three of the twelve (orders 0..2), as the workflow's walk
  // steps leave them: one row each, identity resolved.
  walkedBy261.forEach((key, i) => {
    const status = statusOf[key] ?? "ok";
    walk(261, `aj-${key}`, key, status, i);
    catalog(key, { status, lastWalkedAt: runs[261].completedAt, lastWalkedRunId: "run-261" });
  });

  const liveWalked = tables.appJourney.filter((a) => a.retiredAt === null && a.lastWalkedRunId);
  const N = liveWalked.length;
  const k = walkedBy261.length;

  // ─── The path the workflow takes after the walks ───────────────────────────
  const listed = await planKnownJourneys(env, { runId: "run-261", appId: APP, startOrder: k });
  const bottomLine = fullBottomLine(k, "Signing in works; the verdict page is hard to read.", k, listed);
  for (const entry of listed) await carryJourney(env, "run-261", entry, 261);

  console.log(`checkmyapp.dev as of run #261: ${N} live journeys with a walk behind them, ${k} walked by this run\n`);

  console.log("The verdict lists every known journey");
  const verdict = await loadVerdict(db as never, "pub-261");
  const vj = (verdict?.journeys ?? []) as Array<{ title: string; status: string; carried_from?: { run_number: number | null; walked_at: Date | null } | null }>;
  check(`the verdict has all ${N} journeys, not the ${k} it walked`, vj.length === N, `${vj.length}: ${vj.map((j) => j.title).join(" · ")}`);
  const carried = vj.filter((j) => j.carried_from);
  check(`${N - k} of them are marked carried`, carried.length === N - k, String(carried.length));
  check(
    "the walked ones are not marked carried",
    vj.filter((j) => !j.carried_from).map((j) => j.title).sort().join() === [...walkedBy261].sort().join(),
    vj.filter((j) => !j.carried_from).map((j) => j.title).join(),
  );
  check(
    "each carried journey names the run that walked it and when",
    carried.every((j) => typeof j.carried_from?.run_number === "number" && j.carried_from?.walked_at instanceof Date),
    JSON.stringify(carried.map((j) => [j.title, j.carried_from?.run_number])),
  );
  check(
    "…and that run is the journey's own last walk",
    carried.every((j) => {
      const aj = tables.appJourney.find((a) => a.key === j.title);
      return aj && `run-${j.carried_from?.run_number}` === aj.lastWalkedRunId;
    }),
    JSON.stringify(carried.map((j) => [j.title, j.carried_from?.run_number])),
  );
  check(
    "a carried journey keeps the status its last walk ended with",
    carried.every((j) => j.status === (statusOf[j.title] ?? "ok")),
    JSON.stringify(carried.map((j) => [j.title, j.status])),
  );

  console.log("\nNothing is resurrected or invented");
  const titles = vj.map((j) => j.title);
  check("a retired journey is not listed", !titles.includes("dashboard") && !titles.includes("support"), titles.join());
  check("a journey nothing has walked is not listed", !titles.includes("web"), titles.join());
  check("no journey is listed twice", new Set(titles).size === titles.length, titles.join());

  console.log("\nA copy never takes a walked journey's place, and copies the walk itself");
  const rows261 = tables.journey.filter((j) => j.runId === "run-261");
  const walkedOrders = rows261.filter((j) => !j.carriedFromRunId).map((j) => j.order as number);
  const carriedOrders = rows261.filter((j) => j.carriedFromRunId).map((j) => j.order as number);
  check("the walked rows keep orders 0..k-1", walkedOrders.sort().join() === "0,1,2", walkedOrders.join());
  check("every copy comes after them", carriedOrders.every((o) => o >= k), carriedOrders.join());
  check("no two rows share an order", new Set(rows261.map((j) => j.order)).size === rows261.length);
  const chrome = rows261.find((j) => j.appJourneyId === "aj-start-chrom-extension");
  check("the journey #247 only carried is copied from #242, which walked it", chrome?.carriedFromRunId === "run-242", String(chrome?.carriedFromRunId));
  const chromeSteps = tables.step.filter((s) => s.journeyId === chrome?.id);
  check("…with its steps and evidence", chromeSteps.length === 2 && tables.evidence.some((e) => e.stepId === chromeSteps[0]?.id), String(chromeSteps.length));
  const lastWalkUntouched = tables.appJourney.find((a) => a.key === "billing");
  check(
    "carrying moves nothing about when the journey was really walked",
    lastWalkUntouched?.lastWalkedRunId === "run-247" && lastWalkUntouched?.lastRunNumber === 261,
    JSON.stringify({ lastWalkedRunId: lastWalkUntouched?.lastWalkedRunId, lastRunNumber: lastWalkUntouched?.lastRunNumber }),
  );

  console.log("\nThe bottom line states coverage before its opinion");
  check(
    `it counts ${k} walked of ${N}, ${N - k} carried, and dates the oldest`,
    Boolean(bottomLine?.startsWith(`Re-checked ${k} of ${N} journeys; ${N - k} carried forward from 3 earlier runs (last walked Sep 22).`)),
    String(bottomLine),
  );
  check("…and then says what the verdict says", Boolean(bottomLine?.endsWith("the verdict page is hard to read.")), String(bottomLine));
  check("a run that walked every known journey says nothing extra", fullBottomLine(5, "All good.", 5, []) === "All good.");

  // A partial run's own line is unchanged when nothing else is listed.
  const plan = {
    taken: true,
    baselineRunId: "run-247",
    baselineRunNumber: 247,
    anatomy: null,
    carry: [{ sourceJourneyId: "x", order: 1, title: "a", sourceRunId: "run-247", sourceRunNumber: 247 }],
    rewalk: [{ order: 0, title: "b", steps: [], previousStatus: "broken" }],
    oldestVerifiedAt: "2026-09-23T23:50:00.000Z",
  };
  check(
    "a partial run's line reads exactly as before when nothing else is listed",
    partialBottomLine(plan, "Fine.", 1) === "Re-checked 1 of 2 journeys; 1 carried forward from Run #247 (last walked Sep 23). Fine.",
    partialBottomLine(plan, "Fine.", 1),
  );
  const withListed = partialBottomLine(plan, "Fine.", 1, [
    { sourceJourneyId: "y", order: 2, title: "c", sourceRunId: "run-242", sourceRunNumber: 242, walkedAt: "2026-09-22T23:50:00.000Z" },
  ]);
  check(
    "…and counts and dates what it lists besides",
    withListed === "Re-checked 1 of 3 journeys; 2 carried forward from 2 earlier runs (last walked Sep 22). Fine.",
    withListed,
  );

  console.log("\nWhat an agent reads tells the carried ones apart");
  const reviewSource = await db.run.findUnique({ where: { publicId: "pub-261" } });
  const review = buildReview(
    {
      ...(reviewSource as never),
      bottomLine,
      // Each walk's first step reached `/aj-<key>/0`: billing only on #247's
      // walk (carried here), login on this run's own.
      anatomy: JSON.stringify({ pages: ["Billing (`/aj-billing/0`)", "Sign in (`/aj-login/0`)"] }),
      deploySha: null,
      deployEnv: null,
      startedAt: day("2026-09-28"),
    },
    "https://checkmyapp.dev",
  );
  check(
    "the review marks exactly the carried journeys",
    review.journeys.filter((j) => j.carried).length === N - k && review.journeys.length === N,
    `${review.journeys.filter((j) => j.carried).length} of ${review.journeys.length}`,
  );
  check(
    "a carried journey's skipped step is not reported as this run's gap",
    review.coverage.unverified.every((u) => walkedBy261.includes(u.journey)),
    JSON.stringify(review.coverage.unverified),
  );
  check(
    "a page only a carried journey reached is not claimed as opened this run",
    review.coverage.pages_not_opened.includes("/aj-billing/0") && !review.coverage.pages_not_opened.includes("/aj-login/0"),
    JSON.stringify(review.coverage.pages_not_opened),
  );

  console.log("\nA missing walk costs that one journey, not the list");
  {
    const { db: db2, tables: t2 } = makeDb();
    t2.run.push({ id: "r1", runNumber: 1, completedAt: day("2026-09-20") }, { id: "r2", runNumber: 2, completedAt: day("2026-09-28") });
    t2.appJourney.push(
      { id: "aj-a", appId: "A", key: "a", title: "a", aliases: "[]", plan: "[]", status: "ok", lastWalkedAt: day("2026-09-20"), lastWalkedRunId: "r1", consecutiveBad: 0, retiredAt: null },
      { id: "aj-b", appId: "A", key: "b", title: "b", aliases: "[]", plan: "[]", status: "ok", lastWalkedAt: day("2026-09-20"), lastWalkedRunId: "pruned", consecutiveBad: 0, retiredAt: null },
    );
    t2.journey.push({ id: "src-a", runId: "r1", order: 0, title: "a", status: "ok", appJourneyId: "aj-a", carriedFromRunId: null });
    const got = await planKnownJourneys({ db: db2 }, { runId: "r2", appId: "A", startOrder: 0 });
    check("the journey with a walk is listed, the one without is left off", got.map((g) => g.title).join() === "a", JSON.stringify(got));
  }
}

void main().then(() => {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
