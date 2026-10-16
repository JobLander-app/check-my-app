// CHE-445, CHE-486: how Mender is started. It used to be the worker's cron (a
// clock); owner, 2026-10-15: «главное чтобы не было кронов, а триггерами
// монитора были ошибки в проде». Now the ticket filed for Mender wakes it, at
// the place that files it (wakeMender), and nothing does on a timer.
//
// Without a token dispatch does nothing; with one it asks GitHub for exactly
// one run of mender-agent.yml on main; a refusal is an error that wakeMender
// logs and survives.
//
// The scheduler half is behavioural: it runs the real runDueWatches against a
// database with no rows and a fetch that records what leaves the worker, so it
// fails if a dispatch is put back on the clock (CHE-449).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-mender-dispatch.ts

import Module from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { AgentBindings } from "../src/agent/env";
import { createStubDb } from "./fixtures/mcp-db";
import { dispatchMender, MENDER_REPO, MENDER_WORKFLOW, wakeMender } from "../src/agent/mender-dispatch";

// The generated Prisma client is the workerd build, which plain Node cannot
// load, so the scheduler's database is the in-memory stand-in the other verify
// scripts use: getDb is answered with it, and the scheduler is imported after
// the hook is in place (a static import would be hoisted above it).
const moduleLoader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = moduleLoader._load;
moduleLoader._load = function (request: string, ...rest: unknown[]) {
  const loaded = realLoad.call(this, request, ...rest);
  if (request === "@/lib/db") return { ...(loaded as object), getDb: () => createStubDb().db };
  return loaded;
};

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
};

