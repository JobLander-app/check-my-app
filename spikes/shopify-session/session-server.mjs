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
  // CHE-419: a person is signing in through the live view (viewer.mjs). No
  // check is given the browser meanwhile — the person's clicks and a check's
  // measurements must not share it (Codex on #287). The check is told 409 and
  // asks again later, as it does when another check holds the lease.
  personPresent = () => false,
  // CHE-426: one browser per team. Each slot is a Chrome of its own (its own
  // OS user, profile and DevTools port, provision.sh) with its own lease, its
  // own connection and its own probe log; a request names its slot ("main"
  // when it names none — the browser this host had before slots). A check
  // holding one slot's lease never reaches another slot's browser: the
  // DevTools route is resolved from the session id, which only one slot's
  // book admits.
  slots,
} = {}) {
  if (typeof token !== "string" || token.length < 32) throw new Error("A bearer token of at least 32 characters is required");
  const slotList = (slots ?? [{ name: "main", cdp, probeLog }]).map((s) => ({
    name: String(s.name),
    cdp: s.cdp,
    probeLog: s.probeLog,
    book: new LeaseBook(now),
    connection: null, // at most one per slot: { sessionId, end() }
  }));
  const byName = new Map(slotList.map((s) => [s.name, s]));
  if (byName.size !== slotList.length) throw new Error("Slot names must be unique");
  const book = slotList[0].book;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });

  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (req) => {
    const value = Buffer.from(req.headers.authorization ?? "");
    return value.length === expected.length && timingSafeEqual(value, expected);
  };

  // Asked afresh every time: a restarted Chrome has a new DevTools address.
  async function chrome(slot) {
    const response = await fetch(`${slot.cdp}/json/version`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`DevTools answered HTTP ${response.status}`);
    const version = await response.json();
    return { browser: version.Browser ?? null, ws: version.webSocketDebuggerUrl };
  }

  async function lastProbe(slot) {
    const lines = parseLog(await readFile(slot.probeLog, "utf8").catch(() => ""));
    const last = lines[lines.length - 1];
    return last ? { at: last.at, state: last.state } : null;
  }

  // The slot a request names; "main" when it names none.
  const slotOf = (name) => byName.get(name === undefined || name === null || name === "" ? "main" : String(name)) ?? null;

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
      const url = new URL(req.url, "http://session");
      const path = url.pathname;
      if (req.method === "GET" && path === "/state") {
        const slot = slotOf(url.searchParams.get("slot"));
        if (!slot) return send(404, { error: "No such slot" });
        const lease = slot.book.current();
        const browser = await chrome(slot).then((c) => c.browser, () => null);
        send(200, { slot: slot.name, lease: lease ? view(lease) : null, connected: Boolean(slot.connection), browser, probe: await lastProbe(slot) });
      } else if (req.method === "GET" && path === "/slots") {
        send(200, { slots: slotList.map((s) => ({ slot: s.name, leased: s.book.current() !== null })) });
      } else if (req.method === "POST" && path === "/lease") {
        const input = await body(req);
        const slot = slotOf(input.slot);
        if (!slot) return send(404, { error: "No such slot" });
        // Before the lease, not after: a lease on a browser that is not there
        // would hold every other check out for nothing.
        let browser;
        try {
          browser = (await chrome(slot)).browser;
        } catch {
          send(503, { error: "The browser on the session host is not running" });
          return;
        }
        // A run renewing the lease it already holds keeps it: the person was
        // refused while it held it, so they cannot be here because of it.
        if (personPresent(slot.name) && slot.book.current()?.ownerRunId !== input.ownerRunId) {
          send(409, { error: "A person is signing in on this host" });
          return;
        }
        const taken = slot.book.take(input.ownerRunId, input.maxDurationSeconds);
        if (!taken.ok) {
          send(taken.status, { error: taken.error, ...(taken.heldUntil ? { heldUntil: new Date(taken.heldUntil).toISOString() } : {}) });
          return;
        }
        send(200, { ...view(taken.lease), browser, slot: slot.name });
      } else if (req.method === "DELETE" && path === "/lease") {
        const input = await body(req);
        const slot = slotOf(input.slot);
        if (!slot) return send(404, { error: "No such slot" });
        const held = slot.book.current();
        const released = slot.book.release(input.ownerRunId);
        if (!released.ok) {
          send(released.status, { error: released.error });
          return;
        }
        if (released.released && slot.connection?.sessionId === held.sessionId) await slot.connection.end();
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
    // The slot is the one whose lease names this session id — never one the
    // request could choose.
    const slot = authorized(req) ? slotList.find((s) => s.book.admits(sessionId)) : null;
    if (!slot) {
      socket.destroy();
      return;
    }
    socket.on("error", () => {});
    upgrades = upgrades.then(async () => {
      try {
        // The same run connecting again (its next phase, or a retry of a step
        // whose Worker died) takes over: the old connection's tabs are closed
        // first, so the new one starts in a profile with nothing of ours in it.
        if (slot.connection) await slot.connection.end();
        const upstream = new WebSocket((await chrome(slot)).ws, { maxPayload: MAX_MESSAGE });
        await new Promise((resolve, reject) => {
          upstream.once("open", resolve);
          upstream.once("error", reject);
        });
        if (!slot.book.admits(sessionId) || socket.destroyed) {
          upstream.close();
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (client) => attach(client, upstream, sessionId, slot));
      } catch {
        socket.destroy();
      }
    });
  });

  function attach(client, upstream, sessionId, slot) {
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
        if (slot.connection === self) slot.connection = null;
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
    slot.connection = self;
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
    for (const slot of slotList) {
      if (slot.connection && !slot.book.admits(slot.connection.sessionId)) void slot.connection.end();
    }
  }, sweepMs);
  sweep.unref();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    port: server.address().port,
    // The first slot's book ("main" unless slots were named): what callers
    // before CHE-426 read.
    book,
    slots: byName,
    async close() {
      clearInterval(sweep);
      for (const slot of slotList) if (slot.connection) await slot.connection.end();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// "main=9222,1=9231" → [{name, cdp, probeLog, doorLog}]. The main slot keeps
// the logs it always had; slot n writes probe-<n>.jsonl and door-<n>.jsonl.
export function parseSlots(spec, mainCdp = "http://127.0.0.1:9222", mainProbeLog = "/var/lib/session-host/probe.jsonl") {
  const dir = mainProbeLog.replace(/\/[^/]*$/, "");
  const entries = String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return [{ name: "main", cdp: mainCdp, probeLog: mainProbeLog, doorLog: `${dir}/door.jsonl` }];
  return entries.map((entry) => {
    const match = /^([a-z0-9]{1,16})=(\d{2,5})$/.exec(entry);
    if (!match) throw new Error(`SESSION_SLOTS: "${entry}" is not name=port`);
    const [, name, port] = match;
    return name === "main"
      ? { name, cdp: `http://127.0.0.1:${port}`, probeLog: mainProbeLog, doorLog: `${dir}/door.jsonl` }
      : { name, cdp: `http://127.0.0.1:${port}`, probeLog: `${dir}/probe-${name}.jsonl`, doorLog: `${dir}/door-${name}.jsonl` };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.SESSION_SERVER_TOKEN;
  const viewSecret = process.env.SESSION_VIEW_SECRET;
  delete process.env.SESSION_SERVER_TOKEN;
  delete process.env.SESSION_VIEW_SECRET;
  // Never the secrets themselves — only whether they arrived.
  console.log(`[session-server] boot node=${process.version} token=${typeof token === "string" ? token.length : 0}ch view=${typeof viewSecret === "string" ? viewSecret.length : 0}ch`);
  const cdp = process.env.SESSION_SERVER_CDP ?? "http://127.0.0.1:9222";
  // CHE-426: SESSION_SLOTS="main=9222,1=9231,2=9232" — each slot's name and
  // DevTools port (provision.sh writes it). Absent: the one browser, "main".
  const slots = parseSlots(process.env.SESSION_SLOTS, cdp, process.env.PROBE_LOG ?? "/var/lib/session-host/probe.jsonl");
  console.log(`[session-server] slots ${slots.map((s) => s.name).join(",")}`);
  // CHE-419: the live view a person signs in through, on its own port and
  // hostname (viewer.mjs). Off until the secret is set.
  let viewer = null;
  const started = await startSessionServer({
    token,
    port: Number(process.env.SESSION_SERVER_PORT ?? 9090),
    slots,
    personPresent: (slot) => viewer?.present(slot) ?? false,
  });
  console.log(`[session-server] listening on 127.0.0.1:${started.port}`);
  if (viewSecret) {
    const { startViewer } = await import("./viewer.mjs");
    viewer = await startViewer({
      secret: viewSecret,
      origins: (process.env.VIEW_ORIGINS ?? "https://checkmyapp.dev").split(",").map((o) => o.trim()).filter(Boolean),
      port: Number(process.env.SESSION_VIEW_PORT ?? 9091),
      slots: slots.map((s) => ({
        name: s.name,
        cdp: s.cdp,
        doorLog: s.doorLog,
        leaseHeld: async () => started.slots.get(s.name).book.current() !== null,
      })),
    });
    console.log(`[session-server] viewer on 127.0.0.1:${viewer.port}`);
  }
  process.on("SIGTERM", () => void Promise.all([started.close(), viewer?.close()]).finally(() => process.exit(0)));
}
