// CHE-193 verification: the self-check announces itself to our own hosts and
// never presses their create/mark controls.
//
// Run #146 (the daily self-check of checkmyapp.dev, 2026-09-05 15:30 UTC)
// pressed "Re-check now" on the public verdict page of a stranger's app and
// created two real runs (#147, #148), then pressed "Looks right ✓" on a
// stranger's verdict. CLAUDE.md rule 6 — a self-check cleans up after itself
// — had nothing to clean: the damage was on other people's records, the same
// class as CHE-89 and CHE-98.
//
// The web half answers 403 {"error":"self_check_read_only"} to every
// creating/mutating API when a request carries x-checkmyapp-checker: 1. The
// agent half, proven here on plain Node with a stub page — no browser, no
// tokens, no product:
//   1. isSelfHost: our hosts and their subdomains, an env-listed extra host,
//      and NEVER a customer's host or a look-alike;
//   2. the announcement (CHE-212) rides on the requests the web half guards —
//      a mutating, same-origin request to the target's own host — and on
//      nothing else: not a customer's app, not our own subdomains (the Clerk
//      bundle), not a CDN, not a document, script, style or font. Proven on
//      the pure decision AND through the real routing handler, because the
//      context-wide version of this made the browser preflight Clerk's script,
//      met its 307, left the sign-in page empty, and run #156 published that
//      as a high-severity finding about our own product;
//   3. the click gate refuses the create/mark controls of our own product on
//      a self host, and lets the same labels through on a customer's app;
//   4. a mutating 403 from a self host after a click — or a server action
//      redirecting back with ?self_check=read_only — tells the model the
//      action is unavailable, and report_step cannot write broken/confusing
//      off it — the step is written skipped/not_applicable in product
//      language; a customer's 403 is left to the existing rules.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-self-check-agent.ts

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  coerceSelfCheck403,
  executeTool,
  SELF_HOST_GUARDED_VERBS,
  type ReportedStep,
  type ToolEnv,
} from "@/agent/tools";
import {
  announceSelfCheckOn,
  DEFAULT_SELF_HOSTS,
  isSelfCheckRedirect,
  isSelfHost,
  SELF_CHECK_HEADER,
  selfCheckRequestHeaders,
  selfCheckRefusalIn,
  type SelfCheckRoutable,
  type SelfCheckRoute,
} from "@/agent/self-hosts";
import { hasEnvironmentLeak, SELF_CHECK_REFUSED_OBSERVED } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const SELF = "https://checkmyapp.dev";
const CUSTOMER = "https://joblander.app";

