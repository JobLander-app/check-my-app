// CHE-372 verification: a store password is an access input, like a test login.
//
// A password-protected Shopify store sends every storefront address to
// /password. Runs #281–#283 on securify-demo.myshopify.com stopped there, and
// since CHE-365 such a run is Not verified. The owner can now give us the store
// password and every phase enters it, in code — so this checks the code,
// through the real entry points, with a fake store and no browser:
//
//   1. where the gate is (src/lib/store-gate.ts): the target's exact https
//      origin, path /password;
//   2. the unlock (src/agent/store-password.ts): only Shopify's own
//      storefront-password form, only by POST to the store; the attempt is on
//      the run before it is made; a refused, unknown or unrecordable attempt is
//      never repeated; an accepted one is entered once per browser context;
//   3. the tools: the walk lands behind the gate on the page it asked for, with
//      that page's status; the model never types into the gate, password held
//      or not; no secret reaches a tool result, the trail or a log line; a step
//      on a locked store is written skipped with the right reason;
//   4. the smoke pass does not call a locked store "all healthy";
//   5. the run's state, the prompt, and the one-off clear;
//   6. a run that reached only the gate has no findings and a bottom line that
//      asks for the store password;
//   7. every place a run is made or fed carries the store password — the
//      scheduler, enabling a watch (from an app and from a verdict), the smoke
//      pass, the surface scan, the verdict's loader, partial mode, re-check;
//   8. every sentence a customer reads passes the leak and homework detectors.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-store-password.ts

process.env.CREDENTIALS_SECRET ??= "verify-store-password-secret";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { isStoreGateUrl } from "@/lib/store-gate";
import { clearedCredentials } from "@/lib/test-accounts";
import { hasEnvironmentLeak, hasHomework, hasNarration } from "@/lib/verdict-language";
import { enableWatchForApp, enableWatchForRun } from "@/lib/watch-enable";
import { createRecheckRun } from "@/lib/recheck";
import { unlockStoreGate, type StoreAccess, type StoreState, type UnlockPage } from "@/agent/store-password";
import {
  executeTool,
  productizeStep,
  scrubSecrets,
  STORE_LOCKED_OBSERVED,
  STORE_MISSING_OBSERVED,
  STORE_UNDRIVEN_OBSERVED,
  type RecordedAction,
  type ReportedStep,
  type ToolEnv,
} from "@/agent/tools";
import { credentialToolEnv, persistStoreState, storeAccessFor } from "@/agent/credentials";
import { discoverySystem, walkingSystem } from "@/agent/instructions";
import { judgeVerdictIntegrity, type IntegrityJourney } from "@/agent/verdict-integrity";
import { checkVerdictIntegrity } from "@/agent/verdict-load";
import { gateFindings, STORE_GATE_ONLY } from "@/agent/findings-gate";
import type { SynthesizedFinding } from "@/agent/synthesis";
import type { AgentEnv } from "@/agent/env";
import { createStubDb } from "./fixtures/mcp-db";
import Module from "node:module";
import type { PrismaClient } from "@/generated/prisma/client";

// §4 and §7 drive real code in src/agent/replay.ts, browser.ts, scheduler.ts
// and partial.ts, which reach @cloudflare/playwright, which requires the
// `cloudflare:workers` builtin at load time. No browser is opened here, so the
// builtin is answered with an empty object and those modules are imported
// after the hook — the shim scripts/verify-survey.ts uses.
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
const TEST_PW = "test-login-pw-5512";

// Everything the code under test logs, so no line can carry a secret unseen.
const logged: string[] = [];
for (const level of ["log", "warn", "error"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    if (!String(args[0] ?? "").startsWith("PASS") && !String(args[0] ?? "").startsWith("FAIL")) return;
    real(...args);
  };
}
const report = (line: string) => process.stdout.write(`${line}\n`);

interface FakeOpts {
  /** The store starts locked (default) or open. */
  locked?: boolean;
  /** The page at /password carries Shopify's storefront form (default) or is an ordinary page. */
  shopify?: boolean;
  /** How the storefront form submits. */
  method?: "post" | "get";
}

