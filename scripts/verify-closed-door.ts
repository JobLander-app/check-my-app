// CHE-390 verification: a target whose own first page turns us away.
//
// Run #292 (prod, 2026-10-02): a new account's first check answered 403 on
// every address, the first page included. We mapped it, walked it, published
// "Broken — Entire origin returns 403 Forbidden on every path" with a finding,
// and charged $0.28. Nothing of the product had been seen (rule 8).
//
// The door is now decided by the surface scan, in code, and a closed door ends
// the run there. This drives the real functions with a fake browser and the
// stub database:
//   1. what counts as a closed door (src/agent/closed-door.ts);
//   2. the surface scan asks twice, and only the same answer twice is a door;
//   3. the run ends Not verified, cost 0, price 0, one skipped step carrying
//      our gap, no finding — and a retried step writes nothing twice;
//   4. the gap is a class of its own on our board;
//   5. every sentence the customer reads passes the leak and homework detectors;
//   6. the workflow takes that exit before discovery.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-closed-door.ts

process.env.CREDENTIALS_SECRET ??= "verify-closed-door-secret";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Module from "node:module";
import {
  closedDoor,
  completeClosedDoor,
  doorBottomLine,
  doorObserved,
  DOOR_JOURNEY_TITLE,
  type ClosedDoor,
} from "@/agent/closed-door";
import { GAP_CLASSES, isGapClass } from "@/agent/gap-classes";
import { priceRun } from "@/agent/pricing";
import { priceForCost } from "@/lib/plans";
import { USER_PLANS } from "@/lib/enums";
import { hasEnvironmentLeak, hasHomework, hasNarration } from "@/lib/verdict-language";
import type { AgentEnv } from "@/agent/env";
import { createStubDb } from "./fixtures/mcp-db";

// src/agent/browser.ts reaches @cloudflare/playwright, which requires the
// `cloudflare:workers` builtin at load time. No browser is opened here.
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

const TARGET = "https://192.168.0.197:53317/";

// A site that answers each successive load of its first page with the next
// status, and shows `links[i]` links into itself on that load.
function fakeSite(statuses: Array<number | "timeout">, links: number[], deep: Record<string, number> = {}) {
  let loads = 0;
  let url = "about:blank";
  const opened: string[] = [];
  const page = {
    url: () => url,
    goto: async (to: string) => {
      opened.push(new URL(to).pathname);
      // An address deeper in the app answers with its own status.
      const own = deep[new URL(to).pathname];
      if (own !== undefined) {
        url = to;
        return { status: () => own, headers: () => ({}) };
      }
      const i = loads++;
      const status = statuses[Math.min(i, statuses.length - 1)];
      if (status === "timeout") throw new Error("Timeout 30000ms exceeded.");
      url = to;
      return { status: () => status, headers: () => ({}) };
    },
    waitForTimeout: async () => {},
    // The link count is a function; the store-gate probe is a string.
    evaluate: async (arg: unknown) => (typeof arg === "function" ? links[Math.min(Math.max(loads - 1, 0), links.length - 1)] : undefined),
    content: async () => "<html><body>Forbidden</body></html>",
    addInitScript: async () => {},
    on: () => {},
    screenshot: async () => {
      throw new Error("no screenshots here");
    },
  };
  const browser = { version: () => "126.0.0", newContext: async () => ({ newPage: async () => page, close: async () => {} }) };
  return { browser, loads: () => loads, opened };
}

