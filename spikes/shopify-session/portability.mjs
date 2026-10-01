// CHE-378, daily: does the session the owner signed into on the session host
// work anywhere else? Run from our side (an agent's machine), never on the VM —
// the VM must not hold a Cloudflare credential, and this machine must not hold
// the session.
//
//   1. An IAP SSH tunnel to the host's DevTools (127.0.0.1:9222 on the VM,
//      bound to loopback there, so only SSH reaches it).
//   2. Read the cookies the host's Chrome would send to admin.shopify.com, with
//      one raw CDP call (see cdpCall for why not Playwright on this side).
//      They live in this process's memory only: never written to disk here,
//      never logged — the log line carries a count, nothing else.
//   3. A fresh Cloudflare Browser Run session (remote CDP over WebSocket, the
//      same account our checker runs in), a new context, those cookies, the
//      same URL the hourly probe opens, the same classifier.
//   4. One line {at, kind:"portability", state, accepted, cookies, url_host,
//      url_path, ms} printed here and appended to
//      /var/lib/session-host/portability.jsonl on the host, next to probe.jsonl,
//      so a week's evidence sits in one place.
//
// accepted = the fresh browser landed on the embedded app (state "ok"). It is
// only meaningful while the host itself is signed in: read it next to the
// probe.jsonl line of the same hour.
//
// Usage (from the check-my-app checkout, which has playwright-core installed):
//   node --env-file=.env spikes/shopify-session/portability.mjs
//
// Environment:
//   CLOUDFLARE_API_TOKEN   required; needs Browser Rendering - Edit
//   CLOUDFLARE_ACCOUNT_ID  default 491c314890616555d6f741f1c8d57232

import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { observe } from "./classify.mjs";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "491c314890616555d6f741f1c8d57232";
const VM = ["checkmyapp-session-host", "--zone", "europe-west1-b", "--project", "meet-assistant-6d8ad", "--tunnel-through-iap"];
const LOCAL_PORT = 19222;
const REMOTE_LOG = "/var/lib/session-host/portability.jsonl";

/**
 * Chrome's /json/version names the WebSocket on the VM's own loopback port;
 * through the tunnel the same socket is on LOCAL_PORT. Pure, for the verify
 * script.
 */
export function tunnelledWsEndpoint(version, localPort = LOCAL_PORT) {
  const ws = new URL(version.webSocketDebuggerUrl);
  ws.hostname = "127.0.0.1";
  ws.port = String(localPort);
  return ws.toString();
}

function openTunnel() {
  const child = spawn(
    "gcloud",
    ["compute", "ssh", ...VM, "--", "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${LOCAL_PORT}:127.0.0.1:9222`],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.lastError = () => stderr.split("\n").filter((l) => l && !/numpy|tcp_upload_bandwidth|^WARNING/i.test(l)).slice(-2).join(" ");
  return child;
}

async function waitForDevtools(tunnel, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tunnel.exitCode !== null) throw new Error(`tunnel exited: ${tunnel.lastError()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${LOCAL_PORT}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("DevTools did not answer through the tunnel");
}

/**
 * Pure: the host's cookies (CDP Network.Cookie) that admin.shopify.com would be
 * sent, in the shape Playwright's addCookies takes.
 */
export function cookiesForAdmin(cdpCookies) {
  const host = "admin.shopify.com";
  return cdpCookies
    .filter((c) => (c.domain.startsWith(".") ? host.endsWith(c.domain) || host === c.domain.slice(1) : host === c.domain))
    .map((c) => {
      const cookie = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.session || !(c.expires > 0) ? -1 : c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
      };
      if (["Strict", "Lax", "None"].includes(c.sameSite)) cookie.sameSite = c.sameSite;
      return cookie;
    });
}

// One raw CDP call over one WebSocket, closed cleanly — deliberately not
// Playwright here. Playwright's connectOverCDP turns on target auto-attach with
// waitForDebuggerOnStart, and on 2026-10-01 the IAP tunnel's sshd kept that
// connection open after this script exited: every tab opened afterwards (the
// hourly probe's included) sat paused at about:blank waiting for a debugger that
// was gone, and the probe logged "page.goto: Timeout". A plain Storage call
// attaches to nothing, so even a lingering socket cannot stall the owner's
// browser.
async function cdpCall(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools WebSocket failed")), { once: true });
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

async function readHostCookies() {
  const tunnel = openTunnel();
  try {
    const version = await waitForDevtools(tunnel);
    // Storage.getCookies on the browser target: the default context, i.e. the
    // profile the owner signed into.
    const { cookies } = await cdpCall(tunnelledWsEndpoint(version), "Storage.getCookies");
    return cookiesForAdmin(cookies);
  } finally {
    tunnel.kill("SIGTERM");
  }
}

async function tryInCloudflare(cookies) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set");
  const endpoint = `wss://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/devtools/browser?keep_alive=120000`;
  const browser = await chromium.connectOverCDP(endpoint, { headers: { authorization: `Bearer ${token}` }, timeout: 60_000 });
  try {
    const context = await browser.newContext();
    if (cookies.length) await context.addCookies(cookies);
    const page = await context.newPage();
    return await observe(page);
  } finally {
    // This one is ours: a Cloudflare session we opened and pay for.
    await browser.close().catch(() => {});
  }
}

function appendOnHost(line) {
  return new Promise((resolve) => {
    const child = spawn(
      "gcloud",
      ["compute", "ssh", ...VM, "--command", `sudo -u session-host tee -a ${REMOTE_LOG} >/dev/null`],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    child.on("exit", (code) => resolve(code === 0));
    child.stdin.end(JSON.stringify(line) + "\n");
  });
}

async function main() {
  const at = new Date().toISOString();
  const started = Date.now();
  let line;
  try {
    const cookies = await readHostCookies();
    const observed = await tryInCloudflare(cookies);
    line = { at, kind: "portability", state: observed.state, accepted: observed.state === "ok", cookies: cookies.length, url_host: observed.url_host, url_path: observed.url_path, ms: Date.now() - started };
    if (observed.challenge) line.challenge = observed.challenge;
  } catch (error) {
    line = { at, kind: "portability", state: "error", accepted: false, ms: Date.now() - started, detail: String(error.message).split("\n")[0].slice(0, 200) };
  }
  line.logged_on_host = await appendOnHost(line);
  console.log(JSON.stringify(line));
  process.exit(line.state === "error" ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
