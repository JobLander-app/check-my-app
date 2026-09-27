// CHE-240 verification: two numbers about the same journey, never mistaken for
// each other.
//
// "45 of 100 finish" is something we believe. "38% of 412 people over 14 days"
// is something that happened. Only the second is worth rearranging a roadmap
// for, and a reader who cannot tell them apart will act on the wrong one.
//
// So this file checks three things a careful writer would otherwise have to
// remember every time:
//
//   1. every number carries its source, and the two sources are never the same
//      word — an unlabelled number is the whole defect;
//   2. "not connected", "no funnel" and "not enough traffic" are three
//      different sentences, and none of them is a blank cell that reads as a
//      zero;
//   3. every string here passes the rule 1 leak detector that already exists
//      (src/lib/verdict-language.ts) — these are read by the customer, and the
//      worst failure is homework: never "check this yourself".
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-journey-numbers.ts

import {
  journeyPages,
  pagesLine,
  noMeasurementLine,
  ourLines,
  type NoMeasurement,
} from "@/lib/journey-numbers";
import { hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

/** Every customer-facing string this module can emit, for the rule 1 sweep. */
function everyString(): string[] {
  const out: string[] = [];
  for (const p of [null, 1, 8]) {
    for (const c of [null, 0, 45, 92]) {
      for (const l of ourLines({ price: p, conversion: c })) out.push(l.label, l.value, l.source);
    }
  }
  for (const conv of [null, 0, 38, 100]) {
    const l = pagesLine(journeyPages([{ stage: "/", count: 412 }, { stage: "/cart", count: conv ?? 0 }, { stage: "/thanks", count: 7 }], "/"), 14);
    if (l) out.push(l.label, l.value, l.source);
  }
  for (const r of ["not_connected", "no_funnel", "not_measured_yet", "below_floor"] as NoMeasurement[]) {
    out.push(noMeasurementLine(r), noMeasurementLine(r, 25));
  }
  return out;
}

function main() {
  console.log("Every number names its source, and the two are never the same word");
  {
    const ours = ourLines({ price: 8, conversion: 45 });
    check("our effort line exists and is labelled ours",
      ours[0].value === "8 actions to finish" && ours[0].source === "our estimate", JSON.stringify(ours[0]));
    check("our conversion line says 'of 100', never a percent sign",
      ours[1].value === "45 of 100" && !ours[1].value.includes("%"), ours[1].value);
    check("…because a percent sign is what their measurement looks like",
      ours.every((l) => !l.value.includes("%")));
    check("every one of our lines is sourceKind 'ours'", ours.every((l) => l.sourceKind === "ours"));

    const theirs = pagesLine(journeyPages([{ stage: "/", count: 412 }, { stage: "/cart", count: 38 }, { stage: "/thanks", count: 7 }], "/"), 14);
    // CHE-321: "from /" — the count starts at the front door even though the
    // front door's own number is left out, and saying so is what keeps two
    // journeys on one page from printing two different counts for one page.
    check("their line counts people on named pages of the customer's product",
      theirs?.value === "38 people reached /cart from /, then 7 to /thanks — last 14 days",
      theirs?.value);
    check("…sourced to them, not to us", theirs?.source === "your analytics", theirs?.source);
    check("…and marked as a measurement", theirs?.sourceKind === "measured");

    check("the two sources are different words",
      ours[0].source !== theirs?.source, `${ours[0].source} vs ${theirs?.source}`);
    check("neither source word claims the other's authority",
      !/measur|actual|real/i.test(ours[0].source) && !/estimat|judg|think/i.test(theirs?.source ?? ""),
      `${ours[0].source} | ${theirs?.source}`);

    check("one action is singular", ourLines({ price: 1, conversion: null })[0].value === "1 action to finish");
    check("an unpriced journey produces no line rather than a zero",
      ourLines({ price: null, conversion: null }).length === 0);
    check("a zero we did judge is still a line — 0 is a number, not an absence",
      ourLines({ price: null, conversion: 0 }).length === 1);
    check("a large sample is readable",
      pagesLine(journeyPages([{ stage: "/", count: 9 }, { stage: "/a", count: 41234 }], "/"), 14)?.value.includes("41,234"));
  }

  console.log("\nNo measurement is three different sentences, never a blank");
  {
    const notConnected = noMeasurementLine("not_connected");
    const noFunnel = noMeasurementLine("no_funnel");
    const belowFloor = noMeasurementLine("below_floor", 25);
    const notYet = noMeasurementLine("not_measured_yet");
    const all = [notConnected, noFunnel, belowFloor, notYet];
    check("all four are non-empty", all.every((s) => s.length > 20));
    check("…and all four differ", new Set(all).size === 4, all.join(" | "));
    // The one that matters most: "nothing has counted it yet" must NOT be
    // dressed as "not enough traffic". The second states something about the
    // customer's users that we have not established.
    check("'not counted yet' does not claim anything about their traffic",
      !/enough traffic|too few|not many/i.test(notYet), notYet);
    check("'not connected' offers the thing that would fix it",
      /connect your analytics/i.test(notConnected), notConnected);
    check("'not enough traffic' says how little, so it is a fact with a number",
      belowFloor.includes("25"), belowFloor);
    check("…and one person is singular", noMeasurementLine("below_floor", 1).includes("1 person"));
    check("no sentence contains a bare 0% that would read as a measurement",
      !all.some((s) => /\b0%/.test(s)));
  }

  console.log("\nThe two numbers sit side by side and are never subtracted");
  {
    // There WAS a sentence here joining them, and it was the best line on the
    // page when it was right. It is gone because the subtraction is invalid:
    // our estimate counts people who set out to do the journey, the measurement
    // counts people who reached one page of it, and on joblander.app the gap
    // between those two denominators was 67 points and produced
    // "97% do not finish it" about a login our own walk had just completed.
    // scripts/verify-measured-denominator.ts is the structural guard; this is
    // the reminder at the place someone would reach for it again (CHE-279).
    const theirs = pagesLine(journeyPages([{ stage: "/", count: 412 }, { stage: "/login", count: 12 }], "/"), 14);
    check("a measured line stands on its own without a verdict attached",
      theirs !== null && !/expect|finish|do not/i.test(theirs.value), theirs?.value);
    check("…and says which page it counted",
      theirs?.value.includes("/login") === true, theirs?.value);
  }

  console.log("\nRule 1: every string here is read by the customer");
  {
    const strings = everyString();
    check("there are strings to check", strings.length > 20, String(strings.length));

    const homework = strings.filter((s) => hasHomework(s));
    check("not one string asks the customer to verify anything — the worst leak",
      homework.length === 0, homework.join(" | "));

    const narration = strings.filter((s) => hasNarration(s));
    check("not one string narrates how we check",
      narration.length === 0, narration.join(" | "));

    const machinery = strings.filter((s) =>
      /\b(browser|headless|playwright|crawl|our test|we clicked|selector|viewport|request count)\b/i.test(s));
    check("no machinery words survive a direct sweep either", machinery.length === 0, machinery.join(" | "));

    // "our estimate" is the one place we may name ourselves — it is the label
    // that makes the number honest, not a description of machinery.
    check("the only mention of us is the source label itself",
      strings.filter((s) => /\bour\b|\bwe\b/i.test(s)).every((s) => /our estimate|we expected|we could not|this looked/i.test(s)),
      strings.filter((s) => /\bour\b|\bwe\b/i.test(s)).join(" | ").slice(0, 200));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
