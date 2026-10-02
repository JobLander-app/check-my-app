// CHE-334 verification: the self-check of checkmyapp.dev no longer reports our
// own guard, our own flags or our own history as the product's.
//
// Owner, 2026-09-28, during a live demo: checkmyapp.dev's own verdict showed
// "strange reasons why it's broken". Every input below is the text production
// stored for runs #260 and #261 (read from D1), fed through the functions the
// workflow runs — no browser, no model, no network:
//
//   1. a step our own guard refused (the web half's 403 after "Show me my app",
//      the click gate on "Save & start watching") is written skipped /
//      not_applicable in a fixed sentence, whatever status the model gave it,
//      and does not count toward its journey's status; a customer's 403 is
//      untouched;
//   2. a walk that met the guard cannot say it in its summary, and a run whose
//      steps carry it cannot say it in the bottom line or in a finding;
//   3. a journey summary carries no product description and no history of
//      earlier reports;
//   4. the self-check's account (a test account) is evaluated as a stranger
//      for every flag, so a signed-in walk cannot differ from an anonymous one
//      by our own configuration;
//   5. a finished verdict with no findings does not say "Nothing recorded
//      yet" — and not next to a flagged journey.
//
// Fails on origin/main (the exports it imports do not exist there, and the
// behaviour it checks is what run #260 published).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-self-check-own-state.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  coerceSelfCheck403,
  countsTowardJourney,
  executeTool,
  type ReportedStep,
  type ToolEnv,
} from "@/agent/tools";
import { ownGuardRefusals, type SynthesizedFinding } from "@/agent/synthesis";
import {
  cutSelfCheckRefusalClaims,
  hasEnvironmentLeak,
  isSelfCheckRefusalStep,
  productProse,
  SELF_CHECK_REFUSED_OBSERVED,
  walkSummaryOnly,
} from "@/lib/verdict-language";
import { evaluateFlag, HOME_EXTENSION_CHECK_FLAG, type FlagFetch } from "@/lib/feature-flags";
import { emptyFindingsNote } from "@/components/findings-list";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  →  ${detail}` : ""}`);
}

const SELF = "https://checkmyapp.dev";
const CUSTOMER = "https://joblander.app";

// Enough of a page for click/navigate (the shape verify-self-check-agent.ts
// uses): the control answers with the request lines the case hands it.
function stubPage(origin: string, opts: { onClick: string[]; networkLog: string[] }) {
  const url = `${origin}/`;
  const locator = {
    first: () => locator,
    count: async () => 1,
    or: () => locator,
    elementHandle: async () => null,
    click: async () => {
      opts.networkLog.push(...opts.onClick);
    },
  };
  return {
    url: () => url,
    goto: async () => ({ status: () => 200 }),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => 0,
    addInitScript: async () => {},
    on: () => {},
    getByRole: () => locator,
    getByText: () => locator,
    locator: () => locator,
  };
}

function stubEnv(origin: string, onClick: string[] = [`GET ${origin}/after → 200`]): ToolEnv & { reported: ReportedStep[] } {
  const networkLog: string[] = [];
  const reported: ReportedStep[] = [];
  return {
    page: stubPage(origin, { onClick, networkLog }),
    targetOrigin: origin,
    networkLog,
    consoleLog: [],
    writeAllowed: false,
    credentials: { rejected: false },
    actionTrail: [],
    reported,
    onReportStep: async (s: ReportedStep) => {
      reported.push(s);
    },
  } as unknown as ToolEnv & { reported: ReportedStep[] };
}

// ─── 1. The step ────────────────────────────────────────────────────────────

// Run #260, journey 0, step 1 — exactly as stored.
const RUN_260_SUBMIT = {
  label: "Submit the check via 'Show me my app'",
  status: "skipped" as const,
  unverifiedReason: "not_applicable" as const,
  attempted: "Entered https://example.com and clicked 'Show me my app' to submit the check while not signed in.",
  observed:
    "The product refused the request (POST /api/checks returned 403) — the check is not available to an unauthenticated account. This is expected: a check requires an account.",
};

