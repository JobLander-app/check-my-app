// CHE-179 verification: the smoke pass treats a page that does not answer as
// unreached, not as trouble.
//
// 2026-09-04, the first day the survey (CHE-132) handed the smoke pass every
// page it had seen: all three watched apps went full instead of smoke —
// checkmyapp.dev because /sign-in did not answer within 20 s, joblander.app
// and meetbashar.com because one deep content page each did not. $0.61–0.75
// per app instead of $0.01, for a silence. CLAUDE.md rule 3: silence is not
// evidence. The rule now (src/agent/smoke.ts), exercised here against a stub
// page that can time out per URL, with no browser and no product:
//   a. a timeout on an `extra` page (one the survey saw) → the pass is ok,
//      the page is in `unreached`, "N pages healthy" does not count it, and
//      the same page answering on the retry is healthy;
//   b. a timeout on the homepage or a `core` page (spec/anatomy) → trouble;
//   c. HTTP 500 on any page → trouble, as before;
//   d. the retry is one, with the longer timeout; an uncaught error and a
//      console burst are still trouble; core is probed before extra; the
//      budget still leaves pages `skipped`, never healthy;
//   e. the feed line the owner reads says what answered and what did not,
//      about their pages only.
//
// CHE-187, 2026-09-06 — the console class of the same regression. Run #153
// on joblander.app went full on "75 console errors while loading the pages":
// a limit of five, written for a six-page pass (CHE-51), applied as a total
// across the thirty pages CHE-132 now hands over. The rule now:
//   f. thirty-one pages at three errors each → ok, the total recorded and
//      not trouble; one page at six → trouble naming that page; the counter
//      resets between pages (four on one page, four on the next → ok);
//   g. errors our own environment causes (a blocked tracker, an aborted
//      request, a third party's 4xx, a report-only CSP violation) are recorded
//      on the probe and never counted — six of them → ok; the same 4xx on
//      the product's own origin still counts; an uncaught exception is still
//      trouble on its own;
//   h. the trouble line names the page and its count; the ok line has no
//      console sentence at all.
//
// CHE-213, 2026-09-07 — the per-page limit was still not enough for a chatty
// app. Run #157 on joblander.app: the survey reported no change and nine of
// thirty-one pages logged five or six counted errors apiece, so the pass went
// red and the day cost $0.24 for a walk that returned all_good with no
// findings. On an unchanged app the burst is recorded and not counted:
//   i. two pages at six errors with consoleBurstIsTrouble false → ok, counts
//      still on the probes; the same pages with it true (the default) are
//      trouble; an HTTP 500, a silent core page and an uncaught exception are
//      trouble either way.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-smoke-gate.ts

import {
  CONSOLE_ERROR_LIMIT,
  CORE_SMOKE_PAGES,
  IGNORED_CONSOLE_ERRORS,
  MAX_SMOKE_PAGES,
  PAGE_TIMEOUT_MS,
  RETRY_TIMEOUT_MS,
  consoleSetAsideLine,
  probeTargets,
  quickCheckBottomLine,
  smokeOutcomeLine,
  splitSmokeTargets,
  type ProbePage,
} from "@/agent/smoke";
import { MACHINERY_TERMS, hasEnvironmentLeak, productProse } from "@/lib/verdict-language";

// The whole words gate a synthesized sentence meets: the phrase table and the
// homework family, the machinery words, and productProse leaving it untouched.
// hasEnvironmentLeak alone let "skipping the full agent check" through (CHE-377).
// On top of it, the words of how a check runs: the shared gate cannot ban
// "walk" (the price explanation says "Walked 7 journeys", CLAUDE.md §10), so
// these two lines are held to it here (Codex on #219).
const PROCESS_WORDS = /\b(smoke|replay(?:-first)?|re-?walk\w*|re-?verif\w*|skipp\w*|agent)\b/i;
const speaksProduct = (s: string) =>
  !hasEnvironmentLeak(s) && !MACHINERY_TERMS.test(s) && !PROCESS_WORDS.test(s) && productProse(s) === s;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://target.test";
const u = (path: string) => `${ORIGIN}${path}`;

// Per-URL behaviour: a status to answer with, "timeout" to never answer, or
// "slow" to time out on the first attempt and answer 200 on the next.
type Behaviour = number | "timeout" | "slow";

/** A console error the stub page logs while a navigation is in flight. */
interface ConsoleError {
  text: string;
  /** The resource the message is about, as Playwright's msg.location().url. */
  url?: string;
}

