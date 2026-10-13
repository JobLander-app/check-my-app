// CHE-378 / CHE-464: is the team's Shopify sign-in still alive? One look,
// one line. Run by the session server (runner.mjs probe) in a process of its
// own, when the team's Durable Object asks — hourly.
//
// Attaches to the team's Chrome (DevTools on 127.0.0.1:9222), opens ONE new
// tab on the team's app, classifies what it lands on, closes that tab, and
// prints one line:
//
//   {"at","state","url_host","url_path","ms"[,"challenge"][,"detail"][,"proxy_status"]}
//
// state: ok | login_page | captcha | 2fa | error | proxy (classify.mjs).
//
// The browser itself is never closed or navigated: the probe is a visitor in
// it. The Durable Object keeps the history and decides who hears about it
// (src/agent/session-jar.ts recordProbe).
//
// Environment:
//   PROBE_URL   what to open           default classify.mjs TARGET_URL
//   PROBE_CDP   DevTools endpoint      default http://127.0.0.1:9222

import { request } from "node:http";
import { chromium } from "playwright-core";
import { observe, proxyState } from "./classify.mjs";

const CDP = process.env.PROBE_CDP ?? "http://127.0.0.1:9222";
// The local forwarder Chrome goes out through (forwarder.mjs → IPRoyal).
const PROXY = "http://127.0.0.1:3128";

// CHE-453: ask the proxy itself, over plain HTTP, whether it carries anything.
// A forward-proxy GET of an http:// address: the proxy's own status comes back
// (402 when IPRoyal's traffic is used up), not a tunnel failure with no reason.
function proxyStatus() {
  return new Promise((resolve) => {
    const proxy = new URL(PROXY);
    const req = request(
      { host: proxy.hostname, port: Number(proxy.port), method: "GET", path: "http://example.com/", headers: { host: "example.com" }, timeout: 20_000 },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function main() {
  const at = new Date().toISOString();
  const started = Date.now();
  let result;
  let page;
  try {
    const browser = await chromium.connectOverCDP(CDP, { timeout: 30_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("no default browser context");
    page = await context.newPage();
    result = await observe(page, process.env.PROBE_URL ? { url: process.env.PROBE_URL } : {});
  } catch (error) {
    result = { state: "error", url_host: null, url_path: null, detail: String(error.message).split("\n")[0].slice(0, 200) };
  } finally {
    await page?.close().catch(() => {});
  }
  // An error may be the proxy, not the session: ask it before naming a cause.
  if (result.state === "error") {
    const status = await proxyStatus();
    if (proxyState(status)) result = { ...result, state: "proxy", proxy_status: status };
  }

  const line = { at, state: result.state, url_host: result.url_host, url_path: result.url_path, ms: Date.now() - started };
  if (result.challenge) line.challenge = result.challenge;
  if (result.detail) line.detail = result.detail;
  if (result.proxy_status) line.proxy_status = result.proxy_status;
  console.log(JSON.stringify(line));
  // Not browser.close(): the browser is the team's. Dropping the DevTools
  // connection is all the cleanup a visitor does.
  process.exit(0);
}

main();