// A fake password-protected store. Every address redirects to /password until
// the right password is submitted there; after that the "cookie" lets every
// page through — in this fake, as in the browser, per context (`fresh()`).
function fakeStore(correct: string, opts: FakeOpts = {}) {
  let url = "about:blank";
  let unlocked = opts.locked === false;
  let pending = "";
  const submitted: string[] = [];
  const fills: string[] = [];
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
      fills.push(v);
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
    focus: async () => {},
    pressSequentially: async (v: string) => void fills.push(v),
    // A click on a store link: the cart, which a locked store sends to /password.
    click: async () => {
      url = unlocked ? `${STORE}/cart` : `${STORE}/password`;
    },
    elementHandle: async () => null,
  };
  const page = {
    url: () => url,
    goto: async (to: string) => {
      const asked = new URL(to);
      if (!unlocked && asked.pathname !== "/password") url = `${STORE}/password`;
      // A page behind the gate that echoes a secret back in its own address.
      else if (asked.pathname === "/echo") url = `${STORE}/echo?token=${encodeURIComponent(correct)}`;
      else url = asked.toString();
      // Behind the gate, an address the store does not have answers 404 —
      // the gate itself answers 200 for everything.
      const status = unlocked && asked.pathname === "/no-such-page" ? 404 : 200;
      return { status: () => status, headers: () => ({}) };
    },
    // Playwright resolves when the predicate holds and times out otherwise;
    // the fake times out at once rather than making the script wait.
    waitForURL: async (pred: (u: URL) => boolean) => {
      if (!pred(new URL(url))) throw new Error("Timeout 20000ms exceeded.");
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    // A string is a script: the gate-form probe answers what the page holds.
    // A function is read_page's digest — of a page that shows the password.
    evaluate: async (arg: unknown) => {
      if (typeof arg === "string" && arg.includes("storefront_password")) {
        return onGate() && opts.shopify !== false
          ? { storefront: true, method: opts.method ?? "post", action: `${STORE}/password` }
          : { storefront: false, method: "", action: "" };
      }
      if (typeof arg === "function") {
        return { url, title: `Welcome back — your code is ${correct}`, headings: [], links: [], hrefs: [], buttons: [], fields: [] };
      }
      return undefined;
    },
    locator: () => field,
    getByLabel: () => field,
    getByPlaceholder: () => field,
    getByRole: () => field,
    on: () => {},
    content: async () => "<html></html>",
    addInitScript: async () => {},
    screenshot: async () => {
      throw new Error("no screenshots here");
    },
  };
  return {
    page,
    submitted,
    fills,
    isUnlocked: () => unlocked,
    // A new browser context: same store, no cookie.
    fresh: () => {
      unlocked = opts.locked === false;
      url = "about:blank";
    },
  };
}

function access(password: string | undefined, status: StoreState = "untried") {
  const persisted: StoreState[] = [];
  const a: StoreAccess = {
    password,
    state: { status },
    persist: async (s) => {
      persisted.push(s);
      return true;
    },
  };
  return { access: a, persisted };
}

function toolEnv(page: unknown, store: StoreAccess | undefined, reported: ReportedStep[] = [], extra: Partial<ToolEnv> = {}): ToolEnv {
  return {
    page,
    targetOrigin: STORE,
    networkLog: [],
    consoleLog: [],
    actionTrail: [],
    credentials: { rejected: false },
    testEmail: "qa@store.test",
    testPassword: TEST_PW,
    store,
    onReportStep: async (s: ReportedStep) => {
      reported.push(s);
    },
    ...extra,
  } as unknown as ToolEnv;
}

// The trail of run #281: every product page we asked for ended on /password.
function lockedJourneys(): IntegrityJourney[] {
  const nav = (path: string) =>
    JSON.stringify([{ kind: "navigate", url: `${STORE}${path}`, outcome: { urlAfter: `${STORE}/password`, status: 200 } }]);
  return ["/", "/collections/all", "/cart"].map((p) => ({
    status: "partial",
    steps: [
      { status: "ok", unverifiedReason: null, actions: nav(p) },
      { status: "skipped", unverifiedReason: "missing_access", actions: nav(p) },
    ],
  }));
}

const asPage = (p: unknown) => p as UnlockPage;

