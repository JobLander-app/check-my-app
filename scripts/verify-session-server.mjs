// CHE-389: a check works inside the browser a person signed in to, and can end
// nothing there that it did not start.
//
// Three parts:
//   1. the rules (spikes/shopify-session/lease.mjs), pure;
//   2. the server against a real Chrome with a persistent profile — the same
//      arrangement as the session host: a person's tab holding a signed-in
//      cookie, and a check arriving through the server with Playwright's own
//      connectOverCDP;
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
import { LeaseBook, Owned, leaseSeconds, sessionIdFromPath, LEASE_MAX_SECONDS, LEASE_MIN_SECONDS } from "../spikes/shopify-session/lease.mjs";
import { startSessionServer } from "../spikes/shopify-session/session-server.mjs";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n").join("\n     ")}`);
  }
}

const RUN_A = "run-aaaaaaaa";
const RUN_B = "run-bbbbbbbb";
const TOKEN = "t".repeat(40);

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

await check("a check closes its own tabs and nobody else's", () => {
  const owned = new Owned();
  assert.equal(owned.outgoing({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } }), "forward");
  owned.incoming({ id: 1, result: { targetId: "MINE" } });
  assert.equal(owned.outgoing({ id: 2, method: "Target.closeTarget", params: { targetId: "MINE" } }), "forward");
  assert.equal(owned.outgoing({ id: 3, method: "Target.closeTarget", params: { targetId: "THEIRS" } }), "refuse");
  assert.equal(owned.outgoing({ id: 4, method: "Target.closeTarget" }), "refuse");
});

await check("a tab opened by one of the check's tabs is the check's; one opened by the person's is not", () => {
  const owned = new Owned();
  owned.outgoing({ id: 1, method: "Target.createTarget", params: {} });
  owned.incoming({ id: 1, result: { targetId: "MINE" } });
  owned.incoming({ method: "Target.targetCreated", params: { targetInfo: { targetId: "POPUP", type: "page", openerId: "MINE" } } });
  owned.incoming({ method: "Target.targetCreated", params: { targetInfo: { targetId: "THEIR-POPUP", type: "page", openerId: "THEIRS" } } });
  owned.incoming({ method: "Target.targetCreated", params: { targetInfo: { targetId: "WORKER", type: "service_worker", openerId: "MINE" } } });
  assert.deepEqual([...owned.targets].sort(), ["MINE", "POPUP"]);
  owned.incoming({ method: "Target.targetDestroyed", params: { targetId: "POPUP" } });
  assert.deepEqual([...owned.targets], ["MINE"]);
});

await check("a create answered inside one DevTools session is not credited to the same id in another", () => {
  const owned = new Owned();
  owned.outgoing({ id: 7, sessionId: "S1", method: "Target.createTarget", params: {} });
  owned.incoming({ id: 7, sessionId: "S2", result: { targetId: "NOT-MINE" } });
  assert.equal(owned.targets.size, 0);
  owned.incoming({ id: 7, sessionId: "S1", result: { targetId: "MINE" } });
  assert.deepEqual([...owned.targets], ["MINE"]);
});

await check("a check disposes only a browser context it made", () => {
  const owned = new Owned();
  owned.outgoing({ id: 1, method: "Target.createBrowserContext" });
  owned.incoming({ id: 1, result: { browserContextId: "CTX" } });
  assert.equal(owned.outgoing({ id: 2, method: "Target.disposeBrowserContext", params: { browserContextId: "CTX" } }), "forward");
  assert.equal(owned.outgoing({ id: 3, method: "Target.disposeBrowserContext", params: { browserContextId: "DEFAULT" } }), "refuse");
  owned.incoming({ method: "Target.attachedToTarget", params: { targetInfo: { targetId: "IN-CTX", type: "page", browserContextId: "CTX" } } });
  assert.equal(owned.targets.has("IN-CTX"), true, "a tab in the check's own context is the check's");
});

