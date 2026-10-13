// CHE-389: lets one check at a time work inside the Chrome a person signed in
// to. Since CHE-464 it runs in a team's container (runner.mjs), and the only
// way in is the team's Durable Object, with the bearer it makes for each start.
//
//   GET    /state                         who holds the lease, is a check connected, Chrome's version
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
// There is no profile on disk: the team's sign-in is its cookie jar, kept by
// the team's Durable Object. Four more routes, for that Durable Object only
// (the same bearer):
//
//   GET    /ready                         { jarLoaded, lease, connected, person }
//   PUT    /jar     {cookies}             the team's jar into the browser; until it is in, no lease
//   GET    /jar                           the team's jar out of the browser (values — never logged)
//   POST   /probe   {url}                 the hourly look at the admin (probe.mjs) → its line

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { Gate, LeaseBook, acknowledged, refusal, sessionIdFromPath } from "./lease.mjs";

const MAX_MESSAGE = 64 * 1024 * 1024;

export async function startSessionServer({
  token,
  cdp = "http://127.0.0.1:9222",
  port = 9090,
  host = "127.0.0.1",
  now = Date.now,
  heartbeatMs = 20_000,
  sweepMs = 5_000,
  closeWaitMs = 2_000,
  // Told every method the gate refused or answered itself, and in which scope:
  // the first thing to read when a client that used to work stops working.
  onGate = (action, method, scope) => console.log(`[session-server] ${action} ${method} (${scope ?? "unknown session"})`),
  // CHE-419: a person is signing in through the live view (viewer.mjs). No
  // check is given the browser meanwhile — the person's clicks and a check's
  // measurements must not share it (Codex on #287). The check is told 409 and
  // asks again later, as it does when another check holds the lease.
  personPresent = () => false,
  // CHE-464: { load(cookies) → count, read() → cookies } in a team's
  // container. Null for a browser whose sign-in is already in it (the guards'
  // persistent profiles): nothing to wait for.
  jar = null,
  // CHE-464: (url) → the probe's line, in a team's container.
  probe = null,
} = {}) {
  if (typeof token !== "string" || token.length < 32) throw new Error("A bearer token of at least 32 characters is required");
  const book = new LeaseBook(now);
  // A browser with a jar to receive is not given to a check until it has it:
  // a check that navigated first would meet the sign-in page and call it the
  // product.
  let jarLoaded = jar === null;
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

  const view = (lease) => ({ sessionId: lease.sessionId, ownerRunId: lease.ownerRunId, expiresAt: new Date(lease.expiresAt).toISOString() });

  async function body(req, limit = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error("Request too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  // The jar's routes say nothing about what failed beyond that it failed: a
  // parse error quotes the body, and the body is cookie values.
  async function jarRoute(req, send) {
    try {
      if (req.method === "PUT") {
        const input = await body(req, 512 * 1024);
        const loaded = await jar.load(Array.isArray(input?.cookies) ? input.cookies : []);
        jarLoaded = true;
        send(200, { loaded });
      } else if (req.method === "GET") {
        send(200, { cookies: await jar.read() });
      } else {
        send(405, { error: "Not here" });
      }
    } catch {
      send(req.method === "PUT" ? 422 : 503, { error: "The jar could not be moved" });
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(401).end();
      return;
    }
    const send = (status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    try {
      const path = new URL(req.url, "http://session").pathname;
      if (jar && path === "/jar") {
        await jarRoute(req, send);
      } else if (jar && req.method === "GET" && path === "/ready") {
        send(200, { jarLoaded, lease: book.current() !== null, connected: Boolean(connection), person: personPresent() });
      } else if (probe && req.method === "POST" && path === "/probe") {
        const input = await body(req);
        if (!jarLoaded) {
          send(503, { error: "The browser has not been given its jar" });
          return;
        }
        send(200, await probe(String(input?.url ?? "")));
      } else if (req.method === "GET" && path === "/state") {
        const lease = book.current();
        const browser = await chrome().then((c) => c.browser, () => null);
        send(200, { lease: lease ? view(lease) : null, connected: Boolean(connection), browser });
      } else if (req.method === "POST" && path === "/lease") {
        const input = await body(req);
        // Before the lease, not after: a lease on a browser that is not there
        // would hold every other check out for nothing.
        let browser;
        try {
          browser = (await chrome()).browser;
        } catch {
          send(503, { error: "The session browser is not running" });
          return;
        }
        if (!jarLoaded) {
          send(503, { error: "The browser has not been given its jar" });
          return;
        }
        // A run renewing the lease it already holds keeps it: the person was
        // refused while it held it, so they cannot be here because of it.
        if (personPresent() && book.current()?.ownerRunId !== input.ownerRunId) {
          send(409, { error: "A person is signing in on this host" });
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
          // connect in between. Target discovery — on since the connection
          // began — is what reports the tab gone.
          const gone = new Promise((resolve) => { allGone = resolve; });
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
    // Before anything the check says: the server's own watch on tabs coming
    // and going, which the check cannot switch off (lease.mjs).
    ask(gate.discover());

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
        // A tab one of the check's tabs opens while they are being closed is
        // the check's too, and goes the same way.
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
