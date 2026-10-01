// CHE-372 verification: a store password is an access input, like a test login.
//
// A password-protected Shopify store sends every storefront address to
// /password. Runs #281–#283 on securify-demo.myshopify.com stopped there, and
// since CHE-365 such a run is Not verified. The fix is that the owner can give
// us the store password and every phase enters it, in code — so this checks the
// code, through the real entry points, with a fake store and no browser:
//
//   1. which page is the gate (src/lib/store-gate.ts) — /password on the
//      store's own site, nothing else;
//   2. the unlock itself (src/agent/store-password.ts) against a fake store:
//      the right password opens it, a wrong one is recorded as rejected, and a
//      rejected one is never submitted again (one attempt per run, CHE-100);
//   3. the navigate tool: the walk lands behind the gate, the trail records the
//      real page, the password never appears in anything the tools return; a
//      refused password ends the attempt and every later navigate, and the
//      step on the locked store is written skipped / missing_access;
//   4. the smoke pass does not call a locked store "all healthy";
//   5. the run's state: decrypted for the tools, the rejection persisted once
//      and named in the live feed, cleared with the test password after a
//      one-off run;
//   6. the prompt says the store unlocks itself — never the value or its blob;
//   7. the verdict asks for "the store password" by name when that is what
//      would open the gate, and every sentence a customer reads passes the
//      same leak and homework detectors the verdict does.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-store-password.ts

process.env.CREDENTIALS_SECRET ??= "verify-store-password-secret";

import { encryptSecret } from "@/lib/crypto";
import { isStoreGateUrl } from "@/lib/store-gate";
import { clearedCredentials } from "@/lib/test-accounts";
import { hasEnvironmentLeak, hasHomework, hasNarration } from "@/lib/verdict-language";
import { unlockStoreGate, type StoreAccess, type UnlockPage } from "@/agent/store-password";
import {
  executeTool,
  productizeStep,
  scrubSecrets,
  STORE_LOCKED_OBSERVED,
  type RecordedAction,
  type ReportedStep,
  type ToolEnv,
} from "@/agent/tools";
import { credentialToolEnv, recordStorePasswordRejection, storeAccessFor } from "@/agent/credentials";
import { discoverySystem, walkingSystem } from "@/agent/instructions";
import { judgeVerdictIntegrity, type IntegrityJourney } from "@/agent/verdict-integrity";
import type { AgentEnv } from "@/agent/env";
import { createStubDb } from "./fixtures/mcp-db";
import Module from "node:module";

// §4 drives the smoke pass's real gate step, which lives in src/agent/replay.ts;
// that module reaches @cloudflare/playwright, which requires the
// `cloudflare:workers` builtin at load time. No browser is opened here, so the
// builtin is answered with an empty object and replay.ts is imported after the
// hook — the shim scripts/verify-survey.ts uses.
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

const STORE = "https://securify-demo.myshopify.com";
const RIGHT = "open-sesame-9431";
const WRONG = "stale-store-pw-77";

