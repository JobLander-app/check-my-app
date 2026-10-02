// CHE-389: a check works inside the browser a person signed in to, has its own
// tabs and nothing else, and never carries the session's cookies away.
//
// Three parts:
//   1. the rules (spikes/shopify-session/lease.mjs), pure;
//   2. the server against a real Chrome with a persistent profile — the same
//      arrangement as the session host: a person's tab holding a signed-in
//      HttpOnly cookie, and a check arriving through the server, both with
//      Playwright's own connectOverCDP and as a raw DevTools client saying the
//      things Playwright never would;
//   3. the ways a check goes away without saying so (a killed connection, a
//      silent one, a lease that ran out) — each must leave the profile with the
//      person's tab and none of ours.
//
// `ws` is the copy the repo already installs for wrangler; on the host the
// server gets its own from spikes/shopify-session/package.json.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { chromium } from "playwright";
import { Gate, LeaseBook, PRIVATE_ID_BASE, REDACTED, leaseSeconds, sessionIdFromPath, LEASE_MAX_SECONDS, LEASE_MIN_SECONDS } from "../spikes/shopify-session/lease.mjs";
import { startSessionServer } from "../spikes/shopify-session/session-server.mjs";

let failures = 0;
async function check(name, fn) {
  let timer;
  try {
    // A check that waits for a close that never comes must fail, not hang CI.
    await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("did not finish in 30 s")), 30_000); })]);
    clearTimeout(timer);
    console.log(`ok   ${name}`);
  } catch (error) {
    clearTimeout(timer);
    failures++;
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n").join("\n     ")}`);
  }
}

const RUN_A = "run-aaaaaaaa";
const RUN_B = "run-bbbbbbbb";
const TOKEN = "t".repeat(40);
// The value nobody but the browser may hold.
const COOKIE = "s3ss10n-c00k1e-v4lue";

// --- 1. the rules -----------------------------------------------------------

await check("a lease is clamped to between one and thirty minutes", () => {
  assert.equal(leaseSeconds(1), LEASE_MIN_SECONDS);
  assert.equal(leaseSeconds(99_999), LEASE_MAX_SECONDS);
  assert.equal(leaseSeconds(300), 300);
  assert.equal(leaseSeconds("nonsense"), 600);
});

await check("one run holds the lease; another is refused until it is released or runs out", () => {
  let t = 1_000;
  const book = new LeaseBook(() => t, () => "sid-1");
  const first = book.take(RUN_A, 120);
  assert.equal(first.ok, true);
  const other = book.take(RUN_B, 120);
  assert.deepEqual({ ok: other.ok, status: other.status, heldUntil: other.heldUntil }, { ok: false, status: 409, heldUntil: 1_000 + 120_000 });
  assert.deepEqual(book.release(RUN_B), { ok: false, status: 409, error: "Another check holds this session" });
  t += 120_000;
  assert.equal(book.take(RUN_B, 120).ok, true, "an expired lease does not hold anyone out");
});

await check("the same run taking the lease again renews it and keeps its session id", () => {
  let t = 0;
  let n = 0;
  const book = new LeaseBook(() => t, () => `sid-${++n}`);
  const first = book.take(RUN_A, 60).lease;
  t = 50_000;
  const again = book.take(RUN_A, 60).lease;
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(again.expiresAt, 110_000);
  assert.equal(book.admits(first.sessionId), true);
  assert.equal(book.admits("sid-other"), false);
  t = 110_000;
  assert.equal(book.admits(first.sessionId), false, "admission ends with the lease");
});

await check("a run identity is required, and releasing nothing is not an error", () => {
  const book = new LeaseBook(() => 0);
  assert.equal(book.take("", 60).status, 422);
  assert.equal(book.take("short", 60).status, 422);
  assert.equal(book.take(undefined, 60).status, 422);
  assert.deepEqual(book.release(RUN_A), { ok: true, released: false });
});

// A gate with one tab of the check's, attached as session S1.
function gateWithATab() {
  const gate = new Gate();
  assert.equal(gate.outgoing({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } }), "forward");
  const attach = { method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "MINE", type: "page" }, waitingForDebugger: true } };
  assert.deepEqual(gate.incoming(attach), { client: [], browser: [] }, "nobody owns it until the create is answered");
  const answer = { id: 1, result: { targetId: "MINE" } };
  assert.deepEqual(gate.incoming(answer).client, [attach, answer], "the tab's own attach reaches the check before the answer");
  return gate;
}

await check("at the level of the browser a check may open and close its own tabs and nothing more", () => {
  const gate = gateWithATab();
  assert.equal(gate.outgoing({ id: 2, method: "Target.closeTarget", params: { targetId: "MINE" } }), "forward");
  assert.equal(gate.outgoing({ id: 3, method: "Browser.getVersion" }), "forward");
  assert.equal(gate.outgoing({ id: 4, method: "Target.setAutoAttach", params: {} }), "forward");
  assert.equal(gate.outgoing({ id: 5, method: "Browser.close" }), "disconnect");
  for (const method of [
    "Browser.crash", "Browser.crashGpuProcess", "Browser.grantPermissions", "Browser.setWindowBounds", "Storage.getCookies",
    "Storage.setCookies", "Storage.clearCookies", "Storage.clearDataForOrigin", "SystemInfo.getInfo", "Tracing.start", "IO.read",
    "Target.sendMessageToTarget", "Target.exposeDevToolsProtocol", "Target.setRemoteLocations", "Some.futureMethod",
  ]) assert.equal(gate.outgoing({ id: 9, method }), "refuse", method);
  assert.equal(gate.outgoing({ id: 9 }), "refuse", "a message with no method");
});

