// CHE-389: lets one check at a time work inside the Chrome a person signed in
// to on this host. Runs on checkmyapp-session-host as session-server.service,
// bound to loopback; the only way in from outside is the Cloudflare tunnel's
// second hostname, behind an Access service token, and then this server's own
// bearer token — two secrets held by the agent Worker and nobody else.
//
//   GET    /state                         who holds the lease, is Chrome up, the last probe line
//   POST   /lease   {ownerRunId, maxDurationSeconds}   take or renew → {sessionId, expiresAt, browser}
//   DELETE /lease   {ownerRunId}          give it back; the check's tabs are closed
//   WS     /v1/devtools/browser/<sessionId>   DevTools, filtered (lease.mjs)
//
// The WebSocket address is the one the extension runner serves, so the Worker
// reaches this browser with the client it already has.
//
// The server never starts, stops or navigates Chrome. It forwards a check's
// DevTools messages, refuses the ones that would end the person's session, and
// closes the tabs the check opened when the check goes away — including when it
// goes away without saying so. An abandoned DevTools connection is not
// harmless here: Playwright attaches with waitForDebuggerOnStart, and while
// such a connection stays open every new tab sits paused at about:blank
// (README.md, the 2026-10-01 note).
//
// Environment:
//   SESSION_SERVER_TOKEN   bearer token, at least 32 characters (required)
//   SESSION_SERVER_PORT    default 9090
//   SESSION_SERVER_CDP     default http://127.0.0.1:9222
//   PROBE_LOG              default /var/lib/session-host/probe.jsonl

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { LeaseBook, Owned, acknowledged, refusal, sessionIdFromPath } from "./lease.mjs";
import { parseLog } from "./classify.mjs";

const MAX_MESSAGE = 64 * 1024 * 1024;
const PRIVATE_ID_BASE = -1_000_000;