// Enough of a page for click: the one control answers with whatever request
// line the test hands it, so the reaction is "1 request" and the fresh log
// slice is exactly that line; `landsOn` is where the click (or any goto)
// ends up, as a server action's redirect would leave the page.
function stubPage(origin: string, opts: { onClick: string[]; networkLog: string[]; landsOn?: string }) {
  let url = `${origin}/verdict/abc`;
  const locator = {
    first: () => locator,
    count: async () => 1,
    or: () => locator,
    elementHandle: async () => null,
    click: async () => {
      opts.networkLog.push(...opts.onClick);
      if (opts.landsOn) url = opts.landsOn;
    },
  };
  return {
    url: () => url,
    goto: async (u: string) => {
      url = opts.landsOn ?? u;
      return { status: () => 200 };
    },
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

function stubEnv(
  origin: string,
  opts: { onClick?: string[]; extra?: string; writeAllowed?: boolean; landsOn?: string } = {},
): ToolEnv {
  const networkLog: string[] = [];
  return {
    page: stubPage(origin, { onClick: opts.onClick ?? [`GET ${origin}/after-click → 200`], networkLog, landsOn: opts.landsOn }),
    targetOrigin: origin,
    networkLog,
    consoleLog: [],
    writeAllowed: opts.writeAllowed ?? false,
    credentials: { rejected: false },
    actionTrail: [],
    ...(opts.extra ? { selfCheckHosts: opts.extra } : {}),
  } as unknown as ToolEnv;
}

function step(status: ReportedStep["status"], observed: string, attempted = "Press the control"): ReportedStep {
  return { label: "Press the control", status, attempted, observed };
}

// CHE-212: a stub browser context that records what announceSelfCheckOn does to
// a request. `send` returns the headers the request would actually go out with,
// and `intercepted` says whether the matcher even routed it — a request the
// matcher never sees cannot differ from a visitor's in any way at all.
//
// `from` is the URL of the frame that made the request; omitting it makes
// request.frame() throw, as it does for a service worker.
interface StubRequest {
  url: string;
  method?: string;
  from?: string;
  headers?: Record<string, string>;
}

function routedContext() {
  let matcher: ((url: URL) => boolean) | null = null;
  let handler: ((route: SelfCheckRoute) => Promise<void>) | null = null;
  const context: SelfCheckRoutable = {
    route: async (m, h) => {
      matcher = m;
      handler = h;
    },
  };
  const intercepted = (url: string) => Boolean(matcher && matcher(new URL(url)));
  async function send(req: StubRequest): Promise<Record<string, string>> {
    const original: Record<string, string> = {
      "user-agent": "Mozilla/5.0 Chrome",
      accept: "*/*",
      ...(req.headers ?? {}),
    };
    if (!handler || !intercepted(req.url)) return original;
    let sent = original;
    const route: SelfCheckRoute = {
      request: () => ({
        url: () => req.url,
        method: () => req.method ?? "GET",
        headers: () => original,
        frame: () => {
          if (req.from === undefined) throw new Error("request is not from a frame");
          return { url: () => req.from as string };
        },
      }),
      continue: async (options) => {
        sent = options?.headers ?? original;
      },
    };
    await handler(route);
    return sent;
  }
  return { context, send, intercepted, installed: () => handler !== null };
}

const CLERK_BUNDLE = "https://clerk.checkmyapp.dev/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
const CDN = "https://cdn.jsdelivr.net/npm/some-lib@1/dist/lib.min.js";

async function main() {
  // 1 — whose host is it.
  check("hosts: production is listed by default", DEFAULT_SELF_HOSTS.includes("checkmyapp.dev"));
  const hostCases: [string, string | undefined, boolean][] = [
    ["checkmyapp.dev", undefined, true],
    ["www.checkmyapp.dev", undefined, true],
    ["clerk.checkmyapp.dev", undefined, true],
    ["CheckMyApp.dev.", undefined, true],
    ["joblander.app", undefined, false],
    ["theins.ru", undefined, false],
    ["evil-checkmyapp.dev", undefined, false],
    ["checkmyapp.dev.example.com", undefined, false],
    ["checkmyapp.devil", undefined, false],
    ["", undefined, false],
    ["staging.example.com", "staging.example.com, localhost", true],
    ["preview.staging.example.com", "staging.example.com", true],
    ["localhost", " localhost ", true],
    ["joblander.app", "staging.example.com", false],
  ];
  for (const [host, extra, expect] of hostCases) {
    check(`isSelfHost("${host}"${extra ? `, extra "${extra}"` : ""}) = ${expect}`, isSelfHost(host, extra) === expect);
  }

  // 2 — the announcement rides on the guarded requests of our own host, and on
  // nothing else. CHE-212: run #156 published "Sign-in page renders blank"
  // because the header rode on the Clerk bundle, forced a CORS preflight, and
  // the preflight met the bundle's 307. The rule is proven twice: on the pure
  // decision, and on the real routing handler with a stub context.
  {
    const mutating = { url: `${SELF}/api/checks`, method: "POST", initiatorUrl: `${SELF}/` };
    check("headers: a mutating request to our own host carries x-checkmyapp-checker: 1",
      selfCheckRequestHeaders(SELF, mutating)?.[SELF_CHECK_HEADER] === "1",
      JSON.stringify(selfCheckRequestHeaders(SELF, mutating)));
    check("headers: the header name is the contract the web half checks", SELF_CHECK_HEADER === "x-checkmyapp-checker");

    const cases: [string, string, StubRequest, boolean][] = [
      // target, name, request, does it carry the announcement
      [SELF, "POST /api/checks on our host", { url: `${SELF}/api/checks`, method: "POST", from: `${SELF}/` }, true],
      [SELF, "PATCH a lens on our host", { url: `${SELF}/api/runs/143/lens`, method: "PATCH", from: `${SELF}/verdict/abc` }, true],
      [SELF, "PUT on our host", { url: `${SELF}/api/apps/9`, method: "PUT", from: `${SELF}/apps/9` }, true],
      [SELF, "DELETE on our host", { url: `${SELF}/api/apps/9`, method: "DELETE", from: `${SELF}/apps/9` }, true],
      [SELF, "a form POST (server action) on our host", { url: `${SELF}/apps/9`, method: "POST", from: `${SELF}/apps/9` }, true],
      [`${SELF}/sign-in`, "a mutating request when the target URL has a path", { url: `${SELF}/api/checks`, method: "POST", from: `${SELF}/sign-in` }, true],
      // …and never on anything a visitor would load the same way.
      [SELF, "the Clerk bundle (a subdomain of ours)", { url: CLERK_BUNDLE, from: `${SELF}/sign-in` }, false],
      [SELF, "a POST to Clerk's frontend API (a subdomain of ours)", { url: "https://clerk.checkmyapp.dev/v1/client/sign_ins", method: "POST", from: `${SELF}/sign-in` }, false],
      [SELF, "a third-party CDN script", { url: CDN, from: `${SELF}/` }, false],
      [SELF, "a font from a third party", { url: "https://fonts.gstatic.com/s/inter/v13/font.woff2", from: `${SELF}/` }, false],
      [SELF, "the GET document of our own page", { url: `${SELF}/sign-in`, method: "GET", from: `${SELF}/` }, false],
      [SELF, "a GET API call on our own host", { url: `${SELF}/api/checks/today`, method: "GET", from: `${SELF}/` }, false],
      [SELF, "a HEAD on our own host", { url: `${SELF}/api/checks`, method: "HEAD", from: `${SELF}/` }, false],
      [SELF, "a script served by our own host", { url: `${SELF}/_next/static/chunks/main.js`, from: `${SELF}/` }, false],
      [SELF, "a cross-origin POST to our host from somewhere else", { url: `${SELF}/api/checks`, method: "POST", from: "https://evil.example/page" }, false],
      [SELF, "a POST whose initiator cannot be read (service worker)", { url: `${SELF}/api/checks`, method: "POST" }, false],
      [CUSTOMER, "a mutating request on a customer's app", { url: `${CUSTOMER}/api/orders`, method: "POST", from: `${CUSTOMER}/cart` }, false],
      [CUSTOMER, "a customer's app posting to our host", { url: `${SELF}/api/checks`, method: "POST", from: `${CUSTOMER}/cart` }, false],
      ["https://evil-checkmyapp.dev", "a look-alike host", { url: "https://evil-checkmyapp.dev/api/x", method: "POST", from: "https://evil-checkmyapp.dev/" }, false],
      ["not a url", "an unparsable target", { url: `${SELF}/api/checks`, method: "POST", from: `${SELF}/` }, false],
    ];
    for (const [target, name, request, expect] of cases) {
      const decided = selfCheckRequestHeaders(target, {
        url: request.url,
        method: request.method ?? "GET",
        initiatorUrl: request.from ?? null,
      });
      check(`decision: ${name} → ${expect ? "announced" : "untouched"}`,
        (decided?.[SELF_CHECK_HEADER] === "1") === expect, JSON.stringify(decided));

      // The same case through the real routing handler.
      const routed = routedContext();
      await announceSelfCheckOn(routed.context, target);
      const sent = await routed.send(request);
      check(`routing: ${name} → ${expect ? "announced" : "untouched"}`,
        (sent[SELF_CHECK_HEADER] === "1") === expect, JSON.stringify(sent));
    }

    // The mechanism itself: the requests that made #156 fail are not merely
    // header-free, they are never intercepted, so they leave the browser
    // exactly as a visitor's do.
    {
      const routed = routedContext();
      await announceSelfCheckOn(routed.context, SELF);
      check("routing: the announcement is installed for a run of our own product", routed.installed());
      for (const url of [CLERK_BUNDLE, CDN, "https://fonts.gstatic.com/s/inter/v13/font.woff2", "https://www.checkmyapp.dev/x.js"]) {
        check(`routing: ${new URL(url).hostname} is not intercepted at all`, !routed.intercepted(url));
      }
      check("routing: our own host is intercepted so the guarded requests can be marked", routed.intercepted(`${SELF}/api/checks`));

      const script = await routed.send({ url: `${SELF}/_next/static/chunks/main.js`, from: `${SELF}/` });
      check("routing: a script request from our own host carries no extra header",
        Object.keys(script).every((h) => h.toLowerCase() !== SELF_CHECK_HEADER), JSON.stringify(script));

      const posted = await routed.send({
        url: `${SELF}/api/checks`,
        method: "POST",
        from: `${SELF}/`,
        headers: { "content-type": "application/json", cookie: "__session=abc" },
      });
      check("routing: the announced request keeps the headers it already had",
        posted["content-type"] === "application/json" && posted.cookie === "__session=abc" && posted["user-agent"] === "Mozilla/5.0 Chrome",
        JSON.stringify(posted));
    }

    // A customer's app: no interception, anywhere, ever.
    {
      const routed = routedContext();
      await announceSelfCheckOn(routed.context, CUSTOMER);
      check("routing: a run of a customer's app installs no routing at all", !routed.installed());
      check("routing: nothing on a customer's host is intercepted", !routed.intercepted(`${CUSTOMER}/api/orders`));
    }

    // An env-listed staging host is ours on the same terms.
    {
      const staging = "https://staging.example.com";
      check("decision: an env-listed staging host is announced",
        selfCheckRequestHeaders(staging, { url: `${staging}/api/checks`, method: "POST", initiatorUrl: `${staging}/` }, "staging.example.com")?.[SELF_CHECK_HEADER] === "1");
      check("decision: a customer target with the env list set still carries nothing",
        selfCheckRequestHeaders(CUSTOMER, { url: `${CUSTOMER}/api/orders`, method: "POST", initiatorUrl: `${CUSTOMER}/cart` }, "staging.example.com") === undefined);
      const routed = routedContext();
      await announceSelfCheckOn(routed.context, staging, "staging.example.com");
      const sent = await routed.send({ url: `${staging}/api/checks`, method: "POST", from: `${staging}/` });
      check("routing: an env-listed staging host is announced through the real handler", sent[SELF_CHECK_HEADER] === "1");
      check("routing: a subdomain of the staging host is not intercepted", !routed.intercepted("https://clerk.staging.example.com/x.js"));
    }

    // Installing the route is the one part of this that has never run under
    // workerd. If it throws, the cost must be exactly the lost announcement:
    // the run walks on, and the click gate in tools.ts still refuses every
    // create/mark control. A run that fails outright would be a worse trade
    // than the false finding we are fixing.
    {
      const boom = new Error("route interception unavailable");
      const context: SelfCheckRoutable = {
        route: async () => {
          throw boom;
        },
      };
      const warnings: string[] = [];
      const realWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(" "));
      };
      let threw: unknown = null;
      try {
        await announceSelfCheckOn(context, SELF);
      } catch (err) {
        threw = err;
      } finally {
        console.warn = realWarn;
      }
      check("routing: a context that cannot install the route does not fail the run", threw === null, String(threw));
      check("routing: the failure says so in the log, naming the target and the reason",
        warnings.length === 1 && warnings[0].includes("[self-check]") && warnings[0].includes(SELF) && warnings[0].includes(boom.message),
        warnings.join(" | "));

      // …and the context is still usable afterwards: a page still loads, it
      // simply carries no announcement.
      const routed = routedContext();
      await announceSelfCheckOn(routed.context, SELF);
      const stillWorks = await routed.send({ url: `${SELF}/sign-in`, from: `${SELF}/` });
      check("routing: a later context installs the route as usual",
        routed.installed() && stillWorks[SELF_CHECK_HEADER] === undefined, JSON.stringify(stillWorks));
    }

    // The shape of the mistake, not just its instance: extraHTTPHeaders sets a
    // header on EVERY request a context makes, which is what preflighted
    // Clerk's bundle. No file in the agent may reach for it again.
    {
      const dir = path.resolve(__dirname, "../src/agent");
      const code = (file: string) =>
        readFileSync(path.join(dir, file), "utf8")
          .split("\n")
          .filter((l) => {
            const t = l.trim();
            return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
          })
          .join("\n");
      const offenders = readdirSync(dir)
        .filter((f) => f.endsWith(".ts"))
        .filter((f) => code(f).includes("extraHTTPHeaders"));
      check("source: no context-wide extraHTTPHeaders anywhere in src/agent", offenders.length === 0, offenders.join(", "));
    }
  }

  // 3 — the click gate: our own create/mark controls, on our own host only.
  {
    const guarded = ["Re-check now", "Recheck", "Full re-check", "Check now", "Run check", "Looks right ✓", "Something's off", "Mark as fixed", "File ticket", "Export"];
    for (const label of guarded) {
      check(`verbs: "${label}" is guarded`, SELF_HOST_GUARDED_VERBS.test(label));
    }
    for (const label of ["Sign in", "Open verdict", "Pricing", "Dashboard", "Search"]) {
      check(`verbs: "${label}" is not guarded`, !SELF_HOST_GUARDED_VERBS.test(label));
    }
    for (const label of ["Re-check now", "Looks right ✓", "Full re-check"]) {
      const env = stubEnv(SELF, { writeAllowed: true });
      const out = await executeTool(env, "click", { role: "button", name: label });
      check(`gate: "${label}" on a self host is refused, even with writes allowed`,
        out.startsWith("Refused:") && out.includes('"not_applicable"') && out.includes("real data of this product's users"),
        out.slice(0, 80));
      check(`gate: the refused "${label}" made no request`, env.networkLog.length === 0);
      check(`gate: the refused "${label}" is not on the action trail`, env.actionTrail!.length === 0);
    }
    const bySelector = await executeTool(stubEnv(SELF), "click", { selector: "button.recheck-now" });
    check("gate: a selector naming the control is refused too", bySelector.startsWith("Refused:"), bySelector.slice(0, 60));
    const staging = await executeTool(stubEnv("https://staging.example.com", { extra: "staging.example.com" }), "click", { role: "button", name: "Re-check now" });
    check("gate: an env-listed staging host is guarded like production", staging.startsWith("Refused:"), staging.slice(0, 60));
    for (const label of ["Re-check now", "Looks right ✓", "Full re-check", "Export"]) {
      const env = stubEnv(CUSTOMER);
      const out = await executeTool(env, "click", { role: "button", name: label });
      check(`gate: "${label}" on a customer host is clicked as before`,
        out.startsWith("Clicked (strategy: trusted click)") && env.networkLog.length === 1,
        out.slice(0, 60));
    }
    const plain = await executeTool(stubEnv(SELF), "click", { role: "link", name: "Pricing" });
    check("gate: an ordinary link on a self host is clicked as before", plain.startsWith("Clicked (strategy: trusted click)"), plain.slice(0, 60));

    // The ticket's own list of controls the self-check must never press, each
    // refused on a self host with writes allowed (the widest mode) — and the
    // refusal names which rule fired, so a label that only CREATE_VERBS would
    // catch (read-only runs only) is proven to be caught unconditionally.
    const ticketLabels: [string, string][] = [
      ["Run this one now for $1", "real data of this product's users"],
      ["Enable Daily Watch", "change the state of something that already exists"],
      ["Full re-check", "real data of this product's users"],
      ["That's fine", "real data of this product's users"],
      ["Mark as fixed", "real data of this product's users"],
      ["Dispute", "real data of this product's users"],
      ["Create Ticket", "real data of this product's users"],
      ["Re-check now", "real data of this product's users"],
      ["Looks right ✓", "real data of this product's users"],
      ["Something's off", "real data of this product's users"],
    ];
    for (const [label, rule] of ticketLabels) {
      const env = stubEnv(SELF, { writeAllowed: true });
      const out = await executeTool(env, "click", { role: "button", name: label });
      check(`ticket list: "${label}" is refused on a self host, writes allowed`,
        out.startsWith("Refused:") && out.includes(rule) && out.includes('"not_applicable"') && env.networkLog.length === 0,
        out.slice(0, 70));
    }
    for (const label of ["Run this one now for $1", "That's fine", "Dispute", "Create Ticket"]) {
      const env = stubEnv(CUSTOMER, { writeAllowed: true });
      const out = await executeTool(env, "click", { role: "button", name: label });
      check(`ticket list: "${label}" on a customer host with writes allowed is clicked as before`,
        out.startsWith("Clicked (strategy: trusted click)"), out.slice(0, 60));
    }
  }

  // 4 — the 403 after a click, and the step that cannot be written off it.
  {
    const refusalCases: [string, string[], boolean][] = [
      ["PATCH lens on our host", [`PATCH ${SELF}/api/runs/143/lens → 403`], true],
      ["POST run on our host", [`POST ${SELF}/api/apps/9/runs → 403`], true],
      ["DELETE on a subdomain of ours", ["DELETE https://www.checkmyapp.dev/api/apps/9 → 403"], true],
      ["GET 403 on our host is access control, not the guard", [`GET ${SELF}/verdict/private → 403`], false],
      ["POST 200 on our host", [`POST ${SELF}/api/apps/9/runs → 200`], false],
      ["POST 403 on a customer host", [`POST ${CUSTOMER}/api/x → 403`], false],
      ["POST 403 on a look-alike", ["POST https://evil-checkmyapp.dev/api/x → 403"], false],
    ];
    for (const [name, log, expect] of refusalCases) {
      check(`refusal: ${name}`, Boolean(selfCheckRefusalIn(log)) === expect, selfCheckRefusalIn(log) ?? "none");
    }

    // The click that made run #147: a control the gate does not know by name,
    // answered 403 by the web half.
    const env = stubEnv(SELF, { onClick: [`POST ${SELF}/api/apps/9/runs → 403`] });
    const out = await executeTool(env, "click", { role: "button", name: "Go" });
    check("click: a self-host mutating 403 says the action is not available to this account",
      out.includes("not available to this account") && out.includes('"not_applicable"') && out.includes("not a defect"),
      out.slice(0, 90));
    check("click: the click itself is still on the action trail (CHE-129)", env.actionTrail!.length === 1);
    const reported: ReportedStep[] = [];
    env.onReportStep = async (s) => {
      reported.push(s);
    };
    await executeTool(env, "report_step", step("broken", "Pressing Go returned 403 Forbidden and no run started."));
    check("report_step: broken off the self-host 403 is written skipped / not_applicable",
      reported[0].status === "skipped" && reported[0].unverifiedReason === "not_applicable",
      `${reported[0].status}/${reported[0].unverifiedReason}`);
    // CHE-334: replaced, not appended — the model's sentence is the misreading.
    check("report_step: the step says it stopped on purpose, in product language",
      reported[0].observed === SELF_CHECK_REFUSED_OBSERVED && !hasEnvironmentLeak(reported[0].observed),
      reported[0].observed);

    // CHE-334: that refusal is now written onto the step above; the same log
    // line cannot erase the next step too.
    await executeTool(env, "report_step", step("confusing", "The button seemed to do nothing visible."));
    check("report_step: a refusal already written onto a step does not coerce the next one",
      reported[1].status === "confusing", `${reported[1].status}/${reported[1].unverifiedReason}`);

    // The step text does not say 403 but the log does, and no tool noted it
    // (a request the page made on its own): still coerced.
    const unnoted = stubEnv(SELF);
    unnoted.networkLog.push(`POST ${SELF}/api/apps/9/runs → 403`);
    const reportedUnnoted: ReportedStep[] = [];
    unnoted.onReportStep = async (s) => {
      reportedUnnoted.push(s);
    };
    await executeTool(unnoted, "report_step", step("confusing", "The button seemed to do nothing visible."));
    check("report_step: confusing with the refusal only in the log is coerced",
      reportedUnnoted[0].status === "skipped" && reportedUnnoted[0].unverifiedReason === "not_applicable",
      `${reportedUnnoted[0].status}/${reportedUnnoted[0].unverifiedReason}`);

    // A self-host 403 on our Clerk sign-in keeps its CHE-100 meaning.
    const clerk = stubEnv(SELF, { onClick: ["POST https://clerk.checkmyapp.dev/v1/client/sign_ins → 403"] });
    const signIn = await executeTool(clerk, "click", { role: "button", name: "Continue" });
    check("click: a sign-in 403 on our own Clerk is still a credential rejection (CHE-100)",
      signIn.includes("REJECTED") && signIn.includes('"missing_access"') && clerk.credentials!.rejected,
      signIn.slice(0, 60));

    // Pure coercion: what stays as written.
    const own = stubEnv(SELF);
    const server = step("broken", "Pressing Go answered 403, and the page then showed a 500 from /api/runs.");
    coerceSelfCheck403(server, own);
    check("coerce: a server error in the same step is never gated", server.status === "broken");
    const crash = step("broken", "The page threw an uncaught exception in the console when the modal opened.");
    own.networkLog.push(`PATCH ${SELF}/api/runs/143/lens → 403`);
    coerceSelfCheck403(crash, own);
    check("coerce: a step with its own hard evidence is not erased by an older refusal in the log",
      crash.status === "broken");
    const ok = step("ok", "The control answered 403 as it should for this account.");
    coerceSelfCheck403(ok, own);
    check("coerce: only broken/confusing are rewritten", ok.status === "ok");
    const nothing = step("broken", "The verdict page shows the wrong app name.");
    coerceSelfCheck403(nothing, stubEnv(SELF));
    check("coerce: no 403 anywhere → nothing to decide, step untouched", nothing.status === "broken");

    // The other shape of the web half's answer: a server action (form POST)
    // redirecting back with ?self_check=read_only.
    const redirectCases: [string, string | undefined, boolean][] = [
      [`${SELF}/apps/9?self_check=read_only`, undefined, true],
      [`${SELF}/apps/9?tab=runs&self_check=read_only`, undefined, true],
      ["https://www.checkmyapp.dev/?self_check=read_only", undefined, true],
      ["https://staging.example.com/x?self_check=read_only", "staging.example.com", true],
      [`${SELF}/apps/9?self_check=other`, undefined, false],
      [`${SELF}/apps/9`, undefined, false],
      [`${CUSTOMER}/apps/9?self_check=read_only`, undefined, false],
      ["https://evil-checkmyapp.dev/?self_check=read_only", undefined, false],
      ["not a url", undefined, false],
    ];
    for (const [url, extra, expect] of redirectCases) {
      check(`redirect: ${url} → ${expect}`, isSelfCheckRedirect(url, extra) === expect);
    }
    const formPost = stubEnv(SELF, {
      onClick: [`POST ${SELF}/apps/9 → 303`, `GET ${SELF}/apps/9?self_check=read_only → 200`],
      landsOn: `${SELF}/apps/9?self_check=read_only`,
    });
    const posted = await executeTool(formPost, "click", { role: "button", name: "Go" });
    check("click: a self-host server action redirecting back as read-only says the action is unavailable",
      posted.includes("not available to this account") && posted.includes("redirected back as read-only") && posted.includes('"not_applicable"'),
      posted.slice(0, 90));
    const reportedRedirect: ReportedStep[] = [];
    formPost.onReportStep = async (s) => {
      reportedRedirect.push(s);
    };
    await executeTool(formPost, "report_step", step("broken", "Pressing Go reloaded the page and nothing was saved."));
    check("report_step: broken off the redirect, known only from the action trail, is skipped / not_applicable",
      reportedRedirect[0].status === "skipped" && reportedRedirect[0].unverifiedReason === "not_applicable",
      `${reportedRedirect[0].status}/${reportedRedirect[0].unverifiedReason}`);
    const navRedirect = stubEnv(SELF, { landsOn: `${SELF}/apps/9?self_check=read_only` });
    const navigated = await executeTool(navRedirect, "navigate", { url: `${SELF}/apps/9` });
    check("navigate: landing on the read-only redirect on a self host says the action is unavailable",
      navigated.startsWith(`Navigated to ${SELF}/apps/9?self_check=read_only, and the product refused`) && navigated.includes('"not_applicable"'),
      navigated.slice(0, 90));
    const citedOnly = step("confusing", `The form sent the user back to /apps/9?self_check=read_only with no message.`);
    coerceSelfCheck403(citedOnly, stubEnv(SELF));
    check("coerce: the redirect cited only in the step text is enough on a self host", citedOnly.status === "skipped");
    const theirRedirect = stubEnv(CUSTOMER, { landsOn: `${CUSTOMER}/apps/9?self_check=read_only` });
    const theirNav = await executeTool(theirRedirect, "navigate", { url: `${CUSTOMER}/apps/9` });
    check("navigate: the same parameter on a customer host means nothing",
      theirNav === `Navigated to ${CUSTOMER}/apps/9?self_check=read_only (status 200)`, theirNav);
    const theirCited = step("broken", `The form sent the user back to /apps/9?self_check=read_only with no message.`);
    coerceSelfCheck403(theirCited, theirRedirect);
    check("coerce: the parameter cited on a customer host stays broken", theirCited.status === "broken");

    // A customer's 403 is untouched by this rule.
    const theirs = stubEnv(CUSTOMER, { onClick: [`POST ${CUSTOMER}/api/orders → 403`] });
    const theirClick = await executeTool(theirs, "click", { role: "button", name: "Go" });
    check("click: a customer-host 403 is reported as before", theirClick.startsWith("Clicked (strategy: trusted click)"), theirClick.slice(0, 60));
    const theirStep = step("broken", "Pressing Go returned 403 Forbidden for a signed-in user.");
    coerceSelfCheck403(theirStep, theirs);
    check("coerce: a customer-host 403 stays broken", theirStep.status === "broken");
    const reportedTheirs: ReportedStep[] = [];
    theirs.onReportStep = async (s) => {
      reportedTheirs.push(s);
    };
    await executeTool(theirs, "report_step", step("broken", "Pressing Go returned 403 Forbidden for a signed-in user."));
    check("report_step: a customer-host 403 is written as the model said",
      reportedTheirs[0].status === "broken" && reportedTheirs[0].unverifiedReason === undefined,
      `${reportedTheirs[0].status}`);
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
