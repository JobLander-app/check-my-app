// CHE-319 verification: the checkmyapp-watch channel (mcp/channel/) pushes a
// finished Daily Watch result into a running Claude Code session once, and
// only when it is news.
//
// The far end is the real remote handler (src/lib/mcp/handler.ts) over a stub
// database (scripts/fixtures/mcp-db.ts) — so "new finding" is the server's own
// definition, and the channel's stateless tools/call is proven to be accepted
// by the transport it will meet in production. What must hold:
//
//   1. a quiet start pushes nothing: an old result with new findings and a
//      fresh result with none are both history, not news;
//   2. a new finished run is one push whose content names the host, the
//      verdict, the bottom line, each NEW finding (title + severity, not the
//      ones the previous run had) and "get_review with run_id X"; meta is
//      exactly {app, run_id, verdict} and every key is an identifier (Claude
//      Code silently drops any other);
//   3. the same run is never pushed twice; a run still going or a failed run
//      is not a result;
//   4. a new session starts with the result that is waiting: new findings,
//      under 24 hours old — that one, once;
//   5. a refused key is KeyRefusedError (the server exits on it), not a retry;
//   6. the server declares experimental['claude/channel'], no tools, and the
//      instructions; a push reaches a client as notifications/claude/channel;
//   7. the committed public/mcp/checkmyapp-watch-<CHANNEL_VERSION>.tgz is
//      exactly what the source builds (scripts/build-channel.mjs) — a stale
//      tarball fails here, and the build refuses to rewrite a published
//      version, so the fix is a version bump;
//   8. the tarball's bin, run as a process over stdio against a local HTTP
//      server, completes the handshake and pushes the waiting result; with a
//      wrong key it exits non-zero.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-mcp-channel.ts

process.env.CREDENTIALS_SECRET ??= "verify-mcp-channel-secret";

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hashApiKey } from "@/lib/apiKeys";
import { handleMcpRequest } from "@/lib/mcp/handler";
import type { McpDeps } from "@/lib/mcp/tools";
import { createChannelServer, pollSeconds, push } from "../mcp/channel/server";
import { createWatcher, fetchLatestResults, KeyRefusedError, type ChannelEvent } from "../mcp/channel/watch";
import { createStubDb } from "./fixtures/mcp-db";
import { buildChannel, BIN, tarballPath } from "./build-channel.mjs";
import { CHANNEL_TARBALL_PATH } from "../mcp/channel/watch";
import { watchChannelCommands } from "@/lib/agent-connect";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  // The detail only on a failure: most of it here is a whole pushed message.
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://checkmyapp.dev";
const KEY = "cma_0123456789abcdef0123456789abcdef";
const META_KEY = /^[A-Za-z0-9_]+$/;
const HOUR = 3_600_000;

const detail = (where: string, happened: string) => JSON.stringify({ where, whatHappened: happened, whatWeTried: [] });

// Real clock: step 8 runs the bundled bin, which reads Date.now() itself.
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * HOUR);

function runRow(id: string, appId: string, slug: string, over: Record<string, unknown>) {
  return {
    id, publicId: `pub_${id}`, runNumber: 1, appId, teamId: "team_o", ownerId: "u", appSlug: slug,
    targetUrl: `https://${slug}`, targetKind: "website", status: "completed", verdict: "mostly_ok",
    bottomLine: null, deploySha: null, deployEnv: null, ...over,
  };
}

