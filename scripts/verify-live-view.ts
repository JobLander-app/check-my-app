// CHE-419: a person signs in to their store on our page through a live view of
// one tab of the session browser (spikes/shopify-session/viewer.mjs).
//
// Two parts:
//   1. the rules, pure: the view token, the closed list of things a viewer may
//      say, the store → admin address;
//   2. the viewer against a real Chrome: refused without a token, from another
//      origin or for another slot; frames arrive; clicks, keys and pasted text
//      land in the page; Enter submits; a passkey request fails at once instead
//      of waiting on a window nobody can see; a pop-up is shown while it is
//      open; a second viewer replaces the first.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasEnvironmentLeak, hasHomework } from "../src/lib/verdict-language";
import { SIGN_IN_COPY, allSignInSentences, signInError } from "../src/lib/sign-in-copy";
import WebSocket from "ws";
import { chromium } from "playwright";
// @ts-ignore — the host's own modules are plain JavaScript.
import { signViewToken, verifyViewToken, signedInStore, startViewer, storeAdminUrl, translate } from "../spikes/shopify-session/viewer.mjs";
import { mintViewToken, storeOfAdminUrl } from "../src/lib/session-view";

async function main() {
let failures = 0;
async function check(name, fn) {
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("did not finish in 30 s")), 30_000); })]);
    clearTimeout(timer);
    console.log(`ok   ${name}`);
  } catch (error) {
    clearTimeout(timer);
    failures++;
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n").join("\n     ")}`);
  }
}

const SECRET = "v".repeat(40);
const ORIGIN = "https://checkmyapp.dev";
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

// --- 1. the rules -----------------------------------------------------------

await check("a token we signed is read back; tampered, expired, foreign or of another version is not", () => {
  const token = signViewToken(SECRET, { slot: "main", store: "prod-release-1", exp: inAnHour() });
  assert.equal(verifyViewToken(SECRET, token)?.store, "prod-release-1");
  const [body, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, slot: "main", store: "someone-else", exp: inAnHour() })).toString("base64url");
  assert.equal(verifyViewToken(SECRET, `${forged}.${mac}`), null, "a body with another store kept the signature");
  assert.equal(verifyViewToken("x".repeat(40), token), null, "another secret's token");
  assert.equal(verifyViewToken(SECRET, signViewToken(SECRET, { slot: "main", store: "s", exp: Math.floor(Date.now() / 1000) - 1 })), null, "expired");
  assert.equal(verifyViewToken(SECRET, signViewToken(SECRET, { v: 2, slot: "main", store: "s", exp: inAnHour() })), null, "another version");
  assert.equal(verifyViewToken(SECRET, `${body}.${mac}.x`), null);
  assert.equal(verifyViewToken(SECRET, undefined), null);
});

await check("the token checkmyapp.dev mints is the token the host accepts", async () => {
  const minted = await mintViewToken(SECRET, { slot: "main", store: "prod-release-1" });
  const payload = verifyViewToken(SECRET, minted);
  assert.equal(payload?.store, "prod-release-1");
  assert.equal(payload?.slot, "main");
  assert.ok(payload.exp > Date.now() / 1000 + 25 * 60 && payload.exp <= Date.now() / 1000 + 30 * 60 + 1, "about thirty minutes");
  assert.equal(verifyViewToken("y".repeat(40), minted), null);
  assert.equal(verifyViewToken(SECRET, await mintViewToken(SECRET, { slot: "main", store: "s", now: Date.now() - 31 * 60_000 })), null, "a token older than its life");
  assert.equal(storeOfAdminUrl("https://admin.shopify.com/store/prod-release-1/apps/easy-block-customer-ip-country"), "prod-release-1");
  assert.equal(storeOfAdminUrl("https://prod-release-1.myshopify.com/"), null);
  assert.equal(storeOfAdminUrl("https://admin.shopify.com.evil.dev/store/x"), null);
});