export async function startSessionServer({
  token,
  cdp = "http://127.0.0.1:9222",
  port = 9090,
  host = "127.0.0.1",
  probeLog = "/var/lib/session-host/probe.jsonl",
  now = Date.now,
  heartbeatMs = 20_000,
  sweepMs = 5_000,
  closeWaitMs = 2_000,
} = {}) {
  if (typeof token !== "string" || token.length < 32) throw new Error("A bearer token of at least 32 characters is required");
  const book = new LeaseBook(now);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  let connection = null; // at most one: { sessionId, end() }

  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (req) => {
    const value = Buffer.from(req.headers.authorization ?? "");
    return value.length === expected.length && timingSafeEqual(value, expected);
  };

  // Asked afresh every time: a restarted Chrome has a new DevTools address.
  async function chrome() {
    const response = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`DevTools answered HTTP ${response.status}`);
    const version = await response.json();
    return { browser: version.Browser ?? null, ws: version.webSocketDebuggerUrl };
  }

  async function lastProbe() {
    const lines = parseLog(await readFile(probeLog, "utf8").catch(() => ""));
    const last = lines[lines.length - 1];
    return last ? { at: last.at, state: last.state } : null;
  }

  const view = (lease) => ({ sessionId: lease.sessionId, ownerRunId: lease.ownerRunId, expiresAt: new Date(lease.expiresAt).toISOString() });

  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error("Request too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(401).end();
      return;
    }
    const send = (status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    try {
      const path = new URL(req.url, "http://session").pathname;
      if (req.method === "GET" && path === "/state") {
        const lease = book.current();
        const browser = await chrome().then((c) => c.browser, () => null);
        send(200, { lease: lease ? view(lease) : null, connected: Boolean(connection), browser, probe: await lastProbe() });
      } else if (req.method === "POST" && path === "/lease") {
        const input = await body(req);
        // Before the lease, not after: a lease on a browser that is not there
        // would hold every other check out for nothing.
        let browser;
        try {
          browser = (await chrome()).browser;
        } catch {
          send(503, { error: "The browser on the session host is not running" });
          return;
        }
        const taken = book.take(input.ownerRunId, input.maxDurationSeconds);
        if (!taken.ok) {
          send(taken.status, { error: taken.error, ...(taken.heldUntil ? { heldUntil: new Date(taken.heldUntil).toISOString() } : {}) });
          return;
        }
        send(200, { ...view(taken.lease), browser });
      } else if (req.method === "DELETE" && path === "/lease") {
        const input = await body(req);
        const held = book.current();
        const released = book.release(input.ownerRunId);
        if (!released.ok) {
          send(released.status, { error: released.error });
          return;
        }
        if (released.released && connection?.sessionId === held.sessionId) await connection.end();
        send(200, { released: released.released });
      } else {
        res.writeHead(404).end();
      }
    } catch (error) {
      send(422, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.on("upgrade", async (req, socket, head) => {
    const sessionId = sessionIdFromPath(new URL(req.url, "http://session").pathname);
    if (!authorized(req) || !book.admits(sessionId)) {
      socket.destroy();
      return;
    }
    socket.on("error", () => {});
    try {
      // The same run connecting again (its next phase, or a retry of a step
      // whose Worker died) takes over: the old connection's tabs are closed
      // first, so the new one starts in a profile with nothing of ours in it.
      if (connection) await connection.end();
      const upstream = new WebSocket((await chrome()).ws, { maxPayload: MAX_MESSAGE });
      await new Promise((resolve, reject) => {
        upstream.once("open", resolve);
        upstream.once("error", reject);
      });
      if (!book.admits(sessionId)) {
        upstream.close();
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => attach(client, upstream, sessionId));
    } catch {
      socket.destroy();
    }
  });

  function attach(client, upstream, sessionId) {
    const owned = new Owned();
    let allGone = null; // set while the connection's tabs are being closed
    let ending = null;
    let alive = true;

    // Close what this check opened, then let go of the browser. Runs once, for
    // every way a connection can end.
    const end = () => {
      ending ??= (async () => {
        if (connection === self) connection = null;
        clearInterval(heartbeat);
        if (upstream.readyState === WebSocket.OPEN && owned.targets.size > 0) {
          // "Closed" is the tab being gone, not Chrome agreeing to close it:
          // the answer to closeTarget comes first, and the next check must not
          // connect in between. Target discovery is what reports the tab gone.
          let id = PRIVATE_ID_BASE;
          const ask = (method, params) => upstream.send(JSON.stringify({ id: id--, method, params }));
          const gone = new Promise((resolve) => { allGone = resolve; });
          ask("Target.setDiscoverTargets", { discover: true });
          for (const targetId of owned.targets) ask("Target.closeTarget", { targetId });
          await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, closeWaitMs))]);
        }
        upstream.close();
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close();
      })();
      return ending;
    };
    const self = { sessionId, end };
    connection = self;

    client.on("message", (data, binary) => {
      if (ending) return;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const action = owned.outgoing(message);
      if (action === "disconnect") {
        client.send(JSON.stringify(acknowledged(message)));
        void end();
        return;
      }
      if (action === "refuse") {
        client.send(JSON.stringify(refusal(message)));
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    });

    upstream.on("message", (data, binary) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Answers to the server's own closing questions are nobody else's.
      if (typeof message.id === "number" && message.id <= PRIVATE_ID_BASE) return;
      const known = new Set(owned.targets);
      owned.incoming(message);
      if (allGone) {
        // Discovery, switched on to see the tabs go, can also reveal one of
        // ours nobody had reported yet (a tab opened by the check's tab).
        for (const targetId of owned.targets) {
          if (!known.has(targetId)) upstream.send(JSON.stringify({ id: PRIVATE_ID_BASE - 1_000, method: "Target.closeTarget", params: { targetId } }));
        }
        if (owned.targets.size === 0) allGone();
      }
      if (!ending && client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });

    client.on("pong", () => { alive = true; });
    // A Worker that died mid-step closes nothing. Two missed beats and the
    // connection is treated as gone.
    const heartbeat = setInterval(() => {
      if (!alive) {
        client.terminate();
        void end();
        return;
      }
      alive = false;
      if (client.readyState === WebSocket.OPEN) client.ping();
    }, heartbeatMs);
    heartbeat.unref();

    client.on("close", () => void end());
    client.on("error", () => void end());
    upstream.on("close", () => void end());
    upstream.on("error", () => void end());
  }

  // A lease that ran out takes its connection with it.
  const sweep = setInterval(() => {
    if (connection && !book.admits(connection.sessionId)) void connection.end();
  }, sweepMs);
  sweep.unref();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    port: server.address().port,
    book,
    async close() {
      clearInterval(sweep);
      if (connection) await connection.end();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.SESSION_SERVER_TOKEN;
  delete process.env.SESSION_SERVER_TOKEN;
  // Never the token itself — only whether one arrived.
  console.log(`[session-server] boot node=${process.version} token=${typeof token === "string" ? token.length : 0}ch`);
  const started = await startSessionServer({
    token,
    port: Number(process.env.SESSION_SERVER_PORT ?? 9090),
    cdp: process.env.SESSION_SERVER_CDP ?? "http://127.0.0.1:9222",
    probeLog: process.env.PROBE_LOG ?? "/var/lib/session-host/probe.jsonl",
  });
  console.log(`[session-server] listening on 127.0.0.1:${started.port}`);
  process.on("SIGTERM", () => void started.close().finally(() => process.exit(0)));
}