async function stepChecks(): Promise<void> {
  {
    const env = stubEnv(SELF, [`POST ${SELF}/api/checks → 403`]);
    const out = await executeTool(env, "click", { role: "button", name: "Show me my app" });
    check("#260: clicking 'Show me my app' meets our own guard", out.includes("not available to this account"), out.slice(0, 80));
    await executeTool(env, "report_step", { ...RUN_260_SUBMIT });
    const s = env.reported[0];
    check("#260: the step the model reported skipped is written as our guard", s?.selfCheckRefused === true, JSON.stringify(s));
    check("…skipped / not_applicable", s?.status === "skipped" && s?.unverifiedReason === "not_applicable");
    check("…in the fixed sentence, not 'not available to an unauthenticated account'", s?.observed === SELF_CHECK_REFUSED_OBSERVED, s?.observed);
    check("…which survives the product-prose gate untouched", productProse(s?.observed) === SELF_CHECK_REFUSED_OBSERVED);
    check("…and names none of our machinery", !hasEnvironmentLeak(s?.observed));
    check("…and does not count toward its journey", s ? !countsTowardJourney(s) : false);
    check("…and is recognisable from the stored row alone", isSelfCheckRefusalStep({ unverifiedReason: s?.unverifiedReason, observed: s?.observed }));

    // The refusal belongs to that step only.
    await executeTool(env, "report_step", {
      label: "Read the pricing page",
      status: "confusing",
      attempted: "Opened /pricing.",
      observed: "The plan names differ between the table and the checkout button.",
    });
    const next = env.reported[1];
    check("the next step, with nothing of ours in it, stays as the model wrote it", next?.status === "confusing" && !next?.selfCheckRefused, JSON.stringify(next));
  }
  {
    // Run #260, journey 0, step 3: our click gate on our own host.
    const env = stubEnv(SELF);
    const out = await executeTool(env, "click", { role: "button", name: "Save & start watching" });
    check("#260: 'Save & start watching' on our host is refused by the click gate", out.startsWith("Refused:"), out.slice(0, 60));
    await executeTool(env, "report_step", {
      label: "Register a test app (Save & start watching)",
      status: "skipped",
      unverifiedReason: "not_applicable",
      attempted: "Filled the onboarding 'Add your app' form and attempted to click 'Save & start watching'.",
      observed: "The onboarding form renders and accepts input. The submit button would register the app AND start a real watch.",
    });
    const s = env.reported[0];
    check("#260: the click-gate refusal on our host is our guard too", s?.selfCheckRefused === true && s ? !countsTowardJourney(s) : false, JSON.stringify(s));
  }
  {
    const env = stubEnv(CUSTOMER);
    await executeTool(env, "click", { role: "button", name: "Save & start watching" });
    await executeTool(env, "report_step", {
      label: "Register an app",
      status: "skipped",
      unverifiedReason: "not_applicable",
      attempted: "Filled the form.",
      observed: "The form accepts input; submitting would create a record.",
    });
    const s = env.reported[0];
    check("a customer's read-only refusal is not our guard: it still counts (partial)", !s?.selfCheckRefused && s ? countsTowardJourney(s) : false, JSON.stringify(s));
  }
  {
    const env = stubEnv(CUSTOMER, [`POST ${CUSTOMER}/api/orders → 403`]);
    await executeTool(env, "click", { role: "button", name: "Go" });
    await executeTool(env, "report_step", {
      label: "Place an order",
      status: "skipped",
      attempted: "Pressed Go.",
      observed: "POST /api/orders returned 403 for a signed-in user.",
    });
    const s = env.reported[0];
    check("a customer's 403 is never read as our guard", !s?.selfCheckRefused && s?.observed.includes("403") === true, JSON.stringify(s));
  }
  {
    const env = stubEnv(SELF, [`POST ${SELF}/api/checks → 403`]);
    await executeTool(env, "click", { role: "button", name: "Go" });
    await executeTool(env, "report_step", {
      label: "Start a check",
      status: "broken",
      attempted: "Pressed Go.",
      observed: "Pressing Go answered 403, and then the page showed a 500 from /api/runs.",
    });
    check("the product's own 5xx next to the refusal is left as reported", env.reported[0]?.status === "broken");
  }
  {
    const env = stubEnv(SELF, [`POST ${SELF}/api/checks → 403`]);
    await executeTool(env, "click", { role: "button", name: "Go" });
    await executeTool(env, "report_step", { label: "Form", status: "ok", attempted: "Typed a URL.", observed: "The field accepted the URL." });
    check("an ok step is never rewritten", env.reported[0]?.status === "ok" && !env.reported[0]?.selfCheckRefused);
    await executeTool(env, "report_step", { ...RUN_260_SUBMIT, observed: "The check did not start." });
    check("…and does not use up the refusal: the step it belongs to, reported next, is still ours",
      env.reported[1]?.selfCheckRefused === true, JSON.stringify(env.reported[1]));
  }
  {
    // Codex review of #205: "exposed" is not a way around the rule.
    const env = stubEnv(SELF, [`POST ${SELF}/api/checks → 403`]);
    await executeTool(env, "click", { role: "button", name: "Go" });
    await executeTool(env, "report_step", { label: "Start a check", status: "exposed", attempted: "Pressed Go.", observed: "The API refuses with 403, leaking that checks need an account." });
    check("an 'exposed' step resting on our guard is ours too", env.reported[0]?.selfCheckRefused === true, JSON.stringify(env.reported[0]));
  }
  {
    // …and the product's own evidence in the excerpts keeps the step.
    const env = stubEnv(SELF, [`POST ${SELF}/api/checks → 403`]);
    await executeTool(env, "click", { role: "button", name: "Go" });
    await executeTool(env, "report_step", {
      label: "Start a check", status: "broken", attempted: "Pressed Go.", observed: "Nothing started.",
      consoleExcerpt: "Uncaught TypeError: cannot read properties of undefined (reading 'id')",
    });
    check("a console exception in the step's excerpt keeps it as reported", env.reported[0]?.status === "broken" && !env.reported[0]?.selfCheckRefused);
    const env2 = stubEnv(SELF, [`POST ${SELF}/api/checks → 403`]);
    await executeTool(env2, "click", { role: "button", name: "Go" });
    await executeTool(env2, "report_step", {
      label: "Start a check", status: "broken", attempted: "Pressed Go.", observed: "Nothing started.",
      networkExcerpt: `POST ${SELF}/api/checks → 403\nGET ${SELF}/api/runs/512 → 502`,
    });
    check("a 5xx in the step's network excerpt keeps it as reported", env2.reported[0]?.status === "broken" && !env2.reported[0]?.selfCheckRefused);
    // Codex review of #205 (round 3): the mixed step keeps the 502 and loses the 403.
    const env4 = stubEnv(SELF, [`POST ${SELF}/api/checks → 403`]);
    await executeTool(env4, "click", { role: "button", name: "Go" });
    await executeTool(env4, "report_step", {
      label: "Start a check", status: "broken", attempted: "Pressed Go.",
      observed: "The submission returned 403, then /api/runs/512 returned 502 and the page went blank.",
    });
    const mixedStep = env4.reported[0];
    check("mixed step: status stands on the product's own 502", mixedStep?.status === "broken" && !mixedStep?.selfCheckRefused, JSON.stringify(mixedStep));
    check("…its words keep the 502 and lose the 403",
      /502/.test(mixedStep?.observed ?? "") && !/403/.test(mixedStep?.observed ?? ""), mixedStep?.observed);
    check("…and the walk is told it met our guard", mixedStep?.selfCheckGuardSeen === true);
    const env3 = stubEnv(SELF, [`POST ${SELF}/api/checks → 403`]);
    await executeTool(env3, "click", { role: "button", name: "Go" });
    await executeTool(env3, "report_step", {
      label: "Start a check", status: "skipped", attempted: "Pressed Go.", observed: "Refused.",
      networkExcerpt: `POST ${SELF}/api/runs/512 → 403`,
    });
    check("…but a 5 in a URL is not a 5xx", env3.reported[0]?.selfCheckRefused === true);
  }
  {
    // A skipped step that only says "forbidden", with nothing of ours in the
    // log or the trail, is not our guard.
    const env = stubEnv(SELF);
    const s: ReportedStep = { label: "Admin", status: "skipped", attempted: "Opened /admin.", observed: "The admin area is forbidden to this account." , unverifiedReason: "missing_access" };
    coerceSelfCheck403(s, env);
    check("a skip citing 'forbidden' with no refusal in the machine trail is left alone", s.status === "skipped" && s.unverifiedReason === "missing_access" && !s.selfCheckRefused);
  }
  {
    const env = stubEnv(SELF);
    const s = { ...RUN_260_SUBMIT, selfCheckRefused: true } as ReportedStep;
    s.observed = "The page loaded.";
    s.status = "ok";
    await executeTool(env, "report_step", s as unknown as Record<string, unknown>);
    check("the model cannot mark a step as our guard itself", env.reported[0]?.selfCheckRefused !== true);
  }
}

