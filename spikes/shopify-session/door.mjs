// CHE-419: what a person sees when they open session.checkmyapp.dev is one
// live tab — never a login form that died an hour ago, never a pile of tabs.
//
// Run by session-door.service, which session-door.path starts each time
// x11vnc accepts a viewer (-afteraccept writes /var/lib/session-door/connected
// — its own directory: x11vnc runs as session-browser, which may not enter
// /var/lib/session-host). The 2026-10-05 sign-in cost the owner forty minutes, the first
// of them on "The page you're looking for could not be found": the tab had
// sat on accounts.shopify.com/lookup?rid=… for an hour and Shopify had
// expired the rid.
//
// What it does (while a check holds the browser — the session server's lease
// is set — it only keeps or opens, and closes nothing):
//   - a tab already in the admin (admin.shopify.com) is kept;
//   - else a sign-in tab younger than STALE_MINUTES is kept — the person may
//     be in the middle of signing in, and a viewer reconnect must not wipe it;
//   - else a fresh tab is opened on the store's admin, which Shopify answers
//     with a fresh sign-in form when the session is gone;
//   - the other Shopify tabs and blank tabs are closed — but only those known
//     to have been open for MIN_CLOSE_MINUTES or more (a sign-in tab: for
//     STALE_MINUTES). The hourly probe's tab lives seconds, and a check that
//     takes the lease between our look at /state and our close loop opens its
//     tab after we looked: both are younger than that, so neither can be
//     closed (Codex on #283). A tab whose age could not be read is not closed.
//     The lease is asked again right before closing anything. The kept tab is
//     brought to the front. Tabs of other sites and Chrome's own UI targets
//     (*.top-chrome) are left alone.
//
// It never types, presses or reads anything inside a page beyond its address
// and how long ago it loaded.
//
// Environment:
//   SESSION_SERVER_TOKEN   bearer for the session server's /state (server.env)
//   DOOR_STORE_URL         default https://admin.shopify.com/store/prod-release-1
//   DOOR_CDP               default http://127.0.0.1:9222
//   DOOR_LOG               default /var/lib/session-host/door.jsonl
//   argv --plan            print the decision, change nothing

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const CDP = process.env.DOOR_CDP ?? "http://127.0.0.1:9222";
const STORE_URL = process.env.DOOR_STORE_URL ?? "https://admin.shopify.com/store/prod-release-1";
const LOG = process.env.DOOR_LOG ?? "/var/lib/session-host/door.jsonl";
const SERVER = "http://127.0.0.1:9090";
export const STALE_MINUTES = 20;
export const MIN_CLOSE_MINUTES = 2;

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
const isAdmin = (t) => hostOf(t.url) === "admin.shopify.com";
const isSignIn = (t) => hostOf(t.url) === "accounts.shopify.com";
const isBlank = (t) => t.url === "about:blank" || t.url.startsWith("chrome://newtab");
const isChromeUi = (t) => t.url.startsWith("chrome://") && !isBlank(t);

// The decision, apart from the browser: tabs (page targets in /json order, each
// with ageMinutes or null) → { keep, open, close }. Pure, so --plan and the
// self-test read the same rule the live run acts on.
export function plan(tabs, storeUrl = STORE_URL) {
  const pages = tabs.filter((t) => t.type === "page" && !isChromeUi(t));
  // The person's admin tab is the one that has been open longest — a probe's
  // or a check's is minutes old at most.
  const admins = pages.filter(isAdmin);
  const admin = [...admins].sort((a, b) => (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1))[0];
  const freshSignIn = pages.find((t) => isSignIn(t) && t.ageMinutes !== null && t.ageMinutes < STALE_MINUTES);
  const keep = admin ?? freshSignIn ?? null;
  const old = (t, minutes) => t.ageMinutes !== null && t.ageMinutes >= minutes;
  const closable = (t) =>
    (isSignIn(t) && old(t, STALE_MINUTES)) || ((isAdmin(t) || isBlank(t)) && old(t, MIN_CLOSE_MINUTES));
  const close = pages.filter((t) => t !== keep && closable(t)).map((t) => t.id);
  return { keep: keep?.id ?? null, open: keep ? null : storeUrl, close };
}

async function json(cdp, path, init) {
  const response = await fetch(`${cdp}${path}`, init);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.headers.get("content-type")?.includes("json") ? response.json() : response.text();
}

// How long ago the tab's document loaded, from the page's own clock.
function ageMinutes(target) {
  return new Promise((resolve) => {
    if (!target.webSocketDebuggerUrl) return resolve(null);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const done = (value) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* closing a socket that never opened */
      }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 5_000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "Date.now() - performance.timeOrigin", returnByValue: true } })),
    );
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== 1) return;
      const ms = message.result?.result?.value;
      done(typeof ms === "number" ? Math.round(ms / 60_000) : null);
    });
    ws.on("error", () => done(null));
  });
}

async function leaseHeldOverHttp() {
  const token = process.env.SESSION_SERVER_TOKEN;
  if (!token) throw new Error("SESSION_SERVER_TOKEN is not set");
  const response = await fetch(`${SERVER}/state`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`/state: HTTP ${response.status}`);
  const state = await response.json();
  return state.lease !== null;
}

