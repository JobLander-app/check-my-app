// CHE-389 verification: a check that runs inside a signed-in session, on a day
// the sign-in has ended.
//
// The app's address then leads to the product's sign-in page. A run that went
// on would map and walk that page and report on it as the app (rule 8). So the
// surface scan decides it, in code, and the run ends there. This drives the
// real functions (src/agent/signed-out.ts) with the stub database and the real
// TelegramMessage table:
//   1. what counts as "led somewhere that is not the app";
//   2. the run ends Not verified, cost 0, price 0, one skipped step that names
//      access — and a retried step writes nothing twice;
//   3. every sentence a customer reads passes the leak and homework detectors;
//   4. the person who signs in is told ONCE per ended sign-in: a second run,
//      a tenth run, a retried step send nothing; a sign-in that was restored
//      and ended again is a new message; nothing is sent, and nothing fails,
//      when the channel is not configured;
//   5. the workflow takes that exit before discovery, and before the closed
//      door.
// The scan itself — a real browser inside a real session landing on another
// origin — is in scripts/verify-session-browser.ts.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-signed-out.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  completeSignedOut,
  landedOutside,
  noteSessionReached,
  SIGN_IN_AWAY_MS,
  SIGN_IN_LIMIT_MS,
  SIGN_IN_WATCH_MS,
  SIGNED_OUT_FEED,
  whereItSettled,
  SIGNED_OUT_JOURNEY_TITLE,
  signedOutBottomLine,
  signedOutMessage,
  signedOutObserved,
  signedOutSendId,
  tellOwnerSignedOut,
} from "@/agent/signed-out";
import { priceRun } from "@/agent/pricing";
import { hasEnvironmentLeak, hasHomework, hasNarration } from "@/lib/verdict-language";
import type { SendDeps } from "@/lib/telegram-send";
import type { AgentEnv } from "@/agent/env";
import { createStubDb } from "./fixtures/mcp-db";

