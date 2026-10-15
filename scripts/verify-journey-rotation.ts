// CHE-232 verification: what tonight's run walks is decided per journey, from
// the catalog, with each journey's own clock.
//
// Before this, a partial run read ONE baseline run's rows: every journey on it
// carried the same date, so "walked last night" and "walked eleven days ago"
// were the same fact, and an app with more journeys than a run can afford had
// no way to come round to the rest. joblander's catalog holds 23 live journeys
// against a budget of 5.
//
// The rules, held here against the real planRotation:
//   1. a failing journey is walked every run, however long the queue — it is
//      the one the owner is waiting on, longest streak first;
//   2. a journey nothing has ever walked outranks a green one: an unwalked
//      catalog row is unknown, not verified;
//   3. everything else is oldest-first — the rotation itself, so the 23rd
//      journey comes round on the fifth day instead of never;
//   4. green evidence older than the carry window cannot be carried (that would
//      date last month's walk as tonight's), so it is due even while green;
//   5. what the budget cannot reach and cannot carry is DEFERRED, never
//      silently carried — that is our coverage gap to say out loud (rule 2);
//   6. an unchanged app (CHE-132) does not have journeys forced onto the walk
//      list by age alone;
//   7. the budget is never exceeded, and no journey is in two lists at once.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-journey-rotation.ts

import Module from "node:module";
import type { CatalogJourneyState } from "@/agent/journey-catalog";

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

type PartialModule = typeof import("@/agent/partial");
let planRotation: PartialModule["planRotation"];
let JOURNEY_WALK_BUDGET: PartialModule["JOURNEY_WALK_BUDGET"];
let FULL_RUN_MAX_AGE_DAYS: number;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const NOW = new Date("2026-09-15T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function journey(over: Partial<CatalogJourneyState> & { title: string }): CatalogJourneyState {
  return {
    appJourneyId: `aj-${over.title.replace(/\W+/g, "-")}`,
    plan: ["Open the page", "Do the thing"],
    status: "ok",
    lastWalkedAt: daysAgo(1),
    lastWalkedRunId: "run-old",
    consecutiveBad: 0,
    ...over,
  };
}

const titles = (list: CatalogJourneyState[]) => list.map((j) => j.title);
const ageDays = (j: CatalogJourneyState) => (NOW.getTime() - (j.lastWalkedAt as Date).getTime()) / 86_400_000;

