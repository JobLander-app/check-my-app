// A walk that stops in prose without recording a step is asked once to report
// what it did — and what it reports only because it was asked is not a defect
// unless the page itself produced evidence of one.
//
// Run #337 (pr-353.preview.joblander.app, "Authenticated user accesses the AI
// practice interview module") walked a journey and recorded nothing, and the
// same gap has been filed against us every run since. CHE-420 made such a walk
// honest (a fixed coverage sentence, one gap step) but did nothing to make it
// stop happening; this is the half that does.
//
// Through the real path: walkOneJourney (src/agent/execution.ts) on a real D1,
// a real Chromium and a scripted model —
//   1. silent, then reports ok when asked → the step is recorded, no gap;
//   2. silent when asked too → asked ONCE, the unrecorded-walk gap as before;
//   3. reports on its own → never asked;
//   4. asked, reports "broken" on a healthy page → NOT stored as broken: the
//      walk stays the unrecorded one, and the live feed never says "broken";
//   5. asked, reports "broken" after the product's own endpoint answered 500 →
//      stored as broken (positive evidence);
//   6. asked, reports ok though the walk never acted → NOT stored as ok (nothing
//      was observed), the walk stays the unrecorded one;
//   7. asked, reports broken, and the only error in the walk is an unrelated
//      404 the step does not name → NOT stored as broken;
//   8. asked, reports ok for a step the walk never went to (it only opened the
//      homepage) → NOT stored as ok;
//   9. asked after reading the error through get_network_log (which empties
//      the rolling logs), reports broken → still stored: the evidence is the
//      walk's retained record;
//  10. asked, the product's own homepage answered 500 → stored as broken;
//  11. asked, the walk's only console error is an unrelated "Failed to load
//      module script" and the step says "module" → NOT stored as broken;
//  12. the evidence rule itself: 429, a foreign origin, a bare 200, an error
//      the step does not name, and a console error that shares only a common
//      word are not.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-walk-must-report.ts

process.env.CREDENTIALS_SECRET ??= "verify-walk-must-report-secret";

import "./fixtures/wasm-module-loader.mjs";
import http from "node:http";
import Module from "node:module";
import type Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import { realD1 } from "./fixtures/real-d1";
import type { LlmConfig } from "@/agent/llm";
import type { AgentEnv } from "@/agent/env";
import { HOMEWORK_FALLBACK } from "@/lib/verdict-language";
import { hasPositiveEvidence, nudgedStepStands, WALK_MUST_REPORT_NOTE } from "@/agent/nudged-report";
import type { ReportedStep } from "@/agent/tools";

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

type Turn = { navigate: string } | { network: true } | { report: "ok" | "broken"; observed: string } | { say: string };