await check("nothing addressed to a tab that is not the check's is forwarded", () => {
  const gate = gateWithATab();
  for (const method of ["Target.closeTarget", "Target.attachToTarget", "Target.activateTarget", "Target.getTargetInfo"]) {
    assert.equal(gate.outgoing({ id: 2, method, params: { targetId: "THEIRS" } }), "refuse", method);
    assert.equal(gate.outgoing({ id: 2, method, params: { targetId: "MINE" } }), "forward", method);
  }
  assert.equal(gate.outgoing({ id: 3, method: "Target.closeTarget" }), "refuse");
  // A session the check was never given — the person's tab, whatever its id.
  for (const method of ["Page.close", "Page.navigate", "Runtime.evaluate", "Page.enable"]) {
    assert.equal(gate.outgoing({ id: 4, sessionId: "THEIR-SESSION", method }), "refuse", method);
    assert.equal(gate.outgoing({ id: 4, sessionId: "S1", method }), "forward", method);
  }
  assert.equal(gate.outgoing({ id: 5, method: "Target.detachFromTarget", params: { sessionId: "THEIR-SESSION" } }), "refuse");
  assert.equal(gate.outgoing({ id: 5, method: "Target.detachFromTarget", params: { sessionId: "S1" } }), "forward");
});

await check("a tab that is not the check's is never shown to it, and is started and let go", () => {
  const gate = new Gate();
  // The person's tab, already open when the check connects.
  assert.deepEqual(
    gate.incoming({ method: "Target.attachedToTarget", params: { sessionId: "P1", targetInfo: { targetId: "THEIRS", type: "page" }, waitingForDebugger: false } }),
    { client: [], browser: [{ id: PRIVATE_ID_BASE, method: "Target.detachFromTarget", params: { sessionId: "P1" } }] },
  );
  // A tab the hourly probe opens while the check is connected: it attached
  // standing still, because the check asked for that of its own tabs.
  assert.deepEqual(
    gate.incoming({ method: "Target.attachedToTarget", params: { sessionId: "P2", targetInfo: { targetId: "PROBE", type: "page" }, waitingForDebugger: true } }),
    {
      client: [],
      browser: [
        { id: PRIVATE_ID_BASE - 1, sessionId: "P2", method: "Runtime.runIfWaitingForDebugger" },
        { id: PRIVATE_ID_BASE - 2, method: "Target.detachFromTarget", params: { sessionId: "P2" } },
      ],
    },
  );
  // Nothing the check says on those sessions goes anywhere, and nothing they
  // say reaches the check — including the server's own answers.
  assert.equal(gate.outgoing({ id: 1, sessionId: "P1", method: "Page.close" }), "refuse");
  assert.deepEqual(gate.incoming({ sessionId: "P1", method: "Page.frameNavigated", params: {} }).client, []);
  assert.deepEqual(gate.incoming({ id: PRIVATE_ID_BASE - 2, result: {} }).client, []);
  assert.deepEqual(gate.incoming({ method: "Target.detachedFromTarget", params: { sessionId: "P2" } }).client, []);
  for (const method of ["Target.targetCreated", "Target.targetInfoChanged"]) {
    assert.deepEqual(gate.incoming({ method, params: { targetInfo: { targetId: "THEIRS", type: "page" } } }).client, []);
  }
  assert.deepEqual(gate.incoming({ method: "Target.targetDestroyed", params: { targetId: "THEIRS" } }).client, []);
  // A service worker belongs to an origin, not to a tab: not the check's.
  assert.equal(gate.incoming({ method: "Target.attachedToTarget", params: { sessionId: "W1", targetInfo: { targetId: "SW", type: "service_worker" }, waitingForDebugger: false } }).client.length, 0);
  assert.equal(gate.outgoing({ id: 2, method: PRIVATE_ID_BASE < 0 && "Browser.getVersion", sessionId: undefined }), "forward");
  assert.equal(gate.outgoing({ id: PRIVATE_ID_BASE, method: "Browser.getVersion" }), "refuse", "the server's own ids are not the check's to use");
});

await check("a tab that attaches while the check is opening one is held, then sorted: the check's forwarded, the other let go", () => {
  const gate = new Gate();
  gate.outgoing({ id: 1, method: "Target.createTarget", params: {} });
  const theirs = { method: "Target.attachedToTarget", params: { sessionId: "P1", targetInfo: { targetId: "THEIRS", type: "page" }, waitingForDebugger: true } };
  const mine = { method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "MINE", type: "page" }, waitingForDebugger: true } };
  assert.deepEqual(gate.incoming(theirs), { client: [], browser: [] });
  assert.deepEqual(gate.incoming(mine), { client: [], browser: [] });
  const answer = { id: 1, result: { targetId: "MINE" } };
  const sorted = gate.incoming(answer);
  assert.deepEqual(sorted.client, [mine, answer]);
  assert.deepEqual(sorted.browser.map((c) => [c.method, c.sessionId ?? c.params.sessionId]), [["Runtime.runIfWaitingForDebugger", "P1"], ["Target.detachFromTarget", "P1"]]);
  assert.equal(gate.scope("S1"), "target");
  assert.equal(gate.scope("P1"), undefined);
  // A create that failed still lets held tabs go.
  gate.outgoing({ id: 2, method: "Target.createTarget", params: {} });
  gate.incoming({ method: "Target.attachedToTarget", params: { sessionId: "P3", targetInfo: { targetId: "OTHER", type: "page" }, waitingForDebugger: true } });
  assert.equal(gate.incoming({ id: 2, error: { message: "no" } }).browser.length, 2);
});

