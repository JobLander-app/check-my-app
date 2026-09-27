// CHE-321 verification: what a journey surface says does not contradict itself.
//
// Journey work is paused, and the product launches to everyone anyway. So this
// ticket touched nothing but the places where a visitor would see two of our
// own statements disagree — each one found on a live verdict page or in the
// assembly of the mail, not imagined:
//
//   1. "✓ Works" and "Likely to finish: 0 of 100" on the same journey
//      (checkmyapp.dev, run #247, "Check a website anonymously");
//   2. "0 people reached /verdict/:id" under one journey and "then 1 to
//      /verdict/:id" under the next, on the same page (run #247), because the
//      count is taken from the app's front door and the sentence never said so;
//   3. a comparison that opens "We expected this to be hard going" under our own
//      estimate of 60 of 100, or "We expected most people to get through" under
//      40 of 100;
//   4. a movement sentence whose gap is not the difference of the two
//      percentages it prints ("30% … against 36% before — 5.7 points down");
//   5. the mail's "what changed" pairing, which read the status "before" from a
//      catalog row this very walk had already overwritten — so a journey that
//      went from Works to Confusing was mailed "Nothing changed in this flow";
//   6. the same pairing naming a status by its stored code ("partial") where
//      the page the mail links to says "Works · partly verified".
//
// Every section drives the real function. Each was run against the code before
// the change and failed there first.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-journey-surfaces-agree.ts

import { comparisonLine, completionOf, journeyPages, ourLines, pagesLine } from "@/lib/journey-numbers";
import { numbersForJourneys } from "@/lib/journey-numbers-load";
import { movementOf, movementSentence, type MetricPoint } from "@/lib/metric-movement";
import { flowChanges } from "@/lib/flow-changes";
import { metricAlertsForRun } from "@/agent/metric-alerts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