// Codex on #287: every sentence of the sign-in page comes from one module and
// passes the customer-language guards; the host sends codes, each of which
// has its sentence there.
await check("the sign-in page's every sentence is about the person's store, and every code the host sends has one", async () => {
  for (const sentence of allSignInSentences("prod-release-1")) {
    assert.equal(hasEnvironmentLeak(sentence), false, `leaks our machinery: ${sentence}`);
    assert.equal(hasHomework(sentence), false, `homework: ${sentence}`);
    assert.doesNotMatch(sentence, /\b(browser|tab|screencast|VNC|DevTools|session host)\b/i, `names our machinery: ${sentence}`);
  }
  const source = readFileSync(join(process.cwd(), "spikes/shopify-session/viewer.mjs"), "utf8");
  const codes = [...source.matchAll(/t: "error", code: "([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 4, `codes found: ${codes}`);
  for (const code of codes) assert.notEqual(signInError(code), SIGN_IN_COPY.connectionEnded, `no sentence for "${code}"`);
  assert.doesNotMatch(source, /t: "error", message:/, "the host still sends a sentence of its own");
});

await check("a store becomes its admin address, and nothing else does", () => {
  assert.equal(storeAdminUrl("prod-release-1"), "https://admin.shopify.com/store/prod-release-1");
  assert.equal(storeAdminUrl("Prod-Release-1.myshopify.com"), "https://admin.shopify.com/store/prod-release-1");
  for (const bad of ["", "../x", "a/b", "evil.com", "x?y", "-x"]) assert.equal(storeAdminUrl(bad), null, bad);
  assert.equal(signedInStore("https://admin.shopify.com/store/prod-release-1/apps"), "prod-release-1");
  assert.equal(signedInStore("https://accounts.shopify.com/lookup"), null);
  assert.equal(signedInStore("https://admin.shopify.com.evil.dev/store/x"), null);
});

await check("a viewer may only point, press keys, insert text, answer a dialog, go back or reload", () => {
  assert.equal(translate({ t: "mouse", type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 }).method, "Input.dispatchMouseEvent");
  assert.equal(translate({ t: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65, text: "a" }).params.type, "keyDown");
  assert.equal(translate({ t: "key", type: "keyDown", key: "Tab", code: "Tab", keyCode: 9 }).params.type, "rawKeyDown");
  assert.deepEqual(translate({ t: "key", type: "keyDown", key: "a", commands: ["selectAll", "Runtime.evaluate"] }).params.commands, ["selectAll"]);
  assert.equal(translate({ t: "text", text: "x".repeat(10_000) }).params.text.length, 4096);
  assert.equal(translate({ t: "nav", action: "back" }).params.expression, "history.back()");
  for (const bad of [
    { t: "nav", action: "goto", url: "https://evil.dev" },
    { t: "cdp", method: "Network.getAllCookies" },
    { t: "eval", expression: "document.cookie" },
    { t: "mouse", type: "dragIntercepted" },
    { t: "key", type: "char" },
    { t: "text", text: "" },
    null,
    "Input.insertText",
  ]) assert.equal(translate(bad), null, JSON.stringify(bad));
  const mouse = translate({ t: "mouse", type: "mouseMoved", x: -5, y: 1e9, button: "evil", modifiers: 99 }).params;
  assert.deepEqual([mouse.x, mouse.y, mouse.button, mouse.modifiers], [0, 10_000, "none", 15]);
});

await check("the viewer refuses to start without a real secret", async () => {
  await assert.rejects(() => startViewer({ secret: "short", port: 0 }), /at least 32 characters/);
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

// The "admin": a sign-in form, a button that asks for a passkey, a pop-up.
// Served on localhost so the page is a secure context and WebAuthn exists.
const site = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://site");
  if (url.pathname === "/admin") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><meta charset="utf-8"><title>sign in</title><body style="margin:0">
<form action="/done" method="get"><input id="email" name="email" autofocus style="position:absolute;left:0;top:0;width:300px;height:40px"></form>
<button id="passkey" style="position:absolute;left:0;top:100px;width:200px;height:40px" onclick="
  document.title='asking';
  navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: 'localhost', timeout: 60000, userVerification: 'preferred' } })
    .then(() => { document.title = 'passkey:ok'; }, (e) => { document.title = 'passkey:' + e.name; });
">passkey</button>
<button id="popup" style="position:absolute;left:0;top:200px;width:200px;height:40px" onclick="window.open('/popup', 'p', 'width=400,height=400')">pop-up</button>
</body>`);
  } else if (url.pathname === "/flash") {
    // An admin address that turns into the sign-in form a moment later — what
    // Shopify does with the admin's address when the session has ended.
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><meta charset="utf-8"><title>flash</title><script>setTimeout(() => location.replace('/admin'), 300)</script>`);
  } else if (url.pathname === "/popup") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><title>pop-up</title><button id="close" style="position:absolute;left:0;top:0;width:200px;height:40px" onclick="window.close()">close</button>`);
  } else if (url.pathname === "/done") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><meta charset="utf-8"><title>done</title><p id="email">${url.searchParams.get("email")?.replace(/[<>&]/g, "") ?? ""}</p>`);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const SITE = `http://localhost:${site.address().port}`;

