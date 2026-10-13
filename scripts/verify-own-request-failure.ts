// Verification: a request of the product's own that fails for the page and for
// the worker is a defect a visitor meets — not "a gap of ours".
//
// Pilot feedback, joblander.app, run cmv6rr6oq0003261o50vdr2gb: chat.joblander.app
// (the site's self-hosted chat) was down, and its SDK script,
// https://chat.joblander.app/packs/js/sdk.js, never loaded for anyone. Two
// journeys called it broken; five steps in three others were written
// "skipped / our_capability" — one of them justified by probing chatwoot.com, a
// host the page never loaded from. The browser's own failed request was never
// recorded (only responses were), so no step could be settled against it.
//
// Proven here, through the real attachLogCapture and executeTool with a stub
// page and a stub fetch — no browser, no network, no model, no database:
//   1. a failed request to the product's own host is recorded with its exact
//      URL; a cancelled one, a foreign host and a non-http one are not;
//   2. a skipped/our_capability step about it, with the worker failing the same
//      URL too, becomes broken, in words that describe the product only;
//   3. the URL asked is the exact one the page requested, never a host the step
//      happened to name — and the same symptom gets the same answer in a
//      second step of the same walk;
//   4. where the worker's request is answered, or the step is about something
//      else, or carries a machine-decided class, nothing changes;
//   5. the model sees the failure in get_network_log.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-own-request-failure.ts

import { attachLogCapture, executeTool, type ReportedStep, type ToolEnv } from "@/agent/tools";
import { hasEnvironmentLeak } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://joblander.app";
const SDK = "https://chat.joblander.app/packs/js/sdk.js";

type Handler = (arg: unknown) => void;
function stubEnv(): { env: ToolEnv; emit: (event: string, arg: unknown) => void } {
  const handlers = new Map<string, Handler[]>();
  const page = {
    url: () => `${ORIGIN}/login`,
    on: (event: string, h: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), h]),
  };
  const env = {
    page,
    targetOrigin: ORIGIN,
    networkLog: [],
    consoleLog: [],
    writeAllowed: false,
    credentials: { rejected: false },
    actionTrail: [],
  } as unknown as ToolEnv;
  attachLogCapture(env);
  return { env, emit: (event, arg) => (handlers.get(event) ?? []).forEach((h) => h(arg)) };
}
const failedRequest = (url: string, errorText: string) => ({ url: () => url, failure: () => ({ errorText }) });

async function reportStep(env: ToolEnv, input: ReportedStep): Promise<ReportedStep> {
  const reported: ReportedStep[] = [];
  env.onReportStep = async (s) => {
    reported.push(s);
  };
  await executeTool(env, "report_step", { ...input });
  return reported[0];
}

const realFetch = globalThis.fetch;
function stubFetch(answer: (url: string) => { status: number } | Error) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    const a = answer(url);
    if (a instanceof Error) throw a;
    return { status: a.status, url } as Response;
  }) as typeof fetch;
  return asked;
}

const CHAT_STEP: ReportedStep = {
  label: "Support chat bubble on /login",
  status: "skipped",
  unverifiedReason: "our_capability",
  attempted: "Looked for the support chat bubble on the login page",
  observed: "The chat bubble did not appear and could not be confirmed.",
};