// ─── 1b. The roll-up is wired to it ─────────────────────────────────────────

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function wiringChecks(): void {
  const execution = source("src/agent/execution.ts");
  check("execution.ts: only steps that count are rolled up", /if \(countsTowardJourney\(step\)\) stepStatuses\.push\(/.test(execution));
  check("execution.ts: the summary goes through walkSummaryOnly", /walkSummaryOnly\(claimed, run\.targetUrl\)/.test(execution));
  check("execution.ts: a walk that met our guard has its retelling cut", /metOwnGuard \? cutSelfCheckRefusalClaims\(/.test(execution));
  const partial = source("src/agent/partial.ts");
  check("partial.ts: a carried summary goes through walkSummaryOnly", /walkSummaryOnly\(source\.summary, run\.targetUrl\)/.test(partial));
  check("partial.ts: a carried step keeps why it went unverified", /unverifiedReason: step\.unverifiedReason/.test(partial));
  check("partial.ts: a carried summary loses our guard retold as theirs", /metOwnGuard \? cutSelfCheckRefusalClaims\(walkOnly\.text, source\.steps\)/.test(partial));
  check("capability-gaps.ts: carried steps are not filed as this run's gaps",
    /unverifiedReason: "our_capability", journey: \{ runId, carriedFromRunId: null \}/.test(source("src/agent/capability-gaps.ts")));
  const synthesis = source("src/agent/synthesis.ts");
  check("synthesis.ts: the bottom line and findings go through ownGuardRefusals", /ownGuardRefusals\(journeys, bottomLine, cleanedFindings\)/.test(synthesis));
  const verdict = source("src/components/verdict-view.tsx");
  check("verdict page: the findings section knows whether the run is over and what was flagged",
    /finished=\{run\.status === "completed" \|\| run\.status === "partial"\}/.test(verdict) && /journeysFlagged=\{/.test(verdict));
}

// ─── 2. Summaries, bottom line, findings ────────────────────────────────────

// Run #260, journey 1 summary, as stored.
const RUN_260_J1 =
  "CheckMyApp signs users in cleanly through Clerk and its dashboard, daily-checks page, pricing, and guides all render without error. But the core promise — actually running a first-visit check — is out of reach: \"Show me my app\" returns 403 for this account.";
// Run #260 bottom line, as stored.
const RUN_260_BOTTOM =
  "On your three worries: we walked the main UI paths — home, sign-in, pricing, guides, FAQ, about and the daily-checks page — and every one renders cleanly, and sign-in now authenticates directly (the old Google-OAuth detour is gone), so discovery of your marketing and account surface is solid. Daily Watch (/checks/today) loads and its counter agrees with its data, but there were zero runs today so we only saw the correct empty state — we couldn't judge a populated day. The one path we could not drive to completion is the core promise itself: an anonymous 'Show me my app' submission was refused at the bot-check gate (403) despite the 'NO SIGNUP' copy, and we deliberately stopped before the paid 'Save & start watching', so an end-to-end check run remains unverified this run. Not opened this run: /verdict/cmtnf9n670003wh1rc9o2rild, /verdict/cmtokcgh90003x91r292cdcn3 — so nothing here speaks to them.";

function summaryChecks(): void {
  {
    const r = cutSelfCheckRefusalClaims(RUN_260_J1);
    check("#260 j1: the 403 sentence is cut from the summary", !!r.text && !/403|out of reach/.test(r.text), r.text ?? "");
    check("…and what the walk saw stays", r.text?.startsWith("CheckMyApp signs users in cleanly through Clerk") === true, r.text ?? "");
  }
  const refusedRun = [
    { steps: [{ unverifiedReason: null, observed: "The home page loaded." }, { unverifiedReason: "not_applicable", observed: SELF_CHECK_REFUSED_OBSERVED }] },
  ];
  const guardFinding: SynthesizedFinding = {
    title: "Show me my app is refused with 403 for signed-out visitors",
    category: "broken",
    severity: "high",
    detail: { whatHappened: "POST /api/checks answered 403." },
  };
  const anchored: SynthesizedFinding = {
    title: "The core check cannot be started",
    category: "broken",
    severity: "high",
    detail: { whatHappened: "Nothing started." },
    stepRef: { journeyIndex: 0, stepIndex: 1 },
  };
  const real: SynthesizedFinding = {
    title: "Pricing table and checkout disagree on the plan name",
    category: "confusing",
    severity: "medium",
    detail: { whatHappened: "The table says Pro, the button says Business." },
    stepRef: { journeyIndex: 0, stepIndex: 0 },
  };
  {
    const r = ownGuardRefusals(refusedRun, RUN_260_BOTTOM, [guardFinding, anchored, real]);
    check("#260 bottom line: the bot-check / 403 sentence is gone", !!r.bottomLine && !/403|bot-check|refused/.test(r.bottomLine), r.bottomLine ?? "");
    check("…the rest of the bottom line stands", r.bottomLine?.includes("Daily Watch (/checks/today) loads") === true);
    check("a finding that retells our guard is not written", !r.findings.includes(guardFinding));
    check("a finding anchored on the refused step is not written", !r.findings.includes(anchored));
    check("a finding about the product stays", r.findings.includes(real) && r.findings.length === 1);
  }
  {
    // Codex review of #205: every field the customer reads counts, when the
    // finding has no anchor; a finding anchored on a step that stands is kept.
    const inWhy: SynthesizedFinding = {
      title: "The core promise cannot be tried",
      category: "confusing",
      severity: "medium",
      detail: { whatHappened: "Nothing started.", whyItMatters: "The bot-check gate turns away signed-out visitors." },
    };
    const realForbidden: SynthesizedFinding = {
      title: "The team settings page answers 403 for the account's own admin",
      category: "broken",
      severity: "high",
      detail: { whatHappened: "GET /settings/team returned 403." },
      stepRef: { journeyIndex: 0, stepIndex: 0 },
    };
    const r = ownGuardRefusals(refusedRun, null, [inWhy, realForbidden]);
    check("an unanchored finding retelling our guard in whyItMatters is not written", !r.findings.includes(inWhy));
    check("a 403 finding anchored on a step that stands is kept", r.findings.includes(realForbidden));
  }
  {
    // Codex review of #205 (round 2): a real 403 elsewhere in a guarded run
    // keeps its sentences; only the ones about the refused step go.
    const mixed = [
      {
        steps: [
          { label: "Submit the check via 'Show me my app'", attempted: RUN_260_SUBMIT.attempted, status: "skipped", unverifiedReason: "not_applicable", observed: SELF_CHECK_REFUSED_OBSERVED },
          { label: "Open team settings", attempted: "Opened /settings/team as the admin.", status: "broken", unverifiedReason: null, observed: "GET /settings/team returned 403 for the team's own admin." },
        ],
      },
    ];
    const line =
      "Settings are blocked by a 403 for the team's own admin. An anonymous 'Show me my app' submission was refused with 403. Pricing and FAQ load cleanly.";
    const r = ownGuardRefusals(mixed, line, []);
    check("guarded run: the real settings 403 stays in the bottom line", r.bottomLine?.includes("Settings are blocked by a 403") === true, r.bottomLine ?? "");
    check("…the refused 'Show me my app' sentence goes", r.bottomLine?.includes("Show me my app") === false, r.bottomLine ?? "");
    check("…the rest stays", r.bottomLine?.includes("Pricing and FAQ load cleanly.") === true);
    const s = cutSelfCheckRefusalClaims(
      "The /settings/team page answers 403 for its own admin. \"Show me my app\" returns 403 for this account.",
      mixed[0].steps,
    );
    check("guarded walk summary: the same split", s.text === "The /settings/team page answers 403 for its own admin.", s.text ?? "");
    const unanchored: SynthesizedFinding = {
      title: "Team settings are blocked for the admin",
      category: "broken",
      severity: "high",
      detail: { whatHappened: "GET /settings/team returned 403." },
    };
    check("an unanchored finding about the standing 403 is kept", ownGuardRefusals(mixed, null, [unanchored]).findings.length === 1);
  }
  {
    // Codex review of #205 (round 3): the outcome after "…, but" survives.
    const r = walkSummaryOnly("JobLander is an interview coach, but the practice call crashed with a 500.", "https://joblander.app");
    check("a description joined by ', but' keeps the outcome", r.text === "The practice call crashed with a 500.", r.text ?? "");
  }
  {
    const r = walkSummaryOnly("The Previous Runs table loaded but showed the wrong status for run #12.", SELF);
    check("a page called 'Previous Runs' is this walk, not history", r.cut.length === 0, r.text ?? "");
    const h = walkSummaryOnly("Sign-in with the test account works; unlike in the last check, the dashboard now loads.", SELF);
    check("'in the last check' is history and goes", h.text === "Sign-in with the test account works.", h.text ?? "");
    // Run cmulp9pxt0003ri1o8wptwzo8, carried journey 8, verbatim opening.
    const hy = walkSummaryOnly(
      "The previously-reported sign-in failures are fixed: the email/password flow renders, authenticates via Clerk, and lands on a populated dashboard. The dashboard lists every app.",
      SELF,
    );
    check("'previously-reported … failures are fixed' is history and goes", hy.text === "The dashboard lists every app.", hy.text ?? "");
    const plain = walkSummaryOnly("Two checkout failures were shown to the user as a blank page.", "https://shop.example.org");
    check("failures this walk saw are not history", plain.cut.length === 0, plain.text ?? "");
    // Codex review of #208: resolved on THIS walk is evidence, not history.
    const now = walkSummaryOnly("Two upload failures were resolved by retrying during this walk.", "https://shop.example.org");
    check("failures resolved during this walk stay", now.cut.length === 0, now.text ?? "");
  }
  {
    const customer = [{ steps: [{ unverifiedReason: null, observed: "POST /api/orders returned 403." }] }];
    const line = "Checkout is broken: placing an order is refused with 403 for signed-in users.";
    const theirs: SynthesizedFinding = { ...guardFinding, title: "Checkout refused with 403" };
    const r = ownGuardRefusals(customer, line, [theirs]);
    check("a run with no refusal of ours keeps its 403 bottom line and finding", r.bottomLine === line && r.findings.length === 1 && r.cut.length === 0);
  }

  // Run #261 summaries, as stored.
  const j0 =
    "CheckMyApp is a link-verification tool that checks what a first-time visitor hits; its sign-in now works correctly with email/password (the Clerk session was created and the authenticated dashboard loaded, so the previously reported OAuth redirect bug appears fixed).";
  const j1 =
    "CheckMyApp is a daily QA monitoring product: you sign in (Clerk email/password), add an app by URL with optional test login, ticket params, and test-record permissions, then it runs daily checks and files tickets into your tracker.";
  const j4 =
    "Email/password sign-in now works end-to-end (the previously reported Google-OAuth redirect bug is fixed), but the layout is inconsistent: signed-in users get a Website / Chrome extension tab strip on the homepage while anonymous visitors get no tabs at all, just a single URL field.";
  {
    const r = walkSummaryOnly(j0, SELF);
    check("#261 j0: no product description, no earlier report", !!r.text && !/is a link-verification tool|previously reported|appears fixed/i.test(r.text), r.text ?? "");
    check("…what this walk saw stays", r.text === "Its sign-in now works correctly with email/password.", r.text ?? "");
  }
  {
    const r = walkSummaryOnly(j1, SELF);
    check("#261 j1: a summary that was only a brochure leaves nothing (the journey's fixed sentence stands in)", r.text === null, r.text ?? "");
  }
  {
    const r = walkSummaryOnly(j4, SELF);
    check("#260 j4: the earlier-report aside goes, the sentence stays",
      r.text?.startsWith("Email/password sign-in now works end-to-end, but the layout is inconsistent") === true, r.text ?? "");
  }
  {
    const joblander = "JobLander is an AI interview coach; the practice call connected and the coach greeted the user by name.";
    const r = walkSummaryOnly(joblander, "https://app.joblander.app");
    check("a customer's product description is cut the same way", r.text === "The practice call connected and the coach greeted the user by name.", r.text ?? "");
  }
  for (const untouched of [
    "The sign-in page is a two-step form, and both steps accepted the test account.",
    "Checkout is broken: placing an order returns 500 and the cart empties.",
    "The header is fixed at the top and covers the Sign in button on mobile.",
    "This journey behaved as a user would expect; nothing failed.",
  ]) {
    const r = walkSummaryOnly(untouched, CUSTOMER);
    check(`left as written: "${untouched.slice(0, 50)}…"`, r.text === untouched && r.cut.length === 0, r.text ?? "");
  }
}

// ─── 3. Flags ───────────────────────────────────────────────────────────────

async function flagChecks(): Promise<void> {
  const calls: string[] = [];
  const yes: FlagFetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ flags: { [HOME_EXTENSION_CHECK_FLAG]: { enabled: true } } }) };
  };
  const selfCheckAccount = { distinctId: "user_3IIyig2vio6zNeQGNuWFIRUJ5KV", email: "dogfood+clerk_test@example.com", isTestAccount: true };
  check("the self-check's account sees the extension option as a stranger does: off",
    (await evaluateFlag(HOME_EXTENSION_CHECK_FLAG, selfCheckAccount, yes)) === false);
  check("…without asking PostHog", calls.length === 0, `${calls.length} calls`);
  check("the owner still gets it",
    (await evaluateFlag(HOME_EXTENSION_CHECK_FLAG, { distinctId: "user_owner", email: "sorokinvj@gmail.com", isTestAccount: false }, yes)) === true);
}

// ─── 4. An empty findings section ───────────────────────────────────────────

function findingsNoteChecks(): void {
  check("#261: a finished verdict with a flagged journey does not say 'Nothing recorded yet'",
    !/yet/i.test(emptyFindingsNote(true, true)) && /journeys below/.test(emptyFindingsNote(true, true)), emptyFindingsNote(true, true));
  check("a finished clean verdict says nothing needs fixing", emptyFindingsNote(true, false) === "Nothing to fix was found.");
  check("a run still in progress still says nothing is recorded yet", emptyFindingsNote(false, false) === "Nothing recorded yet.");
  const list = source("src/components/findings-list.tsx");
  check("the second 'No findings recorded yet.' line is gone", !list.includes("No findings recorded yet."));
}

(async () => {
  const warn = console.warn;
  console.warn = () => {};
  await stepChecks();
  await flagChecks();
  console.warn = warn;
  wiringChecks();
  summaryChecks();
  findingsNoteChecks();
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