// The door itself, shared by the VNC trigger (main) and the live view
// (viewer.mjs, which runs inside the session server and asks its lease book
// directly). Returns the log line; `keep` — the tab the person is given — is
// on it, unlogged, whenever one was kept or opened.
//
// While a check holds the browser nothing is closed (its tabs are never ours
// to touch), but the person is still given a tab: kept, or opened beside the
// check's — a new tab disturbs nobody.
export async function openDoor({ dry = false, cdp = CDP, leaseHeld = leaseHeldOverHttp, storeUrl = STORE_URL, log = LOG } = {}) {
  const at = new Date().toISOString();
  const line = { at };
  try {
    const held = await leaseHeld();
    if (held) line.skipped = "a check holds the browser";
    const targets = await json(cdp, "/json");
    const tabs = [];
    for (const t of targets) {
      if (t.type !== "page" || isChromeUi(t)) continue;
      const relevant = isAdmin(t) || isSignIn(t) || isBlank(t);
      tabs.push({ id: t.id, type: t.type, url: t.url, ageMinutes: relevant ? await ageMinutes(t) : null });
    }
    const decision = plan(tabs, storeUrl);
    if (held) decision.close = [];
    line.tabs = tabs.map((t) => ({ host: hostOf(t.url) || t.url.slice(0, 20), age: t.ageMinutes }));
    line.decision = { keep: decision.keep !== null, open: decision.open !== null, close: decision.close.length };
    if (!dry) {
      // Asked again: a check that took the lease while we measured ages is
      // left its browser. (Its tab would be too young to close anyway.)
      if (decision.close.length && (await leaseHeld())) {
        line.skipped = "a check took the browser while the tabs were read";
        decision.close = [];
      }
      let keep = decision.keep;
      if (decision.open) keep = (await json(cdp, `/json/new?${decision.open}`, { method: "PUT" })).id;
      for (const id of decision.close) await json(cdp, `/json/close/${id}`).catch(() => {});
      if (keep) await json(cdp, `/json/activate/${keep}`).catch(() => {});
      if (keep) Object.defineProperty(line, "keep", { value: keep, enumerable: false });
    }
  } catch (error) {
    line.error = String(error.message).split("\n")[0].slice(0, 200);
  }
  if (dry) line.dry = true;
  if (!dry && log) await appendFile(log, JSON.stringify(line) + "\n").catch(() => {});
  return line;
}

async function main() {
  const line = await openDoor({ dry: process.argv.includes("--plan") });
  console.log(JSON.stringify(line));
  // A failure is a failed run, so session-door.service tries again (Restart=
  // on-failure, a few times) instead of spending the viewer's connect on it
  // (Codex on #283). "A check holds the browser" is not a failure.
  if (line.error) process.exitCode = 1;
}

// Self-test of the rule: node door.mjs --self-test
function selfTest() {
  const t = (id, url, ageMinutes = null) => ({ id, type: "page", url, ageMinutes });
  const cases = [
    ["signed in: keep the admin, close an old blank and a stale sign-in", [t("a", "https://admin.shopify.com/store/x", 300), t("b", "about:blank", 30), t("c", "https://accounts.shopify.com/lookup?rid=1", 90)], { keep: "a", open: null, close: ["b", "c"] }],
    ["a stale sign-in only: open a fresh one, close the stale", [t("c", "https://accounts.shopify.com/lookup?rid=1", 61)], { keep: null, open: STORE_URL, close: ["c"] }],
    ["a sign-in five minutes old: keep it (the person may be typing)", [t("c", "https://accounts.shopify.com/login?rid=2", 5)], { keep: "c", open: null, close: [] }],
    ["a sign-in whose age could not be read: not trusted as fresh, and not closed either", [t("c", "https://accounts.shopify.com/login?rid=2", null)], { keep: null, open: STORE_URL, close: [] }],
    ["nothing at all: open the store", [], { keep: null, open: STORE_URL, close: [] }],
    ["Chrome's own UI and other sites are left alone", [t("a", "https://admin.shopify.com/store/x", 300), t("u", "chrome://tab-search.top-chrome/"), t("d", "https://help.shopify.com/en")], { keep: "a", open: null, close: [] }],
    ["two old admin tabs: keep the one open longest, close the other", [t("b", "https://admin.shopify.com/store/x/apps", 40), t("a", "https://admin.shopify.com/store/x", 300)], { keep: "a", open: null, close: ["b"] }],
    // Codex on #283: the probe's tab (seconds old) and a check's tab opened
    // after we looked at /state are young — never closed.
    ["a probe's or a check's fresh admin tab beside the person's: kept open", [t("a", "https://admin.shopify.com/store/x", 300), t("p", "https://admin.shopify.com/store/x/apps/app", 0)], { keep: "a", open: null, close: [] }],
    ["a check's fresh blank tab: kept open", [t("a", "https://admin.shopify.com/store/x", 300), t("n", "about:blank", 0)], { keep: "a", open: null, close: [] }],
    ["a tab whose age could not be read is never closed", [t("a", "https://admin.shopify.com/store/x", 300), t("q", "about:blank", null)], { keep: "a", open: null, close: [] }],
  ];
  let failed = 0;
  for (const [name, tabs, want] of cases) {
    const got = plan(tabs);
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  →  ${JSON.stringify(got)}`}`);
  }
  console.log(failed ? `door: ${failed} FAILED` : "door: all passed");
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-test")) selfTest();
  else main();
}
