// CHE-389 (Worker half): a run works inside the browser a person signed in to
// — through the session host's server, in tabs of its own, leaving the
// person's tab and the person's context alone.
//
// Real on every side that can be: the real session server
// (spikes/shopify-session/session-server.mjs), a real Chrome with a persistent
// profile holding a person's signed-in tab, and the Worker's own SessionBrowser
// and browser.ts helpers. The one thing replaced is the transport: in the
// Worker `connect` is @cloudflare/playwright's (it needs the Workers runtime);
// here it is upstream Playwright's connectOverCDP, handed the very request
// SessionBrowser builds — address and headers — so what is proven is what the
// Worker would send. The Worker's own transport is proven live, not here.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-session-browser.ts
//        SESSION_BROWSER_CHANNEL=chrome … to run it on the system Chrome, as CI does

import http from "node:http";
import net from "node:net";
import Module from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import type { Browser } from "@cloudflare/playwright";
import type { AgentEnv } from "@/agent/env";
import type { Page } from "@cloudflare/playwright";
import type { ToolEnv } from "@/agent/tools";
import { SELF_CHECK_REFUSED_OBSERVED } from "@/lib/verdict-language";
import {
  askForSession,
  inSignedInSession,
  isSessionTarget,
  isSignOutAddress,
  isSignOutText,
  releaseSession,
  SESSION_WAIT_MAX_SECONDS,
  SESSION_WAIT_MIN_SECONDS,
  SessionBrowser,
  sessionBrowserFor,
  SessionBusyError,
  sessionHost,
  sessionWaitSeconds,
  waitForSession,
  type SessionConnect,
  type SessionFetch,
  type SessionHost,
  type SessionSteps,
} from "@/agent/session-browser";

// src/agent/browser.ts reaches @cloudflare/playwright, which requires the
// `cloudflare:workers` builtin at load time (verify-closed-door does the same).
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

const TOKEN = "t".repeat(40);
const COOKIE = "s3ss10n-c00k1e-v4lue";
const RUN_A = "run-aaaaaaaa";
const RUN_B = "run-bbbbbbbb";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function launchProfile(profile: string, debugPort: number): Promise<BrowserContext> {
  // CI has no Playwright build and runs the system Chrome (verify-frame-tools).
  const options = { args: [`--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1"] };
  const channel = process.env.SESSION_BROWSER_CHANNEL;
  if (channel) return chromium.launchPersistentContext(profile, { ...options, channel });
  try {
    return await chromium.launchPersistentContext(profile, options);
  } catch (bundled) {
    try {
      return await chromium.launchPersistentContext(profile, { ...options, channel: "chrome" });
    } catch (system) {
      throw new Error(
        `no Chromium to run the session fixture: Playwright's build (${(bundled as Error).message.split("\n")[0]}) ` +
          `and the system Chrome (${(system as Error).message.split("\n")[0]}) both failed`,
      );
    }
  }
}