// A fake password-protected store. Every address redirects to /password until
// the right password is submitted there; after that the "cookie" lets every
// page through. A wrong password re-renders /password, as Shopify does.
function fakeStore(correct: string, locked = true) {
  let url = "about:blank";
  let unlocked = !locked;
  let pending = "";
  const submitted: string[] = [];
  const onGate = () => {
    try {
      return new URL(url).pathname === "/password";
    } catch {
      return false;
    }
  };
  const field = {
    first: () => field,
    count: async () => (onGate() ? 1 : 0),
    fill: async (v: string) => {
      pending = v;
    },
    press: async () => {
      submitted.push(pending);
      if (pending === correct) {
        unlocked = true;
        url = `${STORE}/`;
      } else url = `${STORE}/password`;
    },
    inputValue: async () => pending,
    or: () => field,
  };
  const page = {
    url: () => url,
    goto: async (to: string) => {
      const asked = new URL(to);
      url = unlocked || asked.pathname === "/password" ? asked.toString() : `${STORE}/password`;
      // Behind the gate, an address the store does not have answers 404 —
      // the gate itself answers 200 for everything.
      const status = unlocked && asked.pathname === "/no-such-page" ? 404 : 200;
      return { status: () => status };
    },
    // Playwright resolves when the predicate holds and times out otherwise;
    // the fake times out at once rather than making the script wait.
    waitForURL: async (pred: (u: URL) => boolean) => {
      if (!pred(new URL(url))) throw new Error("Timeout 20000ms exceeded.");
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => 0,
    locator: () => field,
    getByLabel: () => field,
    getByPlaceholder: () => field,
    getByRole: () => field,
    on: () => {},
  };
  return { page, submitted, isUnlocked: () => unlocked };
}

function toolEnv(page: unknown, store: Partial<ToolEnv>, reported: ReportedStep[] = []): ToolEnv {
  return {
    page,
    targetOrigin: STORE,
    networkLog: [],
    consoleLog: [],
    actionTrail: [],
    credentials: { rejected: false },
    onReportStep: async (s: ReportedStep) => {
      reported.push(s);
    },
    ...store,
  } as unknown as ToolEnv;
}

// The trail of run #281: every product page we asked for ended on /password,
// and the walk typed into "Enter store password" there.
function lockedJourneys(): IntegrityJourney[] {
  const nav = (path: string) =>
    JSON.stringify([{ kind: "navigate", url: `${STORE}${path}`, outcome: { urlAfter: `${STORE}/password`, status: 200 } }]);
  const fill = JSON.stringify([
    { kind: "fill", label: "Enter store password", value: "x", outcome: { urlAfter: `${STORE}/password` } },
  ]);
  return ["/", "/collections/all", "/cart"].map((p) => ({
    status: "partial",
    steps: [
      { status: "ok", unverifiedReason: null, actions: nav(p) },
      { status: "skipped", unverifiedReason: "missing_access", actions: fill },
    ],
  }));
}

async function main() {
  // ── 1 — which page is the gate ──────────────────────────────────────────
  for (const [url, expected, why] of [
    [`${STORE}/password`, true, "the store's own /password"],
    [`${STORE}/password/`, true, "trailing slash folded"],
    [`${STORE}/password?return_to=/cart`, true, "the query is not the place"],
    ["https://www.securify-demo.myshopify.com/password", true, "www folded"],
    [`${STORE}/account/password`, false, "a password page deeper in the site is not the store gate"],
    [`${STORE}/password-reset`, false, "a lookalike path is not the gate"],
    ["https://other-store.myshopify.com/password", false, "another store's gate is not this store's"],
    [`${STORE}/`, false, "the storefront itself"],
  ] as const) {
    check(`gate: ${why}`, isStoreGateUrl(url, STORE) === expected, url);
  }

  // ── 2 — the unlock against a fake store ──────────────────────────────────
  {
    const s = fakeStore(RIGHT);
    await s.page.goto(`${STORE}/`);
    const state = { rejected: false };
    let recorded = 0;
    const access: StoreAccess = { password: RIGHT, state, onRejected: async () => void recorded++ };
    const out = await unlockStoreGate(s.page as unknown as UnlockPage, STORE, access);
    check("unlock: the right password opens the store and lands on its page",
      out === "unlocked" && s.page.url() === `${STORE}/` && s.submitted.join() === RIGHT, `${out} ${s.page.url()}`);
    check("unlock: an accepted password is not recorded as rejected", !state.rejected && recorded === 0);
    const again = await unlockStoreGate(s.page as unknown as UnlockPage, STORE, access);
    check("unlock: off the gate there is nothing to do", again === "not_gate" && s.submitted.length === 1, again);
  }
  {
    const s = fakeStore(RIGHT);
    await s.page.goto(`${STORE}/`);
    const state = { rejected: false };
    let recorded = 0;
    const access: StoreAccess = { password: WRONG, state, onRejected: async () => void recorded++ };
    const out = await unlockStoreGate(s.page as unknown as UnlockPage, STORE, access);
    check("unlock: a wrong password is rejected, recorded once, the store stays locked",
      out === "rejected" && state.rejected && recorded === 1 && !s.isUnlocked(), `${out} recorded=${recorded}`);
    await s.page.goto(`${STORE}/collections/all`);
    const second = await unlockStoreGate(s.page as unknown as UnlockPage, STORE, access);
    check("unlock: once rejected it is never submitted again — one attempt per run",
      second === "already_rejected" && s.submitted.length === 1 && recorded === 1, `${second} submitted=${s.submitted.length}`);
  }
  {
    const s = fakeStore(RIGHT);
    await s.page.goto(`${STORE}/`);
    const out = await unlockStoreGate(s.page as unknown as UnlockPage, STORE, { state: { rejected: false } });
    check("unlock: no store password on the run → nothing typed", out === "no_password" && s.submitted.length === 0, out);
  }

  // ── 3 — the navigate tool ────────────────────────────────────────────────
  {
    const s = fakeStore(RIGHT);
    let recorded = 0;
    const env = toolEnv(s.page, {
      storePassword: RIGHT,
      storeAccess: { rejected: false },
      onStorePasswordRejected: async () => void recorded++,
    });
    const result = await executeTool(env, "navigate", { url: `${STORE}/collections/all` });
    const action = (env.actionTrail as RecordedAction[])[0];
    check("navigate: a locked store is opened with the store password, and the walk is past the gate",
      s.isUnlocked() && s.submitted.join() === RIGHT && !isStoreGateUrl(s.page.url(), STORE), `${result} / ${s.page.url()}`);
    check("navigate: the trail records where the navigation really ended — not the gate",
      action?.kind === "navigate" && !isStoreGateUrl(action.outcome.urlAfter, STORE), JSON.stringify(action));
    check("navigate: the walk lands on the page it asked for, not on the home page the unlock redirects to",
      s.page.url() === `${STORE}/collections/all` && action?.kind === "navigate" && action.outcome.urlAfter === `${STORE}/collections/all`,
      s.page.url());
    check("navigate: the store password is in nothing the tool returns or records",
      !result.includes(RIGHT) && !JSON.stringify(env.actionTrail).includes(RIGHT), result);
    check("navigate: an accepted password leaves no lock behind", !env.storeLocked && recorded === 0);
  }
  {
    // Codex review of #220: the status after the unlock is the destination's,
    // not the gate's 200 — so an address nobody published still meets the
    // CHE-171 guard instead of being remembered as a real page.
    const s = fakeStore(RIGHT);
    const env = toolEnv(s.page, {
      storePassword: RIGHT,
      storeAccess: { rejected: false },
      knownUrls: new Set<string>([`${STORE}/`]),
    });
    const result = await executeTool(env, "navigate", { url: `${STORE}/no-such-page` });
    const action = (env.actionTrail as RecordedAction[])[0];
    check("navigate: after the unlock, the destination's own status is what is read and recorded",
      action?.kind === "navigate" && action.outcome.status === 404 && /status 404/.test(result) && /not linked from any/.test(result),
      `${JSON.stringify(action?.kind === "navigate" ? action.outcome : action)} ${result.slice(0, 80)}`);
    check("navigate: an unpublished address behind the gate is not remembered as published",
      !env.knownUrls?.has(`${STORE}/no-such-page`), JSON.stringify([...(env.knownUrls ?? [])]));
  }
  {
    const s = fakeStore(RIGHT);
    let recorded = 0;
    const reported: ReportedStep[] = [];
    const env = toolEnv(
      s.page,
      { storePassword: WRONG, storeAccess: { rejected: false }, onStorePasswordRejected: async () => void recorded++ },
      reported,
    );
    const first = await executeTool(env, "navigate", { url: `${STORE}/` });
    check("navigate, wrong password: the model is told it was not accepted and what to report",
      /store password we hold was not accepted/.test(first) && first.includes("missing_access") && !first.includes(WRONG), first.slice(0, 160));
    check("navigate, wrong password: the rejection is recorded once", recorded === 1 && env.storeAccess?.rejected === true);
    const action = (env.actionTrail as RecordedAction[])[0];
    check("navigate, wrong password: the trail shows the gate (what rule 1b reads)",
      action?.kind === "navigate" && isStoreGateUrl(action.outcome.urlAfter, STORE), JSON.stringify(action));
    await executeTool(env, "navigate", { url: `${STORE}/cart` });
    check("navigate, wrong password: a later navigate does not submit it again",
      s.submitted.length === 1 && recorded === 1, `submitted ${s.submitted.length}`);
    const typed = await executeTool(env, "fill", { label: "Enter store password", value: "{{TEST_PASSWORD}}" });
    check("fill on the gate: refused — the model cannot retry with something it types",
      typed.startsWith("Refused:") && s.submitted.length === 1, typed.slice(0, 120));
    await executeTool(env, "report_step", {
      label: "Open the catalogue",
      status: "broken",
      attempted: "Opened the catalogue",
      observed: "The site only shows a password form; the catalogue is missing.",
    });
    const step = reported[0];
    check("report_step on the locked store: written skipped / missing_access, naming the store password",
      step?.status === "skipped" && step.unverifiedReason === "missing_access" && step.observed === STORE_LOCKED_OBSERVED,
      JSON.stringify(step));
    if (step) productizeStep(step);
    check("report_step on the locked store: the sentence survives the customer-language pass",
      step?.observed === STORE_LOCKED_OBSERVED, step?.observed);
    await executeTool(env, "report_step", { label: "Next", status: "ok", attempted: "a", observed: "b" });
    check("report_step: the lock is drained with the step it belonged to", reported[1]?.status === "ok", JSON.stringify(reported[1]));
  }
  {
    const s = fakeStore(RIGHT);
    await s.page.goto(`${STORE}/`);
    const env = toolEnv(s.page, { storePassword: RIGHT, storeAccess: { rejected: false } });
    const typed = await executeTool(env, "fill", { label: "Enter store password", value: "guess" });
    check("fill on the gate with a store password held: refused, nothing typed into the store",
      typed.startsWith("Refused:") && s.submitted.length === 0, typed.slice(0, 120));
    const scrubbed = scrubSecrets(env, `echo ${RIGHT} and ${encodeURIComponent(RIGHT)}`);
    check("scrubSecrets: the store password is redacted like a test password", !scrubbed.includes(RIGHT), scrubbed);
  }
  {
    // A run with no store password behaves exactly as before: the gate is
    // reached and nothing is typed.
    const s = fakeStore(RIGHT);
    const env = toolEnv(s.page, {});
    const result = await executeTool(env, "navigate", { url: `${STORE}/` });
    check("navigate without a store password: unchanged — the gate is reached, nothing submitted",
      isStoreGateUrl(s.page.url(), STORE) && s.submitted.length === 0 && !/not accepted/.test(result), result);
  }

  // ── 4 — the smoke pass ───────────────────────────────────────────────────
  {
    const { smokeStoreGate, smokeOutcomeLine, STORE_LOCKED_SMOKE_FAILURE, STORE_GATED_SMOKE_FAILURE } = await import("@/agent/replay");
    const open = fakeStore(RIGHT);
    const ok = await smokeStoreGate(open.page as never, `${STORE}/`, { password: RIGHT, state: { rejected: false } });
    check("smoke: with the right password the pass probes the store, unlocked", ok === null && open.isUnlocked());
    const locked = fakeStore(RIGHT);
    const refused = await smokeStoreGate(locked.page as never, `${STORE}/`, { password: WRONG, state: { rejected: false } });
    check("smoke: a refused password fails the pass instead of calling the gate healthy",
      refused !== null && refused.failures.includes(STORE_LOCKED_SMOKE_FAILURE) && refused.healthy === 0,
      JSON.stringify(refused?.failures));
    const none = await smokeStoreGate(fakeStore(RIGHT, false).page as never, `${STORE}/`, undefined);
    check("smoke: an open store with no store password → the pass is unchanged", none === null);
    // Codex review of #220 (P1): a store that is locked while we hold no
    // password — cleared by the owner, or locked since the last full walk —
    // must not pass as thirty healthy copies of its password page.
    const lockedNone = fakeStore(RIGHT);
    const gated = await smokeStoreGate(lockedNone.page as never, `${STORE}/`, undefined);
    check("smoke: a locked store with no store password fails the pass, nothing typed",
      gated !== null && gated.failures.includes(STORE_GATED_SMOKE_FAILURE) && lockedNone.submitted.length === 0,
      JSON.stringify(gated?.failures));
    const line = smokeOutcomeLine({ ok: false, healthy: 0, unreached: [], failures: [STORE_LOCKED_SMOKE_FAILURE], baselineRunNumber: 1 }, STORE);
    check("smoke: its feed line names the store password", line.includes("store password was not accepted"), line);
  }

  // ── 5 — the run's state ──────────────────────────────────────────────────
  {
    const enc = encryptSecret(RIGHT);
    const stub = createStubDb({
      run: [{ id: "r1", status: "walking", events: null, storePasswordEnc: enc, storePasswordRejected: false, credentialsRejected: false }],
    });
    const env = { db: stub.db } as unknown as AgentEnv;
    const tools = await credentialToolEnv(env, { id: "r1", storePasswordEnc: enc });
    check("credentialToolEnv: decrypts the store password for the tools, in memory",
      tools.storePassword === RIGHT && tools.storeAccess?.rejected === false && enc !== RIGHT);
    await recordStorePasswordRejection(env, "r1");
    await recordStorePasswordRejection(env, "r1");
    const row = stub.table("run")[0];
    const events = JSON.parse(String(row.events)) as Array<{ text: string }>;
    check("rejection: recorded on the run, once, and said in the live feed",
      row.storePasswordRejected === true && events.length === 1 && /store password was not accepted/.test(events[0].text),
      String(row.events));
    check("rejection: it is about the store password, not a test login", row.credentialsRejected === false);
    const next = await storeAccessFor(env, { id: "r1", storePasswordEnc: enc });
    check("rejection: the next phase starts knowing it — no second attempt anywhere in the run", next.state?.rejected === true);
    const cleared = clearedCredentials({ testAccounts: null });
    check("one-off run end: the store password is cleared with the test password",
      cleared.storePasswordEnc === null && cleared.testPasswordEnc === null, JSON.stringify(cleared));
  }

  // ── 6 — the prompt ───────────────────────────────────────────────────────
  {
    const enc = encryptSecret(RIGHT);
    const run = { targetUrl: STORE, scopeHints: null, userNotes: null, focusAreas: null, storePasswordEnc: enc };
    for (const [phase, prompt] of [
      ["discovery", discoverySystem(run)],
      ["walking", walkingSystem(run, "Browse the catalogue", ["Open the catalogue"])],
    ] as const) {
      check(`prompt (${phase}): says the store unlocks itself`, /STORE PASSWORD IS PROVIDED/.test(prompt));
      check(`prompt (${phase}): never the password or its encrypted blob`, !prompt.includes(RIGHT) && !prompt.includes(enc));
    }
    const without = discoverySystem({ ...run, storePasswordEnc: null });
    check("prompt: nothing about a store password when none is held", !/STORE PASSWORD/.test(without));
  }

  // ── 7 — the verdict asks for the right thing ─────────────────────────────
  {
    const synth = { verdict: "all_good" as const, bottomLine: null };
    const none = judgeVerdictIntegrity(lockedJourneys(), [], synth, STORE, { storePassword: false, storePasswordRejected: false });
    check("verdict: a store gate with no store password asks for the store password by name",
      none.verdict === "unverified" && /The store password is what would let us check the rest\./.test(none.bottomLine ?? ""),
      none.bottomLine ?? "");
    const refused = judgeVerdictIntegrity(lockedJourneys(), [], synth, STORE, { storePassword: true, storePasswordRejected: true });
    check("verdict: a refused store password says so and asks for the current one",
      refused.verdict === "unverified" && /store password we were given was not accepted/.test(refused.bottomLine ?? ""),
      refused.bottomLine ?? "");
    const unknown = judgeVerdictIntegrity(lockedJourneys(), [], synth, STORE);
    check("verdict: without access facts the generic sentence stands",
      /A password or a test login for it/.test(unknown.bottomLine ?? ""), unknown.bottomLine ?? "");
    const login = lockedJourneys().map((j) => ({
      ...j,
      steps: j.steps.map((s) => ({ ...s, actions: s.actions?.replaceAll("/password", "/login") })),
    }));
    const saas = judgeVerdictIntegrity(login, [], synth, STORE, { storePassword: false, storePasswordRejected: false });
    check("verdict: a sign-in page that is not the store gate keeps the generic ask",
      saas.verdict === "unverified" && /A password or a test login for it/.test(saas.bottomLine ?? ""), saas.bottomLine ?? "");

    const { STORE_LOCKED_SMOKE_FAILURE, STORE_GATED_SMOKE_FAILURE } = await import("@/agent/replay");
    const customerText = [
      STORE_GATED_SMOKE_FAILURE,
      none.bottomLine ?? "",
      refused.bottomLine ?? "",
      STORE_LOCKED_OBSERVED,
      STORE_LOCKED_SMOKE_FAILURE,
      "The store password was not accepted, so the store behind its password page can't be checked this run.",
    ];
    for (const text of customerText) {
      check(`rule 1: no homework, narration or machinery — "${text.slice(0, 60)}…"`,
        !hasHomework(text) && !hasNarration(text) && !hasEnvironmentLeak(text), text);
    }
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
