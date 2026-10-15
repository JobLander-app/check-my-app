// CHE-378: is the human-signed-in Shopify admin session on this host still
// alive? Run hourly by session-probe.timer on checkmyapp-session-host.
//
// Attaches to the Chrome the owner signed into (DevTools on 127.0.0.1:9222),
// opens ONE new tab on the embedded app, classifies what it lands on, closes
// that tab, and appends one line to the log:
//
//   {"at","state","url_host","url_path","ms"[,"challenge"][,"notified"][,"detail"]}
//
// state: ok | login_page | captcha | 2fa | error (classify.mjs).
//
// The browser itself is never closed or navigated: it is the owner's session,
// and the probe is a visitor in it. On the way down from ok it sends the owner
// ONE Telegram message through @checkmyapp_bot (skill checkmyapp-owner-channel);
// the bot token is read from Secret Manager with this VM's service account, which
// can read that one secret and nothing else.
//
// Environment (all optional):
//   PROBE_CDP   DevTools endpoint      default http://127.0.0.1:9222
//   PROBE_LOG   JSONL log              default /var/lib/session-host/probe.jsonl
//               "-" (CHE-464, a team's container): print the line and nothing
//               else — no log, no message. The team's Durable Object keeps the
//               history and decides who hears about it.
//   PROBE_URL   what to open           default classify.mjs TARGET_URL

import { appendFile, readFile } from "node:fs/promises";
import { request } from "node:http";
import { chromium } from "playwright-core";
import { observe, parseLog, proxyMessage, proxyState, shouldNotify } from "./classify.mjs";

const CDP = process.env.PROBE_CDP ?? "http://127.0.0.1:9222";
const LOG = process.env.PROBE_LOG ?? "/var/lib/session-host/probe.jsonl";
const OWNER_CHAT = "101333337";
const SECRET = "checkmyapp-telegram-bot-token";
const SESSION_URL = process.env.PROBE_SIGN_IN_URL ?? "https://session.checkmyapp.dev";
// The local forward proxy Chrome goes out through (tinyproxy → IPRoyal).
const PROXY = process.env.PROBE_PROXY ?? "http://127.0.0.1:3128";

const METADATA = "http://metadata.google.internal/computeMetadata/v1";

async function metadata(path) {
  const response = await fetch(`${METADATA}/${path}`, { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error(`metadata ${path}: HTTP ${response.status}`);
  return response;
}

async function botToken() {
  const { access_token } = await (await metadata("instance/service-accounts/default/token")).json();
  const project = await (await metadata("project/project-id")).text();
  const response = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${SECRET}/versions/latest:access`,
    { headers: { authorization: `Bearer ${access_token}` } },
  );
  if (!response.ok) throw new Error(`secret manager: HTTP ${response.status}`);
  const { payload } = await response.json();
  return Buffer.from(payload.data, "base64").toString("utf8").trim();
}

const REASON = {
  login_page: "Shopify показывает страницу входа",
  captcha: "Shopify показывает капчу",
  "2fa": "Shopify просит код двухфакторной проверки",
  error: "проба второй час подряд не может открыть админку",
};

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

// Returns an error description, or null when the message went out. The
// description never contains the request URL — it carries the bot token.
//
// CHE-419: the message says what the person will meet, so the sign-in takes a
// minute and not forty (2026-10-05): the link is the app's sign-in page on
// checkmyapp.dev (PROBE_SIGN_IN_URL), the form is already open and fresh
// (door.mjs), a passkey request fails at once instead of opening a window
// (viewer.mjs), and paste is the person's own browser's.
async function notifyOwner(state, at, proxyStatus) {
  let token;
  try {
    token = await botToken();
  } catch (error) {
    return `token: ${error.message}`;
  }
  const text = state === "proxy" ? proxyMessage(proxyStatus, at) :
    `Сессия Shopify admin на session host закончилась: ${REASON[state] ?? state} (${at}).\n` +
    `Нужно войти заново (vladislav@otp.plus): ${SESSION_URL}\n` +
    `Форма входа откроется сама, пароль вставляется как обычно (Cmd+V).\n` +
    `Отвечать не нужно — проба сама увидит, что сессия снова жива.`;
  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chat_id: OWNER_CHAT, text, disable_web_page_preview: "true" }),
    });
    return response.ok ? null : `telegram HTTP ${response.status}`;
  } catch {
    return "telegram unreachable";
  }
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

  if (LOG === "-") {
    console.log(JSON.stringify(line));
    process.exit(0);
  }

  const history = parseLog(await readFile(LOG, "utf8").catch(() => ""));
  if (shouldNotify(history, line.state)) {
    const failure = await notifyOwner(line.state, at, line.proxy_status);
    line.notified = failure === null;
    if (failure) line.notify_error = failure;
  }

  await appendFile(LOG, JSON.stringify(line) + "\n");
  console.log(JSON.stringify(line));
  // Not browser.close(): this is the owner's Chrome. Dropping the DevTools
  // connection is all the cleanup a visitor does.
  process.exit(0);
}

main();
