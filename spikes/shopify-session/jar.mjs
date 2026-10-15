// CHE-464: a team's Shopify sign-in is its cookie jar (jar-rules.mjs). A
// team's container keeps no profile: its Durable Object keeps the jar, puts it
// into a fresh Chrome before anything navigates, and reads it back after every
// check, probe and sign-in. This is the container's half — one DevTools
// command to the browser itself for each.
//
// Values travel between the Durable Object and this container only. They are
// never logged and never written to this container's disk outside Chrome's own
// profile.

import WebSocket from "ws";
import { jarOf } from "./jar-rules.mjs";

export { describeJar, holdsSignIn, jarOf } from "./jar-rules.mjs";

// One command to the browser itself, on a connection of its own that closes
// at once: no target is attached, no tab is touched (CHE-461 round 3's way).
async function browserCommand(cdp, method, params, timeoutMs = 10_000) {
  const version = await (await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(5_000) })).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no answer`)), timeoutMs);
      ws.on("message", (raw) => {
        let message;
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (message.id !== 1) return;
        clearTimeout(timer);
        // The browser's own words about a refusal, never the params we sent.
        if (message.error) reject(new Error(`${method}: ${String(message.error.message ?? "refused").slice(0, 200)}`));
        else resolve(message.result ?? {});
      });
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

/** The team's jar, read out of the browser. */
export async function readJar(cdp) {
  const { cookies } = await browserCommand(cdp, "Storage.getCookies", {});
  return jarOf(cookies);
}

/** The team's jar, put into the browser. Only Shopify's cookies go in. */
export async function loadJar(cdp, jar) {
  const cookies = jarOf(jar);
  if (cookies.length) await browserCommand(cdp, "Storage.setCookies", { cookies });
  return cookies.length;
}