async function main() {
  console.log("\n— 1. a zero never stands beside “Works” —\n");
  {
    const catalog = [
      { id: "aj_works", price: 3, conversion: 0 },
      { id: "aj_broken", price: 3, conversion: 0 },
      { id: "aj_fine", price: 2, conversion: 80 },
    ];
    const db = {
      step: { findMany: async () => [] },
      appJourney: {
        findMany: async () =>
          catalog.map((c) => ({
            ...c,
            funnelStages: null,
            app: { posthogProjectId: null, targetUrl: "https://checkmyapp.dev", team: { posthog: null } },
            metricPoints: [],
          })),
      },
    } as unknown as Parameters<typeof numbersForJourneys>[0];

    const numbers = await numbersForJourneys(db, [
      { id: "j_works", appJourneyId: "aj_works", status: "ok" },
      { id: "j_partly", appJourneyId: "aj_works", status: "partial" },
      { id: "j_broken", appJourneyId: "aj_broken", status: "broken" },
      { id: "j_fine", appJourneyId: "aj_fine", status: "ok" },
    ]);
    const lines = (id: string) => ourLines(numbers[id]?.ours ?? { price: null, conversion: null });
    const said = (id: string) => lines(id).map((l) => `${l.label}: ${l.value}`).join(" · ");

    check("a journey the page marks “Works” does not read “0 of 100” (run #247)",
      !lines("j_works").some((l) => l.value === "0 of 100"), said("j_works"));
    check("…nor one marked “Works · partly verified”",
      !lines("j_partly").some((l) => l.value === "0 of 100"), said("j_partly"));
    check("…while its price, which says nothing about finishing, stays",
      lines("j_works").some((l) => l.value === "3 actions to finish"), said("j_works"));
    check("a journey the page marks “Broken” keeps its zero — there it agrees",
      lines("j_broken").some((l) => l.value === "0 of 100"), said("j_broken"));
    check("any other estimate is untouched",
      lines("j_fine").some((l) => l.value === "80 of 100"), said("j_fine"));
  }

  console.log("\n— 2. one page, one page name, no two counts that disagree —\n");
  {
    // The exact stages the two journeys of run #247 were counted along.
    const browse = pagesLine(
      journeyPages([{ stage: "/checks/today", count: 3 }, { stage: "/verdict/:id", count: 1 }], "/"),
      14,
    );
    const example = pagesLine(
      journeyPages([{ stage: "/", count: 7 }, { stage: "/verdict/:id", count: 0 }], "/"),
      14,
    );
    console.log(`      ${browse?.value}\n      ${example?.value}\n`);
    check("a count taken from the front door says so",
      /0 people reached \/verdict\/:id from \//.test(example?.value ?? ""), example?.value);
    check("…without leading with the front door's crowd (CHE-287)",
      !(example?.value ?? "").includes("7 "), example?.value);
    check("a path that does not start at the front door is not given one",
      !(browse?.value ?? "").includes(" from "), browse?.value);

    const login = pagesLine(journeyPages([{ stage: "/", count: 1446 }, { stage: "/login", count: 74 }], "/"), 14);
    check("joblander.app run #254: “74 people reached /login” names where they came from",
      login?.value === "74 people reached /login from /, last 14 days", login?.value);
  }

  console.log("\n— 3. “we expected” is true of the estimate on the same page —\n");
  {
    // 45% of 400 reached the second page: a struggling journey, by their count.
    const struggling = completionOf(
      journeyPages([{ stage: "/", count: 9000 }, { stage: "/a", count: 400 }, { stage: "/b", count: 180 }], "/"),
      14,
    )!;
    const hardGoing = comparisonLine({ price: 4, conversion: 60 }, struggling);
    check("“we expected this to be hard going” never sits under our own 60 of 100",
      hardGoing === null || !/expected this to be hard going/.test(hardGoing), String(hardGoing));

    const low = completionOf(
      journeyPages([{ stage: "/", count: 9000 }, { stage: "/a", count: 400 }, { stage: "/b", count: 60 }], "/"),
      14,
    )!;
    const most = comparisonLine({ price: 4, conversion: 40 }, low);
    check("“we expected most people to get through” never sits under our own 40 of 100",
      most === null || !/expected most people/.test(most), String(most));

    // The sentences that were right stay.
    check("a real optimistic miss is still said",
      /expected most people/.test(comparisonLine({ price: 4, conversion: 80 }, low) ?? ""));
    check("a real agreement on a hard journey is still said",
      /hard going/.test(comparisonLine({ price: 4, conversion: 40 }, struggling) ?? ""));
  }

  console.log("\n— 4. the gap a sentence names is the gap between the numbers it prints —\n");
  {
    const day = (n: number) => new Date(2026, 8, n);
    const pts = (...convs: number[]): MetricPoint[] =>
      convs.map((conversion, i) => ({ conversion, sampleSize: 1000, measuredAt: day(20 - i) }));
    const path = { from: "/", to: "/signup" };
    for (const [name, series] of [
      ["a fall", pts(30, 35, 36, 36)],
      ["a rise", pts(47, 40, 41, 41)],
    ] as const) {
      const s = movementSentence("Sign up", movementOf(series), path) ?? "";
      console.log(`      ${s}`);
      const pcts = [...s.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
      const gap = Number(/(\d+(?:\.\d+)?) points?/.exec(s)?.[1]);
      check(`${name}: it prints two percentages`, pcts.length === 2, s);
      check(`${name}: the gap it names is their difference`,
        pcts.length === 2 && gap === Math.abs(pcts[0] - pcts[1]), s);
    }
  }

  console.log("\n— 5 & 6. the mail compares this walk with the one before it —\n");
  {
    const PLAN_NOW = ["Open /signup", "Fill the form", "Enter the code from your email"];
    const STEPS = JSON.stringify([{ stage: "/", count: 1000 }, { stage: "/signup", count: 400 }]);
    const day = (n: number) => new Date(2026, 8, n);
    const points = [15, 39, 41, 40].map((conversion, i) => ({
      conversion, sampleSize: 1000, measuredAt: day(20 - i), steps: STEPS,
    }));

    function env(opts: { status: string; prevStatus: string; previous: boolean }) {
      const db = {
        run: { findUnique: async () => ({ snapshotId: null, createdAt: day(20) }) },
        appSnapshot: { findUnique: async () => null },
        journey: {
          findMany: async () => [
            {
              order: 0,
              status: opts.status,
              appJourneyId: "aj_signup",
              steps: PLAN_NOW.map((label) => ({ label })),
              appJourney: {
                title: "Sign up",
                price: 6,
                prevPrice: 6,
                // What recordWalk leaves in the catalog row by the time the
                // mail is composed: THIS walk's plan and status.
                plan: JSON.stringify(PLAN_NOW),
                status: opts.status,
                funnelStages: null,
                metricPoints: points,
              },
            },
          ],
          // The previous walk of the same journey, as its own Journey row.
          findFirst: async () => (opts.previous ? { status: opts.prevStatus } : null),
        },
        finding: { findMany: async () => [] },
      };
      return { db } as unknown as Parameters<typeof metricAlertsForRun>[0];
    }

    const grew = (await metricAlertsForRun(env({ status: "confusing", prevStatus: "ok", previous: true }), "run_2"))[0]?.sentence ?? "";
    console.log(`      ${grew}\n`);
    check("a journey that went from Works to Confusing is not mailed “Nothing changed”",
      !/Nothing changed in this flow/.test(grew), grew);
    check("the status is said in the page's words",
      grew.includes("“Confusing”") && grew.includes("“Works”"), grew);
    check("…never as a stored code",
      !/“(ok|confusing|partial)”/.test(grew), grew);

    const first = (await metricAlertsForRun(env({ status: "confusing", prevStatus: "ok", previous: false }), "run_2"))[0]?.sentence ?? "";
    check("with no earlier walk, no status change is claimed",
      !first.includes("now reads as"), first);

    const coverage = flowChanges({
      price: null, prevPrice: null, plan: [], prevPlan: [],
      status: "partial", prevStatus: "ok", newFindings: [], pageChanged: false,
    });
    check("“Works” to “Works · partly verified” is not a change in the flow",
      coverage.length === 0, JSON.stringify(coverage));
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
