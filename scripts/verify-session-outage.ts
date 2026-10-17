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
import { egressTunnelFailed, SESSION_OUTAGE_MESSAGE, sessionWalkReachedNothing, type WalkedJourney } from "../src/agent/session-outage";
import { classifyRunFailure } from "../src/agent/run-failures";
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

const WORKFLOW_PATH = "src/agent/workflow.ts";
const real = source(WORKFLOW_PATH);

// 1b. CHE-455: runs #375/#376/#411 — admin.shopify.com, a signed-in session, the
// first page never loaded: the proxy would not open the tunnel. The message is
// byte for byte from the ticket.
const TUNNEL =
  'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://admin.shopify.com/store/prod-release-1/apps/easy-block-customer-ip-country\nCall log:\n  - navigating to "https://admin.shopify.com/store/prod-release-1/apps/easy-block-customer-ip-country", waiting until "domcontentloaded"\n';
check("a tunnel the proxy would not open is recognised", egressTunnelFailed(TUNNEL));
check("…and a site that merely reset the connection is not", !egressTunnelFailed("page.goto: net::ERR_CONNECTION_RESET at https://shop.example.org/") && !egressTunnelFailed("page.goto: Timeout 30000ms exceeded."));
const facts = { budget: false, isExtension: false, afterVerdict: false, ourTarget: false, message: TUNNEL };
for (const targetAnswers of [true, false, null]) {
  const c = classifyRunFailure({ ...facts, targetAnswers });
  check(
    `the failure is ours whatever a plain request got (${String(targetAnswers)}), and says it is our egress`,
    c.kind === "ours" && /egress/.test(c.signature) && !/answers a plain request/.test(c.signature),
    JSON.stringify(c),
  );
}
check(
  "the workflow's fail path treats it as the session outage (feed line, watch retried)",
  /const sessionOutage =[^;]*egressTunnelFailed\(msg\)/.test(real.getText().replace(/\s+/g, " ")),
);

// 2. Wiring, read as syntax — every call site, and the fail branch's actions.
// Returns what is wrong; run on the real workflow, then on mutants of it, so
// each answer is seen failing too.
function wiringFaults(wf: ts.SourceFile): string[] {
  const faults: string[] = [];
  const writing = calls(wf).find((c) => c.callee === "step.do" && c.args[0] === '"writing"');
  const transitionWriting = writing && calls(wf, writing.node).find((c) => c.callee === "transition" && c.args[2] === '"writing"');
  const asked = calls(wf).filter((c) => c.callee === "sessionWalkReachedNothing");
  if (asked.length === 0) faults.push("never asked");
  for (const a of asked) {
    const at = `line ${wf.getLineAndCharacterOfPosition(a.node.getStart(wf)).line + 1}`;
    const ifs: ts.IfStatement[] = [];
    for (let n: ts.Node | undefined = a.node; n; n = n.parent) if (ts.isIfStatement(n)) ifs.push(n);
    if (!ifs.slice(1).some((s) => s.expression.getText(wf) === "isSession")) faults.push(`${at}: not only for a session run`);
    const own = ifs[0];
    const thrown = own && own.expression === a.node && ts.isThrowStatement(own.thenStatement) ? own.thenStatement.expression : undefined;
    const isOurs =
      thrown && ts.isNewExpression(thrown) && thrown.expression.getText(wf) === "NonRetryableError" &&
      thrown.arguments?.map((x) => x.getText(wf)).join(",") === 'SESSION_OUTAGE_MESSAGE,"SessionOutageError"';
    if (!isOurs) faults.push(`${at}: does not throw the non-retryable outage`);
    const start = a.node.getStart(wf);
    if (!writing || !transitionWriting || start < writing.node.getStart(wf) || start > transitionWriting.node.getStart(wf)) {
      faults.push(`${at}: not inside the writing step before its transition`);
    }
  }
  // The fail branch: `if (… || sessionOutage)` must write the feed line and move the watch.
  const branches: ts.IfStatement[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIfStatement(n) && /\bsessionOutage\b/.test(n.expression.getText(wf))) branches.push(n);
    n.forEachChild(visit);
  };
  visit(wf);
  if (branches.length !== 1) faults.push(`${branches.length} fail branches on sessionOutage`);
  for (const b of branches) {
    const inside = calls(wf, b.thenStatement);
    if (!inside.some((c) => c.callee === "appendEvent")) faults.push("the fail branch writes no feed line");
    const retry = inside.find((c) => /\.watch\s*\.update$/.test(c.callee.replace(/\s+/g, "")));
    if (!retry || !/nextRunAt/.test(retry.args[0] ?? "")) faults.push("the fail branch does not move the watch's next run");
  }
  return faults;
}

const WORKFLOW = WORKFLOW_PATH;
const faults = wiringFaults(real);
check("the workflow asks it inside the writing step, only for a session run, and throws our outage; the fail path writes the feed line and retries the watch", faults.length === 0, faults.join("; "));

// The same reading must fail on each way the wiring could go wrong.
const mutant = (from: string, to: string) => {
  const text = real.getText();
  if (!text.includes(from)) throw new Error(`mutant source not found: ${from}`);
  return ts.createSourceFile(WORKFLOW, text.replace(from, to), ts.ScriptTarget.Latest, true);
};
const askedLine = "if (sessionWalkReachedNothing(walked)) throw new NonRetryableError(SESSION_OUTAGE_MESSAGE, \"SessionOutageError\");";
const mutants: [string, ts.SourceFile][] = [
  ["a second call outside the session guard", mutant("async function transition(", `function stray(w: never) { if (sessionWalkReachedNothing(w)) throw new NonRetryableError(SESSION_OUTAGE_MESSAGE, "SessionOutageError"); }\nasync function transition(`)],
  ["the call no longer throws", mutant(askedLine, "if (sessionWalkReachedNothing(walked)) console.warn(SESSION_OUTAGE_MESSAGE);")],
  ["the fail branch loses its feed line", mutant("await appendEvent(env, runId, \"connecting\", {\n            icon: \"warn\",", "await Promise.resolve({\n            icon: \"warn\",")],
  ["the fail branch stops retrying the watch", mutant("data: { nextRunAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },\n              })\n              .catch(() => {});\n          }\n        }\n        return { phase: before?.status ?? null", "data: {},\n              })\n              .catch(() => {});\n          }\n        }\n        return { phase: before?.status ?? null")],
];
for (const [name, sf] of mutants) check(`…and fails when ${name}`, wiringFaults(sf).length > 0, wiringFaults(sf).join("; ") || "still green");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