/** What a Playwright ConsoleMessage looks like to the listener in smoke.ts. */
function consoleError(text: string, url = ""): unknown {
  return { type: () => "error", text: () => text, location: () => ({ url, lineNumber: 0, columnNumber: 0 }) };
}

interface Stub {
  page: ProbePage;
  /** Every navigation as "<path> @<timeout>" in order. */
  calls: string[];
  fire: (event: "console" | "pageerror", payload: unknown) => void;
}

function stubPage(
  behaviour: Record<string, Behaviour>,
  /** Console errors each path logs during its navigation (CHE-187). */
  logs: (path: string) => ConsoleError[] = () => [],
): Stub {
  const calls: string[] = [];
  const attempts = new Map<string, number>();
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const fire = (event: string, payload: unknown) => {
    for (const h of handlers.get(event) ?? []) h(payload);
  };
  const page = {
    goto: async (url: string, opts?: { timeout?: number }) => {
      const path = new URL(url).pathname;
      calls.push(`${path} @${opts?.timeout ?? 0}`);
      const n = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, n);
      for (const e of logs(path)) fire("console", consoleError(e.text, e.url));
      const b = behaviour[path] ?? 200;
      if (b === "timeout" || (b === "slow" && n === 1)) {
        throw new Error(`page.goto: Timeout ${opts?.timeout ?? 0}ms exceeded.`);
      }
      const status = b === "slow" ? 200 : b;
      return { status: () => status };
    },
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.from(""),
  } as unknown as ProbePage;
  return { page, calls, fire };
}