async function launchProfile(profile, debugPort) {
  const options = { args: [`--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1"] };
  const channel = process.env.SESSION_SERVER_CHANNEL;
  if (channel) return chromium.launchPersistentContext(profile, { ...options, channel });
  try {
    return await chromium.launchPersistentContext(profile, options);
  } catch {
    return chromium.launchPersistentContext(profile, { ...options, channel: "chrome" });
  }
}

const profile = await mkdtemp(join(tmpdir(), "cma-viewer-"));
const debugPort = await freePort();
const CDP = `http://127.0.0.1:${debugPort}`;
const browser = await launchProfile(profile, debugPort);
const log = [];
let held = false;
const viewer = await startViewer({
  secret: SECRET,
  origins: [ORIGIN],
  cdp: CDP,
  port: 0,
  adminUrlFor: (store) => (store === "fixture" ? `${SITE}/admin` : null),
  leaseHeld: async () => held,
  // The fixture's "signed in": its /done page (and /flash, which leaves for
  // the form a moment after it loads — a sign-in that did not hold).
  signedIn: (href: string) => ["/done", "/flash"].includes(new URL(href).pathname),
  signedInSettleMs: 1_000,
  doorLog: null,
  log: (line) => log.push(line),
});
const VIEW = `ws://127.0.0.1:${viewer.port}/v1/view`;
const token = (over = {}) => signViewToken(SECRET, { slot: "main", store: "fixture", exp: inAnHour(), ...over });

// A connected viewer: its frames and messages, and a way to wait for one.
function connect(t = token(), origin = ORIGIN) {
  const ws = new WebSocket(`${VIEW}?token=${encodeURIComponent(t)}`, { origin });
  const seen = { frames: 0, messages: [] };
  const waiters = [];
  ws.on("message", (data, binary) => {
    if (binary) seen.frames++;
    else seen.messages.push(JSON.parse(String(data)));
    for (const w of [...waiters]) if (w.test()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
  });
  const until = (test, what, ms = 10_000) =>
    test() ? Promise.resolve() : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; messages: ${JSON.stringify(seen.messages)}`)), ms);
      waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
    });
  const opened = new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); ws.once("close", () => reject(new Error("closed before open"))); });
  const say = (m) => ws.send(JSON.stringify(m));
  const click = (x, y) => {
    say({ t: "mouse", type: "mousePressed", x, y, button: "left", clickCount: 1 });
    say({ t: "mouse", type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  return { ws, seen, until, opened, say, click };
}

const refused = (t, origin) => new Promise((resolve) => {
  const ws = new WebSocket(`${VIEW}?token=${encodeURIComponent(t)}`, { origin });
  ws.once("open", () => { ws.close(); resolve(false); });
  ws.once("error", () => resolve(true));
});

// The fixture's tab, as Chrome reports it: the viewer opened it through the door.
const fixtureTab = async (path) => (await (await fetch(`${CDP}/json`)).json()).find((t) => t.type === "page" && t.url.startsWith(`${SITE}${path}`));
async function evaluate(tab, expression) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.once("open", resolve));
  const value = await new Promise((resolve) => {
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.id === 1) resolve(m.result?.result?.value); });
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  ws.close();
  return value;
}
const waitFor = async (fn, what, ms = 10_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

await check("no token, a forged one, another origin or another slot: the socket is refused", async () => {
  assert.equal(await refused("nonsense", ORIGIN), true, "a nonsense token was let in");
  assert.equal(await refused(signViewToken("x".repeat(40), { slot: "main", store: "fixture", exp: inAnHour() }), ORIGIN), true, "another secret's token was let in");
  assert.equal(await refused(token(), "https://evil.dev"), true, "another origin was let in");
  assert.equal(await refused(token({ slot: "team-2" }), ORIGIN), true, "another slot was let in");
  assert.equal(await refused(token({ store: "unknown" }), ORIGIN), true, "a store with no admin address was let in");
});

// Codex on #287: while a check holds the browser, the person is told so and
// given nothing — not a tab beside the measurement, never the check's own.
await check("while a check holds the browser, the viewer is refused with a sentence, and no tab is opened", async () => {
  held = true;
  try {
    const tabsBefore = (await (await fetch(`${CDP}/json`)).json()).length;
    const w = connect();
    await w.opened;
    await w.until(() => w.seen.messages.some((m) => m.t === "error" && m.code === "busy"), "the refusal");
    await new Promise<void>((resolve) => { if (w.ws.readyState === WebSocket.CLOSED) resolve(); else w.ws.once("close", () => resolve()); });
    assert.equal(w.seen.frames, 0, "frames were sent while a check held the browser");
    assert.equal((await (await fetch(`${CDP}/json`)).json()).length, tabsBefore, "a tab was opened");
    assert.equal(viewer.present(), false, "a refused viewer still counts as present");
  } finally {
    held = false;
  }
});

let v;
await check("a viewer with a token sees the tab: its size, its address, its frames", async () => {
  v = connect();
  await v.opened;
  await v.until(() => v.seen.messages.some((m) => m.t === "meta" && m.w > 0), "the frame size");
  await v.until(() => v.seen.frames > 0, "a frame");
  await v.until(() => v.seen.messages.some((m) => m.t === "page" && m.path === "/admin"), "the address");
  assert.equal(viewer.present(), true, "a connected viewer is not reported present — a check could take the browser from under the person");
});

// Chrome drops a tab's virtual authenticators when any other DevTools client
// detaches — `evaluate` here is such a client, and so are the host's probe and
// every check. The click comes right after one left.
await check("a passkey request fails at once instead of waiting on a window nobody can see", async () => {
  const tab = await waitFor(() => fixtureTab("/admin"), "the fixture tab");
  await waitFor(async () => (await evaluate(tab, "document.readyState")) === "complete", "the form loaded");
  await evaluate(tab, "document.title = 'before'");
  // Watched through one client that stays attached: a client polling by
  // attaching and leaving would reset the authenticator itself, every 100 ms.
  const watch = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve) => watch.once("open", resolve));
  let n = 0;
  const titleNow = () => new Promise((resolve) => {
    const id = ++n;
    const on = (raw) => { const m = JSON.parse(String(raw)); if (m.id === id) { watch.off("message", on); resolve(m.result?.result?.value); } };
    watch.on("message", on);
    watch.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } }));
  });
  v.click(100, 120);
  const title = await waitFor(async () => { const t = await titleNow(); return t.startsWith("passkey:") ? t : null; }, "the passkey answer", 5_000).finally(() => watch.close());
  assert.equal(title, "passkey:NotAllowedError", JSON.stringify(log));
});

// Codex on #287: the admin's address shows for a moment before Shopify turns
// it into the sign-in form. That moment is not a sign-in.
await check("an admin address that does not hold is not reported as signed in", async () => {
  const tab = await waitFor(() => fixtureTab("/admin"), "the fixture tab");
  await evaluate(tab, "location.href = '/flash'");
  await v.until(() => v.seen.messages.some((m) => m.t === "page" && m.path === "/flash"), "the flash page shown");
  await v.until(() => v.seen.messages.filter((m) => m.t === "page" && m.path === "/admin").length >= 2, "back on the form");
  await new Promise((r) => setTimeout(r, 1_800));
  assert.equal(v.seen.messages.filter((m) => m.t === "signed_in").length, 0, "told signed in by an address that did not hold");
});

await check("keys and pasted text land in the focused field; Enter submits", async () => {
  const tab = await waitFor(() => fixtureTab("/admin"), "the fixture tab");
  v.click(150, 20);
  for (const ch of "ab") {
    v.say({ t: "key", type: "keyDown", key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch });
    v.say({ t: "key", type: "keyUp", key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0) });
  }
  v.say({ t: "text", text: "-pässwörd!" });
  await waitFor(async () => (await evaluate(tab, "document.getElementById('email').value")) === "ab-pässwörd!", "the typed and pasted value");
  v.say({ t: "key", type: "keyDown", key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
  v.say({ t: "key", type: "keyUp", key: "Enter", code: "Enter", keyCode: 13 });
  await v.until(() => v.seen.messages.some((m) => m.t === "page" && m.path === "/done"), "the form submitted");
  // The signed-in page held: now, and only now, it is said — once, for the token's store.
  await v.until(() => v.seen.messages.some((m) => m.t === "signed_in"), "signed in, once the page held", 5_000);
  assert.deepEqual(v.seen.messages.filter((m) => m.t === "signed_in"), [{ t: "signed_in", store: "fixture" }]);
  const done = await waitFor(() => fixtureTab("/done"), "the submitted page");
  assert.equal(await evaluate(done, "document.getElementById('email').textContent"), "ab-pässwörd!");
  v.say({ t: "nav", action: "back" });
  await v.until(() => v.seen.messages.filter((m) => m.t === "page" && m.path === "/admin").length >= 2, "back to the form");
});

await check("a pop-up the tab opens is shown while it is open, then the tab again", async () => {
  const form = await waitFor(() => fixtureTab("/admin"), "the form tab");
  await waitFor(async () => (await evaluate(form, "document.readyState + ':' + Boolean(document.getElementById('popup'))")) === "complete:true", "the form loaded");
  v.click(100, 220);
  await v.until(() => v.seen.messages.some((m) => m.t === "page" && m.path === "/popup"), "the pop-up shown");
  const before = v.seen.messages.filter((m) => m.t === "page" && m.path === "/admin").length;
  const popup = await waitFor(() => fixtureTab("/popup"), "the pop-up tab");
  await waitFor(async () => (await evaluate(popup, "document.readyState")) === "complete", "the pop-up loaded");
  const pagesBefore = v.seen.messages.filter((m) => m.t === "page").length;
  v.click(100, 20);
  await waitFor(async () => !(await fixtureTab("/popup")), "the pop-up closed");
  // The tab it returns to is read again and named (a sign-in window may have
  // moved it on) — and only then does input go to it.
  await v.until(() => v.seen.messages.slice(pagesBefore).some((m) => m.t === "page" && m.path === "/admin"), "the tab named again after the pop-up");
  // Back on the tab: input reaches it again.
  const tab = await fixtureTab("/admin");
  v.click(150, 20);
  v.say({ t: "text", text: "again" });
  await waitFor(async () => (await evaluate(tab, "document.getElementById('email').value")).endsWith("again"), "input on the tab after the pop-up");
  assert.ok(before >= 1);
});

await check("a second viewer replaces the first", async () => {
  const second = connect();
  await second.opened;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the first viewer stayed connected")), 5_000);
    v.ws.once("close", () => { clearTimeout(timer); resolve(); });
  });
  await second.until(() => second.seen.frames > 0, "a frame for the second viewer");
  second.ws.close();
});

await check("a viewer left without input closes itself, so a person who walked away holds no check out", async () => {
  const quiet = await startViewer({
    secret: SECRET, origins: [ORIGIN], cdp: CDP, port: 0, idleMs: 1_500,
    adminUrlFor: (store) => (store === "fixture" ? `${SITE}/admin` : null), doorLog: null, log: () => {},
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${quiet.port}/v1/view?token=${encodeURIComponent(token())}`, { origin: ORIGIN });
    const messages = [];
    ws.on("message", (data, binary) => { if (!binary) messages.push(JSON.parse(String(data))); });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    assert.equal(quiet.present(), true);
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    assert.ok(messages.some((m) => m.t === "error" && m.code === "idle"), JSON.stringify(messages));
    assert.equal(quiet.present(), false, "still present after it closed");
  } finally {
    await quiet.close();
  }
});

await viewer.close();
await browser.close();
site.close();
await rm(profile, { recursive: true, force: true });
console.log(failures ? `\nverify:live-view — ${failures} FAILED` : "\nverify:live-view — all passed");
process.exit(failures ? 1 : 0);
}

void main();