async function seed() {
  return createStubDb({
    user: [{ id: "u", email: "o@example.test", name: "O" }],
    team: [{ id: "team_o", name: "Owner team", plan: "business", isPersonal: true }],
    apiKey: [{ id: "k", ownerId: "u", teamId: "team_o", scope: "reader", keyHash: await hashApiKey(KEY), lastUsedAt: null }],
    app: [
      { id: "app_old", ownerId: "u", teamId: "team_o", appSlug: "old.test", targetUrl: "https://old.test", createdAt: ago(100) },
      { id: "app_shop", ownerId: "u", teamId: "team_o", appSlug: "shop.test", targetUrl: "https://shop.test", createdAt: ago(99) },
    ],
    run: [
      // old.test: its latest result has a new finding, but it is 30 hours old.
      runRow("o1", "app_old", "old.test", { startedAt: ago(55), completedAt: ago(54), createdAt: ago(55) }),
      runRow("o2", "app_old", "old.test", { verdict: "needs_attention", bottomLine: "Search is down.",
        startedAt: ago(31), completedAt: ago(30), createdAt: ago(31) }),
      // shop.test: fresh, but nothing new — the same regression as the day before.
      runRow("s1", "app_shop", "shop.test", { verdict: "needs_attention", startedAt: ago(26), completedAt: ago(25), createdAt: ago(26) }),
      runRow("s2", "app_shop", "shop.test", { verdict: "needs_attention", bottomLine: "Checkout fails.",
        startedAt: ago(2), completedAt: ago(1), createdAt: ago(2) }),
    ],
    finding: [
      { id: "fo", runId: "o2", number: 1, title: "Search answers 500", category: "broken", severity: "high",
        mark: "none", anchor: null, detail: detail("/search", "GET /api/search answered 500.") },
      { id: "fs1", runId: "s1", number: 1, title: "Checkout returns an error", category: "broken", severity: "high",
        mark: "none", anchor: null, detail: detail("/checkout", "POST /api/orders answered 500.") },
      { id: "fs2", runId: "s2", number: 1, title: "Paying fails at the last step", category: "broken", severity: "high",
        mark: "none", anchor: null, detail: detail("/checkout", "Pressing Pay sent POST /api/orders and got 500 back.") },
    ],
  });
}