await check("nothing that ends or rewrites the person's session is forwarded", () => {
  const owned = new Owned();
  for (const method of [
    "Browser.crash", "Browser.crashGpuProcess", "Network.clearBrowserCookies", "Network.deleteCookies", "Network.setCookie",
    "Network.setCookies", "Storage.clearCookies", "Storage.setCookies", "Storage.clearDataForOrigin", "Storage.clearDataForStorageKey",
  ]) assert.equal(owned.outgoing({ id: 1, method }), "refuse", method);
  assert.equal(owned.outgoing({ id: 2, method: "Browser.close" }), "disconnect");
  assert.equal(owned.outgoing({ id: 3, method: "Page.navigate", params: { url: "https://example.test" } }), "forward");
  assert.equal(owned.outgoing({ id: 4, method: "Storage.getCookies" }), "forward");
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

// The "product": a page that signs the visitor in with a cookie, a page that
// says whether the visitor is signed in, and a link that opens a second tab.
const site = http.createServer((req, res) => {
  const url = new URL(req.url, "http://site");
  if (url.pathname === "/signin") {
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "session=alive; Path=/; HttpOnly" });
    res.end("<!doctype html><title>Signed in</title><h1>Signed in</h1>");
  } else if (url.pathname === "/admin") {
    const signedIn = /(^|;\s*)session=alive/.test(req.headers.cookie ?? "");
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
const started = await startSessionServer({
  token: TOKEN,
  cdp: `http://127.0.0.1:${debugPort}`,
  port: 0,
  probeLog: join(profile, "no-probe.jsonl"),
  now: () => clock,
  heartbeatMs: 300,
  sweepMs: 100,
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

// What the person would see: the tabs open in the profile, by address.
const tabs = async () => {
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  return list.filter((t) => t.type === "page").map((t) => t.url).sort();
};
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
  assert.equal(cookies.find((c) => c.name === "session")?.value, "alive", "the person's session cookie is gone");
};

// A raw DevTools client: what a check's connection is underneath, and the only
// way to say things Playwright itself never would.
function raw(sessionId, options = {}) {
  const socket = new WebSocket(wsUrl(sessionId), { headers: AUTH, ...options });
  const waiting = new Map();
  let next = 1;
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  return {
    socket,
    opened: new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    closed: new Promise((resolve) => socket.once("close", resolve)),
    send(method, params = {}) {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

try {
  await check("no token, no answer: 401 on every route, and no DevTools", async () => {
    assert.equal((await call("GET", "/state", null, {})).status, 401);
    assert.equal((await call("POST", "/lease", { ownerRunId: RUN_A }, { Authorization: "Bearer wrong" })).status, 401);
    const taken = await call("POST", "/lease", { ownerRunId: RUN_A, maxDurationSeconds: 300 });
    assert.equal(taken.status, 200);
    const socket = new WebSocket(wsUrl(taken.json.sessionId));
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

  await check("a check arriving with Playwright works inside the person's session, and leaves only the person's tab", async () => {
    const { sessionId } = (await call("POST", "/lease", { ownerRunId: RUN_A, maxDurationSeconds: 300 })).json;
    const browser = await chromium.connectOverCDP(wsUrl(sessionId), { headers: AUTH });
    const context = browser.contexts()[0];
    assert.ok(context, "the profile's own context is what a check works in");

    const page = await context.newPage();
    await page.goto(`${SITE}/admin`);
    assert.equal(await page.locator("#who").innerText(), "signed in", "the check's tab is not inside the person's session");

    const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#more")]);
    await popup.waitForLoadState();
    assert.equal(await popup.locator("#who").innerText(), "signed in");
    assert.equal((await tabs()).length, 3);
    assert.equal((await call("GET", "/state")).json.connected, true);

    // What a check's own code could do by mistake.
    await assert.rejects(() => context.clearCookies(), /Not allowed in a signed-in session/);
    const root = await browser.newBrowserCDPSession();
    const { targetInfos } = await root.send("Target.getTargets");
    const theirs = targetInfos.find((t) => t.type === "page" && t.url === `${SITE}/signin`);
    assert.ok(theirs, "the person's tab is visible to the check");
    await assert.rejects(() => root.send("Target.closeTarget", { targetId: theirs.targetId }), /Not allowed in a signed-in session/);
    await assert.rejects(() => root.send("Storage.clearDataForOrigin", { origin: SITE, storageTypes: "all" }), /Not allowed in a signed-in session/);

    await browser.close();
    await until("the check's two tabs are closed for it", onlyThePersonsTab);
    await personStillSignedIn();
    assert.equal(personTab.isClosed(), false);
    await until("the server knows the check has gone", async () => (await call("GET", "/state")).json.connected === false);
  });

  await check("Browser.close from a check disconnects the check and closes nothing but its tabs", async () => {
    const { sessionId } = (await call("POST", "/lease", { ownerRunId: RUN_A, maxDurationSeconds: 300 })).json;
    const client = raw(sessionId);
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
    const { sessionId } = (await call("POST", "/lease", { ownerRunId: RUN_A, maxDurationSeconds: 300 })).json;
    const client = raw(sessionId);
    await client.opened;
    await client.send("Target.createTarget", { url: `${SITE}/admin` });
    assert.equal((await tabs()).length, 2);
    client.socket.terminate();
    await until("the abandoned tab is closed", onlyThePersonsTab);
  });

  await check("a connection that goes silent is dropped after two missed beats, and its tab with it", async () => {
    const { sessionId } = (await call("POST", "/lease", { ownerRunId: RUN_A, maxDurationSeconds: 300 })).json;
    const client = raw(sessionId, { autoPong: false });
    await client.opened;
    await client.send("Target.createTarget", { url: `${SITE}/admin` });
    assert.equal((await tabs()).length, 2);
    await until("the silent check's tab is closed", onlyThePersonsTab);
    await client.closed;
  });

  await check("the same run connecting again takes over: the earlier connection's tab is closed first", async () => {
    const { sessionId } = (await call("POST", "/lease", { ownerRunId: RUN_A, maxDurationSeconds: 300 })).json;
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

  await check("a lease that runs out ends the connection, closes its tab and lets the next run in", async () => {
    const { sessionId } = (await call("POST", "/lease", { ownerRunId: RUN_A, maxDurationSeconds: 60 })).json;
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
    const { sessionId } = (await call("POST", "/lease", { ownerRunId: RUN_B, maxDurationSeconds: 300 })).json;
    const client = raw(sessionId);
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
  await started.close();
  await person.close().catch(() => {});
  await new Promise((resolve) => site.close(resolve));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

if (failures > 0) {
  console.log(`\nverify-session-server: ${failures} failed`);
  process.exit(1);
}
console.log("\nverify-session-server: all passed");