const ROOT = join(import.meta.dirname, "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const TARGET = "https://admin.shopify.com/store/prod-release-1/apps/easy-block-customer-ip-country";
const ALLOWED = ["https://admin.shopify.com", "https://securify-app-production-d4wmn.ondigitalocean.app"];
const HOST = "accounts.shopify.com";
const CHAT = "101333337";

async function main() {
  // ── 1 — what counts ──────────────────────────────────────────────────────
  for (const [landed, expected, why] of [
    ["https://accounts.shopify.com/lookup?rid=abc", HOST, "the product's sign-in, on its own host"],
    ["https://accounts.shopify.com/session-service/login?state=x", HOST, "the same, deeper in"],
    [TARGET, null, "the app itself"],
    ["https://admin.shopify.com/store/prod-release-1", null, "another page of the app's own origin — the app answering"],
    ["https://securify-app-production-d4wmn.ondigitalocean.app/dashboard", null, "an origin the owner allowed for the app"],
    ["https://ADMIN.shopify.com/store/prod-release-1", null, "the same origin, written differently"],
    ["https://evil-admin.shopify.com.example/login", "evil-admin.shopify.com.example", "a look-alike host is not the app"],
    ["http://admin.shopify.com/store/prod-release-1", "admin.shopify.com", "the same host over http is another origin"],
    ["about:blank", null, "a blank tab is a load that failed, not somewhere else"],
    ["chrome-error://chromewebdata/", null, "an error page is a load that failed, not somewhere else"],
    ["not an address", null, "nothing readable"],
  ] as const) {
    const got = landedOutside(landed, TARGET, ALLOWED);
    check(`landed: ${why}`, got === expected, String(got));
  }
  check("landed: with nothing allowed, only the app's own origin is the app",
    landedOutside("https://securify-app-production-d4wmn.ondigitalocean.app/", TARGET, []) === "securify-app-production-d4wmn.ondigitalocean.app");

  // Where the address settled: watched on a clock of our own, so each case is
  // the timeline it says it is.
  {
    const APP = TARGET;
    const AWAY = "https://accounts.shopify.com/lookup";
    // timeline: [from ms, address] — the address from that moment on.
    const settle = async (timeline: [number, string][]) => {
      let clock = 0;
      const address = () => [...timeline].reverse().find(([from]) => clock >= from)![1];
      const settled = await whereItSettled(address, (url) => landedOutside(url, TARGET, ALLOWED), async (ms) => { clock += ms as number; }, () => clock);
      return { settled, took: clock };
    };
    const onApp = await settle([[0, APP]]);
    check("settled: on the app through the whole watch → the app", onApp.settled === null && onApp.took >= SIGN_IN_WATCH_MS && onApp.took < SIGN_IN_WATCH_MS + 500, JSON.stringify(onApp));
    const sentAway = await settle([[0, AWAY]]);
    check("settled: sent to the sign-in at once and still there after a while → the sign-in has ended", sentAway.settled === HOST && sentAway.took >= SIGN_IN_AWAY_MS && sentAway.took < SIGN_IN_AWAY_MS + 500, JSON.stringify(sentAway));
    const byScript = await settle([[0, APP], [1_200, AWAY]]);
    check("settled: sent away by a script after the page loaded → ended", byScript.settled === HOST, JSON.stringify(byScript));
    const chain = await settle([[0, AWAY], [900, "https://accounts.shopify.com/session-service/login"], [2_100, "https://accounts.shopify.com/select"]]);
    check("settled: moving between pages of the sign-in host is still away → ended", chain.settled === HOST && chain.took < SIGN_IN_AWAY_MS + 500, JSON.stringify(chain));
    const bounce = await settle([[0, AWAY], [1_500, APP]]);
    check("settled: a bounce through the identity host that comes straight back is a sign-in that works — believed once it has stayed",
      bounce.settled === null && bounce.took >= 1_500 + SIGN_IN_WATCH_MS && bounce.took < 1_500 + SIGN_IN_WATCH_MS + 500, JSON.stringify(bounce));
    const lateBounce = await settle([[0, APP], [4_000, AWAY], [6_000, APP]]);
    check("settled: the same when the bounce starts late in the watch", lateBounce.settled === null && lateBounce.took >= 6_000 + SIGN_IN_WATCH_MS, JSON.stringify(lateBounce));
    const bounceThenOut = await settle([[0, AWAY], [1_000, APP], [2_000, AWAY]]);
    check("settled: a return that does not hold is not a return", bounceThenOut.settled === HOST && bounceThenOut.took >= 2_000 + SIGN_IN_AWAY_MS, JSON.stringify(bounceThenOut));
    const allowedHop = await settle([[0, APP], [800, "https://securify-app-production-d4wmn.ondigitalocean.app/auth"], [2_000, APP]]);
    check("settled: a hop to an origin allowed for the app was never 'away'", allowedHop.settled === null && allowedHop.took < SIGN_IN_WATCH_MS + 500, JSON.stringify(allowedHop));
    let flips = 0;
    let clock = 0;
    const restless = await whereItSettled(() => (Math.floor(clock / 1_000) % 2 === 0 ? AWAY : APP), (url) => { flips++; return landedOutside(url, TARGET, ALLOWED); }, async (ms) => { clock += ms as number; }, () => clock);
    check("settled: an address that never stays put is judged where it stands when time is up — the watch ends", clock >= SIGN_IN_LIMIT_MS && clock < SIGN_IN_LIMIT_MS + 500 && flips > 10 && (restless === null || restless === HOST), `${clock} ms → ${restless}`);
  }

  // ── 2 — the run ends at the sign-in page ─────────────────────────────────
  {
    const stub = createStubDb({
      team: [{ id: "team_1", plan: "business", topupUsd: 0, createdAt: new Date("2026-09-01T00:00:00Z") }],
      run: [{ id: "run_1", teamId: "team_1", status: "surface_scan", verdict: null, bottomLine: null, costUsd: null, priceUsd: null, priceFromTopupUsd: 0, completedAt: null, createdAt: new Date("2026-10-02T06:00:00Z") }],
    });
    const env = { db: stub.db } as unknown as AgentEnv;
    const verdict = await completeSignedOut(env, { id: "run_1", targetUrl: TARGET }, HOST);
    // A Workflow step that is retried runs this again.
    await completeSignedOut(env, { id: "run_1", targetUrl: TARGET }, HOST);
    const run = await stub.db.run.findUnique({ where: { id: "run_1" } });
    const journeys = await stub.db.journey.findMany({ where: { runId: "run_1" } });
    const steps = await stub.db.step.findMany({ where: { journeyId: journeys[0]?.id ?? "none" } });
    const findings = await stub.db.finding.findMany({ where: { runId: "run_1" } });
    check("end: Not verified with the fixed bottom line, finished, nothing spent",
      verdict === "unverified" && run?.verdict === "unverified" && run.status === "partial" && run.bottomLine === signedOutBottomLine(HOST) &&
        run.costUsd === 0 && run.completedAt instanceof Date,
      JSON.stringify({ verdict: run?.verdict, status: run?.status, cost: run?.costUsd }));
    check("end: one journey with one skipped step that names access, not a gap of ours — written once, even when the step is retried",
      journeys.length === 1 && journeys[0].title === SIGNED_OUT_JOURNEY_TITLE && journeys[0].status === "skipped" && steps.length === 1 &&
        steps[0].status === "skipped" && steps[0].unverifiedReason === "missing_access" && !steps[0].gapClass && steps[0].observed === signedOutObserved(HOST),
      `${journeys.length} journeys, ${steps.length} steps, ${steps[0]?.unverifiedReason}/${steps[0]?.gapClass}`);
    check("end: no finding exists", findings.length === 0, `${findings.length}`);
    const price = await priceRun(stub.db, "run_1", new Date("2026-10-02T06:05:00Z"));
    check("end: the check is priced $0", price === 0 && (await stub.db.run.findUnique({ where: { id: "run_1" } }))?.priceUsd === 0, `price=${price}`);
  }
  // A retry that finds the journey written and the step not: the step is still
  // owed. A journey alone would publish Not verified with nothing saying why.
  {
    const stub = createStubDb({
      run: [{ id: "run_half", status: "surface_scan", verdict: null, bottomLine: null, costUsd: null, completedAt: null }],
      journey: [{ id: "j_half", runId: "run_half", order: 0, title: SIGNED_OUT_JOURNEY_TITLE, status: "skipped", summary: signedOutObserved(HOST) }],
    });
    await completeSignedOut({ db: stub.db } as unknown as AgentEnv, { id: "run_half", targetUrl: TARGET }, HOST);
    const journeys = await stub.db.journey.findMany({ where: { runId: "run_half" } });
    const steps = await stub.db.step.findMany({ where: { journeyId: "j_half" } });
    check("end: a retry after the journey was written and the step was not writes the step — and no second journey",
      journeys.length === 1 && steps.length === 1 && steps[0].unverifiedReason === "missing_access" &&
        (await stub.db.run.findUnique({ where: { id: "run_half" } }))?.verdict === "unverified",
      `${journeys.length} journeys, ${steps.length} steps`);
  }

  // ── 3 — rule 1 over every sentence a customer reads ──────────────────────
  for (const text of [signedOutBottomLine(HOST), signedOutObserved(HOST), SIGNED_OUT_FEED]) {
    check(`rule 1: no homework, narration or machinery — "${text.slice(0, 70)}…"`, !hasHomework(text) && !hasNarration(text) && !hasEnvironmentLeak(text), text);
  }
  check("bottom line: says where the address led, that it is not a verdict and was not charged",
    signedOutBottomLine(HOST).includes(HOST) && /not a verdict on your app/.test(signedOutBottomLine(HOST)) && /was not charged/.test(signedOutBottomLine(HOST)));

  // ── 4 — the person who signs in is told once per ended sign-in ───────────
  {
    const { telegramTable } = await import("./fixtures/telegram-table.mjs");
    const table = await telegramTable(ROOT);
    let sends = 0;
    let n = 0;
    const deps: SendDeps = {
      d1: async (sql, params) => table.run(sql, params),
      sendMessage: async (chatId, text) => {
        sends++;
        return { ok: true, result: { message_id: 900 + sends, date: 1_790_000_000, chat: { id: Number(chatId) }, from: { first_name: "CheckMyApp" }, text } as never };
      },
      newId: () => `out-${++n}`,
      now: () => new Date("2026-10-02T06:00:00Z"),
    };
    const stub = createStubDb({ app: [{ id: "app_admin", sessionReachedAt: null }, { id: "app_other", sessionReachedAt: null }] });
    const env = { db: stub.db, bindings: { OWNER_TELEGRAM_CHAT_ID: CHAT, SESSION_SIGN_IN_URL: "https://session.checkmyapp.dev" } } as unknown as AgentEnv;
    const tell = (id: string) => tellOwnerSignedOut(env, { id, appId: "app_admin", appSlug: "admin.shopify.com" }, HOST, deps);
    const rows = () => table.all() as { direction: string; status: string; text: string; sendId: string; chatId: string }[];

    const first = await tell("run_out_1");
    check("told: the first run that meets the sign-in page sends one message, recorded as sent",
      first.told === "sent" && sends === 1 && rows().length === 1 && rows()[0].status === "sent" && rows()[0].direction === "out" && rows()[0].chatId === CHAT,
      JSON.stringify(first));
    check("told: the message says what stopped, where the address leads, where to sign in — and asks for no reply",
      rows()[0].text === signedOutMessage("admin.shopify.com", HOST, "https://session.checkmyapp.dev") &&
        rows()[0].text.includes("admin.shopify.com") && rows()[0].text.includes(HOST) && rows()[0].text.includes("https://session.checkmyapp.dev") && /Отвечать не нужно/.test(rows()[0].text),
      rows()[0].text);
    check("told: the id is the sign-in that ended — the app, and when a check last reached it (never yet)",
      "sendId" in first && first.sendId === signedOutSendId("app_admin", null) && first.sendId === "session-signed-out:app_admin:never");

    const retried = await tell("run_out_1");
    check("told: the same step retried sends nothing", retried.told === "already" && sends === 1, JSON.stringify(retried));
    // The next day's run, and more after it: the sign-in is still the same ended one.
    const later = await Promise.all([3, 7, 12].map((d) => tell(`run_out_${d}`)));
    check("told: every later run that meets the same ended sign-in sends nothing", later.every((t) => t.told === "already") && sends === 1 && rows().length === 1,
      `${later.map((t) => t.told).join()} — ${sends} sends`);

    // Someone signed in. A run's scan reached the app — and that is recorded
    // there and then, whatever became of the run: this one failed in discovery
    // (it never finished, spent nothing that was written), and the sign-in it
    // rode on was real all the same. Then that sign-in ended.
    const REACHED = new Date("2026-10-13T06:00:05.000Z");
    await noteSessionReached(env, { appId: "app_admin" }, REACHED);
    check("reached: written on the app's own row by the scan", ((await stub.db.app.findUnique({ where: { id: "app_admin" } }))?.sessionReachedAt as Date)?.getTime() === REACHED.getTime());
    const again = await tell("run_out_20");
    check("told: a sign-in that was restored and ended again is a new message — even when the only run that rode on it failed later",
      again.told === "sent" && sends === 2 && "sendId" in again && again.sendId === "session-signed-out:app_admin:2026-10-13T06:00:05.000Z", JSON.stringify(again));
    check("told: …and once for that one too", (await tell("run_out_21")).told === "already" && sends === 2);
    // Another app's sign-in is another app's: it does not make this one new.
    await noteSessionReached(env, { appId: "app_other" }, new Date("2026-10-22T06:00:00.000Z"));
    check("told: another app being reached does not make this app's ended sign-in a new one", (await tell("run_out_23")).told === "already" && sends === 2, `${sends} sends`);
    // A run with no saved app has no row to write on: nothing happens, nothing throws.
    await noteSessionReached(env, { appId: null });
    check("reached: a run with no saved app writes nothing", (await stub.db.app.findMany({})).length === 2);

    // The channel is not configured: nothing is sent and nothing fails.
    for (const bindings of [{}, { TELEGRAM_BOT_TOKEN: "t" }, { OWNER_TELEGRAM_CHAT_ID: CHAT }, { TELEGRAM_BOT_TOKEN: " ", OWNER_TELEGRAM_CHAT_ID: CHAT }]) {
      const off = await tellOwnerSignedOut({ db: stub.db, bindings } as unknown as AgentEnv, { id: "run_out_23", appId: "app_admin", appSlug: "admin.shopify.com" }, HOST);
      check(`told: without ${Object.keys(bindings).length === 2 ? "a real token" : Object.keys(bindings).length ? "both the token and the chat" : "any configuration"} nothing is sent — and nothing throws`,
        off.told === "off" && sends === 2, JSON.stringify(off));
    }
    // Telegram refuses, D1 is down: said, never thrown — the run has finished.
    const refusing: SendDeps = { ...deps, sendMessage: async () => ({ ok: false, description: "Bad Request: chat not found" }) };
    await noteSessionReached(env, { appId: "app_admin" }, new Date("2026-10-30T06:00:00.000Z"));
    const refused = await tellOwnerSignedOut(env, { id: "run_out_31", appId: "app_admin", appSlug: "admin.shopify.com" }, HOST, refusing);
    check("told: a refused send is reported as failed, not thrown", refused.told === "failed" && "detail" in refused && /chat not found/.test(refused.detail), JSON.stringify(refused));
    const afterRefusal = await tell("run_out_31");
    check("told: …and the next run may send it — a failed send is not a sent one", afterRefusal.told === "sent" && sends === 3, JSON.stringify(afterRefusal));
    const down: SendDeps = { ...deps, d1: async () => { throw new Error("D1 unavailable"); } };
    const lost = await tellOwnerSignedOut(env, { id: "run_out_31", appId: "app_admin", appSlug: "admin.shopify.com" }, HOST, down);
    check("told: with the record unavailable nothing is sent", lost.told === "failed" && sends === 3, JSON.stringify(lost));
    // Another owner's app at the same address — or this app deleted and added
    // again — is another app: its first ended sign-in is told, though this
    // app's "never reached" one already was. The id names the app, not the slug.
    const twin = await tellOwnerSignedOut(env, { id: "run_twin_1", appId: "app_other", appSlug: "admin.shopify.com" }, HOST, deps);
    await stub.db.app.create({ data: { id: "app_new", sessionReachedAt: null } });
    const recreated = await tellOwnerSignedOut(env, { id: "run_new_1", appId: "app_new", appSlug: "admin.shopify.com" }, HOST, deps);
    check("told: an app that shares the address with another, or was added again, is told for itself",
      twin.told === "sent" && recreated.told === "sent" && sends === 5 && "sendId" in recreated && recreated.sendId === "session-signed-out:app_new:never", `${twin.told}, ${recreated.told} — ${sends} sends`);
    const appless = await tellOwnerSignedOut(env, { id: "run_oneoff", appId: null, appSlug: "admin.shopify.com" }, HOST, deps);
    check("told: a run with no saved app is its own — told once, under its own id",
      appless.told === "sent" && "sendId" in appless && appless.sendId === "session-signed-out:run:run_oneoff:never" &&
        (await tellOwnerSignedOut(env, { id: "run_oneoff", appId: null, appSlug: "admin.shopify.com" }, HOST, deps)).told === "already", JSON.stringify(appless));
  }

  // ── 5 — the workflow takes that exit before discovery ────────────────────
  // The workflow runs only inside the Workers runtime, so its wiring is held
  // by shape.
  {
    const workflow = readFileSync(join(ROOT, "src/agent/workflow.ts"), "utf8");
    const exit = workflow.indexOf("if (scan.signedOut) {");
    const door = workflow.indexOf("if (scan.door) {");
    const discovery = workflow.indexOf('step.do("discovery"');
    const block = exit >= 0 ? workflow.slice(exit, door) : "";
    check("workflow: an ended sign-in ends the run before the closed door and before discovery",
      exit >= 0 && door > exit && discovery > door && /completeSignedOut\(/.test(block) && /priceRun\(/.test(block) &&
        /notifyAndRecord\([^)]*"unverified"\)/.test(block) && /clearedCredentials\(run\)/.test(block) && /\n {8}return;\n/.test(block));
    check("workflow: the message is a step of its own, the host is given back, and no gap is filed on our board for missing access",
      /step\.do\("tell-signed-out"/.test(block) && /tellOwnerSignedOut\(/.test(block) && /releaseSessionHost\("release-session-signed-out"\)/.test(block) && !/fileCapabilityGaps\(/.test(block));
    check("workflow: a sign-in page's status, stack and links are not reported as the app's",
      /if \(r\.signedOut\) return \{ \.\.\.r, extensionIdentity: null \};[\s\S]{0,400}?await appendEvent\(env, runId, "surface_scan", \{\s*icon: "ok",\s*text: `Loaded homepage/.test(workflow));
    // Reaching the app is recorded by the scan step itself, for a session run
    // that was neither sent to a sign-in nor turned away at the door — before
    // anything later in the run can fail.
    const scanStep = workflow.slice(workflow.indexOf('step.do("surface_scan"'), exit);
    check("workflow: the scan records that the app was reached, in the scan step, after the signed-out return",
      /if \(r\.signedOut\) return [^\n]+\n[\s\S]{0,400}?if \(isSession && !r\.door\) await noteSessionReached\(env, run\);/.test(scanStep));
    const feed = block.match(/appendEvent\([^)]*\)/g) ?? [];
    check("workflow: the feed says one thing, in the product's terms", feed.length === 1 && /SIGNED_OUT_FEED/.test(feed[0]), feed.join(" | "));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(String(err instanceof Error ? err.stack : err));
  process.exit(1);
});