async function main() {
  // ── 1 — where the gate is ────────────────────────────────────────────────
  for (const [url, expected, why] of [
    [`${STORE}/password`, true, "the store's own /password"],
    [`${STORE}/password/`, true, "trailing slash folded"],
    [`${STORE}/password?return_to=/cart`, true, "the query is not the place"],
    ["http://securify-demo.myshopify.com/password", false, "plain http is never the gate — no password over it"],
    [`${STORE}:8443/password`, false, "another port is another origin"],
    ["https://www.securify-demo.myshopify.com/password", false, "another host is another origin"],
    [`${STORE}/account/password`, false, "a password page deeper in the site is not the store gate"],
    [`${STORE}/password-reset`, false, "a lookalike path is not the gate"],
    [`${STORE}/`, false, "the storefront itself"],
  ] as const) {
    check(`gate address: ${why}`, isStoreGateUrl(url, STORE) === expected, url);
  }

  // ── 2 — the unlock ───────────────────────────────────────────────────────
  {
    const s = fakeStore(RIGHT);
    await s.page.goto(`${STORE}/`);
    const { access: a, persisted } = access(RIGHT);
    const out = await unlockStoreGate(asPage(s.page), STORE, a);
    check("unlock: the right password opens the store",
      out === "unlocked" && s.submitted.join() === RIGHT && a.state?.status === "accepted", `${out} ${s.page.url()}`);
    check("unlock: the attempt is on the run before the submit, the result after it",
      JSON.stringify(persisted) === JSON.stringify(["pending", "accepted"]), JSON.stringify(persisted));
    s.fresh();
    await s.page.goto(`${STORE}/cart`);
    await unlockStoreGate(asPage(s.page), STORE, a);
    check("unlock: an accepted password is entered once per browser context — a new context enters it again",
      s.submitted.length === 2 && s.isUnlocked(), `${s.submitted.length} submissions`);
    await s.page.goto(`${STORE}/cart`);
    const again = await unlockStoreGate(asPage(s.page), STORE, a);
    check("unlock: within a context, off the gate there is nothing to do", again === "not_gate" && s.submitted.length === 2, again);
  }
  {
    const s = fakeStore(RIGHT);
    await s.page.goto(`${STORE}/`);
    const { access: a, persisted } = access(WRONG);
    const out = await unlockStoreGate(asPage(s.page), STORE, a);
    check("unlock: a wrong password is rejected and recorded, the store stays locked",
      out === "rejected" && a.state?.status === "rejected" && persisted.at(-1) === "rejected" && !s.isUnlocked(), out);
    s.fresh();
    await s.page.goto(`${STORE}/collections/all`);
    const second = await unlockStoreGate(asPage(s.page), STORE, a);
    check("unlock: once rejected it is never submitted again — not in a new context either",
      second === "already_rejected" && s.submitted.length === 1, `${second} submitted=${s.submitted.length}`);
  }
  {
    const s = fakeStore(RIGHT, { shopify: false });
    await s.page.goto(`${STORE}/`);
    const { access: a } = access(RIGHT);
    const out = await unlockStoreGate(asPage(s.page), STORE, a);
    check("unlock: a /password page without Shopify's storefront form is not the gate — nothing typed",
      out === "not_gate" && s.fills.length === 0 && s.submitted.length === 0, out);
  }
  {
    const s = fakeStore(RIGHT, { method: "get" });
    await s.page.goto(`${STORE}/`);
    const { access: a, persisted } = access(RIGHT);
    const out = await unlockStoreGate(asPage(s.page), STORE, a);
    check("unlock: a gate whose form submits by GET (the password into the URL) is refused — nothing typed",
      out === "unsafe_form" && s.fills.length === 0 && persisted.length === 0, out);
  }
  {
    const s = fakeStore(RIGHT);
    await s.page.goto(`${STORE}/`);
    const a: StoreAccess = { password: RIGHT, state: { status: "untried" }, persist: async () => false };
    const out = await unlockStoreGate(asPage(s.page), STORE, a);
    check("unlock: when the attempt cannot be recorded first, it is not made", out === "undriven" && s.submitted.length === 0, out);
    // …and the password does not stay in the field, where a later click on the
    // form's own button would submit what the run never recorded.
    check("unlock: an unrecorded attempt leaves the field empty", s.fills.at(-1) === "" && (await s.page.locator().inputValue()) === "", JSON.stringify(s.fills.map((f) => f.length)));
  }
  {
    const s = fakeStore(RIGHT);
    await s.page.goto(`${STORE}/`);
    const out = await unlockStoreGate(asPage(s.page), STORE, access(undefined).access);
    check("unlock: no store password on the run → nothing typed", out === "no_password" && s.fills.length === 0, out);
  }

  // ── 3 — the tools ────────────────────────────────────────────────────────
  {
    const s = fakeStore(RIGHT);
    const { access: a } = access(RIGHT);
    const env = toolEnv(s.page, a);
    const result = await executeTool(env, "navigate", { url: `${STORE}/collections/all` });
    const action = (env.actionTrail as RecordedAction[])[0];
    check("navigate: the store is opened and the walk lands on the page it asked for",
      s.isUnlocked() && s.page.url() === `${STORE}/collections/all` && action?.kind === "navigate" &&
        action.outcome.urlAfter === `${STORE}/collections/all`,
      `${result} / ${JSON.stringify(action)}`);
    check("navigate: an accepted password leaves no lock behind", !env.storeLocked);

    // Codex review of #220: the destination's own status, not the gate's 200.
    const s404 = fakeStore(RIGHT);
    const env404 = toolEnv(s404.page, access(RIGHT).access, [], { knownUrls: new Set<string>([`${STORE}/`]) });
    const r404 = await executeTool(env404, "navigate", { url: `${STORE}/no-such-page` });
    const a404 = (env404.actionTrail as RecordedAction[])[0];
    check("navigate: after the unlock, the destination's own status is read and recorded",
      a404?.kind === "navigate" && a404.outcome.status === 404 && /not linked from any/.test(r404), r404.slice(0, 100));

    // Cross-review point 1: nothing a page echoes reaches a result, the trail or a log.
    const echoed = await executeTool(env, "navigate", { url: `${STORE}/echo` });
    const read = await executeTool(env, "read_page", {});
    const trail = JSON.stringify(env.actionTrail);
    check("leak: an address that echoes the store password is scrubbed in the navigate result",
      !echoed.includes(RIGHT) && !echoed.includes(encodeURIComponent(RIGHT)) && echoed.includes("[redacted]"), echoed);
    check("leak: …and in the recorded trail (Step.actions)", !trail.includes(RIGHT) && trail.includes("[redacted]"), trail.slice(-160));
    check("leak: a page that shows the store password is scrubbed in read_page", !read.includes(RIGHT) && read.includes("[redacted]"), read.slice(0, 120));
  }
  {
    // A store password is often a plain word that the store's own address
    // contains ("demo" on securify-demo.myshopify.com). Redacting it wherever
    // it occurs would rewrite the address in every result and in the stored
    // trail, and the walk and each replay would navigate to a host that does
    // not exist.
    for (const [pw, why] of [
      ["demo", "a plain word inside the host"],
      ["securify", "a longer plain word inside the host"],
      ["securify-demo", "a strong-looking password that is the host's own label"],
    ] as const) {
      const s = fakeStore(pw);
      const env = toolEnv(s.page, access(pw).access);
      const result = await executeTool(env, "navigate", { url: `${STORE}/collections/all` });
      const action = (env.actionTrail as RecordedAction[])[0];
      check(`scrub, ${why}: the store's address is intact in the result and the trail`,
        s.isUnlocked() && result.includes(`${STORE}/collections/all`) && action?.kind === "navigate" &&
          action.url === `${STORE}/collections/all` && action.outcome.urlAfter === `${STORE}/collections/all`,
        `${result.slice(0, 90)} / ${JSON.stringify(action)}`);
      const echoed = await executeTool(env, "navigate", { url: `${STORE}/echo` });
      const trail = JSON.stringify(env.actionTrail);
      check(`scrub, ${why}: as a value in an address it is still redacted`,
        echoed.includes(`${STORE}/echo?token=[redacted]`) && trail.includes(`${STORE}/echo?token=[redacted]`) &&
          !echoed.includes(`token=${encodeURIComponent(pw)}`),
        echoed.slice(0, 110));
    }
  }
  {
    // Review of that fix: where the value ends, and how it is written. A
    // sentence ends in punctuation, a fragment carries parameters too, and a
    // form writes a space as "+".
    const scrubWith = (pw: string, text: string) => scrubSecrets(toolEnv({}, access(pw).access), text);
    for (const tail of [".", ",", ";", "`", "}"]) {
      const out = scrubWith("demo", `Navigated to ${STORE}/?password=demo${tail}`);
      check(`scrub: a plain-word value followed by ${JSON.stringify(tail)} is redacted`, out === `Navigated to ${STORE}/?password=[redacted]${tail}`, out);
    }
    const fragment = scrubWith("demo", `${STORE}/password#password=demo`);
    check("scrub: a plain-word value in a fragment parameter is redacted", fragment === `${STORE}/password#password=[redacted]`, fragment);
    const plus = scrubWith("pass word", `${STORE}/?password=pass+word`);
    check("scrub: a value with a space written as + is redacted", plus === `${STORE}/?password=[redacted]`, plus);
    const strongPlus = scrubWith("open sesame 9431", `saw ${STORE}/?password=open+sesame+9431 there`);
    check("scrub: a strong password with spaces written as + is redacted", !strongPlus.includes("open+sesame+9431") && strongPlus.includes("[redacted]"), strongPlus);
    // Not redacted, on purpose: a plain word in running text cannot be told
    // from the word, and a longer value that merely starts with it is another value.
    const prose = scrubWith("demo", "The demo store shows a demo banner.");
    check("scrub: a plain word in running text is left alone", prose === "The demo store shows a demo banner.", prose);
    const longer = scrubWith("demo", `${STORE}/?theme=demolition`);
    check("scrub: a longer value that starts with the word is another value", longer === `${STORE}/?theme=demolition`, longer);
  }
  {
    const s = fakeStore(RIGHT);
    const reported: ReportedStep[] = [];
    const { access: a } = access(WRONG);
    const env = toolEnv(s.page, a, reported);
    const first = await executeTool(env, "navigate", { url: `${STORE}/` });
    check("navigate, wrong password: the model is told it was not accepted and what to report",
      /store password we hold was not accepted/.test(first) && first.includes("missing_access"), first.slice(0, 160));
    const action = (env.actionTrail as RecordedAction[])[0];
    check("navigate, wrong password: the trail shows the gate (what rule 1b reads)",
      action?.kind === "navigate" && isStoreGateUrl(action.outcome.urlAfter, STORE), JSON.stringify(action));
    await executeTool(env, "navigate", { url: `${STORE}/cart` });
    check("navigate, wrong password: a later navigate does not submit it again", s.submitted.length === 1, `${s.submitted.length}`);
    await executeTool(env, "report_step", {
      label: "Open the catalogue",
      status: "broken",
      attempted: "Opened the catalogue",
      observed: "The site only shows a password form; the catalogue is missing.",
    });
    const step = reported[0];
    check("report_step, refused: skipped / missing_access, naming the store password",
      step?.status === "skipped" && step.unverifiedReason === "missing_access" && step.observed === STORE_LOCKED_OBSERVED,
      JSON.stringify(step));
    if (step) productizeStep(step);
    check("report_step, refused: the sentence survives the customer-language pass", step?.observed === STORE_LOCKED_OBSERVED, step?.observed);
    await executeTool(env, "report_step", { label: "Next", status: "ok", attempted: "a", observed: "b" });
    check("report_step: the lock is drained with the step it belonged to", reported[1]?.status === "ok", JSON.stringify(reported[1]));
  }
  {
    // Cross-review point 7: a locked store and no password at all.
    const s = fakeStore(RIGHT);
    const reported: ReportedStep[] = [];
    const env = toolEnv(s.page, undefined, reported);
    const result = await executeTool(env, "navigate", { url: `${STORE}/` });
    check("navigate, no store password: told the store is locked and the password is needed",
      /no store password was given/.test(result) && result.includes("missing_access") && s.fills.length === 0, result.slice(0, 160));
    await executeTool(env, "report_step", {
      label: "Browse",
      status: "broken",
      attempted: "Opened the home page",
      observed: "The storefront is hidden behind a password form.",
    });
    check("report_step, no store password: skipped / missing_access in code, whatever the model said",
      reported[0]?.status === "skipped" && reported[0].unverifiedReason === "missing_access" && reported[0].observed === STORE_MISSING_OBSERVED,
      JSON.stringify(reported[0]));
    // Cross-review point 5: never typing into the gate, password held or not.
    const guess = await executeTool(env, "fill", { label: "Enter store password", value: "password123" });
    const placeholder = await executeTool(env, "fill", { label: "Enter store password", value: "{{TEST_PASSWORD}}" });
    check("fill on the gate with no store password: refused — a guess is not typed",
      guess.startsWith("Refused:") && !s.fills.includes("password123"), guess.slice(0, 100));
    check("fill on the gate: {{TEST_PASSWORD}} never resolves there — the test login's password stays out",
      placeholder.startsWith("Refused:") && !s.fills.includes(TEST_PW), placeholder.slice(0, 100));
  }
  {
    // Clicking into the gate is the same as navigating into it.
    const s = fakeStore(RIGHT);
    const env = toolEnv(s.page, access(RIGHT).access);
    await s.page.goto(`${STORE}/`);
    const before = s.submitted.length;
    const clicked = await executeTool(env, "click", { selector: "a.cart" });
    check("click landing on the gate: the store password is entered, as after a navigate",
      s.submitted.length === before + 1 && s.isUnlocked(), clicked.slice(0, 120));
  }
  {
    // Codex review of #220, round 2: a password we could not enter is our hands.
    const s = fakeStore(RIGHT);
    s.page.locator = () =>
      ({
        first() {
          return this;
        },
        count: async () => 1,
        fill: async () => {
          throw new Error("locator.fill: Timeout 8000ms exceeded.");
        },
        press: async () => {},
      }) as never;
    const reported: ReportedStep[] = [];
    const { access: a, persisted } = access(RIGHT);
    const env = toolEnv(s.page, a, reported);
    const result = await executeTool(env, "navigate", { url: `${STORE}/` });
    check("navigate, password could not be entered: our limitation, skip as our_capability, not a rejection",
      result.includes("our_capability") && persisted.length === 0, result.slice(0, 160));
    await executeTool(env, "report_step", { label: "Open", status: "broken", attempted: "a", observed: "Hidden behind a password form." });
    check("report_step after an undriven unlock: skipped / our_capability (undriven_control)",
      reported[0]?.status === "skipped" && reported[0].unverifiedReason === "our_capability" &&
        reported[0].gapClass === "undriven_control" && reported[0].observed === STORE_UNDRIVEN_OBSERVED,
      JSON.stringify(reported[0]));
  }
  {
    const env = toolEnv(fakeStore(RIGHT, { locked: false }).page, access(RIGHT).access);
    const result = await executeTool(env, "navigate", { url: `${STORE}/` });
    check("navigate on an open store: unchanged — no gate, nothing typed, no lock", !env.storeLocked && /status 200/.test(result), result);
  }
  const codeLines = logged.filter((l) => !/^(PASS|FAIL)/.test(l));
  check("logs: no line the code wrote while the tools ran carries the store password",
    codeLines.length > 0 && !codeLines.some((l) => l.includes(RIGHT) || l.includes(encodeURIComponent(RIGHT))),
    codeLines.find((l) => l.includes(RIGHT)) ?? `${codeLines.length} lines`);

  // ── 4 — the smoke pass ───────────────────────────────────────────────────
  const { smokeStoreGate, smokeOutcomeLine, smokeReplay, STORE_LOCKED_SMOKE_FAILURE, STORE_GATED_SMOKE_FAILURE } =
    await import("@/agent/replay");
  {
    const open = fakeStore(RIGHT);
    const ok = await smokeStoreGate(open.page as never, `${STORE}/`, access(RIGHT).access);
    check("smoke: with the right password the pass probes the store, unlocked", ok === null && open.isUnlocked());
    const refused = await smokeStoreGate(fakeStore(RIGHT).page as never, `${STORE}/`, access(WRONG).access);
    check("smoke: a refused password fails the pass instead of calling the gate healthy",
      refused?.failures.includes(STORE_LOCKED_SMOKE_FAILURE) === true && refused.healthy === 0, JSON.stringify(refused?.failures));
    const none = await smokeStoreGate(fakeStore(RIGHT, { locked: false }).page as never, `${STORE}/`, undefined);
    check("smoke: an open store with no store password → the pass is unchanged", none === null);
    const lockedNone = fakeStore(RIGHT);
    const gated = await smokeStoreGate(lockedNone.page as never, `${STORE}/`, undefined);
    check("smoke: a locked store with no store password fails the pass, nothing typed",
      gated?.failures.includes(STORE_GATED_SMOKE_FAILURE) === true && lockedNone.fills.length === 0, JSON.stringify(gated?.failures));
    const line = smokeOutcomeLine({ ok: false, healthy: 0, unreached: [], failures: [STORE_LOCKED_SMOKE_FAILURE], baselineRunNumber: 1 }, STORE);
    check("smoke: its feed line names the store password", line.includes("store password was not accepted"), line);
  }

  // ── 5 — the run's state, the prompt, the one-off clear ───────────────────
  {
    const enc = encryptSecret(RIGHT);
    const stub = createStubDb({
      run: [{ id: "r1", status: "walking", events: null, storePasswordEnc: enc, storePasswordState: null, credentialsRejected: false }],
    });
    const env = { db: stub.db } as unknown as AgentEnv;
    const tools = await credentialToolEnv(env, { id: "r1", storePasswordEnc: enc });
    check("credentialToolEnv: decrypts the store password for the tools, in memory",
      tools.store?.password === RIGHT && tools.store?.state?.status === "untried");
    await persistStoreState(env, "r1", "pending");
    check("state: an attempt is written before it is made", stub.table("run")[0].storePasswordState === "pending");
    await persistStoreState(env, "r1", "rejected");
    await persistStoreState(env, "r1", "rejected");
    const row = stub.table("run")[0];
    const events = JSON.parse(String(row.events)) as Array<{ text: string }>;
    check("state: a rejection is recorded on the run and said in the live feed, once",
      row.storePasswordState === "rejected" && events.length === 1 && /store password was not accepted/.test(events[0].text),
      String(row.events));
    check("state: it is about the store password, not a test login", row.credentialsRejected === false);
    check("state: the next phase starts knowing it", (await storeAccessFor(env, { id: "r1", storePasswordEnc: enc })).state?.status === "rejected");
    const broken = { db: { run: { findUnique: async () => { throw new Error("D1 unavailable"); } } } } as unknown as AgentEnv;
    check("state: a run whose state cannot be read is treated as pending — nothing submitted on a guess",
      (await storeAccessFor(broken, { id: "r1", storePasswordEnc: enc })).state?.status === "pending");
    const failing = { db: { run: { update: async () => { throw new Error("D1 unavailable"); }, findUnique: async () => null } } } as unknown as AgentEnv;
    check("state: a lost write is reported, so the unlock can fail closed", (await persistStoreState(failing, "r1", "pending")) === false);
    const cleared = clearedCredentials({ testAccounts: null });
    check("one-off run end: the store password is cleared with the test password",
      cleared.storePasswordEnc === null && cleared.testPasswordEnc === null, JSON.stringify(cleared));

    const run = { targetUrl: STORE, scopeHints: null, userNotes: null, focusAreas: null, storePasswordEnc: enc };
    for (const [phase, prompt] of [
      ["discovery", discoverySystem(run)],
      ["walking", walkingSystem(run, "Browse the catalogue", ["Open the catalogue"])],
    ] as const) {
      check(`prompt (${phase}): says the store unlocks itself`, /STORE PASSWORD IS PROVIDED/.test(prompt));
      check(`prompt (${phase}): never the password or its encrypted blob`, !prompt.includes(RIGHT) && !prompt.includes(enc));
    }
    const without = discoverySystem({ ...run, storePasswordEnc: null });
    check("prompt with no store password: still says what to do on a store's password page",
      /PASSWORD-PROTECTED STORES/.test(without) && !/STORE PASSWORD IS PROVIDED/.test(without));
  }

  // ── 6 — a run that reached only the gate ─────────────────────────────────
  {
    const finding = { title: "The storefront only shows a password form", category: "broken", severity: "high" } as unknown as SynthesizedFinding;
    const gated = gateFindings([finding], lockedJourneys(), { targetUrl: STORE });
    check("findings: a run that reached only the store's password page keeps no finding",
      gated.kept.length === 0 && gated.dropped[0]?.reason === STORE_GATE_ONLY, JSON.stringify(gated.dropped.map((d) => d.reason)));
    const reached = lockedJourneys();
    reached[0].steps[0].actions = JSON.stringify([
      { kind: "navigate", url: `${STORE}/cart`, outcome: { urlAfter: `${STORE}/cart`, status: 200 } },
    ]);
    check("findings: one page of the store reached and findings stand", gateFindings([finding], reached, { targetUrl: STORE }).kept.length === 1);

    const synth = { verdict: "all_good" as const, bottomLine: null };
    const none = judgeVerdictIntegrity(lockedJourneys(), [], synth, STORE, { storePassword: false, storePasswordRejected: false });
    check("verdict: a store gate with no store password asks for the store password by name",
      none.verdict === "unverified" && /The store password is what would let us check the rest\./.test(none.bottomLine ?? ""), none.bottomLine ?? "");
    const refused = judgeVerdictIntegrity(lockedJourneys(), [], synth, STORE, { storePassword: true, storePasswordRejected: true });
    check("verdict: a refused store password says so and asks for the current one",
      /store password we were given was not accepted/.test(refused.bottomLine ?? ""), refused.bottomLine ?? "");
    const login = lockedJourneys().map((j) => ({
      ...j,
      steps: j.steps.map((s) => ({ ...s, actions: s.actions?.replaceAll("/password", "/login") })),
    }));
    const saas = judgeVerdictIntegrity(login, [], synth, STORE, { storePassword: false, storePasswordRejected: false });
    check("verdict: a sign-in page that is not the store gate keeps the generic ask",
      /A password or a test login for it/.test(saas.bottomLine ?? ""), saas.bottomLine ?? "");

    // The loader the workflow calls, over a database — it must feed the rule the facts.
    const verdictDb = (state: string | null, enc: string | null) =>
      createStubDb({
        run: [{ id: "rv", targetUrl: STORE, storePasswordEnc: enc, storePasswordState: state }],
        journey: lockedJourneys().map((j, i) => ({ id: `j${i}`, runId: "rv", status: j.status })),
        step: lockedJourneys().flatMap((j, i) => j.steps.map((s, k) => ({ id: `s${i}${k}`, journeyId: `j${i}`, ...s }))),
        finding: [],
      });
    const loadedNone = await checkVerdictIntegrity({ db: verdictDb(null, null).db } as unknown as AgentEnv, "rv", synth);
    check("verdict loader: a run without a store password is asked for it",
      /The store password is what would let us check the rest\./.test(loadedNone.bottomLine ?? ""), loadedNone.bottomLine ?? "");
    const loadedRefused = await checkVerdictIntegrity({ db: verdictDb("rejected", encryptSecret(WRONG)).db } as unknown as AgentEnv, "rv", synth);
    check("verdict loader: a run whose store password was refused says so",
      /was not accepted/.test(loadedRefused.bottomLine ?? ""), loadedRefused.bottomLine ?? "");
  }

  // ── 7 — every place a run is made or fed ─────────────────────────────────
  {
    const enc = encryptSecret(RIGHT);
    const pwEnc = encryptSecret(TEST_PW);
    const { createWatchRun } = await import("@/agent/scheduler");
    const stub = createStubDb({ counter: [{ id: "counter", name: "runNumber", value: 10 }] });
    const created = await createWatchRun({ db: stub.db } as unknown as AgentEnv, {
      id: "w1", appSlug: "store.test", targetUrl: `${STORE}/`, notifyEmail: null, testEmail: null, testPasswordEnc: null,
      storePasswordEnc: enc, appId: null, ownerId: "u1", teamId: "t1", app: null,
    }, null);
    const watchRun = stub.table("run").find((r) => r.id === created.id);
    check("scheduler: a watch run carries the watch's store password", watchRun?.storePasswordEnc === enc, String(watchRun?.storePasswordEnc));

    const seedTeam = () =>
      createStubDb({
        user: [{ id: "u1", email: "o@store.test" }],
        team: [{ id: "t1", name: "Store", plan: "business", isPersonal: true }],
        app: [{ id: "app1", ownerId: "u1", teamId: "t1", appSlug: "securify-demo.myshopify.com", targetUrl: `${STORE}/`,
          targetKind: "website", testEmail: "qa@store.test", testPasswordEnc: pwEnc, storePasswordEnc: enc }],
        watch: [],
        run: [{ id: "r_one", publicId: "pub_one", ownerId: "u1", teamId: "t1", appId: "app1", appSlug: "securify-demo.myshopify.com",
          targetUrl: `${STORE}/`, targetKind: "website", status: "completed", testEmail: "qa@store.test", testPasswordEnc: null,
          storePasswordEnc: null, ephemeral: false, notifyEmail: null, scopeHints: null, userNotes: null }],
        counter: [{ id: "counter", name: "runNumber", value: 10 }],
      });
    const user = { id: "u1", teamId: "t1", plan: "business" };
    const fromApp = seedTeam();
    await enableWatchForApp(fromApp.db, user, "app1", { frequency: "daily" });
    check("enable watch (an app): the new watch carries the app's store password",
      fromApp.table("watch")[0]?.storePasswordEnc === enc, String(fromApp.table("watch")[0]?.storePasswordEnc));
    const fromRun = seedTeam();
    const enabled = await enableWatchForRun(fromRun.db, user, { runPublicId: "pub_one", frequency: "daily", notifyOnChangeOnly: true });
    const w = fromRun.table("watch")[0];
    check("enable watch (a verdict whose run lost its copies): the watch carries the app's store password",
      enabled.kind === "ok" && w?.storePasswordEnc === enc, `${enabled.kind} ${String(w?.storePasswordEnc).slice(0, 12)}`);
    check("enable watch (a verdict): …and the app's test login, as a pair (the same path lost it before)",
      w?.testEmail === "qa@store.test" && typeof w?.testPasswordEnc === "string" && decryptSecret(w.testPasswordEnc as string) === TEST_PW,
      `${w?.testEmail} ${String(w?.testPasswordEnc).slice(0, 12)}`);

    const recheck = seedTeam();
    const rc = await createRecheckRun(recheck.db as PrismaClient, "pub_one", {}, {}, {
      canMutate: async () => true,
      trigger: async () => {},
      siteCap: () => 20,
      now: () => new Date(),
      ephemeralTtlDays: () => 7,
    });
    const rerun = recheck.table("run").find((r) => r.publicId === (rc as { publicId?: string }).publicId);
    check("re-check of a saved app: the new run carries the app's store password, though the old run lost its copy",
      rc.kind === "ok" && rerun?.storePasswordEnc === enc, `${rc.kind} ${String(rerun?.storePasswordEnc).slice(0, 12)}`);

    // The smoke pass: the store reaches the probe.
    const now = new Date("2026-10-01T12:00:00.000Z");
    const smokeDb = createStubDb({
      run: [
        { id: "run_now", status: "queued", storePasswordEnc: enc, storePasswordState: null },
        { id: "run_base", runNumber: 42, status: "completed", verdict: "all_good", watchId: "w1", completedAt: new Date(now.getTime() - 86_400_000),
          appLens: null, anatomy: JSON.stringify({ pages: ["/cart"] }) },
      ],
      journey: [{ id: "jb", runId: "run_base" }],
      generatedTest: [{ id: "g1", appSlug: "store.test", title: "t", version: 1, content: "await page.goto('/cart');" }],
    });
    let probed: StoreAccess | undefined;
    await smokeReplay(
      { db: smokeDb.db } as unknown as AgentEnv,
      { id: "run_now", appSlug: "store.test", targetUrl: `${STORE}/`, watchId: "w1", baselineRunId: "run_base", storePasswordEnc: enc },
      null,
      now,
      async (_env, _url, _targets, opts) => {
        probed = opts.store;
        return { probes: [], healthy: 1, unreached: [], skipped: 0, failures: [], consoleErrors: 0, consoleBurstsSetAside: [], pageErrors: 0, screenshotUrl: null };
      },
    );
    check("smoke pass: the run's store password reaches the probe", probed?.password === RIGHT, String(probed?.password ? "set" : "missing"));

    // The surface scan: it opens the store, not its password page.
    const { surfaceScan } = await import("@/agent/browser");
    const scanStore = fakeStore(RIGHT);
    const browser = { version: () => "126.0.0", newContext: async () => ({ newPage: async () => scanStore.page, close: async () => {} }) };
    const scanDb = createStubDb({ run: [{ id: "run_scan", storePasswordEnc: enc, storePasswordState: null }] });
    await surfaceScan({ db: scanDb.db, bindings: {} } as unknown as AgentEnv, browser as never, {
      targetUrl: `${STORE}/`, id: "run_scan", storePasswordEnc: enc,
    });
    check("surface scan: a locked store is opened with the store password", scanStore.isUnlocked() && scanStore.submitted.join() === RIGHT);

    // Partial mode: a store password new since the last walk means a full walk.
    const { planPartialRun } = await import("@/agent/partial");
    const partialEnv = (current: string | null) => {
      const runs: Record<string, Record<string, unknown>> = {
        run_now: { id: "run_now", testEmail: null, testPasswordEnc: null, testAccounts: null, storePasswordEnc: current },
        run_base: { id: "run_base", runNumber: 42, status: "completed", verdict: "mostly_ok", completedAt: new Date(now.getTime() - 86_400_000),
          testEmail: null, testPasswordEnc: null, testAccounts: null, storePasswordEnc: null, appLens: null, anatomy: JSON.stringify({ pages: ["/cart"] }) },
      };
      const journeys = ["ok", "broken", "ok"].map((status, i) => ({
        id: `j${i}`, runId: "run_base", order: i, title: `Journey ${i + 1}`, status, carriedFromRunId: null, steps: [{ label: "open" }],
      }));
      return {
        db: {
          run: {
            findUnique: async ({ where }: { where: { id: string } }) => runs[where.id] ?? null,
            findMany: async ({ where }: { where: { id?: { in: string[] } } }) =>
              where.id?.in ? where.id.in.map((id) => runs[id]).filter(Boolean) : [runs.run_base],
          },
          journey: {
            count: async ({ where }: { where: { runId: string } }) => (where.runId === "run_base" ? journeys.length : 0),
            findMany: async ({ where }: { where: { runId: string } }) => (where.runId === "run_base" ? journeys : []),
          },
          appJourney: { findMany: async () => [] },
        },
      } as unknown as AgentEnv;
    };
    const control = await planPartialRun(partialEnv(null), { id: "run_now", watchId: "w1" }, null, now);
    const withStore = await planPartialRun(partialEnv(enc), { id: "run_now", watchId: "w1" }, null, now);
    check("partial mode: a store password added since the last walk forces a full walk (control: none added)",
      control.reason !== withStore.reason && !withStore.taken && /store password/.test(withStore.reason ?? ""),
      `control: ${control.taken ? "planned" : control.reason} | with: ${withStore.taken ? "planned" : withStore.reason}`);
  }

  // ── 8 — rule 1 over every sentence a customer reads ──────────────────────
  {
    const synth = { verdict: "all_good" as const, bottomLine: null };
    const customerText = [
      judgeVerdictIntegrity(lockedJourneys(), [], synth, STORE, { storePassword: false, storePasswordRejected: false }).bottomLine ?? "",
      judgeVerdictIntegrity(lockedJourneys(), [], synth, STORE, { storePassword: true, storePasswordRejected: true }).bottomLine ?? "",
      STORE_LOCKED_OBSERVED,
      STORE_MISSING_OBSERVED,
      STORE_UNDRIVEN_OBSERVED,
      STORE_LOCKED_SMOKE_FAILURE,
      STORE_GATED_SMOKE_FAILURE,
      "The store password was not accepted, so the store behind its password page can't be checked this run.",
    ];
    for (const text of customerText) {
      check(`rule 1: no homework, narration or machinery — "${text.slice(0, 60)}…"`,
        !hasHomework(text) && !hasNarration(text) && !hasEnvironmentLeak(text), text);
    }
  }

  report(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  report(String(err instanceof Error ? err.stack : err));
  process.exit(1);
});
