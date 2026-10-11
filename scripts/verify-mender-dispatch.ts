// CHE-445: the worker's cron is Mender's clock (GitHub fired the workflow's
// own schedule every 4–7 h). Without a token it does nothing; with one it asks
// GitHub for exactly one run of mender-agent.yml on main; a refusal is an
// error the scheduler logs and survives.
//
// The scheduler half is behavioural: it runs the real runDueWatches against a
// database with no rows and a fetch that records what leaves the worker, so it
// fails if the call is removed, moved behind an early return, or wrapped so it
// never runs — which a regex over the source cannot tell (CHE-449).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-mender-dispatch.ts

import Module from "node:module";
import type { AgentBindings } from "../src/agent/env";
import { createStubDb } from "./fixtures/mcp-db";
import { dispatchMender, MENDER_REPO, MENDER_WORKFLOW } from "../src/agent/mender-dispatch";

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

  const active = await tick("t", () => new Response(null, { status: 204 }));
  check("a tick with a token dispatches Mender exactly once", dispatches() === 1 && active.threw === null,
    `${dispatches()} dispatch(es)${active.threw ? `, tick threw: ${active.threw}` : ""}`);

  const idle = await tick(undefined, () => new Response(null, { status: 204 }));
  check("a tick without a token dispatches nothing", dispatches() === 0 && idle.threw === null);

  const refused = await tick("t", () => new Response("{}", { status: 403 }));
  check("a refused dispatch is logged and does not fail the tick",
    dispatches() === 1 && refused.threw === null && warned.some((w) => w.includes("[mender]")),
    refused.threw ? `tick threw: ${refused.threw}` : warned.join(" | "));

  const down = await tick("t", () => Promise.reject(new Error("network down")));
  check("an unreachable GitHub does not fail the tick",
    dispatches() === 1 && down.threw === null && warned.some((w) => w.includes("[mender]")),
    down.threw ? `tick threw: ${down.threw}` : warned.join(" | "));

  console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