async function main() {
  // ── 1 — what counts ──────────────────────────────────────────────────────
  for (const [first, second, links, expected, why] of [
    [403, 403, 0, "forbidden", "run #292: 403 twice, nothing of the product on the page"],
    [401, 401, 0, "unauthorized", "a sign-in at the address itself, twice"],
    [403, 401, 0, "unauthorized", "turned away both times, by either answer"],
    [403, 200, 0, null, "a challenge that let the browser through on the second try"],
    [403, 403, 4, null, "a 403 page that carries the app's own links is the app answering"],
    [200, 200, 0, null, "an ordinary first page"],
    [503, 503, 0, null, "a site that is down is not a door — that is a legitimate broken"],
    [404, 404, 0, null, "a missing page is not a door"],
    [403, null, 0, null, "the second try did not answer: not known to be a door"],
    [null, null, 0, null, "no answer at all"],
  ] as const) {
    const got = closedDoor(first, second, links);
    check(`door: ${why}`, got === expected, String(got));
  }

  // ── 2 — the surface scan asks twice ──────────────────────────────────────
  const { surfaceScan } = await import("@/agent/browser");
  const scan = async (statuses: Array<number | "timeout">, links: number[], known: string[] = [], deep: Record<string, number> = {}) => {
    const site = fakeSite(statuses, links, deep);
    const db = createStubDb({ run: [{ id: "run_scan", storePasswordEnc: null, storePasswordState: null }] });
    const result = await surfaceScan({ db: db.db, bindings: {} } as unknown as AgentEnv, site.browser as never, {
      targetUrl: TARGET, id: "run_scan", storePasswordEnc: null,
    }, known);
    return { result, loads: site.loads(), opened: site.opened };
  };
  // An app we have looked at before: its first page is closed, an address it
  // is known to have is not (review of PR #238).
  {
    const ORIGIN = new URL(TARGET).origin;
    const { result, opened } = await scan([403, 403], [0, 0], [`${ORIGIN}/app`], { "/app": 200 });
    check("scan: the first page is closed but a known address of the app opens → not a door, the check goes on",
      result.door === null && opened.join() === "/,/,/app", `${result.door} opened ${opened.join()}`);
    const closed = await scan([403, 403], [0, 0], [`${ORIGIN}/app`, `${ORIGIN}/pricing`, `${ORIGIN}/docs`], { "/app": 403, "/pricing": 401, "/docs": 200 });
    check("scan: known addresses are turned away too → a closed door, and no more than two are tried",
      closed.result.door === "forbidden" && closed.opened.join() === "/,/,/app,/pricing", `${closed.result.door} opened ${closed.opened.join()}`);
    const foreign = await scan([403, 403], [0, 0], ["https://elsewhere.example/app", TARGET, `${ORIGIN}/#top`], { "/app": 200 });
    check("scan: another site's address and the first page itself are not 'deeper'",
      foreign.result.door === "forbidden" && foreign.opened.join() === "/,/", `${foreign.result.door} opened ${foreign.opened.join()}`);
    const down = await scan([403, 403], [0, 0], [`${ORIGIN}/app`], { "/app": 500 });
    check("scan: a known address that errors does not open the door", down.result.door === "forbidden", String(down.result.door));
  }
  {
    const { result, loads } = await scan([403, 403], [0, 0]);
    check("scan: 403 on the first page and again on a second try → a closed door", result.door === "forbidden" && loads === 2, `${result.door} after ${loads} loads`);
  }
  {
    const { result } = await scan([401, 401], [0, 0]);
    check("scan: 401 twice → a closed door that asks for a sign-in", result.door === "unauthorized", String(result.door));
  }
  {
    const { result, loads } = await scan([403, 200], [0, 3]);
    check("scan: 403 then the real page on the second try → not a door, and the scan reports the page it got",
      result.door === null && loads === 2 && result.status === 200 && result.internalLinkCount === 3,
      `${result.door} status=${result.status} links=${result.internalLinkCount}`);
  }
  {
    const { result, loads } = await scan([403], [4]);
    check("scan: a 403 page with the app's links on it → not a door, not asked twice", result.door === null && loads === 1, `${result.door} after ${loads} loads`);
  }
  {
    const { result, loads } = await scan([200], [7]);
    check("scan: an ordinary first page is loaded once", result.door === null && loads === 1 && result.status === 200, `${loads} loads`);
  }
  {
    const { result, loads } = await scan([503], [0]);
    check("scan: a 503 first page is not a door and is not asked twice", result.door === null && loads === 1, `${result.door} after ${loads} loads`);
  }
  {
    const { result } = await scan([403, "timeout"], [0, 0]);
    check("scan: a second try that never answers → not known to be a door, the run goes on", result.door === null && result.status === 403, String(result.door));
  }

  // ── 3 — the run ends at the door ─────────────────────────────────────────
  for (const door of ["forbidden", "unauthorized"] as ClosedDoor[]) {
    const stub = createStubDb({
      team: [{ id: "team_1", plan: "free", topupUsd: 0, createdAt: new Date("2026-10-02T00:36:00Z") }],
      run: [{ id: "run_292", teamId: "team_1", status: "surface_scan", verdict: null, bottomLine: null, costUsd: null, priceUsd: null, priceFromTopupUsd: 0, completedAt: null, createdAt: new Date("2026-10-02T00:39:31Z") }],
    });
    const env = { db: stub.db } as unknown as AgentEnv;
    const verdict = await completeClosedDoor(env, { id: "run_292", targetUrl: TARGET }, door);
    // A Workflow step that is retried runs this again.
    await completeClosedDoor(env, { id: "run_292", targetUrl: TARGET }, door);
    const run = await stub.db.run.findUnique({ where: { id: "run_292" } });
    const journeys = await stub.db.journey.findMany({ where: { runId: "run_292" } });
    const steps = await stub.db.step.findMany({ where: { journeyId: journeys[0]?.id ?? "none" } });
    const findings = await stub.db.finding.findMany({ where: { runId: "run_292" } });
    check(`end, ${door}: Not verified with the fixed bottom line, finished, nothing spent`,
      verdict === "unverified" && run?.verdict === "unverified" && run.status === "partial" && run.bottomLine === doorBottomLine(door) &&
        run.costUsd === 0 && run.completedAt instanceof Date,
      JSON.stringify({ verdict: run?.verdict, status: run?.status, cost: run?.costUsd }));
    check(`end, ${door}: one journey with one skipped step that carries our gap — written once, even when the step is retried`,
      journeys.length === 1 && journeys[0].title === DOOR_JOURNEY_TITLE && journeys[0].status === "skipped" && steps.length === 1 &&
        steps[0].status === "skipped" && steps[0].unverifiedReason === "our_capability" && steps[0].gapClass === "target_door" &&
        steps[0].observed === doorObserved(door),
      `${journeys.length} journeys, ${steps.length} steps, ${steps[0]?.unverifiedReason}/${steps[0]?.gapClass}`);
    check(`end, ${door}: no finding exists`, findings.length === 0, `${findings.length}`);
    const price = await priceRun(stub.db, "run_292", new Date("2026-10-02T00:42:00Z"));
    const priced = await stub.db.run.findUnique({ where: { id: "run_292" } });
    check(`end, ${door}: the check is priced $0 (run #292 was charged $0.28)`, price === 0 && priced?.priceUsd === 0, `price=${price}`);
  }
  check("price: a check that cost nothing is free on every plan", USER_PLANS.every((p) => priceForCost(p, 0) === 0));

  // ── 4 — the gap on our board ─────────────────────────────────────────────
  check("gap: target_door is a class with its own label (its own ticket)",
    isGapClass("target_door") && Object.values(GAP_CLASSES).filter((c) => c.label === GAP_CLASSES.target_door.label).length === 1,
    GAP_CLASSES.target_door.label);

  // ── 5 — rule 1 over every sentence a customer reads ──────────────────────
  for (const door of ["forbidden", "unauthorized"] as ClosedDoor[]) {
    for (const text of [doorBottomLine(door), doorObserved(door)]) {
      check(`rule 1: no homework, narration or machinery — "${text.slice(0, 70)}…"`,
        !hasHomework(text) && !hasNarration(text) && !hasEnvironmentLeak(text), text);
    }
    check(`bottom line, ${door}: says it is not a verdict and was not charged`,
      /not a verdict on your app/.test(doorBottomLine(door)) && /was not charged/.test(doorBottomLine(door)));
  }

  // ── 6 — the workflow takes that exit before discovery ────────────────────
  // The workflow runs only inside the Workers runtime, so its wiring is held
  // by shape: the closed-door exit sits after the scan and before discovery,
  // prices the run, files the gap, and returns.
  {
    const workflow = readFileSync(join(import.meta.dirname, "..", "src/agent/workflow.ts"), "utf8");
    const exit = workflow.indexOf("if (scan.door) {");
    const discovery = workflow.indexOf('step.do("discovery"');
    const block = exit >= 0 ? workflow.slice(exit, discovery) : "";
    check("workflow: a closed door ends the run before discovery",
      exit >= 0 && discovery > exit && /completeClosedDoor\(/.test(block) && /priceRun\(/.test(block) && /fileCapabilityGaps\(/.test(block) &&
        /notifyAndRecord\([^)]*"unverified"\)/.test(block) && /clearedCredentials\(run\)/.test(block) && /\n {8}return;\n/.test(block));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(String(err instanceof Error ? err.stack : err));
  process.exit(1);
});