async function main() {
  // ── the configuration: all four values or the kind cannot run ──
  const full = { SESSION_HOST_URL: " https://session-api.example.test/ ", SESSION_ACCESS_CLIENT_ID: "id.access", SESSION_ACCESS_CLIENT_SECRET: "secret", SESSION_SERVER_TOKEN: "token" };
  const parsed = sessionHost(full);
  check("configuration: read, trimmed, no trailing slash", parsed.url === "https://session-api.example.test" && parsed.accessClientId === "id.access" && parsed.token === "token");
  for (const missing of Object.keys(full) as (keyof typeof full)[]) {
    let threw = "";
    try {
      sessionHost({ ...full, [missing]: "" });
    } catch (error) {
      threw = (error as Error).message;
    }
    check(`configuration: without ${missing} the kind cannot run — an internal error, nothing a customer reads`, threw.startsWith("internal:"), threw);
  }
  {
    let threw = "";
    try {
      sessionHost({ ...full, SESSION_HOST_URL: "http://session-api.example.test" });
    } catch (error) {
      threw = (error as Error).message;
    }
    check("configuration: the host is reached over https or not at all", threw.startsWith("internal:"), threw);
  }
  check("kind: only \"session\" is a session target", isSessionTarget({ targetKind: "session" }) && !isSessionTarget({ targetKind: "website" }) && !isSessionTarget({ targetKind: "extension" }) && !isSessionTarget({}));

  // ── the product, the person's browser, the host's server ──
  // The product's sign-in lives on a host of its own, as Shopify's does: where
  // the app's address leads once a sign-in has ended.
  const signIn = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    // A sign-in that is still good: the identity host renews it and sends the
    // visitor straight back — a moment away from the app, not a sign-in ended.
    if ((req.url ?? "").startsWith("/sso")) {
      res.end('<!doctype html><title>Signing you in…</title><script>setTimeout(() => { location.href = new URLSearchParams(location.search).get("return_to"); }, 700);</script>');
      return;
    }
    res.end('<!doctype html><title>Log in</title><form><input type="email" name="email"><button>Continue</button></form>');
  });
  await new Promise<void>((resolve) => signIn.listen(0, "127.0.0.1", resolve));
  const SIGN_IN = `http://127.0.0.1:${(signIn.address() as net.AddressInfo).port}`;

  // Every request that would end the sign-in, however it was made.
  const signOuts: string[] = [];
  const writes: string[] = [];
  const site = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://site");
    // An app whose sign-in has ended: the server sends the visitor away, or
    // the page does it from a script a moment after it loads.
    if (url.pathname === "/expired") {
      res.writeHead(302, { Location: `${SIGN_IN}/login?return_to=expired` }).end();
      return;
    }
    if (url.pathname === "/renewed") {
      res.writeHead(302, { Location: `${SIGN_IN}/sso?return_to=${encodeURIComponent(`http://${req.headers.host}/admin`)}` }).end();
      return;
    }
    if (url.pathname === "/expired-late") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><title>Loading</title><p>Loading…</p><script>setTimeout(() => { location.href = "${SIGN_IN}/login?return_to=late"; }, 300);</script>`);
      return;
    }
    if (["/logout", "/auth/sign_out", "/session/logout", "/account/switch"].includes(url.pathname)) {
      signOuts.push(`${req.method} ${url.pathname}`);
      res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "session=; Path=/; Max-Age=0" });
      res.end("<!doctype html><title>Signed out</title><h1>Signed out</h1>");
    } else if (url.pathname === "/admin/menu") {
      // The ways a product offers to end a sign-in: by its words, by a name
      // only a screen reader hears, by where a link leads, by the form a
      // button sends — and one control that does none of it.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Menu</title><nav>
        <a href="/logout">Log out</a>
        <button id="icon" aria-label="Sign out" onclick="location.href='/logout'">⎋</button>
        <a id="leave" href="/auth/sign_out">Leave</a>
        <form action="/session/logout" method="post"><button id="bye">Goodbye</button></form>
        <a href="/account/switch"><span id="inner">Switch account</span></a>
        <a id="docs" href="/admin?logout-guide">How signing out works</a>
        <a href="/admin?next">Next</a>
      </nav>`);
    } else if (url.pathname.startsWith("/admin/write/")) {
      // CHE-406: every request that would change something in the person's account.
      writes.push(`${req.method} ${url.pathname}`);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>Written</title><h1>Written</h1>");
    } else if (url.pathname === "/admin/app") {
      // CHE-406: an app's settings inside the person's admin — the ways a page
      // offers to save, remove, commit and switch, and the things on the same
      // page that only read: a link that leads to a page, a tab, a field, a
      // "View" button, a card with a paragraph inside it.
      const write = (what: string) => `fetch('/admin/write/${what}', { method: 'POST' })`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>App settings</title>
        <nav><a id="nav-block" href="/admin?block-countries">Block countries</a></nav>
        <div role="tablist"><button id="tab" role="tab" onclick="document.title = 'Order protection'">Order protection</button></div>
        <form action="/admin/write/save" method="post">
          <input id="note" placeholder="Add a note…">
          <button id="b0">Save</button>
        </form>
        <button id="b1" onclick="${write("delete")}"><span id="b1t">Delete rule</span></button>
        <button id="b2" aria-label="Remove country" onclick="${write("remove")}">×</button>
        <button id="b3" onclick="${write("block")}">Block country</button>
        <button id="b4" onclick="${write("update")}">Update settings</button>
        <button id="b5" role="switch" aria-checked="false" onclick="${write("switch")}">VPN traffic</button>
        <button id="b6" onclick="${write("plan")}">Start free trial</button>
        <button id="b7" onclick="${write("pause")}">Pause protection</button>
        <a id="b8" href="#" onclick="${write("add")}">Add rule</a>
        <button id="b9" aria-labelledby="l9" style="width:24px;height:24px" onclick="${write("labelled")}"></button><span id="l9" style="position:absolute;left:-999px">Delete rule</span>
        <button id="b10" onclick="${write("alt")}"><img alt="Remove" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="16" height="16"></button>
        <button id="b11" style="width:24px;height:24px" onclick="${write("unnamed")}"></button>
        <button id="b12" onclick="${write("both")}">Save and continue</button>
        <a id="b13" href="/admin/write/cancel">Details</a>
        <a id="b14" href="/admin?products-new">Add product</a>
        <label id="b15l"><input id="b15" type="checkbox" onchange="${write("checkbox")}"> <span id="b15t">Email alerts</span></label>
        <div id="b16" role="checkbox" aria-checked="false" tabindex="0" onclick="${write("rolecheckbox")}">Weekly digest</div>
        <label><input id="b17" type="radio" name="mode" onchange="${write("radio")}"> Strict mode</label>
        <button id="view" onclick="document.title = 'Details'">View details</button>
        <button id="faq1" aria-expanded="false" onclick="document.title = 'FAQ'">Can I cancel my subscription?<span aria-hidden="true"> +</span></button>
        <button id="faq2" aria-expanded="false" onclick="document.title = 'FAQ2'">How do I get a refund?</button>
        <button id="b18" onclick="${write("delete-account")}">Delete account?</button>
        <section id="card" onclick="document.title = 'Card'"><p>Rules you save here apply to every visitor. You can add, update or delete a rule at any time, and block or unblock a country from the list below this card.</p></section>`);
    } else if (url.pathname === "/signin") {
      res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": `session=${COOKIE}; Path=/; HttpOnly` });
      res.end("<!doctype html><title>Signed in</title><h1>Signed in</h1>");
    } else if (url.pathname === "/admin") {
      const signedIn = (req.headers.cookie ?? "").includes(`session=${COOKIE}`);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><title>Admin</title><h1 id="who">${signedIn ? "signed in" : "signed out"}</h1><a href="/admin?next">Next</a>`);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const SITE = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;

  const profile = await mkdtemp(join(tmpdir(), "cma-session-browser-"));
  const debugPort = await freePort();
  const person = await launchProfile(profile, debugPort);
  const personTab = person.pages()[0] ?? (await person.newPage());
  await personTab.goto(`${SITE}/signin`);

  // The host's server, as deployed: plain JavaScript (it runs on the VM with
  // nothing but node and ws), an ES module with a top-level await — hence the
  // dynamic import.
  // @ts-expect-error — no type declarations for the host's .mjs
  const { startSessionServer } = await import("../spikes/shopify-session/session-server.mjs");
  const server = await startSessionServer({ token: TOKEN, cdp: `http://127.0.0.1:${debugPort}`, port: 0, probeLog: join(profile, "no-probe.jsonl"), onGate: () => {} });
  const host: SessionHost = { url: `http://127.0.0.1:${server.port}`, accessClientId: "client-id.access", accessClientSecret: "client-secret", token: TOKEN };

  // What SessionBrowser asked for when it connected: the Worker's client calls
  // endpoint.fetch with an Upgrade request to a placeholder host. Recorded
  // here, then handed to Playwright as the address and headers to connect with.
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: SessionFetch = async (input, init) => {
    if (new URL(input).pathname.startsWith("/v1/devtools/")) {
      asked.push({ url: input, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(null, { status: 200 });
    }
    return fetch(input, init);
  };
  const connect: SessionConnect = async (endpoint, options) => {
    // The same call @cloudflare/playwright's connect() makes.
    await endpoint.fetch(`http://fake.host/v1/devtools/browser/${options.sessionId}?persistent=true`, { headers: { Upgrade: "websocket", "cf-brapi-client": "verify" } });
    const last = asked[asked.length - 1];
    const browser = await chromium.connectOverCDP(last.url.replace(/^http/, "ws"), { headers: last.headers });
    return browser as unknown as Browser;
  };

  const tabs = async () =>
    ((await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { type: string; url: string }[]).filter((t) => t.type === "page").map((t) => t.url).sort();
  const state = async () => (await (await fetch(`${host.url}/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()) as { lease: { ownerRunId: string; sessionId: string } | null; connected: boolean };
  const until = async (predicate: () => Promise<boolean>, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  const onlyThePersonsTab = async () => {
    const open = await tabs();
    return open.length === 1 && open[0] === `${SITE}/signin`;
  };

  try {
    // ── a phase of a run ──
    const session = await SessionBrowser.open(host, RUN_A, connect, fetchImpl);
    const lease = (await state()).lease;
    check("open: the run holds the host's lease under its own id", lease?.ownerRunId === RUN_A, JSON.stringify(lease));
    const request = asked[asked.length - 1];
    check("open: the DevTools request goes to the session host, at the lease's address",
      request.url === `${host.url}/v1/devtools/browser/${lease?.sessionId}?persistent=true`, request.url);
    check("open: it carries the Access service token and the server's bearer — and the client's own headers",
      request.headers["cf-access-client-id"] === "client-id.access" &&
        request.headers["cf-access-client-secret"] === "client-secret" &&
        request.headers.authorization === `Bearer ${TOKEN}` &&
        request.headers.upgrade === "websocket",
      JSON.stringify(Object.keys(request.headers)));
    check("the registry knows the browser", sessionBrowserFor(session.browser) === session);
    check("the person's tab is not among the run's pages", session.context().pages().length === 0, String(session.context().pages().length));

    const page = await session.newPage();
    await page.goto(`${SITE}/admin`);
    check("a run's tab is inside the person's session", (await page.locator("#who").innerText()) === "signed in");
    const viewport = page.viewportSize();
    check("a run's tab has our viewport; the context has no options of ours", viewport?.width === 1366 && viewport?.height === 900, JSON.stringify(viewport));
    const second = await session.newPage();
    await second.goto(`${SITE}/admin?second`);
    check("two tabs of the run's, beside the person's", (await tabs()).length === 3, JSON.stringify(await tabs()));

    await session.closePages();
    check("closePages: the run's tabs are gone, the person's stays", await until(onlyThePersonsTab), JSON.stringify(await tabs()));
    check("closePages: the context is still there for the next phase's page", (await (await session.newPage()).goto(`${SITE}/admin`))?.status() === 200);

    await session.close();
    check("close: no tab of the run's is left", await until(onlyThePersonsTab), JSON.stringify(await tabs()));
    check("close: the person's tab is where it was, and signed in", personTab.url() === `${SITE}/signin` && (await person.cookies(SITE)).some((c) => c.name === "session" && c.value === COOKIE));
    check("close: the lease is kept for the run's next phase", (await state()).lease?.ownerRunId === RUN_A);

    // ── the next phase of the same run; another run meanwhile ──
    const again = await SessionBrowser.open(host, RUN_A, connect, fetchImpl);
    check("the same run opens again under the same lease", (await state()).lease?.sessionId === lease?.sessionId);
    let busy: unknown = null;
    try {
      await SessionBrowser.open(host, RUN_B, connect, fetchImpl);
    } catch (error) {
      busy = error;
    }
    check("another run while the host is held: SessionBusyError, with when it frees — not a verdict",
      busy instanceof SessionBusyError && typeof busy.heldUntil === "string" && busy.message.startsWith("internal:"),
      String(busy));

    // ── the helpers every phase goes through (src/agent/browser.ts) ──
    const { newAgentContext, newAgentPage, closeAgentContext, closeAgentBrowser, surfaceScan } = await import("@/agent/browser");
    const context = await newAgentContext(again.browser, `${SITE}/admin`, {});
    check("newAgentContext: the person's own context, not a new one", context === again.context());
    const walked = await newAgentPage(again.browser, context);
    await walked.goto(`${SITE}/admin`);
    check("newAgentPage: a tab of the run's own, signed in", (await walked.locator("#who").innerText()) === "signed in" && walked !== (personTab as unknown));
    await closeAgentContext(again.browser, context);
    check("closeAgentContext: the run's tab closed, the context left open", await until(onlyThePersonsTab) && again.context() === context);
    const scan = await surfaceScan({ db: {}, bindings: {} } as unknown as AgentEnv, again.browser, { targetUrl: `${SITE}/admin`, id: RUN_A, storePasswordEnc: null });
    check("surfaceScan: scans in a tab of its own inside the session, and leaves none behind",
      scan.status === 200 && scan.internalLinkCount === 1 && scan.door === null && (await until(onlyThePersonsTab)),
      JSON.stringify({ status: scan.status, links: scan.internalLinkCount, door: scan.door }));
    // The sign-in has ended (signed-out.ts): the app's address leads to the
    // product's sign-in on another host. The scan says so, in code, before a
    // model sees anything — and says nothing of the kind when it reached the app.
    const signInHost = new URL(SIGN_IN).host;
    check("surfaceScan: an app that was reached is not a sign-in that ended", scan.signedOut === null, String(scan.signedOut));
    const expired = await surfaceScan({ db: {}, bindings: {} } as unknown as AgentEnv, again.browser, { targetUrl: `${SITE}/expired`, id: RUN_A, storePasswordEnc: null });
    check("surfaceScan: the app's address answered by sending the visitor to the sign-in host → the sign-in has ended, and that is not a closed door",
      expired.signedOut === signInHost && expired.door === null && (await until(onlyThePersonsTab)), JSON.stringify({ signedOut: expired.signedOut, door: expired.door }));
    const late = await surfaceScan({ db: {}, bindings: {} } as unknown as AgentEnv, again.browser, { targetUrl: `${SITE}/expired-late`, id: RUN_A, storePasswordEnc: null });
    check("surfaceScan: the same when the page sends the visitor away from a script, after it loaded",
      late.signedOut === signInHost && (await until(onlyThePersonsTab)), String(late.signedOut));
    // A sign-in that works may leave the app for a moment — a bounce through
    // the identity host that comes straight back. Where it ends is what counts.
    const renewed = await surfaceScan({ db: {}, bindings: {} } as unknown as AgentEnv, again.browser, { targetUrl: `${SITE}/renewed`, id: RUN_A, storePasswordEnc: null });
    check("surfaceScan: a bounce through the sign-in host that comes straight back is not a sign-in that ended — the app was reached",
      renewed.signedOut === null && renewed.internalLinkCount === 1 && (await until(onlyThePersonsTab)), JSON.stringify({ signedOut: renewed.signedOut, links: renewed.internalLinkCount }));
    // Outside a session nothing of this applies: an ordinary check that is
    // redirected to another host is read the way it always was.
    {
      const own = await chromium.launch(process.env.SESSION_BROWSER_CHANNEL ? { channel: process.env.SESSION_BROWSER_CHANNEL } : {}).catch(() => chromium.launch({ channel: "chrome" }));
      try {
        const ordinaryScan = await surfaceScan({ db: {}, bindings: {} } as unknown as AgentEnv, own as unknown as Browser, { targetUrl: `${SITE}/expired`, id: RUN_B, storePasswordEnc: null });
        check("surfaceScan: outside a signed-in session a redirect to another host is not 'signed out'", ordinaryScan.signedOut === null && ordinaryScan.status === 200, JSON.stringify({ signedOut: ordinaryScan.signedOut, status: ordinaryScan.status }));
        // CHE-393: where an ordinary walk stands, read from the page and from
        // the account it signed in as — the fact Step.signedIn is written from.
        const { signedInNow } = await import("@/agent/tools");
        const plain = await own.newPage();
        await plain.goto(`${SITE}/admin/menu`);
        const fromPage = await signedInNow({ page: plain, credentials: { rejected: false } } as unknown as ToolEnv);
        await plain.goto(`${SITE}/admin`);
        const noSign = await signedInNow({ page: plain, credentials: { rejected: false } } as unknown as ToolEnv);
        const asAccount = await signedInNow({ page: plain, activeAccount: "default", credentials: { rejected: false } } as unknown as ToolEnv);
        const turnedAway = await signedInNow({ page: plain, activeAccount: "default", credentials: { rejected: true } } as unknown as ToolEnv);
        check("signedInNow: a page with a sign-out control is signed in; one without, and no account filled, is not; an account filled is — unless it was turned away",
          fromPage === true && noSign === false && asAccount === true && turnedAway === false,
          JSON.stringify({ fromPage, noSign, asAccount, turnedAway }));
        await plain.close();
      } finally {
        await own.close();
      }
    }
    await closeAgentBrowser(again.browser);
    check("closeAgentBrowser: disconnected; the person's tab alone remains", !again.browser.isConnected() && (await until(onlyThePersonsTab)));

    // ── the person's sign-in is not ours to end ──
    // The real tools (src/agent/tools.ts), on a tab of the run's inside the
    // session, against a menu that offers every way out.
    const { executeTool, prepareAgentPage } = await import("@/agent/tools");
    const guarded = await SessionBrowser.open(host, RUN_A, connect, fetchImpl);
    const menuPage = await guarded.newPage();
    const toolEnv = { page: menuPage, targetOrigin: SITE, credentials: { rejected: false }, networkLog: [], consoleLog: [], actionTrail: [], undrivenControls: [] } as unknown as ToolEnv;
    await prepareAgentPage(toolEnv);
    const opened = await executeTool(toolEnv, "navigate", { url: `${SITE}/admin/menu` });
    check("the tools work in a tab inside the session", opened.startsWith("Navigated") && inSignedInSession(menuPage) && !inSignedInSession(personTab as unknown as Page), opened.slice(0, 80));
    const refusedAt = async (name: string, how: string, input: Record<string, unknown>) => {
      const result = await executeTool(toolEnv, how, input);
      check(`signing out is refused: ${name}`, result.startsWith("Refused:") && result.includes("not_applicable") && menuPage.url() === `${SITE}/admin/menu`, result.slice(0, 110));
    };
    await refusedAt("a sign-out address, typed", "navigate", { url: `${SITE}/logout` });
    await refusedAt("a sign-out address in the query", "navigate", { url: `${SITE}/admin?action=logout` });
    await refusedAt("\"Log out\" by its name", "click", { role: "link", name: "Log out" });
    await refusedAt("an icon button whose accessible name is \"Sign out\", clicked by selector", "click", { selector: "#icon" });
    await refusedAt("a link called \"Leave\" that leads to a sign-out address", "click", { selector: "#leave" });
    await refusedAt("a button called \"Goodbye\" whose form posts to a sign-out address", "click", { selector: "#bye" });
    await refusedAt("\"Switch account\", clicked on the text inside the link", "click", { selector: "#inner" });
    check("…and none of it reached the product", signOuts.length === 0, signOuts.join(", "));
    const walkedOn = await executeTool(toolEnv, "click", { role: "link", name: "Next" });
    check("an ordinary link in the same menu is still pressed", walkedOn.startsWith("Clicked") && menuPage.url() === `${SITE}/admin?next`, walkedOn.slice(0, 80));
    check("…and the run's tab is still signed in", (await menuPage.locator("#who").innerText()) === "signed in");
    // The rules themselves: words, and addresses — never a word inside a longer one.
    check("words: the ways a product says it",
      ["Log out", "Logout", "Sign out", "log-out", "Sign off", "Switch accounts", "Use another account", "Remove this account", 'a[href="/logout"]'].every(isSignOutText) &&
        !["Sign in", "Log in", "Checkout", "Blog outline", "Design options", "Next", "Lockout policy"].some(isSignOutText));
    check("addresses: a path segment or a query value",
      ["/logout", "/auth/sign_out", "/users/sign-out", "/account/logout?next=/", "/admin?action=logout", "https://x.test/session/logoff"].every((a) => isSignOutAddress(a, SITE)) &&
        !["/blog/outline", "/catalog/outdoor", "/design-office", "/admin?next", "/checkout", "/dialogout"].some((a) => isSignOutAddress(a, SITE)));

    // ── nothing in the person's account is ours to change (CHE-406) ──
    // Run #304 pressed a button its gate refuses by name, by calling it
    // `button[type=submit]`. Inside a person's session the control is read for
    // what it is, and there is no gate at all for "Delete" to slip past.
    await executeTool(toolEnv, "navigate", { url: `${SITE}/admin/app` });
    const heldAt = async (name: string, input: Record<string, unknown>) => {
      const result = await executeTool(toolEnv, "click", input);
      check(`changing the account is refused: ${name}`,
        result.startsWith("Refused:") && result.includes("not_applicable") && !/CSS selector instead/.test(result) && menuPage.url() === `${SITE}/admin/app`, result.slice(0, 110));
    };
    // Addressed by selectors that say nothing of what the controls do — as a
    // walk addresses them when it wants the gate not to hear.
    await heldAt("\"Save\", addressed as the form's button", { selector: "form button" });
    await heldAt("\"Save\" by its name — and the refusal no longer offers a selector as the way round", { role: "button", name: "Save" });
    await heldAt("\"Delete rule\", clicked on the text inside the button", { selector: "#b1t" });
    await heldAt("an icon button whose accessible name is \"Remove country\"", { selector: "#b2" });
    await heldAt("\"Block country\" by selector", { selector: "#b3" });
    await heldAt("\"Update settings\" by selector", { selector: "#b4" });
    await heldAt("a switch, whatever it is called (\"VPN traffic\")", { selector: "#b5" });
    await heldAt("\"Start free trial\" by selector", { selector: "#b6" });
    await heldAt("\"Pause protection\" by selector", { selector: "#b7" });
    await heldAt("a link that leads nowhere (href=\"#\") and is called \"Add rule\"", { selector: "#b8" });
    // Codex on #261, round 1.
    await heldAt("an icon button named only through aria-labelledby (\"Delete rule\")", { selector: "#b9" });
    await heldAt("an icon button named only by its image's alt (\"Remove\")", { selector: "#b10" });
    await heldAt("a button with no name at all", { selector: "#b11" });
    await heldAt("\"Save and continue\" — a word that only reads does not cancel the one that saves", { selector: "#b12" });
    await heldAt("a link called \"Details\" that leads to an address naming an action (/admin/write/cancel)", { selector: "#b13" });
    // Codex on #261, round 2: a checkbox saves on the spot as readily as a switch.
    await heldAt("a checkbox called \"Email alerts\"", { selector: "#b15" });
    await heldAt("…pressed through the text of its label", { selector: "#b15t" });
    await heldAt("a role=checkbox called \"Weekly digest\"", { selector: "#b16" });
    await heldAt("a radio button called \"Strict mode\"", { selector: "#b17" });
    // #277: a question mark does not free a button that acts.
    await heldAt("\"Delete account?\" by selector", { selector: "#b18" });
    await heldAt("\"Delete account?\" by its name", { role: "button", name: "Delete account?" });
    const typed = await executeTool(toolEnv, "navigate", { url: `${SITE}/admin/write/delete` });
    check("…and such an address is not opened when the walk types it either", typed.startsWith("Refused:") && typed.includes("not_applicable") && menuPage.url() === `${SITE}/admin/app`, typed.slice(0, 110));
    check("…and none of it reached the product", writes.length === 0, writes.join(", "));
    // The refusal is a request to a model. A walk that was refused "Save" and
    // then reports the button as dead must not publish that about the product.
    const reported: Record<string, unknown>[] = [];
    toolEnv.onReportStep = async (step) => {
      reported.push({ ...step });
    };
    await executeTool(toolEnv, "report_step", { label: "Save the settings", status: "broken", attempted: "Pressed Save", observed: "The Save button does nothing: the settings are never stored." });
    check("a step reported broken after such a refusal is settled in code: skipped, not applicable, not counted against the product",
      reported[0]?.status === "skipped" && reported[0]?.unverifiedReason === "not_applicable" && reported[0]?.observed === SELF_CHECK_REFUSED_OBSERVED, JSON.stringify(reported[0]));
    await executeTool(toolEnv, "report_step", { label: "Read the rules", status: "confusing", attempted: "Read the list", observed: "Two rules have the same name." });
    check("…and it is spent on that step: the next one is the walk's own", reported[1]?.status === "confusing" && reported[1]?.observed === "Two rules have the same name.", JSON.stringify(reported[1]));
    // CHE-393: inside a person's session every step is reported signed in —
    // written by the tool, whatever the model sent (here: nothing).
    check("a step reported inside the session carries signedIn = true, written by the tool", reported[0]?.signedIn === true && reported[1]?.signedIn === true, JSON.stringify([reported[0]?.signedIn, reported[1]?.signedIn]));
    // What only reads is still pressed, on the same page.
    const tab = await executeTool(toolEnv, "click", { selector: "#tab" });
    const view = await executeTool(toolEnv, "click", { role: "button", name: "View details" });
    const card = await executeTool(toolEnv, "click", { selector: "#card" });
    const note = await executeTool(toolEnv, "fill", { selector: "#note", value: "seen" });
    check("a tab called \"Order protection\", a \"View details\" button, a card whose paragraph mentions saving and deleting, and a field whose placeholder says \"Add a note…\" are pressed and typed into",
      tab.startsWith("Clicked") && view.startsWith("Clicked") && card.startsWith("Clicked") && note.startsWith("Filled"),
      [tab, view, card, note].map((r) => r.slice(0, 40)).join(" | "));
    // #277 (CHE-407's one false hold): an FAQ accordion asks, it does not do —
    // by its name, which the name gates in click read first, and by selector,
    // which the control's own words answer, glyph and all.
    const faqNamed = await executeTool(toolEnv, "click", { role: "button", name: "Can I cancel my subscription?" });
    const faqSelector = await executeTool(toolEnv, "click", { selector: "#faq1" });
    const faqRefund = await executeTool(toolEnv, "click", { role: "button", name: "How do I get a refund?" });
    check("an FAQ button \"Can I cancel my subscription? +\" is pressed by its name and by selector, and so is \"How do I get a refund?\"",
      faqNamed.startsWith("Clicked") && faqSelector.startsWith("Clicked") && faqRefund.startsWith("Clicked"),
      [faqNamed, faqSelector, faqRefund].map((r) => r.slice(0, 70)).join(" | "));
    // A link whose words say it changes something is not clicked — a click
    // runs whatever the page hung on it — and the walk is sent to its address.
    const notClicked = await executeTool(toolEnv, "click", { selector: "#nav-block" });
    check("a link called \"Block countries\" is not clicked, and the walk is told to open its address instead",
      notClicked.startsWith("Refused:") && /open that page by its address with navigate/.test(notClicked) && menuPage.url() === `${SITE}/admin/app`, notClicked.slice(0, 120));
    await executeTool(toolEnv, "report_step", { label: "Open the countries page", status: "skipped", unverifiedReason: "our_capability", attempted: "Opened the countries page", observed: "The page could not be opened." });
    check("…a refusal that leaves a way open settles no step: what the walk reports next is its own", reported[2]?.unverifiedReason === "our_capability" && reported[2]?.observed !== SELF_CHECK_REFUSED_OBSERVED, JSON.stringify(reported[2]));
    const led = await executeTool(toolEnv, "navigate", { url: `${SITE}/admin?block-countries` });
    check("…and opened by its address, the page is read", led.startsWith("Navigated") && menuPage.url() === `${SITE}/admin?block-countries`, `${led.slice(0, 60)} → ${menuPage.url()}`);
    await executeTool(toolEnv, "navigate", { url: `${SITE}/admin/app` });
    const form = await executeTool(toolEnv, "click", { selector: "#b14" });
    check("a link called \"Add product\" that leads to a page is followed — opening a form is reading",
      form.startsWith("Clicked") && menuPage.url() === `${SITE}/admin?products-new`, `${form.slice(0, 60)} → ${menuPage.url()}`);
    check("…and still nothing was written", writes.length === 0, writes.join(", "));
    await guarded.close();

    // ── the end of the run ──
    check("releaseSession: the host is given back", (await releaseSession(host, RUN_A, fetchImpl)) === true && (await state()).lease === null);
    check("releaseSession: nothing held is not an error", (await releaseSession(host, RUN_A, fetchImpl)) === false);
    const other = await SessionBrowser.open(host, RUN_B, connect, fetchImpl);
    check("…and the next run gets it", (await state()).lease?.ownerRunId === RUN_B);
    await other.close();
    await releaseSession(host, RUN_B, fetchImpl);

    // ── two runs at once: the second waits its turn, it does not fail ──
    // The loop is the Worker's own (waitForSession); the steps are ours — what
    // step.do and step.sleep are in the Workflow — against the real server.
    const stepsFor = (runId: string, onSleep: (nth: number) => Promise<void> = async () => {}) => {
      const log: string[] = [];
      const slept: number[] = [];
      const steps: SessionSteps = {
        ask: async (name) => {
          const turn = await askForSession(host, runId, fetchImpl);
          log.push(`${name}:${turn.taken ? "taken" : "held"}`);
          return turn;
        },
        waiting: async (name) => {
          log.push(name);
        },
        sleep: async (name, seconds) => {
          log.push(name);
          slept.push(seconds);
          await onSleep(slept.length);
        },
      };
      return { steps, log, slept };
    };

    const free = stepsFor(RUN_A);
    check("a free host: the run takes it at the first ask and waits for nothing",
      (await waitForSession(free.steps, "scan")) === 0 && free.log.join(" ") === "session-turn-scan-1:taken" && (await state()).lease?.ownerRunId === RUN_A,
      free.log.join(" "));

    const turn = await askForSession(host, RUN_B, fetchImpl);
    check("a held host: one ask says 'not yet' and how long to wait — it throws nothing and takes nothing",
      turn.taken === false && turn.waitSeconds >= SESSION_WAIT_MIN_SECONDS && turn.waitSeconds <= SESSION_WAIT_MAX_SECONDS && (await state()).lease?.ownerRunId === RUN_A,
      JSON.stringify(turn));

    // The holder finishes while the second run is in its second sleep.
    const queued = stepsFor(RUN_B, async (nth) => {
      if (nth === 2) await releaseSession(host, RUN_A, fetchImpl);
    });
    const waited = await waitForSession(queued.steps, "scan");
    check("a held host: the second run asks, sleeps, asks again — and starts once the first has finished",
      queued.log.join(" ") === "session-turn-scan-1:held session-waiting-scan session-wait-scan-1 session-turn-scan-2:held session-wait-scan-2 session-turn-scan-3:taken" &&
        (await state()).lease?.ownerRunId === RUN_B,
      queued.log.join(" "));
    check("…it says so once, and every step has a name of its own",
      queued.log.filter((name) => name === "session-waiting-scan").length === 1 && new Set(queued.log.map((entry) => entry.split(":")[0])).size === queued.log.length);
    // The same run before its next phase: the lease is its own, so the ask is
    // a renewal — one step, under that phase's name, no wait.
    const next = stepsFor(RUN_B);
    check("the holder before its next phase: one ask under that phase's name, no wait",
      (await waitForSession(next.steps, "walk-3")) === 0 && next.log.join(" ") === "session-turn-walk-3-1:taken", next.log.join(" "));
    check("…and what it reports having waited is what it slept",
      waited === queued.slept.reduce((sum, seconds) => sum + seconds, 0) && queued.slept.every((s) => s >= SESSION_WAIT_MIN_SECONDS && s <= SESSION_WAIT_MAX_SECONDS),
      `${waited}s in ${JSON.stringify(queued.slept)}`);

    // A holder that never lets go: the wait has an end, and the end is ours.
    const stuck = stepsFor(RUN_A);
    let gaveUp: unknown = null;
    try {
      await waitForSession(stuck.steps, "discovery", 400);
    } catch (error) {
      gaveUp = error;
    }
    const sleptStuck = stuck.slept.reduce((sum, seconds) => sum + seconds, 0);
    check("a host held past the limit: an internal error after the limit is spent, never before",
      gaveUp instanceof SessionBusyError && gaveUp.message.startsWith("internal:") && sleptStuck >= 400 && sleptStuck - stuck.slept[stuck.slept.length - 1] < 400,
      `${String(gaveUp)} after ${sleptStuck}s`);
    check("…and the holder still holds", (await state()).lease?.ownerRunId === RUN_B);
    // The run that gave up goes through its failure path, which gives the host
    // back — a host it never held. That must not take it from the holder.
    check("a run that does not hold the host cannot give it back for the one that does",
      (await releaseSession(host, RUN_A, fetchImpl)) === false && (await state()).lease?.ownerRunId === RUN_B);
    await releaseSession(host, RUN_B, fetchImpl);

    let notBusy = "";
    try {
      await waitForSession({ ...stepsFor(RUN_A).steps, ask: () => askForSession({ ...host, token: "w".repeat(40) }, RUN_A, fetchImpl) }, "scan");
    } catch (error) {
      notBusy = error instanceof SessionBusyError ? "SessionBusyError" : (error as Error).message;
    }
    check("a host that refuses is not 'busy': the wait ends at once with the refusal", notBusy.startsWith("internal:") && notBusy.includes("401"), notBusy);

    // How long between asks.
    const NOW = Date.parse("2026-10-02T06:00:00.000Z");
    const inSeconds = (s: number) => new Date(NOW + s * 1000).toISOString();
    check("the wait: until the holder's lease would lapse, a little over",
      sessionWaitSeconds(inSeconds(100), NOW) === 105, String(sessionWaitSeconds(inSeconds(100), NOW)));
    check("the wait: never longer than the cap — the holder gives the host back as soon as it finishes",
      sessionWaitSeconds(inSeconds(1500), NOW) === SESSION_WAIT_MAX_SECONDS);
    check("the wait: never a busy loop — a lapsed, missing or unreadable time still waits",
      [inSeconds(1), inSeconds(-60), null, "soon"].every((heldUntil) => sessionWaitSeconds(heldUntil, NOW) === SESSION_WAIT_MIN_SECONDS));

    // The run waits BEFORE its first phase: a wait inside a phase would be a
    // step failing and being retried — the very thing this replaces.
    const workflow = await readFile(join(process.cwd(), "src/agent/workflow.ts"), "utf8");
    const helperAt = workflow.indexOf("const sessionTurn = async");
    const helper = workflow.slice(helperAt, workflow.indexOf("// Everything below is inside the failure handler", helperAt));
    check("the workflow: a session run takes its turn in steps that sleep — and only a session run",
      helperAt > 0 && /if \(!isSession\) return;\s*await waitForSession\(/.test(helper) && /sleep: \(name, seconds\) => step\.sleep\(name, seconds \* 1000\)/.test(helper),
      helper.slice(0, 80));
    // Before every phase that opens the browser, under that phase's name: a
    // wait inside a phase would be a step failing and being retried.
    const before = (turn: string, phaseStep: string) => {
      const turnAt = workflow.indexOf(turn);
      const phaseAt = workflow.indexOf(phaseStep);
      return turnAt > 0 && phaseAt > turnAt && phaseAt - turnAt < 400;
    };
    check("the workflow: the turn is taken before the scan, before discovery and before every walk",
      before('await sessionTurn("scan"', 'step.do("surface_scan"') &&
        before('await sessionTurn("discovery"', 'step.do("discovery"') &&
        before("await sessionTurn(`walk-${order}`", "step.do(`walk-${order}`") &&
        (workflow.match(/launchAgentBrowser\(env, \{ run, phase:/g) ?? []).length === 3,
      `${(workflow.match(/launchAgentBrowser\(env, \{ run, phase:/g) ?? []).length} phases open the run's browser`);
    // What a person watching reads while the run waits: that it waits. Whose
    // turn it is on our host is not about their product (rule 1) — the feed is
    // public (the live page, get_check_status) — and nothing at all would read
    // as a check that hung.
    const said = [...workflow.matchAll(/sessionTurn\([^)]*?text: "([^"]+)"/g)].map((m) => m[1]);
    check("the workflow: the feed says the run waits, and nothing about who it waits for",
      (helper.match(/appendEvent\(/g) ?? []).length === 1 && /appendEvent\(env, runId, feed\.phase, \{ icon: "info", text: feed\.text \}\)/.test(helper) &&
        said.length === 3 && said.every((text) => text === "Waiting to start" || text === "Waiting to continue") && said[0] === "Waiting to start",
      said.join(" | "));
    // The host goes back when the last walk is done, not after the verdict.
    const walkedAt = workflow.indexOf('releaseSessionHost("release-session-walked")');
    check("the workflow: the host is given back after the last walk, before the verdict is written",
      walkedAt > workflow.indexOf("step.do(`walk-${order}`") && walkedAt < workflow.indexOf('step.do("anatomy"') && walkedAt < workflow.indexOf('"Writing your verdict"'),
      `released at ${walkedAt}`);

    // ── the host is not there ──
    let down = "";
    try {
      await SessionBrowser.open({ ...host, url: `http://127.0.0.1:${await freePort()}` }, RUN_A, connect, fetchImpl);
    } catch (error) {
      down = error instanceof SessionBusyError ? "SessionBusyError" : (error as Error).name;
    }
    check("a host that does not answer is an error of ours, not 'busy'", down !== "" && down !== "SessionBusyError", down);
    let refused = "";
    try {
      await SessionBrowser.open({ ...host, token: "w".repeat(40) }, RUN_A, connect, fetchImpl);
    } catch (error) {
      refused = (error as Error).message;
    }
    check("a refused lease is an internal error", refused.startsWith("internal:") && refused.includes("401"), refused);

    check("after all of it: the person's tab, signed in, and nothing else",
      (await onlyThePersonsTab()) && !personTab.isClosed() && (await person.cookies(SITE)).some((c) => c.name === "session" && c.value === COOKIE));

    // Last, because it ends the sign-in: the refusal belongs to a signed-in
    // session only. In an ordinary check — a browser of our own, a test account
    // — "Log out" is part of the product and is pressed like anything else.
    const ordinary = await person.newPage();
    const ordinaryEnv = { page: ordinary, targetOrigin: SITE, credentials: { rejected: false }, networkLog: [], consoleLog: [], actionTrail: [], undrivenControls: [] } as unknown as ToolEnv;
    await prepareAgentPage(ordinaryEnv);
    await executeTool(ordinaryEnv, "navigate", { url: `${SITE}/admin/menu` });
    const pressed = await executeTool(ordinaryEnv, "click", { selector: "#leave" });
    check("outside a signed-in session the same control is pressed: signing out is the product's to offer",
      pressed.startsWith("Clicked") && signOuts.join() === "GET /auth/sign_out", `${pressed.slice(0, 60)} | ${signOuts.join(", ")}`);
    // CHE-406: and so is a control addressed by selector — in an ordinary run on
    // a customer's app the gates read the name the walk gave, as they did.
    await executeTool(ordinaryEnv, "navigate", { url: `${SITE}/admin/app` });
    const ordinaryDelete = await executeTool(ordinaryEnv, "click", { selector: "#b1" });
    check("outside a signed-in session a control addressed by selector is pressed as before",
      ordinaryDelete.startsWith("Clicked") && writes.join() === "POST /admin/write/delete", `${ordinaryDelete.slice(0, 60)} | ${writes.join(", ")}`);
    await ordinary.close();
  } finally {
    const within = (work: () => Promise<unknown>) => Promise.race([work().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await within(() => server.close());
    await within(() => person.close());
    site.closeAllConnections();
    await within(() => new Promise((resolve) => site.close(resolve)));
    signIn.closeAllConnections();
    await within(() => new Promise((resolve) => signIn.close(resolve)));
    await within(() => rm(profile, { recursive: true, force: true }));
  }

  console.log(failures === 0 ? "\nverify-session-browser: all checks passed" : `\nverify-session-browser: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