async function main() {
  const core = [u("/sign-in"), u("/pricing")];
  const extra = [u("/tutorials/103-safe-practice-mock-interviews"), u("/learn/does-bashar-contradict-himself"), u("/docs")];

  // a — a silence on an extra page: unreached, not trouble, not healthy.
  {
    const stub = stubPage({ "/tutorials/103-safe-practice-mock-interviews": "timeout" });
    const out = await probeTargets(stub.page, u("/"), { core, extra });
    check("a: extra page timing out twice → smoke ok", out.failures.length === 0, out.failures.join("; "));
    check("a: the page is listed as unreached", JSON.stringify(out.unreached) === JSON.stringify([u("/tutorials/103-safe-practice-mock-interviews")]), JSON.stringify(out.unreached));
    check("a: healthy counts the pages that answered only (home + 4)", out.healthy === 5 && out.probes.length === 6, `healthy=${out.healthy} probes=${out.probes.length}`);
    check("a: nothing skipped", out.skipped === 0, String(out.skipped));
    const retries = stub.calls.filter((c) => c.startsWith("/tutorials/"));
    check("a: exactly one retry, at the longer timeout", JSON.stringify(retries) === JSON.stringify([`/tutorials/103-safe-practice-mock-interviews @${PAGE_TIMEOUT_MS}`, `/tutorials/103-safe-practice-mock-interviews @${RETRY_TIMEOUT_MS}`]), retries.join(" | "));
    const probe = out.probes.find((p) => p.url.includes("/tutorials/"));
    check("a: the probe records two attempts and no status", probe?.attempts === 2 && probe.status === null, JSON.stringify(probe));
  }
  // a' — the same page answering on the retry is healthy.
  {
    const stub = stubPage({ "/learn/does-bashar-contradict-himself": "slow" });
    const out = await probeTargets(stub.page, u("/"), { core, extra });
    check("a': extra page answering on the retry → ok, nothing unreached, all healthy", out.failures.length === 0 && out.unreached.length === 0 && out.healthy === 6, `healthy=${out.healthy} unreached=${out.unreached.length}`);
    const probe = out.probes.find((p) => p.url.includes("/learn/"));
    check("a': the probe records two attempts and the status", probe?.attempts === 2 && probe.status === 200, JSON.stringify(probe));
  }

  // b — a silence on the homepage or a core page is trouble.
  {
    const stub = stubPage({ "/sign-in": "timeout" });
    const out = await probeTargets(stub.page, u("/"), { core, extra });
    check("b: core page timing out twice → trouble", out.failures.length === 1 && out.failures[0] === "/sign-in did not answer in time", out.failures.join("; "));
    check("b: … and it is also listed as unreached, not counted healthy", out.unreached.length === 1 && out.healthy === 5, `unreached=${out.unreached.length} healthy=${out.healthy}`);
    const stubHome = stubPage({ "/": "timeout" });
    const home = await probeTargets(stubHome.page, u("/"), { core, extra });
    check("b: homepage timing out twice → trouble", home.failures.some((f) => f === "/ did not answer in time"), home.failures.join("; "));
    check("b: the homepage got its retry too", stubHome.calls.filter((c) => c.startsWith("/ @")).length === 2, stubHome.calls.slice(0, 2).join(" | "));
    const stubSlowCore = stubPage({ "/sign-in": "slow" });
    const slow = await probeTargets(stubSlowCore.page, u("/"), { core, extra });
    check("b: core page answering on the retry → ok", slow.failures.length === 0 && slow.unreached.length === 0);
    const stubDns = stubPage({});
    (stubDns.page as unknown as { goto: (url: string) => Promise<never> }).goto = async (url: string) => {
      stubDns.calls.push(new URL(url).pathname);
      if (new URL(url).pathname === "/pricing") throw new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://target.test/pricing");
      return { status: () => 200 } as never;
    };
    const dns = await probeTargets(stubDns.page, u("/"), { core, extra });
    check("b: a core page that fails for another reason names it without the driver prefix", dns.failures[0] === "/pricing did not answer (net::ERR_NAME_NOT_RESOLVED at https://target.test/pricing)", dns.failures.join("; "));
  }

  // c — a 5xx anywhere is trouble; a 4xx is an answer.
  {
    const stub = stubPage({ "/docs": 500 });
    const out = await probeTargets(stub.page, u("/"), { core, extra });
    check("c: HTTP 500 on an extra page → trouble", out.failures.length === 1 && out.failures[0] === "/docs returned HTTP 500", out.failures.join("; "));
    check("c: a 500 is an answer — not retried, not unreached", stub.calls.filter((c) => c.startsWith("/docs")).length === 1 && out.unreached.length === 0);
    const stub404 = stubPage({ "/docs": 404 });
    const nf = await probeTargets(stub404.page, u("/"), { core, extra });
    check("c: HTTP 404 is an answer, not trouble (as before)", nf.failures.length === 0 && nf.healthy === 6);
  }

  // d — the other rules still hold.
  {
    const stub = stubPage({});
    const pending = probeTargets(stub.page, u("/"), { core, extra });
    stub.fire("pageerror", new Error("TypeError: x is undefined"));
    const out = await pending;
    check("d: an uncaught JS error is trouble", out.failures.some((f) => f.startsWith("uncaught JS error on load")), out.failures.join("; "));
    const stubBurst = stubPage({});
    const pendingBurst = probeTargets(stubBurst.page, u("/"), { core, extra });
    for (let i = 0; i < 5; i++) stubBurst.fire("console", consoleError(`TypeError: cannot read properties of undefined (${i})`, u("/app.js")));
    const burst = await pendingBurst;
    check("d: five console errors on one page are trouble, naming the page", burst.failures.some((f) => f === "/ logged 5 console errors"), burst.failures.join("; "));
    const order = stubPage({});
    await probeTargets(order.page, u("/"), { core, extra });
    check("d: homepage, then core, then extra", JSON.stringify(order.calls.map((c) => c.split(" @")[0])) === JSON.stringify(["/", "/sign-in", "/pricing", "/tutorials/103-safe-practice-mock-interviews", "/learn/does-bashar-contradict-himself", "/docs"]), order.calls.join(" | "));
    // Budget: a clock that jumps past the budget after the second page.
    let tick = 0;
    const budget = stubPage({});
    const capped = await probeTargets(budget.page, u("/"), { core, extra }, { now: () => (tick++ < 3 ? 0 : 1_000_000) });
    check("d: the budget leaves pages skipped, never healthy", capped.skipped === 3 && capped.healthy === 3 && capped.failures.length === 0, `skipped=${capped.skipped} healthy=${capped.healthy}`);
  }

  // d' — the split: the first CORE_SMOKE_PAGES known pages are core, the rest
  // and the survey's pages are extra, deduped, under the cap.
  {
    const known = Array.from({ length: 8 }, (_, i) => u(`/k${i}`));
    const surveyed = [u("/k1"), u("/k7"), ...Array.from({ length: 40 }, (_, i) => u(`/s${i}`))];
    const sets = splitSmokeTargets(known, surveyed);
    check("d': core = the first six known pages", JSON.stringify(sets.core) === JSON.stringify(known.slice(0, CORE_SMOKE_PAGES)), sets.core.join(" "));
    check("d': extra starts with the known pages past six, then the survey's, deduped", sets.extra[0] === u("/k6") && sets.extra[1] === u("/k7") && sets.extra[2] === u("/s0") && !sets.extra.includes(u("/k1")), sets.extra.slice(0, 4).join(" "));
    check("d': core + extra stay under the cap", sets.core.length + sets.extra.length === MAX_SMOKE_PAGES, String(sets.core.length + sets.extra.length));
    const none = splitSmokeTargets([], []);
    check("d': nothing known, nothing surveyed → empty sets", none.core.length === 0 && none.extra.length === 0);
  }

  // e — the feed line the owner reads (2026-09-04's three apps, as they should have read).
  {
    const stub = stubPage({ "/tutorials/103-safe-practice-mock-interviews": "timeout" });
    const out = await probeTargets(stub.page, u("/"), { core, extra });
    const line = smokeOutcomeLine({ ok: out.failures.length === 0, ...out, fullRunNumber: 134 }, u("/"));
    check("e: ok with one silent page", line === "All 5 pages healthy, 1 did not answer in time (/tutorials/103-safe-practice-mock-interviews) — the journey results are Run #134's", line);
    const clean = smokeOutcomeLine({ ok: true, healthy: 12, unreached: [], failures: [], fullRunNumber: 134 }, u("/"));
    check("e: ok with every page answering reads as before", clean === "All 12 pages healthy, no uncaught errors — the journey results are Run #134's", clean);
    check("e: the ok lines pass the whole words gate", speaksProduct(line) && speaksProduct(clean), `${line} | ${clean}`);
    // Two green quick checks in a row: the second one's baseline is the first
    // (#141, no journeys walked); the results are still the walk's (#134).
    const second = { ok: true, healthy: 12, unreached: [], failures: [], baselineRunNumber: 141, fullRunNumber: 134 };
    const again = smokeOutcomeLine(second, u("/"));
    check("e: the second quick check in a row names the run that walked the journeys, not the quick check before it",
      again.endsWith("the journey results are Run #134's") && !again.includes("#141"), again);
    const bottom = quickCheckBottomLine(second);
    check("e: …and the feed line and the bottom line name the same run",
      bottom.includes("journey results are from Run #134") && !bottom.includes("#141"), bottom);
    const trouble = smokeOutcomeLine({ ok: false, healthy: 4, unreached: [u("/sign-in")], failures: ["/sign-in did not answer in time"], fullRunNumber: 134 }, u("/"));
    check("e: trouble names the page and the fact", trouble === "Smoke found trouble: /sign-in did not answer in time — running the full check", trouble);
    check("e: no machinery leaks into either line", !hasEnvironmentLeak(line) && !hasEnvironmentLeak(trouble) && !/page\.goto|playwright|headless|browser/i.test(line + trouble));
  }

  // f — the console limit is per page (CHE-187). Run #153's shape: thirty-one
  // pages, a few errors on each, none of them a burst.
  {
    const known = Array.from({ length: CORE_SMOKE_PAGES }, (_, i) => u(`/k${i}`));
    const surveyed = Array.from({ length: MAX_SMOKE_PAGES }, (_, i) => u(`/s${i}`));
    const sets = splitSmokeTargets(known, surveyed);
    const chatty = (path: string) => [
      { text: "Failed to load resource: the server responded with a status of 404 ()", url: u(`${path}/hero.webp`) },
      { text: "Uncaught (in promise) TypeError: Cannot read properties of null", url: u("/app.js") },
      { text: "Warning: a widget failed to hydrate", url: u("/app.js") },
    ];
    const stub = stubPage({}, chatty);
    const out = await probeTargets(stub.page, u("/"), sets);
    check("f: 31 pages × 3 errors → smoke ok", out.failures.length === 0 && out.probes.length === 31, `failures=${out.failures.join("; ")} probes=${out.probes.length}`);
    check("f: … the total is recorded as a fact (93), not a rule", out.consoleErrors === 93, String(out.consoleErrors));
    check("f: … and each probe carries its own count", out.probes.every((p) => p.consoleErrors === 3 && p.ignoredConsoleErrors === 0), JSON.stringify(out.probes.slice(0, 2)));
    check("f: … with the first counted message kept for diagnosis", out.probes[0].consoleSample === chatty("/")[0].text, out.probes[0].consoleSample);
    const one = stubPage({}, (path) => (path === "/s3" ? Array.from({ length: 6 }, (_, i) => ({ text: `ReferenceError: x${i} is not defined`, url: u("/app.js") })) : []));
    const burst = await probeTargets(one.page, u("/"), sets);
    check("f: one page with 6 → trouble naming that page", JSON.stringify(burst.failures) === JSON.stringify(["/s3 logged 6 console errors"]), burst.failures.join("; "));
    check("f: … the burst page's probe says 6; the total says 6", burst.probes.find((p) => p.url === u("/s3"))?.consoleErrors === 6 && burst.consoleErrors === 6, String(burst.consoleErrors));
    const four = (path: string) => (path === "/sign-in" || path === "/pricing" ? Array.from({ length: 4 }, (_, i) => ({ text: `TypeError: t${i}`, url: u("/app.js") })) : []);
    const split = stubPage({}, four);
    const reset = await probeTargets(split.page, u("/"), { core, extra });
    check("f: the counter resets between pages (4 on A, 4 on B → ok, total 8)", reset.failures.length === 0 && reset.consoleErrors === 8, `failures=${reset.failures.join("; ")} total=${reset.consoleErrors}`);
    check("f: the limit that decides is the exported one", CONSOLE_ERROR_LIMIT === 5, String(CONSOLE_ERROR_LIMIT));
    // The homepage's errors arrive after domcontentloaded, during the settle;
    // they belong to the homepage, not to the first core page.
    const late = stubPage({});
    (late.page as unknown as { waitForTimeout: () => Promise<void> }).waitForTimeout = async () => {
      for (let i = 0; i < 5; i++) late.fire("console", consoleError(`TypeError: late ${i}`, u("/app.js")));
    };
    const settled = await probeTargets(late.page, u("/"), { core, extra });
    check("f: errors logged while the homepage settles count for the homepage", JSON.stringify(settled.failures) === JSON.stringify(["/ logged 5 console errors"]) && settled.probes[0].consoleErrors === 5 && settled.probes[1].consoleErrors === 0, settled.failures.join("; "));
  }

  // g — noise our own environment causes is recorded, never counted.
  {
    const blocked = stubPage({}, (path) => (path === "/pricing" ? Array.from({ length: 6 }, () => ({ text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT", url: "https://www.googletagmanager.com/gtm.js" })) : []));
    const out = await probeTargets(blocked.page, u("/"), { core, extra });
    check("g: 6 errors that are all ERR_BLOCKED_BY_CLIENT → ok", out.failures.length === 0 && out.consoleErrors === 0, `failures=${out.failures.join("; ")} total=${out.consoleErrors}`);
    check("g: … recorded on the probe for diagnosis", out.probes.find((p) => p.url === u("/pricing"))?.ignoredConsoleErrors === 6, JSON.stringify(out.probes.find((p) => p.url === u("/pricing"))));
    const noise: ConsoleError[] = [
      { text: "Failed to load resource: net::ERR_ABORTED 200", url: u("/api/session") },
      { text: "Failed to load resource: the server responded with a status of 404 ()", url: u("/favicon.ico") },
      { text: "Failed to load resource: the server responded with a status of 403 ()", url: "https://www.google-analytics.com/collect" },
      { text: "Failed to load resource: net::ERR_CONNECTION_REFUSED", url: "https://o123.ingest.us.sentry.io/api/1/envelope/" },
      { text: "POST https://api.segment.io/v1/t 400", url: "https://cdn.segment.com/analytics.js" },
      { text: "Failed to load resource: the server responded with a status of 401 ()", url: "https://api-iam.intercom.io/messenger/web/ping" },
      { text: "[Report Only] Refused to load the script 'https://cdn.example.com/x.js' because it violates the following Content Security Policy directive", url: u("/") },
      { text: "Failed to load resource: the server responded with a status of 403 ()", url: "https://fonts.example-cdn.com/inter.woff2" },
      { text: "Failed to load resource: the server responded with a status of 429 ()", url: "https://connect.facebook.net/en_US/fbevents.js" },
    ];
    const all = stubPage({}, (path) => (path === "/docs" ? noise : []));
    const ignored = await probeTargets(all.page, u("/"), { core, extra });
    const docs = ignored.probes.find((p) => p.url === u("/docs"));
    check("g: every listed kind of noise is ignored", ignored.failures.length === 0 && docs?.consoleErrors === 0 && docs.ignoredConsoleErrors === noise.length, JSON.stringify(docs));
    check("g: every rule carries its why", IGNORED_CONSOLE_ERRORS.every((r) => r.why.length > 0), String(IGNORED_CONSOLE_ERRORS.length));
    const own = stubPage({}, (path) => (path === "/docs" ? Array.from({ length: 5 }, (_, i) => ({ text: "Failed to load resource: the server responded with a status of 404 ()", url: u(`/assets/${i}.js`) })) : []));
    const missing = await probeTargets(own.page, u("/"), { core, extra });
    check("g: the same 4xx on the product's own origin counts (5 missing assets → trouble)", JSON.stringify(missing.failures) === JSON.stringify(["/docs logged 5 console errors"]), missing.failures.join("; "));
    const fb = stubPage({}, (path) => (path === "/docs" ? Array.from({ length: 5 }, () => ({ text: "Facebook login failed: invalid app id", url: u("/app.js") })) : []));
    const product = await probeTargets(fb.page, u("/"), { core, extra });
    check("g: a product's own message that names a tracker still counts", product.failures.length === 1, product.failures.join("; "));
    const stub = stubPage({}, (path) => (path === "/pricing" ? [{ text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT", url: "https://www.googletagmanager.com/gtm.js" }] : []));
    const pending = probeTargets(stub.page, u("/"), { core, extra });
    stub.fire("pageerror", new Error("TypeError: x is undefined"));
    const uncaught = await pending;
    check("g: an uncaught exception is still trouble on its own", JSON.stringify(uncaught.failures) === JSON.stringify(['uncaught JS error on load — "TypeError: x is undefined"']), uncaught.failures.join("; "));
  }

  // i — CHE-213: on an app the survey saw unchanged, a console burst is
  // recorded and does not fail the pass; the live signals still do. This is
  // the rule that decides whether run #157's shape (nine chatty pages, two
  // comparable snapshots that agreed) costs $0.24 or $0.01. replay.ts passes
  // consoleBurstIsTrouble: false exactly when surveySaysUnchanged is true.
  {
    const chatty = (path: string) =>
      path === "/docs" || path === "/pricing"
        ? Array.from({ length: 6 }, (_, i) => ({ text: `ReferenceError: x${i} is not defined`, url: u("/app.js") }))
        : [];
    const quiet = await probeTargets(stubPage({}, chatty).page, u("/"), { core, extra }, { consoleBurstIsTrouble: false });
    check("i: unchanged app · two pages at 6 errors → ok", quiet.failures.length === 0, quiet.failures.join("; "));
    check("i: … the counts are still recorded, per page and in total", quiet.consoleErrors === 12 && quiet.probes.find((p) => p.url === u("/docs"))?.consoleErrors === 6, String(quiet.consoleErrors));
    check("i: … and both pages are listed as set aside, never swallowed", JSON.stringify(quiet.consoleBurstsSetAside) === JSON.stringify([u("/pricing"), u("/docs")]), quiet.consoleBurstsSetAside.join(", "));
    const loud = await probeTargets(stubPage({}, chatty).page, u("/"), { core, extra }, { consoleBurstIsTrouble: true });
    check("i: … the same pages are trouble when the survey did not say the app stood still", loud.failures.length === 2 && loud.consoleBurstsSetAside.length === 0, loud.failures.join("; "));
    check("i: … and the option defaults to trouble when nobody passes it", (await probeTargets(stubPage({}, chatty).page, u("/"), { core, extra })).failures.length === 2);
    const dead = await probeTargets(stubPage({ "/pricing": 500 }, chatty).page, u("/"), { core, extra }, { consoleBurstIsTrouble: false });
    check("i: an HTTP 500 is still trouble on an unchanged app", JSON.stringify(dead.failures) === JSON.stringify(["/pricing returned HTTP 500"]), dead.failures.join("; "));
    const silent = await probeTargets(stubPage({ "/sign-in": "timeout" }, chatty).page, u("/"), { core, extra }, { consoleBurstIsTrouble: false });
    check("i: a silent core page is still trouble on an unchanged app", silent.failures.length === 1 && /sign-in/.test(silent.failures[0]), silent.failures.join("; "));
    const thrower = stubPage({}, chatty);
    const pending = probeTargets(thrower.page, u("/"), { core, extra }, { consoleBurstIsTrouble: false });
    thrower.fire("pageerror", new Error("TypeError: x is undefined"));
    const crash = await pending;
    check("i: an uncaught exception is still trouble on an unchanged app", crash.failures.length === 1 && /uncaught/.test(crash.failures[0]), crash.failures.join("; "));
  }

  // j — CHE-213: the class the survey could NOT have checked. It compares
  // markup and static assets, so a backend that started answering 500 to an
  // XHR leaves every page byte-identical and this console line is the only
  // trace. One is trouble, on any app, at any count.
  {
    const target = (text: string, url = u("/api/session")) => ({ text, url });
    const fiveHundred = "Failed to load resource: the server responded with a status of 500 ()";
    const one = await probeTargets(
      stubPage({}, (path) => (path === "/docs" ? [target(fiveHundred)] : [])).page,
      u("/"), { core, extra }, { consoleBurstIsTrouble: false },
    );
    check("j: one 500 from their own server on an unchanged app → trouble", JSON.stringify(one.failures) === JSON.stringify(["/docs — 1 request on this page came back as a server error"]), one.failures.join("; "));
    check("j: … counted on the probe as a server error and sampled", one.probes.find((p) => p.url === u("/docs"))?.serverErrors === 1 && one.probes.find((p) => p.url === u("/docs"))?.serverErrorSample === fiveHundred);
    check("j: … and it is not listed as set aside", one.consoleBurstsSetAside.length === 0, one.consoleBurstsSetAside.join(", "));
    for (const status of [502, 503, 504]) {
      const out = await probeTargets(
        stubPage({}, (path) => (path === "/docs" ? [target(`Failed to load resource: the server responded with a status of ${status} ()`)] : [])).page,
        u("/"), { core, extra }, { consoleBurstIsTrouble: false },
      );
      check(`j: ${status} from their own server is trouble too`, out.failures.length === 1, out.failures.join("; "));
    }
    const transport = await probeTargets(
      stubPage({}, (path) => (path === "/docs" ? [target("Failed to load resource: net::ERR_CONNECTION_RESET")] : [])).page,
      u("/"), { core, extra }, { consoleBurstIsTrouble: false },
    );
    check("j: a transport failure on a request to their own host is trouble", transport.failures.length === 1, transport.failures.join("; "));
    const foreign = await probeTargets(
      stubPage({}, (path) => (path === "/docs" ? [target("Failed to load resource: net::ERR_CONNECTION_RESET", "https://cdn.other.test/x.js")] : [])).page,
      u("/"), { core, extra }, { consoleBurstIsTrouble: false },
    );
    check("j: the same transport failure to another host is not their server", foreign.failures.length === 0, foreign.failures.join("; "));
    const unplaceable = await probeTargets(
      stubPage({}, (path) => (path === "/docs" ? [target(fiveHundred, "")] : [])).page,
      u("/"), { core, extra }, { consoleBurstIsTrouble: false },
    );
    check("j: a 5xx we cannot attribute stays trouble — a blind spot is not calm", unplaceable.failures.length === 1, unplaceable.failures.join("; "));
    // The XHR shape: an unchanged page whose backend started failing produces
    // exactly this and nothing else. The URL lives in the text, not location.
    const inText = await probeTargets(
      stubPage({}, (path) => (path === "/docs" ? [target(`POST ${u("/api/save")} 503 (Service Unavailable)`, "")] : [])).page,
      u("/"), { core, extra }, { consoleBurstIsTrouble: false },
    );
    check("j: an XHR 5xx to their own host is trouble, placed by the URL in the message", JSON.stringify(inText.failures) === JSON.stringify(["/docs — 1 request on this page came back as a server error"]), inText.failures.join("; "));
    const foreignXhr = await probeTargets(
      stubPage({}, (path) => (path === "/docs" ? [target("GET https://api.other.test/v1/thing 502 (Bad Gateway)", "")] : [])).page,
      u("/"), { core, extra }, { consoleBurstIsTrouble: false },
    );
    check("j: the same XHR 5xx to another host is not their server", foreignXhr.failures.length === 0, foreignXhr.failures.join("; "));
    // Our own environment and third parties are filtered before the class is
    // judged, so neither can masquerade as their server failing.
    const ours = await probeTargets(
      stubPage({}, (path) => (path === "/docs" ? [target("Failed to load resource: net::ERR_ABORTED 200"), target("Failed to load resource: net::ERR_BLOCKED_BY_CLIENT", "https://www.googletagmanager.com/gtm.js")] : [])).page,
      u("/"), { core, extra }, { consoleBurstIsTrouble: false },
    );
    check("j: our own aborted and blocked requests are never a server error", ours.failures.length === 0 && ours.probes.find((p) => p.url === u("/docs"))?.serverErrors === 0, ours.failures.join("; "));
    const sentry = await probeTargets(
      stubPage({}, (path) => (path === "/docs" ? [target("Failed to load resource: net::ERR_CONNECTION_REFUSED", "https://o123.ingest.us.sentry.io/api/1/envelope/")] : [])).page,
      u("/"), { core, extra }, { consoleBurstIsTrouble: false },
    );
    check("j: a third-party error-reporting host failing is not their server", sentry.failures.length === 0, sentry.failures.join("; "));
    // One page, one line: a chatty page that also has a server error says the
    // server error, not both.
    const both = await probeTargets(
      stubPage({}, (path) => (path === "/docs" ? [target(fiveHundred), ...Array.from({ length: 6 }, (_, i) => target(`ReferenceError: x${i}`, u("/app.js")))] : [])).page,
      u("/"), { core, extra }, { consoleBurstIsTrouble: true },
    );
    check("j: a page with both a burst and a server error produces one line, the server one", both.failures.length === 1 && /server error/.test(both.failures[0]), both.failures.join("; "));
    check("j: the 4xx rules are untouched (a 404 on their own origin is still just a console error)", (await probeTargets(
      stubPage({}, (path) => (path === "/docs" ? Array.from({ length: 5 }, (_, i) => target("Failed to load resource: the server responded with a status of 404 ()", u(`/assets/${i}.js`))) : [])).page,
      u("/"), { core, extra },
    )).failures.join() === "/docs logged 5 console errors");
  }

  // k — the set-aside line the owner reads on a green pass (CHE-213).
  {
    const line = consoleSetAsideLine([u("/settings"), u("/en/roles"), u("/about"), u("/terms"), u("/docs")], u("/"));
    check("k: the line names the pages, caps the list and counts the rest", line === "Console errors on 5 pages (/settings, /en/roles, /about, /terms and 1 more) — none of them your server answering with an error, and those pages have not changed since the last check", line ?? "null");
    check("k: no machinery leaks into it", !!line && !hasEnvironmentLeak(line));
    check("k: it claims no walk and no homework", !!line && !/journey|walk|verif|check it|yourself|manual/i.test(line), line ?? "null");
    const single = consoleSetAsideLine([u("/about")], u("/"));
    check("k: one page reads as one page", single === "Console errors on 1 page (/about) — none of them your server answering with an error, and those pages have not changed since the last check", single ?? "null");
    check("k: nothing set aside → no line at all", consoleSetAsideLine([], u("/")) === null);
  }

  // h — the feed line: the count appears only when it decided something.
  {
    const trouble = smokeOutcomeLine({ ok: false, healthy: 31, unreached: [], failures: ["/tutorials/103-safe-practice-mock-interviews logged 6 console errors"], fullRunNumber: 152 }, u("/"));
    check("h: trouble names the page and its count", trouble === "Smoke found trouble: /tutorials/103-safe-practice-mock-interviews logged 6 console errors — running the full check", trouble);
    const ok = smokeOutcomeLine({ ok: true, healthy: 31, unreached: [], failures: [], fullRunNumber: 152 }, u("/"));
    check("h: the ok line has no console sentence (93 errors recorded, none spoken)", !/console/i.test(ok), ok);
    check("h: no machinery leaks", !hasEnvironmentLeak(trouble) && !hasEnvironmentLeak(ok));
  }

  // l — CHE-377: the quick check's bottom line, the one verdict sentence no
  // synthesis gate sees. It reaches the verdict page, the email, the MCP tools
  // and a CI job summary, so it meets the whole gate here instead.
  {
    const all = quickCheckBottomLine({ healthy: 31, unreached: [], fullRunNumber: 275 });
    check("l: every page answering", all === "Quick check: 31 pages healthy, nothing changed since Run #275. Your app is up and its known pages still serve; the journey results are from Run #275.", all);
    const some = quickCheckBottomLine({ healthy: 1, unreached: [u("/docs"), u("/blog")], fullRunNumber: 9 });
    check("l: a page that did not answer is said, and one page reads as one", some === "Quick check: 1 page healthy, 2 did not answer in time, nothing changed since Run #9. Your app is up and its known pages still serve; the journey results are from Run #9.", some);
    check("l: both pass the whole words gate", speaksProduct(all) && speaksProduct(some), `${all} | ${some}`);
    check("l: coverage is still said — where the journey results come from (CLAUDE.md §2)", /journey results are from Run #275/.test(all));
    const before = "Daily smoke pass: 31 pages healthy, nothing changed since Run #275 — full agent check skipped (replay-first). This confirms your app is up and its known pages still serve; it does not re-verify the journeys.";
    check("l: the gate rejects the wording 28 verdicts carried", !speaksProduct(before));
    const firstFix = "Quick check: 31 pages healthy, nothing changed since Run #275. Your app is up and its known pages still serve; the journeys were not re-walked this time.";
    check("l: …and the first fix's process clause (Codex on #219)", !speaksProduct(firstFix));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
