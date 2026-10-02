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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import type { Browser } from "@cloudflare/playwright";
import type { AgentEnv } from "@/agent/env";
import {
  isSessionTarget,
  releaseSession,
  SessionBrowser,
  sessionBrowserFor,
  SessionBusyError,
  sessionHost,
  type SessionConnect,
  type SessionFetch,
  type SessionHost,
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
  const site = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://site");
    if (url.pathname === "/signin") {
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
    await closeAgentBrowser(again.browser);
    check("closeAgentBrowser: disconnected; the person's tab alone remains", !again.browser.isConnected() && (await until(onlyThePersonsTab)));

    // ── the end of the run ──
    check("releaseSession: the host is given back", (await releaseSession(host, RUN_A, fetchImpl)) === true && (await state()).lease === null);
    check("releaseSession: nothing held is not an error", (await releaseSession(host, RUN_A, fetchImpl)) === false);
    const other = await SessionBrowser.open(host, RUN_B, connect, fetchImpl);
    check("…and the next run gets it", (await state()).lease?.ownerRunId === RUN_B);
    await other.close();
    await releaseSession(host, RUN_B, fetchImpl);

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

    check("after all of it: the person's tab, signed in, and nothing else", (await onlyThePersonsTab()) && !personTab.isClosed());
  } finally {
    const within = (work: () => Promise<unknown>) => Promise.race([work().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await within(() => server.close());
    await within(() => person.close());
    site.closeAllConnections();
    await within(() => new Promise((resolve) => site.close(resolve)));
    await within(() => rm(profile, { recursive: true, force: true }));
  }

  console.log(failures === 0 ? "\nverify-session-browser: all checks passed" : `\nverify-session-browser: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
