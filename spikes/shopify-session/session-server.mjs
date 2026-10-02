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
// The server never starts, stops or navigates Chrome. Every DevTools message,
// in both directions, goes through the gate in lease.mjs: a check is given its
// own tabs and nothing else, and the session's cookies never reach it as
// values. The tabs (and contexts) a check opened are closed when it goes away —
// including when it goes away without saying so. An abandoned DevTools
// connection is not harmless here: Playwright attaches with
// waitForDebuggerOnStart, and while such a connection stays open every new tab
// sits paused at about:blank (README.md, the 2026-10-01 note).
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
import { Gate, LeaseBook, acknowledged, refusal, sessionIdFromPath } from "./lease.mjs";
import { parseLog } from "./classify.mjs";

const MAX_MESSAGE = 64 * 1024 * 1024;

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
  // Told every method the gate refused or answered itself, and in which scope:
  // the first thing to read when a client that used to work stops working.
  onGate = (action, method, scope) => console.log(`[session-server] ${action} ${method} (${scope ?? "unknown session"})`),
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

  // One at a time, in the order they arrived. Two connections for one session
  // id that raced each other both saw "nobody is connected", both attached, and
  // the first was left running where neither a release nor the lease's end
  // could reach it (both reviews of #240).
  let upgrades = Promise.resolve();
  server.on("upgrade", (req, socket, head) => {
    const sessionId = sessionIdFromPath(new URL(req.url, "http://session").pathname);
    if (!authorized(req) || !book.admits(sessionId)) {
      socket.destroy();
      return;
    }
    socket.on("error", () => {});
    upgrades = upgrades.then(async () => {
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
        if (!book.admits(sessionId) || socket.destroyed) {
          upstream.close();
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (client) => attach(client, upstream, sessionId));
      } catch {
        socket.destroy();
      }
    });
  });

  function attach(client, upstream, sessionId) {
    const gate = new Gate();
    let allGone = null; // set while the connection's tabs are being closed
    let ending = null;
    let alive = true;
    const ask = (command) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(command));
    };

    // Close what this check opened, then let go of the browser. Runs once, for
    // every way a connection can end.
    const end = () => {
      ending ??= (async () => {
        if (connection === self) connection = null;
        clearInterval(heartbeat);
        if (upstream.readyState === WebSocket.OPEN && (gate.targets.size > 0 || gate.contexts.size > 0)) {
          // "Closed" is the tab being gone, not Chrome agreeing to close it:
          // the answer to closeTarget comes first, and the next check must not
          // connect in between. Target discovery is what reports the tab gone.
          const gone = new Promise((resolve) => { allGone = resolve; });
          ask({ id: gate.nextPrivateId(), method: "Target.setDiscoverTargets", params: { discover: true } });
          for (const targetId of gate.targets) ask({ id: gate.nextPrivateId(), method: "Target.closeTarget", params: { targetId } });
          // A context the check made goes with it, and takes its tabs along.
          for (const browserContextId of gate.contexts) ask({ id: gate.nextPrivateId(), method: "Target.disposeBrowserContext", params: { browserContextId } });
          if (gate.targets.size === 0) allGone();
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
      const action = gate.outgoing(message);
      if (action === "forward") {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        return;
      }
      if (action !== "disconnect") onGate(action, String(message.method), gate.scope(message.sessionId));
      client.send(JSON.stringify(action === "refuse" ? refusal(message) : acknowledged(message)));
      if (action === "disconnect") void end();
    });

    upstream.on("message", (data, binary) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const known = new Set(gate.targets);
      const { client: forClient, browser: forBrowser } = gate.incoming(message);
      for (const command of forBrowser) ask(command);
      if (allGone) {
        // Discovery, switched on to see the tabs go, can also reveal one of
        // ours nobody had reported yet (a tab opened by the check's tab).
        for (const targetId of gate.targets) {
          if (!known.has(targetId)) ask({ id: gate.nextPrivateId(), method: "Target.closeTarget", params: { targetId } });
        }
        if (gate.targets.size === 0) allGone();
      }
      if (ending || client.readyState !== WebSocket.OPEN) return;
      for (const item of forClient) {
        // Unchanged messages go out as the bytes they came in as.
        if (item === message) client.send(data, { binary });
        else client.send(JSON.stringify(item));
      }
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