await check("a tab opened by one of the check's tabs is the check's; frames and workers inside its tabs are too", () => {
  const gate = gateWithATab();
  const popup = { method: "Target.attachedToTarget", params: { sessionId: "S2", targetInfo: { targetId: "POPUP", type: "page", openerId: "MINE" }, waitingForDebugger: true } };
  assert.deepEqual(gate.incoming(popup), { client: [popup], browser: [] });
  assert.equal(gate.owns("POPUP"), true);
  const frame = { sessionId: "S1", method: "Target.attachedToTarget", params: { sessionId: "S3", targetInfo: { targetId: "FRAME", type: "iframe" }, waitingForDebugger: true } };
  assert.deepEqual(gate.incoming(frame).client, [frame]);
  assert.equal(gate.outgoing({ id: 7, sessionId: "S3", method: "Runtime.evaluate" }), "forward");
  const theirPopup = { method: "Target.attachedToTarget", params: { sessionId: "P9", targetInfo: { targetId: "THEIR-POPUP", type: "page", openerId: "THEIRS" }, waitingForDebugger: false } };
  assert.deepEqual(gate.incoming(theirPopup).client, []);
  const gone = { method: "Target.targetDestroyed", params: { targetId: "POPUP" } };
  assert.deepEqual(gate.incoming(gone).client, [gone]);
  assert.equal(gate.owns("POPUP"), false);
  const detached = { method: "Target.detachedFromTarget", params: { sessionId: "S2" } };
  assert.deepEqual(gate.incoming(detached).client, [detached]);
  assert.equal(gate.outgoing({ id: 8, sessionId: "S2", method: "Page.enable" }), "refuse", "a session that ended is no longer the check's");
});

await check("the list of tabs a check asks for holds only its own", () => {
  const gate = gateWithATab();
  assert.equal(gate.outgoing({ id: 2, method: "Target.getTargets" }), "forward");
  const answer = gate.incoming({ id: 2, result: { targetInfos: [{ targetId: "THEIRS", type: "page", url: "https://admin.example/" }, { targetId: "MINE", type: "page", url: "about:blank" }] } });
  assert.deepEqual(answer.client, [{ id: 2, result: { targetInfos: [{ targetId: "MINE", type: "page", url: "about:blank" }] } }]);
});

await check("a check disposes only a browser context it made, and a tab in that context is the check's", () => {
  const gate = new Gate();
  gate.outgoing({ id: 1, method: "Target.createBrowserContext" });
  gate.incoming({ id: 1, result: { browserContextId: "CTX" } });
  assert.equal(gate.outgoing({ id: 2, method: "Target.disposeBrowserContext", params: { browserContextId: "CTX" } }), "forward");
  assert.equal(gate.outgoing({ id: 3, method: "Target.disposeBrowserContext", params: { browserContextId: "DEFAULT" } }), "refuse");
  const inContext = { method: "Target.attachedToTarget", params: { sessionId: "S5", targetInfo: { targetId: "IN-CTX", type: "page", browserContextId: "CTX" }, waitingForDebugger: false } };
  assert.deepEqual(gate.incoming(inContext).client, [inContext]);
  // Where downloads go: the check's context is the check's business, the
  // profile's own is answered and left alone.
  assert.equal(gate.outgoing({ id: 4, method: "Browser.setDownloadBehavior", params: { behavior: "deny", browserContextId: "CTX" } }), "forward");
  assert.equal(gate.outgoing({ id: 5, method: "Browser.setDownloadBehavior", params: { behavior: "deny", browserContextId: "DEFAULT" } }), "acknowledge");
  assert.equal(gate.outgoing({ id: 6, method: "Browser.setDownloadBehavior", params: { behavior: "deny" } }), "acknowledge");
});

await check("inside its own tab a check does what a page can do, and nothing that reaches past the page", () => {
  const gate = gateWithATab();
  const on = (method, params) => gate.outgoing({ id: 5, sessionId: "S1", method, params });
  for (const method of ["Page.navigate", "Page.close", "Runtime.evaluate", "Input.dispatchMouseEvent", "Network.enable", "Emulation.setDeviceMetricsOverride", "Page.captureScreenshot", "Fetch.enable", "DOMStorage.getDOMStorageItems", "Browser.getVersion", "Browser.getWindowForTarget"]) {
    assert.equal(on(method), "forward", method);
  }
  for (const method of [
    // the cookie jar, read or written, under every name it has
    "Network.getCookies", "Network.getAllCookies", "Network.setCookie", "Network.setCookies", "Network.deleteCookies", "Network.clearBrowserCookies",
    "Page.getCookies", "Page.setCookie", "Page.deleteCookie", "Network.setCookieControls", "Storage.getCookies", "Storage.setCookies", "Storage.clearCookies",
    // any origin's storage, by name
    "Storage.clearDataForOrigin", "Storage.clearDataForStorageKey", "Storage.getUsageAndQuota", "IndexedDB.deleteDatabase", "IndexedDB.clearObjectStore",
    "DOMStorage.clear", "DOMStorage.setDOMStorageItem", "DOMStorage.removeDOMStorageItem", "CacheStorage.deleteCache", "Network.clearBrowserCache",
    // the browser
    "Browser.close", "Browser.crash", "Browser.setWindowBounds", "Browser.grantPermissions", "Browser.setDownloadBehavior",
  ]) assert.equal(on(method), "refuse", method);
});

