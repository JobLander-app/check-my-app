// CHE-129 verification: recorded actions carry no secret, and a replay
// classifies what it saw honestly.
//
// The spike's whole value is a number — how many journeys a browser can redo
// without a model — and that number is only worth anything if two things hold
// deterministically. First, what gets written into Step.actions is executable
// and never a credential: the fill value keeps its {{TEST_PASSWORD}}
// placeholder, and a refused or errored call (which never ran) records nothing,
// or a replay would redo what the walk did not. Second, the replay reads the
// tool's own result text the way the walk did, so "reproduced" means the same
// thing at both ends. Both are exercised here through the real executeTool and
// the real replayJourney with a stub page and a stub browser — no Browser
// Rendering session, no tokens, no product anywhere near it.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-replay-actions.ts

import { executeTool, type RecordedAction, type ToolEnv } from "@/agent/tools";
import {
  classifyResult,
  replayJourney,
  replayNote,
  rollUpJourney,
  worstOutcome,
  type ReplayStepResult,
} from "@/agent/journey-replay";
import type { AgentEnv } from "@/agent/env";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const SECRET = "s3cret-value";

// Enough of a Playwright page for navigate/click/fill to run end to end. A
// click "reacts" (one request, a navigation) unless told to throw, so the
// executor takes its normal path rather than the inert-fallback ladder.
function stubPage(networkLog: string[], opts: { clickThrows?: boolean } = {}) {
  let url = "https://target.test/login";
  let filled = "";
  const locator = {
    first: () => locator,
    count: async () => 1,
    or: () => locator,
    elementHandle: async () => null,
    click: async () => {
      if (opts.clickThrows) throw new Error("locator.click: Timeout 8000ms exceeded");
      networkLog.push("POST https://target.test/api/session → 200");
      url = "https://target.test/app";
    },
    fill: async (v: string) => {
      filled = v;
    },
    // A credential is written in the page by tools.ts WRITE_SECRET (CHE-373); here it lands.
    evaluate: async (_write: unknown, arg: { value: string }) => {
      filled = arg.value;
      return "ok";
    },
    inputValue: async () => filled,
  };
  return {
    url: () => url,
    goto: async (u: string) => {
      url = u;
      return { status: () => 200 };
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => 0,
    addInitScript: async () => {},
    on: () => {},
    getByRole: () => locator,
    getByLabel: () => locator,
    getByPlaceholder: () => locator,
    getByText: () => locator,
    locator: () => locator,
  };
}

function stubEnv(opts: { clickThrows?: boolean } = {}): ToolEnv {
  const networkLog: string[] = [];
  return {
    page: stubPage(networkLog, opts),
    targetOrigin: "https://target.test",
    testEmail: "qa@target.test",
    testPassword: SECRET,
    networkLog,
    consoleLog: [],
    credentials: { rejected: false },
    actionTrail: [],
  } as unknown as ToolEnv;
}

async function main() {
  // (a) — the three executable tools record an action of the expected shape.
  const env = stubEnv();
  const trail = env.actionTrail as RecordedAction[];

  await executeTool(env, "navigate", { url: "https://target.test/login" });
  const nav = trail[0];
  check(
    "navigate records {kind, url, outcome.urlAfter}",
    nav?.kind === "navigate" &&
      nav.url === "https://target.test/login" &&
      nav.outcome.urlAfter === "https://target.test/login" &&
      nav.outcome.status === 200,
    JSON.stringify(nav),
  );

  await executeTool(env, "fill", { label: "Email", value: "{{TEST_EMAIL}}" });
  await executeTool(env, "fill", { label: "Password", value: "{{TEST_PASSWORD}}" });
  const pwd = trail[2];
  check(
    "fill records the placeholder, never the password",
    pwd?.kind === "fill" && pwd.label === "Password" && pwd.value === "{{TEST_PASSWORD}}",
    JSON.stringify(pwd),
  );

  // The model occasionally pastes back a value the page echoed. Even then the
  // secret does not reach the column.
  await executeTool(env, "fill", { selector: "#confirm", value: SECRET });
  const pasted = trail[3];
  check(
    "fill of a literal secret is scrubbed before recording",
    pasted?.kind === "fill" && pasted.value === "[redacted]",
    JSON.stringify(pasted),
  );

  await executeTool(env, "click", { role: "button", name: "Sign in" });
  const clk = trail[4];
  check(
    "click records {role, name, outcome.navigated/requests/mutations/urlAfter}",
    clk?.kind === "click" &&
      clk.role === "button" &&
      clk.name === "Sign in" &&
      clk.outcome.navigated === true &&
      clk.outcome.requests === 1 &&
      clk.outcome.mutations === 0 &&
      clk.outcome.urlAfter === "https://target.test/app",
    JSON.stringify(clk),
  );

  const serialized = JSON.stringify(trail);
  check(
    "the whole trail serializes without the secret or the email",
    !serialized.includes(SECRET) && !serialized.includes("qa@target.test"),
    `${trail.length} actions, ${serialized.length} chars`,
  );

  // (b) — what did not run is not recorded. A create-shaped click in a
  // read-only run is refused before the browser is touched…
  const before = trail.length;
  const refused = await executeTool(env, "click", { role: "button", name: "Create account" });
  check(
    "refused click (create verb, read-only run) records nothing",
    refused.startsWith("Refused:") && trail.length === before,
    refused.slice(0, 60),
  );
  // …and a click Playwright could not perform is not an action either. CHE-214
  // changed what it SAYS — a bare "Error:" invited the model to read the
  // silence as a defect — but not what it records, and a replay still counts
  // it as errored.
  const broken = stubEnv({ clickThrows: true });
  const errored = await executeTool(broken, "click", { role: "button", name: "Sign in" });
  check(
    "undrivable click (locator timeout) records nothing",
    (broken.actionTrail as RecordedAction[]).length === 0,
    errored.slice(0, 60),
  );
  check(
    "…and says it was ours, with the step to report",
    errored.includes("could not be driven from here") && errored.includes("our_capability"),
    errored.slice(0, 120),
  );
  check(
    "…and a replay reads that as errored, not ok",
    classifyResult("click", errored) === "errored",
    classifyResult("click", errored),
  );
  // Observation tools are not part of the path.
  await executeTool(env, "get_network_log", {});
  check("get_network_log records nothing", trail.length === before);

  // (c) — the classifier reads the tool's own words.
  const cases: Array<[Parameters<typeof classifyResult>[0], string, string]> = [
    ["click", "Error: locator.click: Timeout 8000ms exceeded", "errored"],
    ["fill", "Refused: this product's auth endpoint already rejected the credential", "refused"],
    ["click", "Clicked, but the page did not react AT ALL: 0 network requests", "diverged"],
    ["navigate", "Navigated to https://t.dev/ (status 503)", "diverged"],
    ["navigate", "Navigated to https://t.dev/ (status 200)", "ok"],
    ["navigate", "Navigated to https://t.dev/missing (status 404)", "ok"],
    ["click", "Clicked (strategy: trusted click). Current URL: https://t.dev/app (2 network requests)", "ok"],
    ["click", "The credential we hold was REJECTED (POST /api/auth → 401).", "diverged"],
    ["fill", "Filled (credential substituted server-side).", "ok"],
  ];
  for (const [kind, text, expect] of cases) {
    const got = classifyResult(kind, text);
    check(`classify: "${text.slice(0, 44)}…" → ${expect}`, got === expect, got);
  }

  // Step roll-up is worst-of; an empty step is no_actions.
  check("step: worst of [ok, refused, ok] is refused", worstOutcome(["ok", "refused", "ok"]) === "refused");
  check("step: worst of [refused, diverged] is diverged", worstOutcome(["refused", "diverged"]) === "diverged");
  check("step: worst of [diverged, errored] is errored", worstOutcome(["diverged", "errored"]) === "errored");
  check("step: no actions is no_actions", worstOutcome([]) === "no_actions");

  // Journey roll-up.
  check("journey: all ok → reproduced", rollUpJourney(["ok", "ok"]) === "reproduced");
  check(
    "journey: ok + no_actions → reproduced (unexecutable steps do not count against it)",
    rollUpJourney(["ok", "no_actions", "ok"]) === "reproduced",
  );
  check("journey: only no_actions → no_actions", rollUpJourney(["no_actions", "no_actions"]) === "no_actions");
  check("journey: empty → no_actions", rollUpJourney([]) === "no_actions");
  check("journey: ok + refused → refused", rollUpJourney(["ok", "refused"]) === "refused");
  check(
    "journey: refused + diverged + ok → diverged (worst step wins)",
    rollUpJourney(["refused", "diverged", "ok"]) === "diverged",
  );
  check("journey: anything + errored → errored", rollUpJourney(["ok", "diverged", "errored"]) === "errored");

  const noted: ReplayStepResult[] = [
    { order: 0, label: "Open login", status: "ok", detail: null },
    { order: 1, label: "Enter email", status: "ok", detail: null },
    { order: 2, label: "Submit", status: "diverged", detail: "click button Sign in → Clicked, but the page did not react AT ALL" },
    { order: 3, label: "See dashboard", status: "ok", detail: null },
    { order: 4, label: "Check header", status: "no_actions", detail: null },
  ];
  const note = replayNote(noted);
  check(
    "note names the count and the first step that did not reproduce",
    note.startsWith("3 of 4 steps reproduced; step 3 \"Submit\" diverged:") &&
      note.endsWith("1 step without recorded actions"),
    note,
  );

  // (d) — the real replay loop over a stub browser: the same gates the walk
  // had apply, and the journey's verdict follows from them.
  const agentEnv = {
    db: {
      run: {
        findUnique: async () => ({ credentialsRejected: false }),
        update: async () => ({}),
      },
    },
  } as unknown as AgentEnv;
  let contextClosed = false;
  const browser = {
    newContext: async () => ({
      newPage: async () => stubPage([]),
      close: async () => {
        contextClosed = true;
      },
    }),
  } as unknown as Parameters<typeof replayJourney>[1];
  const result = await replayJourney(
    agentEnv,
    browser,
    { id: "run_stub", targetUrl: "https://target.test", testEmail: "qa@target.test", testPasswordEnc: null },
    {
      id: "journey_stub",
      title: "Sign in and create a record",
      steps: [
        {
          order: 0,
          label: "Open login",
          actions: JSON.stringify([
            { kind: "navigate", url: "https://target.test/login", outcome: { urlAfter: "https://target.test/login", status: 200 } },
            { kind: "fill", label: "Email", value: "{{TEST_EMAIL}}", outcome: { urlAfter: "https://target.test/login" } },
          ]),
        },
        {
          order: 1,
          label: "Leave the site",
          actions: JSON.stringify([
            { kind: "navigate", url: "https://elsewhere.test/", outcome: { urlAfter: "https://elsewhere.test/", status: 200 } },
          ]),
        },
        {
          order: 2,
          label: "Create a record",
          actions: JSON.stringify([
            { kind: "click", role: "button", name: "Create record", outcome: { urlAfter: "https://target.test/app", navigated: true, requests: 1, mutations: 0 } },
          ]),
        },
        { order: 3, label: "Read the result", actions: null },
        { order: 4, label: "Garbage column", actions: "{not json" },
      ],
    },
    (b) => b.newContext({}),
  );
  check(
    "replay: origin gate and create gate both refuse; journey is refused",
    result.status === "refused" &&
      result.steps.map((s) => s.status).join(",") === "ok,refused,refused,no_actions,no_actions",
    result.steps.map((s) => `${s.order}:${s.status}`).join(" "),
  );
  check(
    "replay: note says how far it got",
    result.note.startsWith("1 of 3 steps reproduced; step 2 \"Leave the site\" refused:") &&
      result.note.includes("2 steps without recorded actions"),
    result.note,
  );
  check("replay: the browser context is closed afterwards", contextClosed);

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
