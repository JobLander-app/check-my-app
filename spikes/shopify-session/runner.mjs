// CHE-464: one team's Shopify session browser, in a Cloudflare Container. The
// session host's stack (README.md) without the host: a display, the
// residential forwarder, Chrome started as a plain process with the host's
// flags, and the same session server and live view in front of it. One
// container per team, started and fed by the team's Durable Object
// (src/agent/session-runner.ts), which is the only thing that can reach it.
//
// Why a plain process (CHE-461 round 2): google-chrome-stable started this way
// reaches accounts.shopify.com without a challenge; Chromium launched by
// Playwright gets Cloudflare's Turnstile. Playwright only ever attaches over
// DevTools afterwards — the session server, the live view and the probe.
//
// What differs from the host: no profile is kept (the team's sign-in is its
// cookie jar — jar.mjs — put in by the Durable Object before anything is let
// through), no VNC, no tunnel, no firewall (DevTools stays on loopback and
// every way in asks for the Durable Object's bearer or a view token).
//
// Environment, read once and removed before Chrome starts (Chrome gets an
// environment of its own with none of it):
//   SESSION_SERVER_TOKEN   the Durable Object's bearer for this start (required)
//   SESSION_VIEW_SECRET    this team's view key (src/lib/session-view.ts viewKeyFor)
//   SESSION_SLOT           the team's id — the slot a view token must name
//   VIEW_ORIGINS           the pages a live view may be opened from
//   PROXY_URL              the residential upstream, this team's sticky session; unset = direct

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startForwarder } from "./forwarder.mjs";
import { startSessionServer } from "./session-server.mjs";
import { startViewer } from "./viewer.mjs";
import { loadJar, readJar } from "./jar.mjs";

const CDP = "http://127.0.0.1:9222";
const DISPLAY = ":99";
const PROBE = fileURLToPath(new URL("./probe.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const take = (name) => {
  const value = process.env[name];
  delete process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
const token = take("SESSION_SERVER_TOKEN");
const viewSecret = take("SESSION_VIEW_SECRET");
const slot = take("SESSION_SLOT");
const origins = (take("VIEW_ORIGINS") ?? "https://checkmyapp.dev").split(",").map((o) => o.trim()).filter(Boolean);
const proxyUrl = take("PROXY_URL");
// Never the secrets — only whether they arrived.
console.log(`[runner] boot node=${process.version} token=${token?.length ?? 0}ch view=${viewSecret?.length ?? 0}ch slot=${slot ? "set" : "none"} proxy=${proxyUrl ? "set" : "direct"}`);

// Anything of ours dying takes the container with it: the Durable Object sees
// it stop and starts a fresh one with the jar, instead of handing checks a
// browser that is not there.
function essential(name, child) {
  child.on("exit", (code, signal) => {
    console.error(`[runner] ${name} exited (${code ?? signal}); the container ends`);
    process.exit(1);
  });
  return child;
}

async function until(what, test, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`${what} did not come up in ${ms / 1000}s`);
}

essential("Xvfb", spawn("Xvfb", [DISPLAY, "-screen", "0", "1366x900x24", "-nolisten", "tcp"], { stdio: "ignore" }));
await until("the display", async () => existsSync("/tmp/.X11-unix/X99"), 20_000);

if (proxyUrl) {
  const forwarder = await startForwarder({ upstream: proxyUrl });
  console.log(`[runner] forwarder on 127.0.0.1:${forwarder.port}`);
}

// The session host's flags (systemd/session-chrome.service), a profile that
// lives as long as this container, and a blank first tab: nothing navigates
// before the team's jar is in. --disable-dev-shm-usage: a container's /dev/shm
// is small and an admin tab outgrows it; nothing a page can observe.
const home = "/tmp/chrome-home";
mkdirSync(home, { recursive: true });
const flags = [
  "--user-data-dir=/tmp/chrome-profile",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=9222",
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
  "--hide-crash-restore-bubble",
  "--window-position=0,0",
  "--window-size=1366,900",
  "--start-maximized",
  "--disable-dev-shm-usage",
  ...(proxyUrl ? ["--proxy-server=http://127.0.0.1:3128"] : []),
  "about:blank",
];
essential(
  "Chrome",
  spawn("/usr/bin/google-chrome-stable", flags, {
    env: { DISPLAY, HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "en_US.UTF-8", TZ: "UTC" },
    stdio: ["ignore", "ignore", "ignore"],
  }),
);
await until("Chrome's DevTools", async () => (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2_000) })).ok, 60_000);

// The hourly look at the admin: probe.mjs in a process of its own, as on the
// host, so its DevTools connection is gone the moment it has answered (an
// abandoned one leaves every new tab paused — README, the 2026-10-01 note).
function probe(url) {
  return new Promise((resolve) => {
    let address;
    try {
      address = new URL(url);
    } catch {
      address = null;
    }
    if (!address || address.protocol !== "https:" || address.hostname !== "admin.shopify.com") {
      resolve({ at: new Date().toISOString(), state: "error", url_host: null, url_path: null, ms: 0, detail: "not an admin address" });
      return;
    }
    execFile(
      process.execPath,
      [PROBE],
      { env: { PATH: process.env.PATH, PROBE_LOG: "-", PROBE_URL: address.toString(), PROBE_CDP: CDP }, timeout: 180_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const last = String(stdout ?? "").trim().split("\n").pop();
        try {
          resolve(JSON.parse(last));
        } catch {
          resolve({ at: new Date().toISOString(), state: "error", url_host: null, url_path: null, ms: 0, detail: String(error?.message ?? "no line").split("\n")[0].slice(0, 200) });
        }
      },
    );
  });
}

let viewer = null;
const server = await startSessionServer({
  token,
  cdp: CDP,
  port: 9090,
  host: "0.0.0.0",
  probeLog: "/dev/null",
  personPresent: () => viewer?.present() ?? false,
  jar: { load: (cookies) => loadJar(CDP, cookies), read: () => readJar(CDP) },
  probe,
});
console.log(`[runner] session server on :${server.port}`);
if (viewSecret && slot) {
  viewer = await startViewer({
    secret: viewSecret,
    origins,
    cdp: CDP,
    port: 9091,
    host: "0.0.0.0",
    slot,
    leaseHeld: async () => server.book.current() !== null,
    doorLog: null,
  });
  console.log(`[runner] live view on :${viewer.port}`);
}
process.on("SIGTERM", () => void Promise.all([server.close(), viewer?.close()]).finally(() => process.exit(0)));