await check("a response the check writes may not carry Set-Cookie", () => {
  const gate = gateWithATab();
  const on = (method, params) => gate.outgoing({ id: 5, sessionId: "S1", method, params });
  assert.equal(on("Fetch.fulfillRequest", { requestId: "r", responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }] }), "forward");
  assert.equal(on("Fetch.fulfillRequest", { requestId: "r", responseCode: 200, responseHeaders: [{ name: "Set-Cookie", value: "session=forged" }] }), "refuse");
  assert.equal(on("Fetch.continueResponse", { requestId: "r", responseHeaders: [{ name: "set-cookie", value: "session=forged" }] }), "refuse");
  assert.equal(on("Fetch.fulfillRequest", { requestId: "r", responseCode: 200, binaryResponseHeaders: btoa("content-type: text/html\0Set-Cookie: session=forged") }), "refuse");
  assert.equal(on("Fetch.fulfillRequest", { requestId: "r", responseCode: 200, binaryResponseHeaders: btoa("content-type: text/html") }), "forward");
  assert.equal(on("Fetch.fulfillRequest", { requestId: "r", responseCode: 200, binaryResponseHeaders: "%%% not base64" }), "refuse");
  assert.equal(on("Fetch.continueRequest", { requestId: "r", headers: [{ name: "x-test", value: "1" }] }), "forward");
});

await check("cookie values are taken out of what DevTools reports about requests, in every shape it reports them", () => {
  const gate = gateWithATab();
  const through = (method, params) => JSON.stringify(gate.incoming({ sessionId: "S1", method, params }).client);
  const cases = [
    ["Network.requestWillBeSentExtraInfo", { requestId: "1", headers: { Cookie: `session=${COOKIE}`, Accept: "*/*" }, associatedCookies: [{ blockedReasons: [], cookie: { name: "session", value: COOKIE, httpOnly: true } }] }],
    ["Network.responseReceivedExtraInfo", { requestId: "1", headers: { "set-cookie": `session=${COOKIE}; HttpOnly` }, headersText: `HTTP/1.1 200 OK\r\nSet-Cookie: session=${COOKIE}; HttpOnly\r\nContent-Type: text/html\r\n`, blockedCookies: [{ blockedReasons: ["x"], cookieLine: `other=${COOKIE}`, cookie: { name: "other", value: COOKIE } }] }],
    ["Network.responseReceived", { requestId: "1", response: { url: "https://a/", headers: { "Set-Cookie": `session=${COOKIE}` }, requestHeaders: { cookie: `session=${COOKIE}` }, requestHeadersText: `GET / HTTP/1.1\r\ncookie: session=${COOKIE}\r\n` } }],
    ["Network.requestWillBeSent", { requestId: "1", request: { url: "https://a/", headers: { Cookie: `session=${COOKIE}` } }, redirectResponse: { headers: { "set-cookie": `session=${COOKIE}` } } }],
    ["Network.webSocketWillSendHandshakeRequest", { requestId: "1", request: { headers: { Cookie: `session=${COOKIE}` } } }],
    ["Fetch.requestPaused", { requestId: "1", request: { url: "https://a/", headers: { Cookie: `session=${COOKIE}` } }, responseHeaders: [{ name: "Set-Cookie", value: `session=${COOKIE}` }, { name: "content-type", value: "text/html" }] }],
  ];
  for (const [method, params] of cases) {
    const text = through(method, params);
    assert.equal(text.includes(COOKIE), false, `${method} still carries the value`);
    assert.equal(text.includes(REDACTED), true, method);
  }
  const kept = through("Network.responseReceivedExtraInfo", { requestId: "1", headers: { "content-type": "text/html" }, headersText: "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n" });
  assert.equal(kept.includes("text/html") && !kept.includes(REDACTED), true, "everything that is not a cookie is left as it was");
  const untouched = { sessionId: "S1", method: "Network.loadingFinished", params: { requestId: "1" } };
  assert.equal(gate.incoming(untouched).client[0], untouched, "a message with nothing to take out is passed on as the object it was");
});

await check("only /v1/devtools/browser/<id> names a session", () => {
  assert.equal(sessionIdFromPath("/v1/devtools/browser/abc"), "abc");
  assert.equal(sessionIdFromPath("/v1/devtools/browser/"), null);
  assert.equal(sessionIdFromPath("/v1/devtools/browser/abc/extra"), null);
  assert.equal(sessionIdFromPath("/devtools/browser/abc"), null);
});

await check("the server refuses to start without a real token", async () => {
  await assert.rejects(() => startSessionServer({ token: "short", port: 0 }), /at least 32 characters/);
  await assert.rejects(() => startSessionServer({ port: 0 }), /at least 32 characters/);
});

