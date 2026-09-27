// CHE-242 verification: the pairing, assembled the way the mail assembles it.
//
// `verify-flow-changes.ts` holds `flowChanges` and `pairedSentence` to account
// as pure functions. `verify-metric-movement.ts` holds the judgement. Neither
// touches `metricAlertsForRun`, which is the part that decides WHICH journeys
// speak and composes what the owner actually reads — and that assembly had no
// coverage at all.
//
// That matters more here than usual, because the sentence this file exercises
// has never been rendered in production and cannot be on demand: an alert needs
// four measured points on one journey AND a genuine material fall in a real
// customer's traffic. The second cannot be arranged honestly. So this is the
// closest thing to the live message that can exist without inventing one, and it
// drives the real function rather than a reimplementation of it.
//
// What CHE-242 asks for, and what is checked here:
//
//   "an app where a flow got more expensive and converted worse gets one
//    message with both facts in it"
//   "an app where the number moved and the flow did not gets the movement and
//    an explicit 'nothing changed here'"
//   "and no message ever names a file, a cause or a fix"
//
// The last is rule 9 — take them over the water, do not build them the bridge —
// and it is checked over the ASSEMBLED sentence, not over the fragments, because
// a sentence can acquire a diagnosis in the joining.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-metric-alerts.ts