// Plays `turns` in order, one per walking call; counts how often the nudge
// arrived. A call without tools is the summary request.
function scriptedModel(turns: Turn[]) {
  let calls = 0;
  let nudges = 0;
  const message = (content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"]) =>
    ({ id: `m${calls}`, type: "message", role: "assistant", model: "scripted", stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage, content }) as Anthropic.Message;
  const create = async (params: { tools?: unknown; messages: Anthropic.MessageParam[] }): Promise<Anthropic.Message> => {
    calls += 1;
    if (!params.tools) return message([{ type: "text", text: "The practice module opens.", citations: null }], "end_turn");
    const last = params.messages[params.messages.length - 1];
    if (last.role === "user" && last.content === WALK_MUST_REPORT_NOTE) nudges += 1;
    const turn = turns[Math.min(calls - 1, turns.length - 1)];
    if ("navigate" in turn) {
      return message([{ type: "tool_use", id: `tu_${calls}`, name: "navigate", input: { url: turn.navigate } }], "tool_use");
    }
    if ("network" in turn) {
      return message([{ type: "tool_use", id: `tu_${calls}`, name: "get_network_log", input: {} }], "tool_use");
    }
    if ("report" in turn) {
      return message([{ type: "tool_use", id: `tu_${calls}`, name: "report_step",
        input: { label: "Open the module", status: turn.report, attempted: "Open the module.", observed: turn.observed } }], "tool_use");
    }
    return message([{ type: "text", text: turn.say, citations: null }], "end_turn");
  };
  const client = { messages: { create } } as unknown as Anthropic;
  const llm: LlmConfig = { navClient: client, synthClient: client, structClient: client, navModel: "scripted", synthModel: "scripted", structModel: "scripted", navVision: false };
  return { llm, nudges: () => nudges };
}

async function main() {
  const { walkOneJourney } = await import("@/agent/execution");
  const site = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/missing")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"nope"}');
      return;
    }
    if (req.url?.startsWith("/api/practice")) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(req.url?.startsWith("/module-error")
      ? "<!doctype html><meta charset=utf-8><title>Practice</title><h1>Practice</h1><script>console.error('Failed to load module script')</script>"
      : req.url?.startsWith("/broken")
      ? "<!doctype html><meta charset=utf-8><title>Practice</title><h1>Practice</h1><script>fetch('/api/practice')</script>"
      : req.url?.startsWith("/unrelated")
      ? "<!doctype html><meta charset=utf-8><title>Practice</title><h1>Practice</h1><script>fetch('/api/missing')</script>"
      : "<!doctype html><meta charset=utf-8><title>Practice</title><h1>Practice</h1><p>Start a mock interview</p>");
  });
  // A product whose homepage itself answers 500.
  const down = http.createServer((_req, res) => {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end("<!doctype html><meta charset=utf-8><title>Error</title><h1>Something went wrong</h1>");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", () => resolve()));
  await new Promise<void>((resolve) => down.listen(0, "127.0.0.1", () => resolve()));
  const downTarget = `http://127.0.0.1:${(down.address() as { port: number }).port}/`;
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const target = `${origin}/`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let real: Awaited<ReturnType<typeof realD1>> | undefined;
  try {
    browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
    real = await realD1();
    const db = real.db;
    await db.user.create({ data: { id: "ann", clerkUserId: "ck_ann", email: "ann@a.test" } });
    await db.team.create({ data: { id: "team_a", name: "A", plan: "business" } });
    const env = { db, bindings: {} } as unknown as AgentEnv;
    let runNumber = 0;

    const walk = async (id: string, turns: Turn[], targetUrl = target) => {
      runNumber += 1;
      await db.run.create({ data: { id, runNumber, ownerId: "ann", teamId: "team_a", targetUrl, appSlug: "127.0.0.1", status: "walking" } as never });
      const model = scriptedModel(turns);
      const feed: string[] = [];
      await walkOneJourney({
        env,
        llm: model.llm,
        browser: browser as never,
        run: { id, runNumber, appSlug: "127.0.0.1", targetUrl, testEmail: null, testPasswordEnc: null, scopeHints: null, userNotes: null, focusAreas: null },
        proposed: { title: "Open the practice module", steps: ["Open the module"] },
        index: 0,
        onProgress: async (note) => { feed.push(note); },
      });
      const journey = await db.journey.findFirst({ where: { runId: id }, include: { steps: { orderBy: { order: "asc" } } } });
      return { steps: journey?.steps ?? [], summary: journey?.summary, nudges: model.nudges(), feed };
    };
    const shape = (steps: { status: string; gapClass: string | null }[]) => JSON.stringify(steps.map((s) => [s.status, s.gapClass]));

    const asked = await walk("run_asked", [{ navigate: `${origin}/practice` }, { say: "Done." }, { report: "ok", observed: "The practice module opens." }, { say: "Done." }]);
    check("silent, then asked: the step it reports is recorded and no unrecorded-walk gap is left",
      asked.nudges === 1 && asked.steps.length === 1 && asked.steps[0].status === "ok" && asked.steps[0].gapClass !== "unrecorded_walk",
      `${asked.nudges} nudge(s), ${shape(asked.steps)}`);

    // Nothing was done before the nudge: an ok now is a report on request about
    // a walk that observed nothing.
    const idle = await walk("run_idle", [{ say: "Done." }, { report: "ok", observed: "The module opens." }, { say: "Done." }]);
    check("asked after doing nothing, reports ok: not stored as ok — the unrecorded-walk step",
      idle.nudges === 1 && idle.steps.length === 1 && idle.steps[0].status === "skipped" && idle.steps[0].gapClass === "unrecorded_walk",
      shape(idle.steps));

    // The walk opened the homepage and nothing else; a step about another page
    // is not backed by that.
    const elsewhere = await walk("run_elsewhere", [{ navigate: target }, { say: "Done." }, { report: "ok", observed: "The checkout completes." }, { say: "Done." }]);
    check("asked, reports ok for a step the walk never went to: not stored as ok — the unrecorded-walk step",
      elsewhere.nudges === 1 && elsewhere.steps.length === 1 && elsewhere.steps[0].status === "skipped" && elsewhere.steps[0].gapClass === "unrecorded_walk",
      shape(elsewhere.steps));

    const stubborn = await walk("run_stubborn", [{ say: "Done." }]);
    check("silent when asked too: asked once, and the walk is still the unrecorded-walk gap",
      stubborn.nudges === 1 && stubborn.steps.length === 1 && stubborn.steps[0].gapClass === "unrecorded_walk",
      `${stubborn.nudges} nudge(s), ${shape(stubborn.steps)}`);

    const own = await walk("run_own", [{ report: "ok", observed: "The module opens." }, { say: "Done." }]);
    check("a walk that reports on its own is never asked", own.nudges === 0 && own.steps.length === 1, `${own.nudges} nudge(s)`);

    // The page loaded fine (a 200 and a trail of one navigation) — that is not
    // evidence for "broken".
    const forced = await walk("run_forced", [{ navigate: target }, { say: "Done." }, { report: "broken", observed: "The practice module stayed empty." }, { say: "Done." }]);
    check("asked, reports broken on a healthy page: not stored as broken — the unrecorded-walk step",
      forced.nudges === 1 && forced.steps.length === 1 && forced.steps[0].status === "skipped" && forced.steps[0].gapClass === "unrecorded_walk",
      shape(forced.steps));
    check("…and the journey's summary is the fixed coverage sentence, not the model's prose",
      forced.summary === HOMEWORK_FALLBACK, String(forced.summary));
    check("…and the live feed never announced the broken step", forced.feed.length > 0 && forced.feed.every((n) => !n.startsWith("broken")), JSON.stringify(forced.feed));

    const evidenced = await walk("run_evidenced", [{ navigate: `${origin}/broken` }, { say: "Done." }, { report: "broken", observed: "The practice module could not load its data: /api/practice answered 500." }, { say: "Done." }]);
    check("asked, reports broken after the product's own endpoint answered 500: stored as broken",
      evidenced.nudges === 1 && evidenced.steps.length === 1 && evidenced.steps[0].status === "broken",
      shape(evidenced.steps));

    // get_network_log empties the rolling logs; the error it returned is still
    // the walk's evidence.
    const read = await walk("run_read", [{ navigate: `${origin}/broken` }, { network: true }, { say: "Done." }, { report: "broken", observed: "The practice module could not load its data: /api/practice answered 500." }, { say: "Done." }]);
    check("asked after reading the error through get_network_log, reports broken: still stored as broken",
      read.nudges === 1 && read.steps.length === 1 && read.steps[0].status === "broken",
      shape(read.steps));

    const rootDown = await walk("run_root_down", [{ navigate: downTarget }, { say: "Done." }, { report: "broken", observed: "The practice module is unreachable: the app's own homepage answered 500." }, { say: "Done." }], downTarget);
    check("asked, the product's own homepage answered 500: stored as broken",
      rootDown.nudges === 1 && rootDown.steps.length === 1 && rootDown.steps[0].status === "broken",
      shape(rootDown.steps));

    const moduleError = await walk("run_module_error", [{ navigate: `${origin}/module-error` }, { say: "Done." }, { report: "broken", observed: "The practice module stayed empty." }, { say: "Done." }]);
    check("asked, reports broken while the walk's only console error is an unrelated 'module script' failure: not stored as broken",
      moduleError.nudges === 1 && moduleError.steps.length === 1 && moduleError.steps[0].status === "skipped" && moduleError.steps[0].gapClass === "unrecorded_walk",
      shape(moduleError.steps));

    // An error elsewhere in the walk (a 404) that the step does not name is no
    // evidence for what the step claims.
    const unrelated = await walk("run_unrelated", [{ navigate: `${origin}/unrelated` }, { say: "Done." }, { report: "broken", observed: "The practice module stayed empty." }, { say: "Done." }]);
    check("asked, reports broken while the walk's only error is an unrelated 404 the step does not name: not stored as broken",
      unrelated.nudges === 1 && unrelated.steps.length === 1 && unrelated.steps[0].status === "skipped" && unrelated.steps[0].gapClass === "unrecorded_walk",
      shape(unrelated.steps));

    const own1 = [origin];
    const words = "the practice module could not load its data: /api/x answered 500.";
    check("evidence: a 500 from the product's own origin counts",
      hasPositiveEvidence({ networkLog: [`GET ${origin}/api/x → 500`], consoleLog: [], ownOrigins: own1, words }));
    check("evidence: a 500 the step does not name is not",
      !hasPositiveEvidence({ networkLog: [`GET ${origin}/favicon.ico → 404`], consoleLog: [], ownOrigins: own1, words }));
    check("evidence: a 500 on another path is not, even when the step says 500",
      !hasPositiveEvidence({ networkLog: [`GET ${origin}/api/other → 500`], consoleLog: [], ownOrigins: own1, words: "the practice module returned 500." }));
    check("evidence: a path is named whole, not as the front of a longer one",
      !hasPositiveEvidence({ networkLog: [`GET ${origin}/api → 500`], consoleLog: [], ownOrigins: own1, words: "/api/x answered 500." }));
    check("evidence: generic exception words are not",
      !hasPositiveEvidence({ networkLog: [], consoleLog: ["[error] Uncaught TypeError: analyticsWidget is undefined"], ownOrigins: own1, words: "the page threw: practicemodule is undefined" }));
    check("evidence: a shared common word is not a match",
      !hasPositiveEvidence({ networkLog: [], consoleLog: ["[error] Failed to load module script"], ownOrigins: own1, words: "the practice module stayed empty" }));
    check("evidence: the product's root answering 500 counts when the walk stood on it",
      hasPositiveEvidence({ networkLog: [`GET ${origin}/ → 500`], consoleLog: [], ownOrigins: own1, words: "the homepage answered 500",
        actionTrail: [{ kind: "navigate", url: origin, outcome: { urlAfter: `${origin}/`, status: 500 } }] }));
    check("evidence: the root answering 500 does not count for a walk that never stood on it",
      !hasPositiveEvidence({ networkLog: [`GET ${origin}/ → 500`], consoleLog: [], ownOrigins: own1, words: "the homepage answered 500", actionTrail: [] }));
    check("evidence: a console error counts",
      hasPositiveEvidence({ networkLog: [], consoleLog: ["[error] Uncaught TypeError: practiceModule is undefined"], ownOrigins: own1, words: "the page threw: practicemodule is undefined" }));
    check("evidence: a console error the step does not name is not",
      !hasPositiveEvidence({ networkLog: [], consoleLog: ["[error] Uncaught TypeError: analyticsWidget is undefined"], ownOrigins: own1, words }));
    check("evidence: a bare 200 and a warning do not",
      !hasPositiveEvidence({ networkLog: [`GET ${origin}/ → 200`], consoleLog: ["[warning] deprecated"], ownOrigins: own1, words }));
    const step = (status: ReportedStep["status"], observed: string): ReportedStep => ({ label: "Open the module", status, attempted: "Open the module.", observed });
    const nav = (path: string, status = 200) => ({ kind: "navigate" as const, url: `${origin}${path}`, outcome: { urlAfter: `${origin}${path}`, status } });
    const ev = (actionTrail: Parameters<typeof nudgedStepStands>[1]["actionTrail"], networkLog: string[] = []) => ({ networkLog, consoleLog: [], ownOrigins: own1, actionTrail });
    check("ok: an action the step names, ended well, stands",
      nudgedStepStands(step("ok", "The practice module opens."), ev([nav("/practice")])));
    check("ok: only the homepage visited, a step about checkout does not stand",
      !nudgedStepStands(step("ok", "Checkout completes."), ev([nav("/")])));
    check("ok: a control the step names counts",
      nudgedStepStands(step("ok", "Start interview opens the session."), ev([{ kind: "click", name: "Start interview", outcome: { urlAfter: `${origin}/`, navigated: false, requests: 0, mutations: 1 } }])));
    check("ok: the named page answered an error — does not stand",
      !nudgedStepStands(step("ok", "The practice module opens."), ev([nav("/practice", 500)])));
    check("ok: the named page failed on a later request — does not stand",
      !nudgedStepStands(step("ok", "The practice module opens."), ev([nav("/practice")], [`GET ${origin}/practice → 500`])));
    check("ok: no action at all does not stand", !nudgedStepStands(step("ok", "The practice module opens."), ev([])));
    check("evidence: 429 is our own request volume, never evidence",
      !hasPositiveEvidence({ networkLog: [`GET ${origin}/api/x → 429`], consoleLog: [], ownOrigins: own1, words: "answered 429 /api/x" }));
    check("evidence: another origin's 500 is not the product's",
      !hasPositiveEvidence({ networkLog: ["GET https://analytics.example.com/c → 500"], consoleLog: [], ownOrigins: own1, words: "answered 500 /c" }));
  } finally {
    await real?.dispose();
    await browser?.close();
    site.close();
    down.close();
  }
  console.log(failures ? `\nverify-walk-must-report: ${failures} FAILED` : "\nverify-walk-must-report: all passed");
  process.exit(failures ? 1 : 0);
}

void main();