// --- 2. against a real Chrome ----------------------------------------------

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The "product": a page that signs the visitor in with an HttpOnly cookie, a
// page that says whether the visitor is signed in, and a link that opens a
// second tab.
const site = http.createServer((req, res) => {
  const url = new URL(req.url, "http://site");
  if (url.pathname === "/signin") {
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": `session=${COOKIE}; Path=/; HttpOnly` });
    res.end("<!doctype html><title>Signed in</title><h1>Signed in</h1>");
  } else if (url.pathname === "/admin") {
    const signedIn = (req.headers.cookie ?? "").includes(`session=${COOKIE}`);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><title>Admin</title><h1 id="who">${signedIn ? "signed in" : "signed out"}</h1><a id="more" href="/admin?tab=2" target="_blank">Open in a new tab</a>`);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const SITE = `http://127.0.0.1:${site.address().port}`;

async function launchProfile(profile, debugPort) {
  // CI has no Playwright build and runs the system Chrome (verify-frame-tools).
  const options = { args: [`--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1"] };
  const channel = process.env.SESSION_SERVER_CHANNEL;
  if (channel) return chromium.launchPersistentContext(profile, { ...options, channel });
  try {
    return await chromium.launchPersistentContext(profile, options);
  } catch (bundled) {
    try {
      return await chromium.launchPersistentContext(profile, { ...options, channel: "chrome" });
    } catch (system) {
      throw new Error(
        `no Chromium to run the session fixture: Playwright's build (${bundled.message.split("\n")[0]}) ` +
          `and the system Chrome (${system.message.split("\n")[0]}) both failed`,
      );
    }
  }
}

const profile = await mkdtemp(join(tmpdir(), "cma-session-"));
const debugPort = await freePort();
const person = await launchProfile(profile, debugPort);
const personTab = person.pages()[0] ?? (await person.newPage());
await personTab.goto(`${SITE}/signin`);

let clock = Date.now();
const gateLog = [];
const started = await startSessionServer({
  token: TOKEN,
  cdp: `http://127.0.0.1:${debugPort}`,
  port: 0,
  probeLog: join(profile, "no-probe.jsonl"),
  now: () => clock,
  heartbeatMs: 300,
  sweepMs: 100,
  onGate: (action, method, scope) => gateLog.push(`${action} ${method} (${scope})`),
});
const BASE = `http://127.0.0.1:${started.port}`;
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const call = async (method, path, body, headers = AUTH) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};
const wsUrl = (sessionId) => `ws://127.0.0.1:${started.port}/v1/devtools/browser/${sessionId}`;
const lease = async (run = RUN_A, seconds = 300) => (await call("POST", "/lease", { ownerRunId: run, maxDurationSeconds: seconds })).json.sessionId;

// What the person would see: the tabs open in the profile, by address — asked
// of Chrome directly, not through the server.
const pageTargets = async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).filter((t) => t.type === "page");
const tabs = async () => (await pageTargets()).map((t) => t.url).sort();
const until = async (what, predicate, ms = 5_000) => {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${what} — still not true after ${ms} ms (last: ${JSON.stringify(last)})`);
};
const onlyThePersonsTab = async () => {
  const open = await tabs();
  return open.length === 1 && open[0] === `${SITE}/signin` ? true : open;
};
const personStillSignedIn = async () => {
  const cookies = await person.cookies(SITE);
  assert.equal(cookies.find((c) => c.name === "session")?.value, COOKIE, "the person's session cookie is gone or changed");
};
const personsTargetId = async () => (await pageTargets()).find((t) => t.url === `${SITE}/signin`).id;

// A DevTools client. Through the server it is what a check's connection is
// underneath, and the only way to say things Playwright itself never would;
// pointed at Chrome directly it is the person's own view. Every frame it
// receives is kept, so "the check was never told" can be said of all of them.
function devtools(url, options = {}) {
  const socket = new WebSocket(url, options);
  const waiting = new Map();
  const frames = [];
  let next = 1;
  socket.on("message", (data) => {
    const text = data.toString();
    frames.push(text);
    const message = JSON.parse(text);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  return {
    socket,
    frames,
    opened: new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    closed: new Promise((resolve) => socket.once("close", resolve)),
    send(method, params = {}, sessionId) {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    // Open a tab and attach to it: → { targetId, sessionId }.
    async openTab(address) {
      const { result } = await this.send("Target.createTarget", { url: address });
      const attached = await this.send("Target.attachToTarget", { targetId: result.targetId, flatten: true });
      return { targetId: result.targetId, sessionId: attached.result.sessionId };
    },
  };
}
const raw = (sessionId, options = {}) => devtools(wsUrl(sessionId), { headers: AUTH, ...options });
const direct = async () => {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  const client = devtools(webSocketDebuggerUrl);
  await client.opened;
  return client;
};
const NOT_ALLOWED = /Not allowed in a signed-in session/;

try {
  await check("no token, no answer: 401 on every route, and no DevTools", async () => {
    assert.equal((await call("GET", "/state", null, {})).status, 401);
    assert.equal((await call("POST", "/lease", { ownerRunId: RUN_A }, { Authorization: "Bearer wrong" })).status, 401);
    const sessionId = await lease();
    const socket = new WebSocket(wsUrl(sessionId));
    await assert.rejects(() => new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }));
    assert.equal((await call("DELETE", "/lease", { ownerRunId: RUN_A })).json.released, true);
  });

  await check("a lease names the browser; a second run is told when to come back; no lease, no DevTools", async () => {
    const before = await call("GET", "/state");
    assert.deepEqual({ lease: before.json.lease, connected: before.json.connected, probe: before.json.probe }, { lease: null, connected: false, probe: null });
    assert.match(before.json.browser, /Chrome\//);

    const taken = await call("POST", "/lease", { ownerRunId: RUN_A, maxDurationSeconds: 300 });
    assert.equal(taken.status, 200);
    assert.match(taken.json.browser, /Chrome\//);
    assert.equal(taken.json.ownerRunId, RUN_A);

    const other = await call("POST", "/lease", { ownerRunId: RUN_B, maxDurationSeconds: 300 });
    assert.equal(other.status, 409);
    assert.equal(other.json.heldUntil, taken.json.expiresAt);
    assert.equal((await call("DELETE", "/lease", { ownerRunId: RUN_B })).status, 409);

    const stranger = raw("not-the-session-id");
    await assert.rejects(() => stranger.opened, "a wrong session id must not reach DevTools");

    const again = await call("POST", "/lease", { ownerRunId: RUN_A, maxDurationSeconds: 300 });
    assert.equal(again.json.sessionId, taken.json.sessionId);
  });

  await check("a check arriving with Playwright works inside the person's session, sees only its own tabs, and leaves only the person's", async () => {
    gateLog.length = 0;
    const browser = await chromium.connectOverCDP(wsUrl(await lease()), { headers: AUTH });
    const context = browser.contexts()[0];
    assert.ok(context, "the profile's own context is what a check works in");
    assert.deepEqual(context.pages().map((p) => p.url()), [], "the person's tab was handed to the check");

    const page = await context.newPage();
    await page.goto(`${SITE}/admin`);
    assert.equal(await page.locator("#who").innerText(), "signed in", "the check's tab is not inside the person's session");
    await page.setViewportSize({ width: 1200, height: 800 });
    assert.ok((await page.screenshot()).length > 1_000);

    const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#more")]);
    await popup.waitForLoadState();
    assert.equal(await popup.locator("#who").innerText(), "signed in");
    assert.deepEqual(context.pages().map((p) => p.url()).sort(), [`${SITE}/admin`, `${SITE}/admin?tab=2`]);
    assert.equal((await tabs()).length, 3);
    assert.equal((await call("GET", "/state")).json.connected, true);

    // While the check is connected the person opens another tab. The check
    // asked the browser to hold new tabs for it; this one is not the check's,
    // so it must load all the same — and the check must not hear of it.
    const second = await person.newPage();
    await second.goto(`${SITE}/admin?person`, { timeout: 10_000 });
    assert.equal(await second.locator("#who").innerText(), "signed in");
    assert.deepEqual(context.pages().map((p) => p.url()).sort(), [`${SITE}/admin`, `${SITE}/admin?tab=2`], "the person's new tab was handed to the check");
    await second.close();

    // An ordinary walk asks for nothing the gate refuses. If a Playwright
    // upgrade starts to, this is where it shows — not in a run.
    assert.deepEqual(gateLog.filter((line) => line.startsWith("refuse")), []);
    assert.deepEqual([...new Set(gateLog)], ["acknowledge Browser.setDownloadBehavior (browser)"]);

    // What a check's own code could do by mistake.
    await assert.rejects(() => context.clearCookies(), NOT_ALLOWED);
    await assert.rejects(() => context.cookies(), NOT_ALLOWED);
    await assert.rejects(() => context.storageState(), NOT_ALLOWED);
    await assert.rejects(() => context.addCookies([{ name: "session", value: "forged", url: SITE }]), NOT_ALLOWED);
    const root = await browser.newBrowserCDPSession();
    const { targetInfos } = await root.send("Target.getTargets");
    assert.deepEqual(targetInfos.map((t) => t.url).sort(), [`${SITE}/admin`, `${SITE}/admin?tab=2`], "the list of tabs names one that is not the check's");
    const theirs = await personsTargetId();
    await assert.rejects(() => root.send("Target.closeTarget", { targetId: theirs }), NOT_ALLOWED);
    await assert.rejects(() => root.send("Target.attachToTarget", { targetId: theirs, flatten: true }), NOT_ALLOWED);
    await assert.rejects(() => root.send("Storage.clearDataForOrigin", { origin: SITE, storageTypes: "all" }), NOT_ALLOWED);
    const own = await context.newCDPSession(page);
    await assert.rejects(() => own.send("Network.getAllCookies"), NOT_ALLOWED);
    await assert.rejects(() => own.send("Network.clearBrowserCookies"), NOT_ALLOWED);
    // What the check's request carried is reported to it without the value.
    const seen = [];
    page.on("request", (request) => seen.push(request.allHeaders()));
    await page.goto(`${SITE}/admin?again`);
    const headers = await Promise.all(seen);
    assert.ok(headers.length > 0);
    assert.equal(JSON.stringify(headers).includes(COOKIE), false, "the session cookie's value reached the check in a request's headers");

    await browser.close();
    await until("the check's two tabs are closed for it", onlyThePersonsTab);
    await personStillSignedIn();
    assert.equal(personTab.isClosed(), false);
    await until("the server knows the check has gone", async () => (await call("GET", "/state")).json.connected === false);
  });

  await check("a raw client cannot reach the person's tab by any address, and no frame it receives holds the cookie", async () => {
    const client = raw(await lease());
    await client.opened;
    const theirs = await personsTargetId();
    // The person's own DevTools session id for that tab, from a connection of
    // their own: the most a check could ever guess.
    const personsView = await direct();
    const { result: theirSession } = await personsView.send("Target.attachToTarget", { targetId: theirs, flatten: true });

    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await client.send("Target.setDiscoverTargets", { discover: true });
    assert.deepEqual((await client.send("Target.getTargets")).result.targetInfos, []);
    for (const [method, params, sessionId] of [
      ["Target.attachToTarget", { targetId: theirs, flatten: true }],
      ["Target.closeTarget", { targetId: theirs }],
      ["Target.activateTarget", { targetId: theirs }],
      ["Target.getTargetInfo", { targetId: theirs }],
      ["Page.close", {}, theirSession.sessionId],
      ["Runtime.evaluate", { expression: "location.href = '/admin?hijacked'" }, theirSession.sessionId],
      ["Page.navigate", { url: `${SITE}/admin?hijacked` }, theirSession.sessionId],
      ["Storage.getCookies", {}],
      ["Storage.clearCookies", {}],
      ["Browser.crash", {}],
    ]) {
      const answer = await client.send(method, params, sessionId);
      assert.match(answer.error?.message ?? "FORWARDED", NOT_ALLOWED, method);
    }

    // In its own tab: every way to the cookie jar, and a forged Set-Cookie.
    // (Auto-attach off first: a tab attached that way stands still until it
    // is started, and this client attaches by hand.)
    await client.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    const tab = await client.openTab(`${SITE}/admin`);
    await client.send("Network.enable", {}, tab.sessionId);
    await client.send("Page.enable", {}, tab.sessionId);
    for (const method of ["Network.getCookies", "Network.getAllCookies", "Page.getCookies"]) {
      assert.match((await client.send(method, {}, tab.sessionId)).error?.message ?? "FORWARDED", NOT_ALLOWED, method);
    }
    for (const [method, params] of [
      ["Network.setCookie", { name: "session", value: "forged", url: SITE }],
      ["Page.setCookie", { cookieName: "session", cookieValue: "forged", url: SITE }],
      ["Network.deleteCookies", { name: "session", url: SITE }],
      ["Page.deleteCookie", { cookieName: "session", url: SITE }],
      ["Network.clearBrowserCookies", {}],
      ["Fetch.fulfillRequest", { requestId: "interception-1", responseCode: 200, responseHeaders: [{ name: "Set-Cookie", value: "session=forged; Path=/" }] }],
    ]) {
      assert.match((await client.send(method, params, tab.sessionId)).error?.message ?? "FORWARDED", NOT_ALLOWED, method);
    }
    // Both directions of the cookie pass through the check's own tab here: it
    // is sent with the request for /admin and set again by /signin.
    await client.send("Page.navigate", { url: `${SITE}/signin` }, tab.sessionId);
    await client.send("Page.navigate", { url: `${SITE}/admin?after` }, tab.sessionId);
    await until("the navigations were reported", async () => client.frames.filter((f) => f.includes("Network.responseReceivedExtraInfo")).length >= 2);
    assert.equal(client.frames.some((f) => f.includes(REDACTED)), true, "no request with a cookie was reported at all — the fixture proved nothing");
    assert.equal(client.frames.filter((f) => f.includes(COOKIE)).length, 0, "a frame delivered to the check holds the session cookie's value");
    assert.equal(client.frames.some((f) => f.includes(theirs)), false, "the check was told the person's tab exists");
    const rendered = await client.send("Runtime.evaluate", { expression: "document.querySelector('#who').textContent" }, tab.sessionId);
    assert.equal(rendered.result.result.value, "signed in", "the check's own tab must still be inside the session");

    client.socket.close();
    await until("its tab is closed", onlyThePersonsTab);
    assert.equal(personTab.url(), `${SITE}/signin`, "the person's tab was moved");
    await personStillSignedIn();
    personsView.socket.close();
  });

  await check("Browser.close from a check disconnects the check and closes nothing but its tabs", async () => {
    const client = raw(await lease());
    await client.opened;
    const created = await client.send("Target.createTarget", { url: `${SITE}/admin` });
    assert.ok(created.result?.targetId);
    const answer = await client.send("Browser.close");
    assert.deepEqual(answer.result, {});
    await client.closed;
    await until("its tab is closed", onlyThePersonsTab);
    assert.match((await call("GET", "/state")).json.browser, /Chrome\//, "the browser itself must still be running");
    await personStillSignedIn();
  });

  // --- 3. checks that go away without saying so ------------------------------

  await check("a connection that is killed leaves no tab behind", async () => {
    const client = raw(await lease());
    await client.opened;
    await client.send("Target.createTarget", { url: `${SITE}/admin` });
    assert.equal((await tabs()).length, 2);
    client.socket.terminate();
    await until("the abandoned tab is closed", onlyThePersonsTab);
  });

  await check("a second tab the check's tab opened, which nobody had reported, is closed with it", async () => {
    const client = raw(await lease());
    await client.opened;
    // No target discovery and no auto-attach on this connection: the server
    // first hears of the second tab while it is already closing the first.
    const tab = await client.openTab(`${SITE}/admin`);
    await client.send("Runtime.evaluate", { expression: "window.open('/admin?tab=2') && true", userGesture: true }, tab.sessionId);
    await until("the second tab is open", async () => (await tabs()).length === 3);
    client.socket.terminate();
    await until("both of the check's tabs are closed", onlyThePersonsTab);
  });

  await check("a browser context the check made goes with it", async () => {
    const personsView = await direct();
    const before = (await personsView.send("Target.getBrowserContexts")).result.browserContextIds.length;
    const client = raw(await lease());
    await client.opened;
    const { result: made } = await client.send("Target.createBrowserContext");
    await client.send("Target.createTarget", { url: `${SITE}/admin`, browserContextId: made.browserContextId });
    assert.equal((await personsView.send("Target.getBrowserContexts")).result.browserContextIds.length, before + 1);
    client.socket.terminate();
    await until("the context is disposed", async () => (await personsView.send("Target.getBrowserContexts")).result.browserContextIds.length === before);
    await until("and its tab with it", onlyThePersonsTab);
    personsView.socket.close();
  });

  await check("a connection that goes silent is dropped after two missed beats, and its tab with it", async () => {
    const client = raw(await lease(), { autoPong: false });
    await client.opened;
    await client.send("Target.createTarget", { url: `${SITE}/admin` });
    assert.equal((await tabs()).length, 2);
    await until("the silent check's tab is closed", onlyThePersonsTab);
    await client.closed;
  });

  await check("the same run connecting again takes over: the earlier connection's tab is closed first", async () => {
    const sessionId = await lease();
    const first = raw(sessionId);
    await first.opened;
    await first.send("Target.createTarget", { url: `${SITE}/admin?first` });
    const second = raw(sessionId);
    await second.opened;
    await first.closed;
    assert.deepEqual(await onlyThePersonsTab(), true);
    await second.send("Target.createTarget", { url: `${SITE}/admin?second` });
    assert.deepEqual(await tabs(), [`${SITE}/admin?second`, `${SITE}/signin`]);
    second.socket.close();
    await until("the second connection's tab is closed", onlyThePersonsTab);
  });

  await check("connections that race for one session id leave exactly one, and a release reaches it", async () => {
    const sessionId = await lease();
    const racers = [raw(sessionId), raw(sessionId), raw(sessionId)];
    await Promise.all(racers.map((r) => r.opened));
    await Promise.all([racers[0].closed, racers[1].closed]);
    assert.equal(racers[2].socket.readyState, WebSocket.OPEN, "the last to arrive is the one that stays");
    await racers[2].send("Target.createTarget", { url: `${SITE}/admin?racer` });
    assert.deepEqual((await call("DELETE", "/lease", { ownerRunId: RUN_A })).json, { released: true });
    await racers[2].closed;
    assert.deepEqual(await onlyThePersonsTab(), true, "a connection the server lost track of kept its tab");
  });

  await check("a lease that runs out ends the connection, closes its tab and lets the next run in", async () => {
    const sessionId = await lease(RUN_A, 60);
    const client = raw(sessionId);
    await client.opened;
    await client.send("Target.createTarget", { url: `${SITE}/admin` });
    clock += 61_000;
    await client.closed;
    await until("the expired check's tab is closed", onlyThePersonsTab);
    const late = raw(sessionId);
    await assert.rejects(() => late.opened, "an expired session id must not reach DevTools");
    assert.equal((await call("POST", "/lease", { ownerRunId: RUN_B, maxDurationSeconds: 60 })).status, 200);
  });

  await check("giving the lease back closes the holder's tab and frees the session at once", async () => {
    const client = raw(await lease(RUN_B));
    await client.opened;
    await client.send("Target.createTarget", { url: `${SITE}/admin` });
    const released = await call("DELETE", "/lease", { ownerRunId: RUN_B });
    assert.deepEqual(released.json, { released: true });
    assert.deepEqual(await onlyThePersonsTab(), true, "the tab must be closed by the time the release is answered");
    await client.closed;
    assert.equal((await call("POST", "/lease", { ownerRunId: RUN_A, maxDurationSeconds: 60 })).status, 200);
    assert.deepEqual((await call("DELETE", "/lease", { ownerRunId: RUN_A })).json, { released: true });
    assert.deepEqual((await call("DELETE", "/lease", { ownerRunId: RUN_A })).json, { released: false });
  });

  await check("after all of it the person's tab is where it was and still signed in", async () => {
    assert.equal(personTab.isClosed(), false);
    assert.equal(personTab.url(), `${SITE}/signin`);
    await personStillSignedIn();
    await personTab.goto(`${SITE}/admin`);
    assert.equal(await personTab.locator("#who").innerText(), "signed in");
  });

  await check("no browser, no lease: 503 and the session stays free", async () => {
    const dead = await startSessionServer({ token: TOKEN, cdp: `http://127.0.0.1:${await freePort()}`, port: 0, probeLog: join(profile, "no-probe.jsonl") });
    try {
      const response = await fetch(`http://127.0.0.1:${dead.port}/lease`, { method: "POST", headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ ownerRunId: RUN_A }) });
      assert.equal(response.status, 503);
      assert.equal(dead.book.current(), null);
      const state = await (await fetch(`http://127.0.0.1:${dead.port}/state`, { headers: AUTH })).json();
      assert.equal(state.browser, null);
    } finally {
      await dead.close();
    }
  });
} finally {
  // A failed check can leave a tab that never loads or a socket that never
  // closes; the verdict must still be printed. Each step gets five seconds.
  const within = (work) => Promise.race([Promise.resolve().then(work).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await within(() => started.close());
  await within(() => person.close());
  site.closeAllConnections();
  await within(() => new Promise((resolve) => site.close(resolve)));
  await within(() => rm(profile, { recursive: true, force: true }));
}

console.log(failures > 0 ? `\nverify-session-server: ${failures} failed` : "\nverify-session-server: all passed");
process.exit(failures > 0 ? 1 : 0);
