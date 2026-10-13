// CHE-464: move the live Shopify sign-in from the session host's Chrome (the
// GCP VM) into a team's own session browser — nobody signs in again (CHE-437).
//
// CHE-461 round 3's path: an IAP SSH tunnel to the host's DevTools, one raw
// Storage.getCookies on the browser target (no tab is attached, nothing is
// navigated), the team's jar picked out (jar-rules.mjs: Shopify's cookies
// only), and POSTed to the agent worker's /session/jar with our admin bearer.
// The values live in this process's memory only: never printed, never written
// to disk. What is printed is jar-rules.mjs describeJar — names and a count.
//
//   SESSION_ADMIN_TOKEN=… node scripts/session-jar-import.mjs <teamId> [agent-url]
//
// agent-url defaults to the agent worker's workers.dev address.

import { spawn } from "node:child_process";
import { describeJar, holdsSignIn, jarOf } from "../spikes/shopify-session/jar-rules.mjs";

const [teamId, agentUrl = "https://checkmyapp-agent.frosty-fog-32a2.workers.dev"] = process.argv.slice(2);
const admin = process.env.SESSION_ADMIN_TOKEN?.trim();
if (!teamId || !admin) {
  console.error("usage: SESSION_ADMIN_TOKEN=… node scripts/session-jar-import.mjs <teamId> [agent-url]");
  process.exit(2);
}

const VM = ["checkmyapp-session-host", "--zone", "europe-west1-b", "--project", "meet-assistant-6d8ad", "--tunnel-through-iap"];
const LOCAL_PORT = 19225;
const tunnel = spawn("gcloud", ["compute", "ssh", ...VM, "--", "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${LOCAL_PORT}:127.0.0.1:9222`], { stdio: "ignore" });

try {
  let version;
  for (let i = 0; i < 90 && !version; i++) {
    if (tunnel.exitCode !== null) throw new Error("the IAP tunnel exited");
    try {
      const response = await fetch(`http://127.0.0.1:${LOCAL_PORT}/json/version`);
      if (response.ok) version = await response.json();
    } catch {
      /* not up yet */
    }
    if (!version) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!version) throw new Error("the host's DevTools did not answer");
  const address = new URL(version.webSocketDebuggerUrl);
  address.hostname = "127.0.0.1";
  address.port = String(LOCAL_PORT);
  const ws = new WebSocket(address.toString());
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("the DevTools socket did not open")), { once: true });
  });
  const { cookies } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Storage.getCookies: no answer")), 30_000);
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.error) reject(new Error(`Storage.getCookies: ${message.error.message}`));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
  });
  ws.close();

  const jar = jarOf(cookies);
  console.log(`[import] from the host's Chrome (${version.Browser}): ${JSON.stringify(describeJar(jar))}`);
  if (!holdsSignIn(jar)) throw new Error("the host's jar holds no sign-in — nothing to move");

  const response = await fetch(`${agentUrl.replace(/\/+$/, "")}/session/jar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
    body: JSON.stringify({ teamId, cookies: jar }),
  });
  console.log(`[import] into ${teamId}: HTTP ${response.status} ${await response.text()}`);
  if (!response.ok) process.exitCode = 1;
} finally {
  tunnel.kill("SIGTERM");
}