async function main() {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(null, { status: 204 }));

  check("no token, no call", (await dispatchMender({}, ok)) === "no-token" && calls.length === 0);

  check("with a token, one dispatch", (await dispatchMender({ MENDER_DISPATCH_TOKEN: "t" }, ok)) === "dispatched" && calls.length === 1);
  check("…of mender-agent.yml in this repository, on main",
    calls[0]?.url === `https://api.github.com/repos/${MENDER_REPO}/actions/workflows/${MENDER_WORKFLOW}/dispatches` &&
      JSON.parse(String(calls[0]?.init.body)).ref === "main" && calls[0]?.init.method === "POST");
  check("…bounded in time, so a stalled GitHub cannot hold the scheduler's tick", calls[0]?.init.signal instanceof AbortSignal);

  let threw = false;
  try {
    await dispatchMender({ MENDER_DISPATCH_TOKEN: "t" }, async () => new Response("{}", { status: 403 }));
  } catch {
    threw = true;
  }
  check("a refusal is an error, not a silent success", threw);

  const { runDueWatches } = await import("../src/agent/scheduler");

  // The database is the stub above, empty: the sweeps and the due-watch read
  // find nothing to do, so the tick is only its own wiring.
  const bindings = (token?: string) => ({ MENDER_DISPATCH_TOKEN: token }) as unknown as AgentBindings;

  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const sent: string[] = [];
  const warned: string[] = [];
  const tick = async (token: string | undefined, answer: () => Response | Promise<Response>) => {
    sent.length = 0;
    warned.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return answer();
    }) as typeof fetch;
    console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
    try {
      await runDueWatches(bindings(token), new Date(Date.UTC(2026, 9, 11, 12, 0, 0)));
      return { threw: null as unknown };
    } catch (err) {
      return { threw: err };
    } finally {
      globalThis.fetch = realFetch;
      console.warn = realWarn;
    }
  };
  const dispatches = () => sent.filter((u) => u.includes("/actions/workflows/") && u.endsWith("/dispatches")).length;

  // CHE-486: no clock. A tick with a token and nothing filed starts no Mender.
  const active = await tick("t", () => new Response(null, { status: 204 }));
  check("the scheduler's tick no longer starts Mender (no crons)", dispatches() === 0 && active.threw === null,
    `${dispatches()} dispatch(es)${active.threw ? `, tick threw: ${active.threw}` : ""}`);

  // wakeMender: the event's own call, which never throws.
  const said: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => void said.push(args.join(" "));
  console.warn = (...args: unknown[]) => void said.push(args.join(" "));
  const woke = await wakeMender({ MENDER_DISPATCH_TOKEN: "t" }, "run failure CHE-1", ok);
  const refused = await wakeMender({ MENDER_DISPATCH_TOKEN: "t" }, "run failure CHE-2", async () => new Response("{}", { status: 403 }));
  const down = await wakeMender({ MENDER_DISPATCH_TOKEN: "t" }, "run failure CHE-3", async () => { throw new Error("network down"); });
  const none = await wakeMender({}, "run failure CHE-4", ok);
  console.log = realLog;
  console.warn = realWarn;
  check("waking Mender says why, and a refused or unreachable GitHub is logged, never thrown",
    woke === "dispatched" && refused === "failed" && down === "failed" && none === "no-token" &&
      said.some((s) => s.includes("woken: run failure CHE-1")) && said.some((s) => s.includes("CHE-3") && s.includes("network down")), said.join(" | "));

  // Every place that files a ticket for Mender wakes it, right after filing —
  // read from the syntax tree, so a call in a comment, a string or the wrong
  // function does not count (CodeRabbit, #357). That the feedback wake follows
  // a created ticket is verify-feedback's, run for real.
  const sites = (file: string) => {
    const sf = ts.createSourceFile(file, readFileSync(new URL(`../src/agent/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const found: { fn: string; guard: string; reason: string }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "wakeMender") {
        let fn = "", guard = "";
        for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
          if (!guard && ts.isIfStatement(up) && up.thenStatement.pos <= node.pos && node.end <= up.thenStatement.end) guard = up.expression.getText(sf);
          if (ts.isFunctionDeclaration(up) && up.name) { fn = up.name.text; break; }
        }
        found.push({ fn, guard, reason: node.arguments[1]?.getText(sf) ?? "" });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return { sf, found };
  };
  const gaps = sites("capability-gaps.ts").found;
  const failures = sites("run-failures.ts");
  const feedback = sites("feedback-filing.ts").found;
  const forMender = (() => {
    let init = "";
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "forMender") init = node.initializer?.getText(failures.sf) ?? "";
      ts.forEachChild(node, visit);
    };
    visit(failures.sf);
    return init;
  })();
  const shape = JSON.stringify({ gaps, failures: failures.found, feedback, forMender });
  check("a checker gap wakes Mender once, after the gaps are filed, only when one was",
    gaps.length === 1 && gaps[0].fn === "fileCapabilityGaps" && /icon === "ok"/.test(gaps[0].guard) && /checker gap/.test(gaps[0].reason), shape);
  check("a run failure wakes Mender once, for a new ticket or a recurrence that holds Mender's label",
    failures.found.length === 1 && failures.found[0].fn === "fileRunFailure" && failures.found[0].guard === "forMender" &&
      /outcome\.kind === "created"/.test(forMender) && /tracker\.addLabel\(outcome\.identifier, MENDER_LABEL\)\.then\(\(\) => true/.test(forMender), shape);
  check("a pilot report wakes Mender once per tick, for every ticket created",
    feedback.length === 1 && feedback[0].fn === "fileOpenFeedback" && feedback[0].guard === "created.length" && /created\.join/.test(feedback[0].reason), shape);
  check("a run failure is filed under Mender's label",
    /selfPolicy\(self, "\[Checker failure\] \{verdict\}", \[MENDER_LABEL\]\)/.test(failures.sf.getFullText()));

  const wf = readFileSync(new URL("../.github/workflows/mender-agent.yml", import.meta.url), "utf8");
  check("Mender's workflow has no schedule", !/^\s*schedule:|cron:/m.test(wf));
  // The safety net without a clock: a wake GitHub refused, a ticket labelled by
  // hand, a key raised after an alarm — each is picked up at the next deploy.
  check("…and looks at its queue after every deploy of main",
    /workflow_run:\s*\n\s*workflows: \["CI \/ Deploy"\]\s*\n\s*types: \[completed\]\s*\n\s*branches: \[main\]/.test(wf));

  console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