async function main() {
  ({ planRotation, JOURNEY_WALK_BUDGET } = await import("@/agent/partial"));
  ({ FULL_RUN_MAX_AGE_DAYS } = await import("@/agent/replay"));

  console.log("A failing journey is walked every run");
  {
    const journeys = [
      journey({ title: "green-1", lastWalkedAt: daysAgo(1) }),
      journey({ title: "broken", status: "broken", consecutiveBad: 3, lastWalkedAt: daysAgo(1) }),
      journey({ title: "green-2", lastWalkedAt: daysAgo(2) }),
      journey({ title: "confusing", status: "confusing", consecutiveBad: 1, lastWalkedAt: daysAgo(1) }),
    ];
    const r = planRotation({ journeys, now: NOW, budget: 2 });
    check("the two failing journeys take the whole budget", titles(r.walk).join() === "broken,confusing", titles(r.walk).join());
    check("…longest failing streak first", r.walk[0].title === "broken", titles(r.walk).join());
    check("the greens are carried, not dropped", titles(r.carry).sort().join() === "green-1,green-2", titles(r.carry).join());
    check("nothing is deferred while the greens are fresh", r.deferred.length === 0, titles(r.deferred).join());
  }

  console.log("\nAn unwalked journey is unknown, not green");
  {
    const journeys = [
      journey({ title: "walked-yesterday", lastWalkedAt: daysAgo(1) }),
      journey({ title: "never-walked", status: null, lastWalkedAt: null, lastWalkedRunId: null }),
    ];
    const r = planRotation({ journeys, now: NOW, budget: 1 });
    check("the unwalked one is what gets walked", titles(r.walk).join() === "never-walked", titles(r.walk).join());
    check("…and a journey with no walk behind it is never carried",
      !titles(r.carry).includes("never-walked"), titles(r.carry).join());
  }

  console.log("\nThe rotation: oldest first, so the queue comes round");
  {
    // 23 journeys, all green, spread over six days — joblander's catalog size.
    const journeys = Array.from({ length: 23 }, (_, i) =>
      journey({ title: `j${String(i).padStart(2, "0")}`, lastWalkedAt: daysAgo((i % 6) + 1) }),
    );
    const r = planRotation({ journeys, now: NOW, budget: JOURNEY_WALK_BUDGET });
    check("exactly the budget is walked", r.walk.length === JOURNEY_WALK_BUDGET, String(r.walk.length));
    check("every walked journey is at least as stale as every carried one",
      Math.min(...r.walk.map(ageDays)) >= Math.max(...r.carry.map(ageDays)),
      `walked ${Math.min(...r.walk.map(ageDays))}d..${Math.max(...r.walk.map(ageDays))}d, carried up to ${Math.max(...r.carry.map(ageDays))}d`);
    check("nobody is in two lists", new Set([...titles(r.walk), ...titles(r.carry), ...titles(r.deferred)]).size === 23);

    // Five days of it: walk what is due, stamp those as walked, repeat.
    const state = new Map(journeys.map((j) => [j.title, { ...j }]));
    const seen = new Set<string>();
    for (let day = 0; day < 5; day++) {
      const at = new Date(NOW.getTime() + day * 86_400_000);
      const plan = planRotation({ journeys: [...state.values()], now: at, budget: JOURNEY_WALK_BUDGET });
      for (const j of plan.walk) {
        seen.add(j.title);
        state.set(j.title, { ...(state.get(j.title) as CatalogJourneyState), lastWalkedAt: at, status: "ok" });
      }
    }
    check("five daily runs reach every journey in a 23-journey catalog", seen.size === 23, `${seen.size}/23`);
  }

  console.log("\nEvidence too old to stand on is due, and says so when it cannot be reached");
  {
    const journeys = [
      journey({ title: "stale-1", lastWalkedAt: daysAgo(FULL_RUN_MAX_AGE_DAYS + 3) }),
      journey({ title: "stale-2", lastWalkedAt: daysAgo(FULL_RUN_MAX_AGE_DAYS + 2) }),
      journey({ title: "fresh", lastWalkedAt: daysAgo(1) }),
    ];
    const r = planRotation({ journeys, now: NOW, budget: 1 });
    check("the stalest green is walked before a fresh one", titles(r.walk).join() === "stale-1", titles(r.walk).join());
    check("the other expired one is deferred, not carried as if it were recent",
      titles(r.deferred).join() === "stale-2", `carry=${titles(r.carry).join()} deferred=${titles(r.deferred).join()}`);
    check("the fresh one is carried", titles(r.carry).join() === "fresh", titles(r.carry).join());

    // Undateable evidence is unusable evidence, whatever the status says.
    const undateable = planRotation({
      journeys: [journey({ title: "no-source", lastWalkedRunId: null, lastWalkedAt: daysAgo(1) })],
      now: NOW,
      budget: 0,
    });
    check("a green journey with no run behind it is deferred, never carried",
      titles(undateable.deferred).join() === "no-source",
      JSON.stringify({ carry: titles(undateable.carry), deferred: titles(undateable.deferred) }));
  }

  console.log("\nAn unchanged app is not sent walking by age alone (CHE-132)");
  {
    const journeys = [
      journey({ title: "old-but-green", lastWalkedAt: daysAgo(FULL_RUN_MAX_AGE_DAYS + 5) }),
      journey({ title: "bad", status: "broken", consecutiveBad: 1, lastWalkedAt: daysAgo(1) }),
    ];
    const counted = planRotation({ journeys, now: NOW, budget: 2, ageCounts: true });
    check("with age counting, both are walked", counted.walk.length === 2, titles(counted.walk).join());
    const unchanged = planRotation({ journeys, now: NOW, budget: 1, ageCounts: false });
    check("on an unchanged app the failing one is what the budget buys",
      titles(unchanged.walk).join() === "bad", titles(unchanged.walk).join());
    // CHE-311: meetbashar.com's runs are mostly smoke passes that walk nothing,
    // so its journeys age past the window together. On an unchanged app they
    // were then "deferred" and filed as "cannot keep every journey checked".
    check("…and the old green one is carried under its own date, not deferred",
      titles(unchanged.carry).join() === "old-but-green" && unchanged.deferred.length === 0,
      `carry=${titles(unchanged.carry).join()} deferred=${titles(unchanged.deferred).join()}`);
    check("with age counting, the same old journey still cannot be carried",
      titles(planRotation({ journeys, now: NOW, budget: 1, ageCounts: true }).deferred).join() === "old-but-green");

    const catalog12 = Array.from({ length: 12 }, (_, i) =>
      journey({ title: `m${i}`, lastWalkedAt: daysAgo(FULL_RUN_MAX_AGE_DAYS + 1 + i) }),
    );
    const quiet = planRotation({ journeys: catalog12, now: NOW, ageCounts: false });
    check("twelve expired greens on an unchanged app: five walked, seven carried, none deferred",
      quiet.walk.length === JOURNEY_WALK_BUDGET && quiet.carry.length === 12 - JOURNEY_WALK_BUDGET && quiet.deferred.length === 0,
      `walk=${quiet.walk.length} carry=${quiet.carry.length} deferred=${quiet.deferred.length}`);
    // Undated evidence stays unusable whatever the survey said.
    const undated = planRotation({
      journeys: [journey({ title: "no-source", lastWalkedRunId: null })],
      now: NOW,
      budget: 0,
      ageCounts: false,
    });
    check("an unchanged app still never carries a journey with no run behind it",
      titles(undated.deferred).join() === "no-source" && undated.carry.length === 0);
  }

  // CHE-232: the rotation used to be consulted only by partial mode, which is
  // 18% of watch runs. On a full run the model proposed five and picked its
  // headline flows every time — joblander has 9 of 23 journeys walked once or
  // never while its primary flows carry 20-31 walks.
  console.log("\nA full run gives its last slots to the journeys that have waited longest");
  {
    const { fullRunQueue, ROTATION_SLOTS } = await import("@/agent/partial");
    const proposed = ["Sign up", "Practice an interview", "Install the extension", "Browse roles", "Read the guides"].map(
      (title) => ({ title, steps: [`Open ${title}`] }),
    );
    const catalog = [
      // What discovery proposed, as the catalog knows it — walked yesterday.
      ...proposed.map((p, i) => journey({ title: p.title, lastWalkedAt: daysAgo(1), plan: [], status: "ok", appJourneyId: `aj-p${i}` })),
      // The tail nobody has walked in weeks.
      journey({ title: "Export your data", lastWalkedAt: daysAgo(19), plan: ["Open settings", "Click export"] }),
      journey({ title: "Invite a teammate", lastWalkedAt: daysAgo(22) }),
      journey({ title: "Change your password", lastWalkedAt: daysAgo(4) }),
    ].map((j) => ({ ...j, key: `k-${j.title.replace(/\W+/g, "-")}`, aliases: [j.title], surface: null }));

    const queue = fullRunQueue({ proposed, catalog, now: NOW });
    check("the queue is still the budget", queue.length === JOURNEY_WALK_BUDGET, String(queue.length));
    check(
      `the last ${ROTATION_SLOTS} slots go to the two stalest journeys`,
      queue.slice(-ROTATION_SLOTS).map((q) => q.title).join() === "Invite a teammate,Export your data",
      queue.map((q) => q.title).join(" · "),
    );
    check(
      "discovery keeps the rest, in its own order",
      queue.slice(0, JOURNEY_WALK_BUDGET - ROTATION_SLOTS).map((q) => q.title).join() === "Sign up,Practice an interview,Install the extension",
      queue.map((q) => q.title).join(" · "),
    );
    check(
      "a rotated journey brings its stored plan, not just its title",
      (queue.find((q) => q.title === "Export your data")?.steps ?? []).join() === "Open settings,Click export",
      JSON.stringify(queue.find((q) => q.title === "Export your data")?.steps),
    );

    // A journey discovery already proposed must not also take a rotation slot,
    // however it was worded this time.
    const reworded = [{ title: "Invite a teammate to your workspace", steps: ["Open settings"] }, ...proposed.slice(0, 4)];
    const q2 = fullRunQueue({ proposed: reworded, catalog, now: NOW });
    check(
      "a reworded proposal does not buy the same journey a second slot",
      q2.filter((q) => /invite a teammate/i.test(q.title)).length === 1,
      q2.map((q) => q.title).join(" · "),
    );

    // The first run of an app has nothing to rotate through.
    const first = fullRunQueue({ proposed, catalog: [], now: NOW });
    check("with no catalog the queue is exactly what discovery proposed", first.map((p) => p.title).join() === proposed.map((p) => p.title).join());

    // A short proposal must not be padded past what discovery found.
    const two = fullRunQueue({ proposed: proposed.slice(0, 2), catalog, now: NOW });
    check("a two-journey proposal still gets its rotation slots and no more", two.length <= JOURNEY_WALK_BUDGET && two.length >= 2, String(two.length));
    check("discovery always keeps at least one slot", fullRunQueue({ proposed, catalog, now: NOW, rotationSlots: 99 })[0].title === "Sign up");
  }

  console.log("\nA deferred journey is only counted against us once we know how many journeys there are");
  {
    const { catalogIsDeduplicated } = await import("@/agent/journey-catalog");
    const db = (titles: string[]) =>
      ({ db: { appJourney: { findMany: async () => titles.map((title) => ({ title })) } } }) as never;

    // checkmyapp.dev as production actually holds it (CHE-247): the same journey
    // written twice. A "cannot keep every journey checked" ticket built on that
    // count sends the next reader to raise the budget instead of fixing identity.
    const asProduction = await catalogIsDeduplicated(
      db([
        "Check a web app (primary value action)",
        "Analyze a web app by URL (primary value action)",
        "Sign up via the free pricing CTA",
        "Sign up via the free pricing CTA",
      ]),
      "app-1",
    );
    check("a catalog with two rows of one title is not countable", asProduction === false, String(asProduction));

    const spacingAndCase = await catalogIsDeduplicated(db(["Start a check", "  start a CHECK "]), "app-1");
    check("…and neither is one that differs only by case or padding", spacingAndCase === false, String(spacingAndCase));

    const clean = await catalogIsDeduplicated(db(["Start a check", "Sign in", "Enable daily monitoring"]), "app-1");
    check("a catalog that says each thing once is countable", clean === true, String(clean));

    const empty = await catalogIsDeduplicated(db([]), "app-1");
    check("an empty catalog is countable rather than an error", empty === true, String(empty));
  }

  console.log("\nThe budget is a budget");
  {
    const journeys = Array.from({ length: 12 }, (_, i) =>
      journey({ title: `b${i}`, status: "broken", consecutiveBad: 1, lastWalkedAt: daysAgo(1) }),
    );
    const r = planRotation({ journeys, now: NOW, budget: JOURNEY_WALK_BUDGET });
    check("twelve broken journeys still walk only five tonight", r.walk.length === JOURNEY_WALK_BUDGET, String(r.walk.length));
    check("the other seven are deferred — a broken journey is never carried as green",
      r.deferred.length === 7 && r.carry.length === 0,
      `carry=${r.carry.length} deferred=${r.deferred.length}`);
    const empty = planRotation({ journeys: [], now: NOW });
    check("an empty catalog plans nothing rather than throwing",
      empty.walk.length === 0 && empty.carry.length === 0 && empty.deferred.length === 0);
  }
}

void main().then(() => {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