async function main() {
  const stub = await seed();
  const deps: McpDeps = {
    db: stub.db,
    origin: ORIGIN,
    trigger: async () => {},
    siteCap: () => 20,
    ephemeralTtlDays: () => 7,
    sleep: async () => {},
    now: () => Date.now(),
  };
  const fetchIn = ((url: string | URL, init?: RequestInit) =>
    handleMcpRequest(new Request(url, init), deps)) as typeof fetch;
  const latest = (apiKey = KEY) => fetchLatestResults({ base: ORIGIN, apiKey, fetch: fetchIn });
  const addRun = (row: Record<string, unknown>) => stub.table("run").push(row);
  const addFinding = (row: Record<string, unknown>) => stub.table("finding").push(row);

  // 1 — a quiet start.
  const session = createWatcher({ now: () => Date.now() });
  {
    const apps = await latest();
    check("fetch: a stateless tools/call of latest_results is answered by the real handler",
      apps.length === 2 && apps.every((a) => a.latest_run !== null), JSON.stringify(apps.map((a) => a.latest_run?.run_id)));
    const events = session.observe(apps);
    check("quiet start: an old result with new findings and a fresh one with none push nothing",
      events.length === 0 && session.seeded, JSON.stringify(events));
    const again = session.observe(await latest());
    check("quiet start: the next tick with nothing new pushes nothing", again.length === 0, JSON.stringify(again));
  }

  // 2 — a new finished run of shop.test: the regression it shares with the
  // previous run is not news; the dead sign-in is.
  let pushed: ChannelEvent | undefined;
  {
    addRun(runRow("s3", "app_shop", "shop.test", { verdict: "broken", bottomLine: "Checkout fails and sign-in is dead.",
      startedAt: new Date(NOW - 60_000), completedAt: new Date(NOW - 30_000), createdAt: new Date(NOW - 60_000) }));
    addFinding({ id: "fs3a", runId: "s3", number: 1, title: "Paying still fails", category: "broken", severity: "high",
      mark: "none", anchor: null, detail: detail("/checkout", "POST /api/orders answered 500 again.") });
    addFinding({ id: "fs3b", runId: "s3", number: 2, title: "Sign-in button does nothing", category: "broken",
      severity: "medium", mark: "none", anchor: null, detail: detail("/login", "No request left the page.") });
    const events = session.observe(await latest());
    pushed = events[0];
    check("new run: exactly one push", events.length === 1, JSON.stringify(events));
    const c = pushed?.content ?? "";
    check("new run: content names the host, verdict and bottom line",
      c.includes("shop.test") && c.includes("Verdict: broken") && c.includes("Checkout fails and sign-in is dead."), c);
    check("new run: content lists the new finding with its severity, not the known one",
      c.includes("[medium] Sign-in button does nothing") && !c.includes("Paying still fails"), c);
    check("new run: content says how to get the review",
      c.includes("Call get_review with run_id pub_s3"), c);
    check("new run: meta is {app, run_id, verdict}",
      JSON.stringify(pushed?.meta) === JSON.stringify({ app: "shop.test", run_id: "pub_s3", verdict: "broken" }),
      JSON.stringify(pushed?.meta));
    check("new run: every meta key is an identifier Claude Code keeps",
      Object.keys(pushed?.meta ?? { "": "" }).every((k) => META_KEY.test(k)) && Object.values(pushed?.meta ?? {}).every(
        (v) => typeof v === "string"));
  }

  // 3 — never twice; not-yet-results are not results.
  {
    const again = session.observe(await latest());
    check("no duplicate: the same run is not pushed again", again.length === 0, JSON.stringify(again));
    addRun(runRow("o3", "app_old", "old.test", { status: "walking", verdict: null, startedAt: new Date(NOW), completedAt: null,
      createdAt: new Date(NOW) }));
    addRun(runRow("o4", "app_old", "old.test", { status: "failed", verdict: null, startedAt: new Date(NOW),
      completedAt: new Date(NOW), createdAt: new Date(NOW) }));
    const running = session.observe(await latest());
    check("no push for a run still going or a run that failed", running.length === 0, JSON.stringify(running));
  }

  // 4 — a new session: shop.test's result is fresh and has a new finding.
  {
    const next = createWatcher({ now: () => Date.now() });
    const events = next.observe(await latest());
    check("startup: the waiting result (new findings, < 24h) is pushed once, and only that one",
      events.length === 1 && events[0].meta.run_id === "pub_s3", JSON.stringify(events.map((e) => e.meta)));
    check("startup: not again on the next tick", next.observe(await latest()).length === 0);
    const tomorrow = createWatcher({ now: () => Date.now() + 25 * HOUR });
    check("startup: the same result a day later is history", tomorrow.observe(await latest()).length === 0);
  }

  // 5 — a refused key.
  {
    let error: unknown;
    try {
      await latest("cma_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    } catch (err) {
      error = err;
    }
    check("refused key: KeyRefusedError, which the server exits on", error instanceof KeyRefusedError, String(error));
    check("poll interval: default 300, never under 60",
      pollSeconds(undefined) === 300 && pollSeconds("5") === 60 && pollSeconds("120") === 120 && pollSeconds("x") === 300);
  }

  // 6 — the MCP surface a Claude Code client sees.
  {
    const server = createChannelServer();
    const client = new Client({ name: "verify-mcp-channel", version: "0.0.0" });
    const received: Array<{ method: string; params?: unknown }> = [];
    client.fallbackNotificationHandler = async (n) => {
      received.push(n);
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const caps = client.getServerCapabilities() ?? {};
    check("server: declares experimental['claude/channel'] and no tools (one-way)",
      JSON.stringify(caps.experimental?.["claude/channel"]) === "{}" && caps.tools === undefined, JSON.stringify(caps));
    const instr = client.getInstructions() ?? "";
    check("server: instructions name the tag, get_review, and waiting for the user",
      instr.includes('<channel source="checkmyapp-watch"') && instr.includes("get_review") && instr.includes("wait for the user"));
    if (pushed) await push(server, pushed);
    await new Promise((r) => setTimeout(r, 20));
    check("server: a push arrives as notifications/claude/channel with content and meta",
      received.length === 1 && received[0].method === "notifications/claude/channel" &&
        JSON.stringify(received[0].params) === JSON.stringify(pushed), JSON.stringify(received));
    await client.close();
  }

  // 7 — the committed tarball is what the source builds.
  const unpacked = mkdtempSync(path.join(tmpdir(), "verify-mcp-channel-"));
  const TARBALL = tarballPath() as string;
  const printed = watchChannelCommands(null);
  check("tarball: the URL the guide prints is the file this version builds",
    TARBALL.endsWith(path.join("public", ...CHANNEL_TARBALL_PATH.split("/"))) &&
      printed.add.endsWith(`npx -y https://checkmyapp.dev${CHANNEL_TARBALL_PATH}`) &&
      printed.start === "claude --dangerously-load-development-channels server:checkmyapp-watch" &&
      printed.add.startsWith("claude mcp add checkmyapp-watch "),
    `${JSON.stringify(printed)} vs ${TARBALL}`);
  const guide = readFileSync(path.join(__dirname, "..", "src", "app", "guides", "results-in-your-agent", "page.tsx"), "utf8");
  check("guide: the page prints watchChannelCommands, not a retyped URL",
    guide.includes("watchChannelCommands(") && !guide.includes(".tgz"));
  try {
    let committed: Record<string, string> = {};
    try {
      execFileSync("tar", ["-xzf", TARBALL, "-C", unpacked]);
      committed = {
        "package.json": readFileSync(path.join(unpacked, "package", "package.json"), "utf8"),
        [BIN]: readFileSync(path.join(unpacked, "package", BIN), "utf8"),
      };
    } catch (err) {
      check("tarball: public/mcp/checkmyapp-watch.tgz exists and unpacks", false, String(err));
    }
    const fresh = (await buildChannel()) as Record<string, string>;
    for (const name of Object.keys(fresh)) {
      check(`tarball: ${name} matches a fresh build (npm run build:channel if not)`, committed[name] === fresh[name],
        committed[name] ? `${committed[name].length} vs ${fresh[name].length} chars` : "missing");
    }
    const pkg = JSON.parse(committed["package.json"] ?? "{}") as { bin?: Record<string, string>; dependencies?: unknown };
    check("tarball: one bin, checkmyapp-watch, and zero dependencies",
      pkg.bin?.["checkmyapp-watch"] === BIN && pkg.dependencies === undefined, JSON.stringify(pkg));

    // 8 — the bundled bin as a process: stdio in, HTTP out.
    if (committed[BIN]) await runBin(path.join(unpacked, "package", BIN), deps);
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nverify-mcp-channel: all checks passed" : `\nverify-mcp-channel: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

function serve(deps: McpDeps): Promise<HttpServer> {
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const response = await handleMcpRequest(
      new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) }),
      deps,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  return new Promise((resolve) => http.listen(0, "127.0.0.1", () => resolve(http)));
}

async function runBin(bin: string, deps: McpDeps) {
  const http = await serve(deps);
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  try {
    // A good key: handshake, then the waiting shop.test result arrives.
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, CHECKMYAPP_API_KEY: KEY, CHECKMYAPP_URL: base, CHECKMYAPP_POLL_SECONDS: "60" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const messages: Array<Record<string, unknown>> = [];
    let buffer = "";
    child.stdout.on("data", (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) messages.push(JSON.parse(line));
      }
    });
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } } });
    await until(() => messages.some((m) => m.id === 1), 10_000);
    const init = messages.find((m) => m.id === 1) as { result?: { capabilities?: Record<string, unknown>; serverInfo?: { name?: string } } };
    check("bin: initialize answers as checkmyapp-watch with the channel capability",
      init?.result?.serverInfo?.name === "checkmyapp-watch" &&
        JSON.stringify((init.result.capabilities?.experimental as Record<string, unknown>)?.["claude/channel"]) === "{}",
      JSON.stringify(init));
    const pushedBefore = messages.some((m) => m.method === "notifications/claude/channel");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await until(() => messages.some((m) => m.method === "notifications/claude/channel"), 10_000);
    const note = messages.find((m) => m.method === "notifications/claude/channel") as
      { params?: { content?: string; meta?: Record<string, string> } } | undefined;
    check("bin: nothing is pushed before the client says initialized", !pushedBefore);
    check("bin: the waiting result is pushed over stdio after the handshake",
      note?.params?.meta?.run_id === "pub_s3" && (note.params.content ?? "").includes("Sign-in button does nothing"),
      JSON.stringify(note) + " stderr: " + stderr);
    check("bin: stdout carries only JSON-RPC (logs go to stderr)", stderr.includes("watching " + base));
    check("bin: the first poll says what the session starts with",
      stderr.includes("connected: 2 app(s), 2 with a finished check, 1 waiting"), stderr);
    child.stdin.end();
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    check("bin: exits when the client closes stdin", code === 0, String(code));

    // A wrong key: one message, non-zero exit, no retry loop.
    const bad = spawn(process.execPath, [bin], {
      env: { ...process.env, CHECKMYAPP_API_KEY: "cma_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", CHECKMYAPP_URL: base },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let badErr = "";
    bad.stderr.on("data", (d) => (badErr += d));
    bad.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } } }) + "\n");
    bad.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const badCode = await Promise.race([
      new Promise<number | null>((r) => bad.on("exit", r)),
      new Promise<string>((r) => setTimeout(() => r("still running after 10s"), 10_000)),
    ]);
    if (badCode === "still running after 10s") bad.kill();
    check("bin: a refused key exits non-zero with one message",
      typeof badCode === "number" && badCode !== 0 && badErr.includes("refused the API key"), `${badCode} ${badErr}`);
  } finally {
    http.close();
  }
}

async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
