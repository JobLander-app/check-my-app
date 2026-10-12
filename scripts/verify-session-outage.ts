// CHE-453 verification: a session run whose walk reached nothing of the app is
// our outage — the run fails with an internal reason and publishes nothing.
//
//   1. the rule, on run #373's shape and its neighbours: every step left for our
//      own incapacity and no journey walked → outage; a walk that met missing
//      access, a stop on purpose, or walked anything → a run about the app;
//   2. the workflow asks it before synthesis, only for a session run, and
//      throws a non-retryable error the fail path treats as ours (feed line,
//      the watch retried) — read as syntax.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-session-outage.ts

import ts from "typescript";
import { SESSION_OUTAGE_MESSAGE, sessionWalkReachedNothing, type WalkedJourney } from "../src/agent/session-outage";
import { calls, source } from "./fixtures/ts-source";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ours = (n: number) => Array.from({ length: n }, () => ({ status: "skipped", unverifiedReason: "our_capability" }));
const journey = (steps: WalkedJourney["steps"], status = "skipped", carriedFromRunId: string | null = null): WalkedJourney => ({ status, carriedFromRunId, steps });

// 1. Run #373: five planned journeys, twenty steps, all our_capability.
const run373 = [journey(ours(5)), journey(ours(4)), journey(ours(4)), journey(ours(4)), journey(ours(3)), journey([{ status: "ok", unverifiedReason: null }], "ok", "earlier-run")];
check("run #373: no journey walked, every step ours → our outage", sessionWalkReachedNothing(run373));
check("…carried journeys from earlier runs do not count either way", sessionWalkReachedNothing(run373.filter((j) => !j.carriedFromRunId)));
check("a walk that met missing access is about the app (a sign-in, a store password)", !sessionWalkReachedNothing([journey([...ours(3), { status: "skipped", unverifiedReason: "missing_access" }])]));
check("a walk stopped on purpose (read-only) is about the app", !sessionWalkReachedNothing([journey([...ours(2), { status: "skipped", unverifiedReason: "not_applicable" }])]));
check("one journey walked is a run about the app", !sessionWalkReachedNothing([journey(ours(3)), journey([{ status: "ok", unverifiedReason: null }], "ok")]));
check("a step checked inside a skipped journey is a run about the app", !sessionWalkReachedNothing([journey([...ours(2), { status: "ok", unverifiedReason: null }])]));
check("no journey of its own, only carried ones, is not this rule's", !sessionWalkReachedNothing([journey(ours(3), "skipped", "earlier")]));
check("no step at all is not this rule's", !sessionWalkReachedNothing([journey([])]));
check("the internal reason is internal and names the ticket", SESSION_OUTAGE_MESSAGE.startsWith("internal:") && SESSION_OUTAGE_MESSAGE.includes("CHE-453"));

// 2. Wiring.
const wf = source("src/agent/workflow.ts");
const asked = calls(wf).find((c) => c.callee === "sessionWalkReachedNothing");
let guarded = false;
let throwsOurs = false;
for (let n: ts.Node | undefined = asked?.node; n; n = n.parent) {
  if (ts.isIfStatement(n) && n.expression.getText(wf) === "isSession") guarded = true;
}
if (asked) {
  const ifStmt = asked.node.parent;
  throwsOurs = /new NonRetryableError\(SESSION_OUTAGE_MESSAGE, "SessionOutageError"\)/.test(ifStmt.getText(wf).replace(/\s+/g, " "));
}
check("the workflow asks it only for a session run", guarded);
check("…and throws a non-retryable outage when it holds", throwsOurs);
const writing = calls(wf).find((c) => c.callee === "step.do" && c.args[0] === '"writing"');
const transitionWriting = calls(wf, writing?.node).find((c) => c.callee === "transition" && c.args[2] === '"writing"');
check(
  "…before the verdict is written (before the writing transition, inside the writing step)",
  Boolean(asked && writing && transitionWriting) && asked!.node.getStart(wf) > writing!.node.getStart(wf) && asked!.node.getStart(wf) < transitionWriting!.node.getStart(wf),
);
check("the fail path treats it as our outage: the feed line and the watch retry", /sessionOutage\s*=/.test(wf.getText()) && /if \(budget \|\| sessionOutage\)/.test(wf.getText()));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