import { metricAlertsForRun } from "@/agent/metric-alerts";
import { MATERIAL_POINTS } from "@/lib/metric-movement";
import { hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const STEPS = JSON.stringify([
  { stage: "/", count: 1000 },
  { stage: "/signup", count: 400 },
]);

const day = (n: number) => new Date(2026, 8, n);

/** Points newest first, as CHE-239 stores them. */
function points(...convs: number[]) {
  return convs.map((conversion, i) => ({
    conversion,
    sampleSize: 1000,
    measuredAt: day(20 - i),
    steps: STEPS,
  }));
}

interface Spec {
  title: string;
  convs: number[];
  price?: number | null;
  prevPrice?: number | null;
  plan?: string[];
  prevPlan?: string[];
  status?: string | null;
  prevStatus?: string | null;
  findings?: string[];
  steps?: string | null;
  /** The pages this journey's funnel names, as the catalog holds them. */
  stages?: string[] | null;
}

/** What the run's own snapshot says about the app's pages (CHE-285). */
interface Survey {
  /** Present unless the run took no survey at all. */
  snapshotId?: string | null;
  /** NULL = nothing comparable to compare against. */
  changed?: boolean | null;
  changedPaths?: string[];
  addedPaths?: string[];
  /** Make the snapshot read blow up, to prove what it costs. */
  broken?: boolean;
}

function build(specs: Spec[], survey: Survey = {}) {
  const db = {
    run: {
      findUnique: async () => ({
        snapshotId: survey.snapshotId === undefined ? "snap_1" : survey.snapshotId,
        createdAt: day(20),
      }),
    },
    appSnapshot: {
      findUnique: async () => {
        if (survey.broken) throw new Error("D1 unavailable");
        return {
          changed: survey.changed === undefined ? true : survey.changed,
          diff: JSON.stringify({
            changedPaths: survey.changedPaths ?? [],
            addedPaths: survey.addedPaths ?? [],
            removedPaths: [],
          }),
        };
      },
    },
    journey: {
      findMany: async () =>
        specs.map((s, i) => ({
          order: i,
          status: s.status ?? "ok",
          appJourneyId: `aj_${i}`,
          steps: (s.plan ?? []).map((label) => ({ label })),
          appJourney: {
            title: s.title,
            price: s.price ?? null,
            prevPrice: s.prevPrice ?? null,
            plan: JSON.stringify(s.prevPlan ?? []),
            // CHE-321: by the time the mail is composed, recordWalk has written
            // THIS walk's status into the catalog row — so that is what the row
            // holds here. The status before is the previous walk's own Journey
            // row, served by findFirst below.
            status: s.status ?? "ok",
            funnelStages: s.stages === undefined ? null : s.stages && JSON.stringify(s.stages),
            metricPoints: points(...s.convs).map((p) => ({
              ...p,
              steps: s.steps === undefined ? STEPS : s.steps,
            })),
          },
        })),
      findFirst: async ({ where }: { where: { appJourneyId: string } }) => {
        const s = specs[Number(where.appJourneyId.slice("aj_".length))];
        return s ? { status: s.prevStatus ?? "ok" } : null;
      },
    },
    finding: {
      findMany: async () =>
        specs.flatMap((s, i) =>
          (s.findings ?? []).map((title) => ({
            title,
            anchor: JSON.stringify({ stepRef: { journeyIndex: i } }),
          })),
        ),
    },
  };
  return { db } as unknown as Parameters<typeof metricAlertsForRun>[0];
}

/** A clear, significant fall: 40% for three checks, then 15%. */
const FELL = [15, 39, 41, 40];
/** Flat: no movement at all. */
const FLAT = [40, 40, 40, 40];
/** Real but under the materiality floor. */
const TINY = [40 - (MATERIAL_POINTS - 2), 40, 40, 40];

async function main() {
  console.log("\n— a flow that got more expensive AND converted worse: one message, both facts —\n");
  {
    const alerts = await metricAlertsForRun(
      build([
        {
          title: "Sign up / create an account",
          convs: FELL,
          price: 8,
          prevPrice: 6,
          plan: ["Open /signup", "Fill the form", "Enter the code from your email"],
          prevPlan: ["Open /signup", "Fill the form"],
        },
      ]),
      "run_1",
    );
    check("exactly one alert", alerts.length === 1, String(alerts.length));
    const s = alerts[0]?.sentence ?? "";
    console.log(`      ${s}\n`);
    check("it names the journey", s.includes("Sign up / create an account"));
    check("it carries the movement", /points? down/.test(s), s);
    check("…and the baseline it moved from", /against \d+% before/.test(s), s);
    check("it carries what got more expensive", /6 → 8 actions/.test(s), s);
    check("…and the step that appeared", /Enter the code from your email/.test(s), s);
    check("both facts are in ONE message", alerts.length === 1 && /down/.test(s) && /What changed/.test(s));
  }

  console.log("— the number moved and the flow did not: say so outright —\n");
  {
    const alerts = await metricAlertsForRun(
      build([{ title: "Checkout", convs: FELL, price: 6, prevPrice: 6, plan: ["a"], prevPlan: ["a"] }]),
      "run_1",
    );
    const s = alerts[0]?.sentence ?? "";
    console.log(`      ${s}\n`);
    check("still one alert — the movement is news on its own", alerts.length === 1);
    check("it says nothing changed, rather than going quiet",
      /Nothing changed in this flow between the two checks\./.test(s), s);
    check("…and does not pretend to a cause", !/because|caused|due to|explains/i.test(s), s);
  }

  console.log("— no alert where there is no movement —\n");
  {
    const flat = await metricAlertsForRun(build([{ title: "Checkout", convs: FLAT }]), "run_1");
    check("a flat series alerts nobody", flat.length === 0, String(flat.length));

    const tiny = await metricAlertsForRun(build([{ title: "Checkout", convs: TINY }]), "run_1");
    check("a real but immaterial move alerts nobody", tiny.length === 0, String(tiny.length));

    const short = await metricAlertsForRun(build([{ title: "Checkout", convs: [15, 40] }]), "run_1");
    check("two points are not a baseline", short.length === 0, String(short.length));

    const rose = await metricAlertsForRun(build([{ title: "Checkout", convs: [70, 39, 41, 40] }]), "run_1");
    check("a rise is good news and does not raise a siren", rose.length === 0, String(rose.length));
  }

  console.log("\n— a movement we cannot name the path of says nothing (CHE-279) —\n");
  {
    const noPath = await metricAlertsForRun(
      build([{ title: "Checkout", convs: FELL, steps: null }]),
      "run_1",
    );
    check("no stored path, no alert", noPath.length === 0, String(noPath.length));
  }

  console.log("\n— CHE-285: the page it runs on is not the page it was —\n");
  {
    const changed = await metricAlertsForRun(
      build([{ title: "Checkout", convs: FELL, stages: ["/cart", "/checkout"] }], {
        changedPaths: ["/checkout"],
      }),
      "run_1",
    );
    const s = changed[0]?.sentence ?? "";
    console.log(`      ${s}\n`);
    check("a stage the survey saw change is said out loud",
      s.includes("the page it runs on is not the page it was"), s);
    check("…and the movement is still the news it sits beside", /points? down/.test(s), s);

    const appeared = await metricAlertsForRun(
      build([{ title: "Checkout", convs: FELL, stages: ["/cart", "/checkout"] }], {
        addedPaths: ["/checkout"],
      }),
      "run_1",
    );
    check("a page that was not there last time counts too",
      (appeared[0]?.sentence ?? "").includes("not the page it was"), appeared[0]?.sentence ?? "");

    // An id-bearing address is most of what sits behind a login. The survey
    // records it literally; the stage that names it cannot. If these two do not
    // meet, the sentence is unsayable for exactly the pages it matters on.
    const viaId = await metricAlertsForRun(
      build([{ title: "Checkout", convs: FELL, stages: ["/", "/order/:id"] }], {
        changedPaths: ["/order/cmtmsvbyx0001rz1tkzevj5dc"],
      }),
      "run_1",
    );
    check("a stage and a literal address for the same page meet",
      (viaId[0]?.sentence ?? "").includes("not the page it was"), viaId[0]?.sentence ?? "");

    console.log("");
    const elsewhere = await metricAlertsForRun(
      build([{ title: "Checkout", convs: FELL, stages: ["/cart", "/checkout"] }], {
        changedPaths: ["/blog/hello", "/pricing"],
      }),
      "run_1",
    );
    check("a page somewhere else in the app is not this journey's page",
      !(elsewhere[0]?.sentence ?? "").includes("not the page it was"), elsewhere[0]?.sentence ?? "");

    const noFunnel = await metricAlertsForRun(
      build([{ title: "Checkout", convs: FELL, stages: null }], { changedPaths: ["/checkout"] }),
      "run_1",
    );
    check("a journey that names no pages claims nothing about them",
      !(noFunnel[0]?.sentence ?? "").includes("not the page it was"), noFunnel[0]?.sentence ?? "");

    const notComparable = await metricAlertsForRun(
      build([{ title: "Checkout", convs: FELL, stages: ["/cart", "/checkout"] }], {
        changed: null,
        changedPaths: ["/checkout"],
      }),
      "run_1",
    );
    check("nothing comparable to compare against says nothing, not everything",
      !(notComparable[0]?.sentence ?? "").includes("not the page it was"),
      notComparable[0]?.sentence ?? "");

    const noSurvey = await metricAlertsForRun(
      build([{ title: "Checkout", convs: FELL, stages: ["/cart", "/checkout"] }], {
        snapshotId: null,
        changedPaths: ["/checkout"],
      }),
      "run_1",
    );
    check("a run that took no survey claims nothing about pages",
      !(noSurvey[0]?.sentence ?? "").includes("not the page it was"), noSurvey[0]?.sentence ?? "");

    const brokenDiff = await metricAlertsForRun(
      build([{ title: "Checkout", convs: FELL, stages: ["/cart", "/checkout"] }], {
        broken: true,
        changedPaths: ["/checkout"],
      }),
      "run_1",
    );
    check("a diff we could not read costs the line, never the alert",
      brokenDiff.length === 1 && !(brokenDiff[0]?.sentence ?? "").includes("not the page it was"),
      brokenDiff[0]?.sentence ?? "(no alert)");
  }

  console.log("\n— rule 9: the message names the symptom, never a cause or a fix —\n");
  {
    // Every shape of change at once, so the joined sentence is the longest and
    // most diagnosis-prone one the assembly can produce.
    const alerts = await metricAlertsForRun(
      build([
        {
          title: "Book a demo",
          convs: FELL,
          price: 9,
          prevPrice: 4,
          plan: ["Open /demo", "Pick a slot", "Confirm by email"],
          prevPlan: ["Open /demo", "Pick a slot"],
          status: "confusing",
          prevStatus: "ok",
          findings: ["The confirm button reports success and books nothing"],
          stages: ["/", "/demo"],
        },
      ], { changedPaths: ["/demo"] }),
      "run_1",
    );
    const s = alerts[0]?.sentence ?? "";
    console.log(`      ${s}\n`);

    const BANNED = [
      "fix", "cause", "caused", "because", "due to", "should", "try ", "add a", "remove the",
      "revert", "deploy", "regression", "bug in", ".ts", ".tsx", ".js", "src/", "function ",
    ];
    for (const w of BANNED) {
      check(`never says "${w.trim()}"`, !s.toLowerCase().includes(w), s.length > 0 ? s : "(empty)");
    }
    check("no homework for the customer", !hasHomework(s), s);
    check("no narration of how we check", !hasNarration(s), s);
    check("the finding is named as a problem, not as work to do",
      s.includes("a problem on one of its steps"), s);
  }

  console.log("\n— a failure costs the alert, never the mail —\n");
  {
    const broken = {
      db: {
        journey: { findMany: async () => { throw new Error("D1 unavailable"); } },
        finding: { findMany: async () => [] },
      },
    } as unknown as Parameters<typeof metricAlertsForRun>[0];
    let threw = false;
    let out: unknown;
    try {
      out = await metricAlertsForRun(broken, "run_1");
    } catch {
      threw = true;
    }
    check("a database failure does not throw into the mail", !threw);
    check("…and yields no alerts rather than a half-written one",
      Array.isArray(out) && out.length === 0, JSON.stringify(out));
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