async function main() {
  // 1 — what is recorded.
  {
    const { env, emit } = stubEnv();
    emit("requestfailed", failedRequest(SDK, "net::ERR_CONNECTION_RESET"));
    emit("requestfailed", failedRequest(`${ORIGIN}/api/slow`, "net::ERR_ABORTED"));
    emit("requestfailed", failedRequest("https://www.googletagmanager.com/gtm.js", "net::ERR_CONNECTION_RESET"));
    emit("requestfailed", failedRequest("data:text/plain,hello", "net::ERR_FAILED"));
    emit("requestfailed", failedRequest(`${SDK}#frag`, "net::ERR_CONNECTION_RESET"));
    check("own host recorded once, by exact URL; cancelled, foreign and non-http not",
      [...(env.ownRequestFailures?.keys() ?? [])].join(" ") === SDK, [...(env.ownRequestFailures?.keys() ?? [])].join(" "));
    const log = await executeTool(env, "get_network_log", {});
    check("get_network_log shows the model the request that got no answer", log.includes(`${SDK} → no answer`), log);
  }

  // 2 + 3 — the joblander shape: browser failed, worker fails the same URL.
  {
    const { env, emit } = stubEnv();
    emit("requestfailed", failedRequest(SDK, "net::ERR_CONNECTION_RESET"));
    const asked = stubFetch(() => new Error("connect ECONNRESET 203.0.113.9:443"));
    const first = await reportStep(env, CHAT_STEP);
    check("skipped/our_capability about the failing script becomes broken",
      first.status === "broken" && first.unverifiedReason === undefined, `${first.status}/${first.unverifiedReason}`);
    check("the words name the exact URL and describe the product only",
      first.observed.includes(SDK) && !hasEnvironmentLeak(first.observed), first.observed);

    // Journey 5 step 1: the model probed chatwoot.com and said it responds normally.
    const second = await reportStep(env, {
      label: "Chat SDK loads",
      status: "skipped",
      unverifiedReason: "our_capability",
      attempted: "Checked that the chat SDK loads",
      observed: "The chatwoot.com SDK endpoint itself responds normally to a server-side request, so this cannot be verified.",
    });
    globalThis.fetch = realFetch;
    check("a second step in the same walk, naming another host, gets the same classification",
      second.status === "broken", `${second.status}/${second.unverifiedReason}`);
    check("what was asked from the worker is the exact script URL — once, and never the host the step named",
      asked.length === 1 && asked[0] === SDK, asked.join(" "));
  }

  // 2b — the product's own error status counts, too.
  {
    const { env, emit } = stubEnv();
    emit("requestfailed", failedRequest(SDK, "net::ERR_CONNECTION_RESET"));
    stubFetch(() => ({ status: 502 }));
    const step = await reportStep(env, CHAT_STEP);
    globalThis.fetch = realFetch;
    check("a 502 from the same URL confirms it", step.status === "broken" && step.observed.includes("HTTP 502"), step.observed);
  }

  // 4 — where nothing changes.
  {
    const { env, emit } = stubEnv();
    emit("requestfailed", failedRequest(SDK, "net::ERR_CONNECTION_RESET"));
    stubFetch(() => ({ status: 200 }));
    const answered = await reportStep(env, CHAT_STEP);
    check("the worker gets an answer: it was our browser, the step stays skipped/our_capability",
      answered.status === "skipped" && answered.unverifiedReason === "our_capability", `${answered.status}/${answered.unverifiedReason}`);

    stubFetch(() => new Error("connect ECONNRESET"));
    const elsewhere = await reportStep(env, {
      ...CHAT_STEP,
      label: "Pricing toggle",
      attempted: "Switched the pricing toggle between monthly and yearly",
      observed: "The toggle could not be driven and could not be confirmed.",
    });
    check("a step about something else is left alone",
      elsewhere.status === "skipped" && elsewhere.unverifiedReason === "our_capability", `${elsewhere.status}/${elsewhere.unverifiedReason}`);

    const classed = await reportStep(env, { ...CHAT_STEP, gapClass: "undriven_control" });
    check("a step with a machine-decided class is left alone",
      classed.status === "skipped" && classed.gapClass === "undriven_control", `${classed.status}`);

    const notOurs = await reportStep(env, { ...CHAT_STEP, unverifiedReason: "missing_access" });
    globalThis.fetch = realFetch;
    check("a step that is about access is left alone", notOurs.status === "skipped" && notOurs.unverifiedReason === "missing_access");
  }
  {
    const { env, emit } = stubEnv();
    emit("requestfailed", failedRequest("https://widget.example/chat.js", "net::ERR_CONNECTION_RESET"));
    stubFetch(() => new Error("connect ECONNRESET"));
    const foreign = await reportStep(env, CHAT_STEP);
    globalThis.fetch = realFetch;
    check("a failure of another site's host is never evidence against the product",
      foreign.status === "skipped" && foreign.unverifiedReason === "our_capability" && !env.ownRequestFailures?.size);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
