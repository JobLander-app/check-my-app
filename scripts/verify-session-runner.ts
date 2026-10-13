// CHE-464: a team's Shopify session browser in a Cloudflare Container.
//
// What can be run outside the Workers runtime is run here, for real:
//   - the jar's rules (spikes/shopify-session/jar-rules.mjs) and its seal
//     (src/agent/session-jar.ts): Shopify's cookies only, a value never said,
//     a jar that opens for its own team only;
//   - a team's own residential session and its own view key: one team's token
//     or pick is no use to another;
//   - the worker's doors (src/agent/session-routes.ts), with a stub in place of
//     the Durable Object: the live view reaches only the team its token was
//     signed for, the admin routes only with our bearer;
//   - the session server as the container runs it, on a real Chrome: no lease
//     before the team's jar is in, the jar in and back out through DevTools,
//     and no cookie value in anything it logs or answers on a failure;
//   - the forwarder: credentials added, the upstream's own refusal passed back;
//   - the image: Chrome started as a plain process with no secret in its
//     environment, never launched through Playwright.
// The Durable Object itself (session-runner.ts) needs the Workers runtime and
// is proven live.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-session-runner.ts
//        SESSION_BROWSER_CHANNEL=chrome … to run it on the system Chrome, as CI does

import http from "node:http";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { mintViewToken, verifyPick, verifyViewToken, viewKeyFor, viewTokenSlot } from "@/lib/session-view";
import { openJar, probeMessage, proxyForTeam, sealJar } from "@/agent/session-jar";
import { routeLiveView, routeSessionAdmin } from "@/agent/session-routes";

let failures = 0;
// Our own lines go out past the capture below, which listens to everything else.
const say = console.log.bind(console);
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const VALUE = "fake-merchant-essential-0f9e8d7c6b5a";
const OTHER_VALUE = "not-shopify-a1b2c3d4";
const JAR_SECRET = "j".repeat(48);
const VIEW_SECRET = "v".repeat(48);
const ADMIN = "a".repeat(48);
const TEAM_A = "team_aaaa";
const TEAM_B = "team_bbbb";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function launchProfile(profile: string, debugPort: number): Promise<BrowserContext> {
  const options = { args: [`--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1"] };
  const channel = process.env.SESSION_BROWSER_CHANNEL;
  if (channel) return chromium.launchPersistentContext(profile, { ...options, channel });
  try {
    return await chromium.launchPersistentContext(profile, options);
  } catch {
    return chromium.launchPersistentContext(profile, { ...options, channel: "chrome" });
  }
}

const sessionCookie = (value = VALUE) => ({
  name: "_merchant_essential",
  value,
  domain: ".shopify.com",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
  expires: Math.floor(Date.now() / 1000) + 3600,
});

async function jarRules() {
  // @ts-expect-error — plain JavaScript, shared with the container
  const { jarOf, holdsSignIn, describeJar } = await import("../spikes/shopify-session/jar-rules.mjs");
  const jar = jarOf([
    sessionCookie(),
    { name: "_merchant_analytics", value: "x", domain: "admin.shopify.com", path: "/", session: true, expires: -1, size: 10 },
    { name: "store", value: "y", domain: "prod-release-1.myshopify.com", path: "/" },
    { name: "theirs", value: OTHER_VALUE, domain: ".example.com", path: "/" },
    { name: "lookalike", value: "z", domain: "shopify.com.evil.test", path: "/" },
  ]);
  check("jar: Shopify's cookies only (admin, accounts, stores), never another site's or a look-alike", jar.map((c: { name: string }) => c.name).join(",") === "_merchant_essential,_merchant_analytics,store", JSON.stringify(jar.map((c: { name: string }) => c.name)));
  check("jar: a session cookie goes back without an expiry; fields setCookies does not take are dropped", jar[1].expires === undefined && jar[1].size === undefined && jar[1].session === undefined);
  check("jar: a sign-in is the session cookie", holdsSignIn(jar) && !holdsSignIn(jar.slice(1)) && !holdsSignIn([{ ...sessionCookie(""), value: "" }]));
  const said = JSON.stringify(describeJar(jar));
  check("jar: what is said about it carries names and counts, never a value", !said.includes(VALUE) && said.includes("_merchant_essential"), said);
}

async function seal() {
  const jar = [sessionCookie()];
  const sealed = await sealJar(JAR_SECRET, TEAM_A, jar);
  check("seal: the sealed jar does not carry the value in the clear", !JSON.stringify(sealed).includes(VALUE));
  const opened = await openJar(JAR_SECRET, TEAM_A, sealed);
  check("seal: it opens for its own team", opened.length === 1 && opened[0].value === VALUE);
  const refused = async (make: () => Promise<unknown>) => make().then(() => false, () => true);
  check("seal: another team's object cannot open it", await refused(() => openJar(JAR_SECRET, TEAM_B, sealed)));
  check("seal: another key cannot open it", await refused(() => openJar("k".repeat(48), TEAM_A, sealed)));
  let threw = "";
  await sealJar("short", TEAM_A, jar).catch((error: Error) => { threw = error.message; });
  check("seal: without SESSION_JAR_KEY nothing is kept — an internal error", threw.startsWith("internal:"), threw);
}

async function proxy() {
  const upstream = "http://user1234:base0000_country-de_city-aachen_session-abcd1234_lifetime-7d@geo.iproyal.com:12321";
  const a = await proxyForTeam(upstream, TEAM_A);
  const b = await proxyForTeam(upstream, TEAM_B);
  const sessionOf = (url: string | null) => /_session-([A-Za-z0-9]+)/.exec(decodeURIComponent(new URL(url ?? "http://x").password))?.[1];
  check("proxy: each team its own sticky session, the same one every time", Boolean(a && b) && sessionOf(a) !== sessionOf(b) && sessionOf(a) === sessionOf(await proxyForTeam(upstream, TEAM_A)) && sessionOf(a)?.length === 8, `${sessionOf(a)} ${sessionOf(b)}`);
  check("proxy: everything else about the upstream is kept", new URL(a ?? "").host === "geo.iproyal.com:12321" && decodeURIComponent(new URL(a ?? "").password).startsWith("base0000_country-de_city-aachen_session-") && new URL(a ?? "").username === "user1234");
  check("proxy: a URL with no session part is used as it is", (await proxyForTeam("http://u:p@h.test:1", TEAM_A)) === "http://u:p@h.test:1");
  check("proxy: no URL is direct egress; anything but http://user@… is not a proxy", (await proxyForTeam(undefined, TEAM_A)) === null && (await proxyForTeam("socks5://u:p@h:1", TEAM_A)) === null && (await proxyForTeam("http://h:1", TEAM_A)) === null);
}

async function messages() {
  const at = "2026-10-13T14:00:00.000Z";
  const out = probeMessage("Securify", "app_1", { at, state: "login_page", url_host: "accounts.shopify.com", url_path: "/lookup", ms: 1 });
  check("probe message: a sign-in that ended links to the app's own sign-in page", out.includes("https://checkmyapp.dev/health/apps/app_1/sign-in") && out.includes("Securify") && out.includes("страницу входа"), out);
  const p402 = probeMessage("T", "a", { at, state: "proxy", url_host: null, url_path: null, ms: 1, proxy_status: 402 });
  const p407 = probeMessage("T", "a", { at, state: "proxy", url_host: null, url_path: null, ms: 1, proxy_status: 407 });
  check("probe message: 402 asks for a top-up, 407 for the credentials — and neither for a new sign-in", p402.includes("пополнить") && p407.includes("SESSION_PROXY_URL") && !p407.includes("пополнить") && p402.includes("Входить в Shopify заново не нужно"));
}

async function viewKeys() {
  const keyA = await viewKeyFor(VIEW_SECRET, TEAM_A);
  const keyB = await viewKeyFor(VIEW_SECRET, TEAM_B);
  check("view key: each team its own, never the secret itself", keyA !== keyB && keyA.length === 64 && !keyA.includes(VIEW_SECRET));
  const token = await mintViewToken(keyA, { slot: TEAM_A, store: "prod-release-1" });
  check("view token: names its team before it is verified", viewTokenSlot(token) === TEAM_A);
  check("view token: verifies with its team's key and no other", (await verifyViewToken(keyA, token))?.slot === TEAM_A && (await verifyViewToken(keyB, token)) === null);
  check("view token: an expired one does not", (await verifyViewToken(keyA, await mintViewToken(keyA, { slot: TEAM_A, store: "s", now: Date.now() - 31 * 60_000 }))) === null);
  // viewer.mjs signs a pick with the key it was started with — the team's.
  // @ts-expect-error — plain JavaScript, shared with the container
  const { signPick } = await import("../spikes/shopify-session/viewer.mjs");
  const pick = signPick(keyA, { slot: TEAM_A, store: "prod-release-1", handle: "securify", name: "Securify", origin: "https://app.test" });
  check("pick: verifies with its team's key, not another team's", (await verifyPick(keyA, pick))?.handle === "securify" && (await verifyPick(keyB, pick)) === null);
  check("pick: is not a view token", (await verifyViewToken(keyA, pick)) === null);
}

async function doors() {
  const seen: { name: string; url: string; team: string | null; origin: string | null; upgrade: string | null; auth: string | null }[] = [];
  const rpc: string[] = [];
  const namespace = {
    getByName: (name: string) => ({
      fetch: async (request: Request) => {
        seen.push({ name, url: request.url, team: request.headers.get("X-Session-Team"), origin: request.headers.get("Origin"), upgrade: request.headers.get("Upgrade"), auth: request.headers.get("Authorization") });
        return new Response("to the container", { status: 200 });
      },
      importJar: async (team: string, cookies: unknown) => {
        rpc.push(`import:${name}:${team}:${Array.isArray(cookies) ? cookies.length : "none"}`);
        return { saved: 1, loaded: false };
      },
      describe: async (team: string) => {
        rpc.push(`describe:${name}:${team}`);
        return { team };
      },
    }),
  };
  const bindings = { SESSION_RUNNER: namespace, SESSION_VIEW_SECRET: VIEW_SECRET, SESSION_ADMIN_TOKEN: ADMIN } as unknown as Parameters<typeof routeLiveView>[0] & Parameters<typeof routeSessionAdmin>[1];
  const keyA = await viewKeyFor(VIEW_SECRET, TEAM_A);
  const ws = (token: string, extra: Record<string, string> = {}) =>
    new Request(`https://live.checkmyapp.dev/session/view?token=${encodeURIComponent(token)}`, { headers: { Upgrade: "websocket", Origin: "https://checkmyapp.dev", ...extra } });

  const good = await mintViewToken(keyA, { slot: TEAM_A, store: "prod-release-1" });
  check("live view: a plain request is not a socket", (await routeLiveView(new Request(`https://live.checkmyapp.dev/session/view?token=${good}`), bindings)).status === 426);
  check("live view: no token, a forged one, nothing woken", (await routeLiveView(ws(""), bindings)).status === 403 && (await routeLiveView(ws(`${good}x`), bindings)).status === 403 && seen.length === 0);
  const claimsB = await mintViewToken(keyA, { slot: TEAM_B, store: "prod-release-1" });
  check("live view: a token signed with team A's key that names team B reaches nobody", (await routeLiveView(ws(claimsB), bindings)).status === 403 && seen.length === 0);
  check("live view: without the secret on the worker nothing is let through", (await routeLiveView(ws(good), { ...bindings, SESSION_VIEW_SECRET: "" })).status === 403);
  const passed = await routeLiveView(ws(good, { Authorization: "Bearer smuggled" }), bindings);
  const to = seen[0];
  check(
    "live view: a good token reaches its own team's browser, at the viewer's address, as a socket from the person's page",
    passed.status === 200 && seen.length === 1 && to.name === TEAM_A && to.team === TEAM_A && new URL(to.url).pathname === "/v1/view" && new URL(to.url).searchParams.get("token") === good && to.upgrade === "websocket" && to.origin === "https://checkmyapp.dev",
    JSON.stringify(to),
  );

  const admin = (path: string, init: RequestInit = {}) => routeSessionAdmin(new Request(`https://checkmyapp-agent.test${path}`, init), bindings);
  check("admin: no bearer, a wrong one — refused", (await admin("/session/state?teamId=team_aaaa")).status === 401 && (await admin("/session/state?teamId=team_aaaa", { headers: { Authorization: `Bearer ${"b".repeat(48)}` } })).status === 401 && rpc.length === 0);
  check("admin: a token shorter than 32 characters configured is no token", (await routeSessionAdmin(new Request("https://x.test/session/state?teamId=team_aaaa", { headers: { Authorization: "Bearer short" } }), { ...bindings, SESSION_ADMIN_TOKEN: "short" })).status === 401);
  const imported = await admin("/session/jar", { method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify({ teamId: TEAM_A, cookies: [sessionCookie()] }) });
  const described = await admin(`/session/state?teamId=${TEAM_A}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  check("admin: with our bearer a jar goes to the team's own browser, and its state is read there", imported.status === 200 && described.status === 200 && rpc.join(" ") === `import:${TEAM_A}:${TEAM_A}:1 describe:${TEAM_A}:${TEAM_A}`, rpc.join(" "));
  const imported2 = await (await admin("/session/jar", { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` }, body: "{}" })).json() as { error?: string };
  check("admin: no team, no import", imported2.error === "teamId required");
}

async function serverWithJar() {
  const profile = await mkdtemp(join(tmpdir(), "cma-session-runner-"));
  const debugPort = await freePort();
  const browser = await launchProfile(profile, debugPort);
  const cdp = `http://127.0.0.1:${debugPort}`;
  // Everything the server and the jar code say, captured.
  const said: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const realError = console.error;
  const capture = (...args: unknown[]) => said.push(args.map(String).join(" "));
  // @ts-expect-error — plain JavaScript, shared with the container
  const { startSessionServer } = await import("../spikes/shopify-session/session-server.mjs");
  // @ts-expect-error — plain JavaScript, shared with the container
  const { loadJar, readJar } = await import("../spikes/shopify-session/jar.mjs");
  const TOKEN = "t".repeat(48);
  let server: { port: number; close(): Promise<void> } | null = null;
  try {
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    server = await startSessionServer({
      token: TOKEN,
      cdp,
      port: 0,
      probeLog: join(profile, "none.jsonl"),
      jar: { load: (cookies: unknown[]) => loadJar(cdp, cookies), read: () => readJar(cdp) },
      probe: async (url: string) => ({ at: new Date().toISOString(), state: "ok", url_host: new URL(url).hostname, url_path: "/", ms: 1 }),
    });
    const base = `http://127.0.0.1:${server!.port}`;
    const ask = (method: string, path: string, body?: unknown, token = TOKEN) =>
      fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const ready = async () => (await (await ask("GET", "/ready")).json()) as { jarLoaded: boolean; lease: boolean };

    const before = await ready();
    const earlyLease = await ask("POST", "/lease", { ownerRunId: "run-aaaaaaaa", maxDurationSeconds: 120 });
    const earlyProbe = await ask("POST", "/probe", { url: "https://admin.shopify.com/store/x/apps/y" });
    check("server: a browser not yet given its team's jar is given to no check and no probe", before.jarLoaded === false && earlyLease.status === 503 && earlyProbe.status === 503, `${earlyLease.status} ${earlyProbe.status}`);
    check("server: the jar's routes ask for the bearer like every other", (await ask("GET", "/jar", undefined, "w".repeat(48))).status === 401 && (await ask("PUT", "/jar", { cookies: [] }, "w".repeat(48))).status === 401);

    const broken = await ask("PUT", "/jar", `{"cookies":[{"name":"_merchant_essential","value":"${VALUE}"`);
    const brokenText = await broken.text();
    check("server: a jar that does not parse is refused without a word of what it held", broken.status === 422 && !brokenText.includes(VALUE), brokenText);

    const put = await ask("PUT", "/jar", { cookies: [sessionCookie(), { name: "theirs", value: OTHER_VALUE, domain: ".example.com", path: "/" }] });
    const putBody = (await put.json()) as { loaded?: number };
    check("server: the team's jar goes in — Shopify's cookies only", put.status === 200 && putBody.loaded === 1, JSON.stringify(putBody));
    const inChrome = await browser.cookies("https://admin.shopify.com");
    check("server: Chrome now holds the session cookie for the admin", inChrome.some((c) => c.name === "_merchant_essential" && c.value === VALUE));
    check("server: and nothing of another site came with it", !(await browser.cookies("https://www.example.com")).some((c) => c.value === OTHER_VALUE));
    await browser.addCookies([{ name: "theirs", value: OTHER_VALUE, domain: ".example.com", path: "/" }]);
    const out = (await (await ask("GET", "/jar")).json()) as { cookies: { name: string; value: string; domain: string }[] };
    check("server: the jar comes back out with its value, and only Shopify's", out.cookies.some((c) => c.name === "_merchant_essential" && c.value === VALUE) && !out.cookies.some((c) => c.value === OTHER_VALUE), JSON.stringify(out.cookies.map((c) => c.name)));
    check("server: with the jar in, the browser is ready, a check gets its lease and the probe runs",
      (await ready()).jarLoaded === true && (await ask("POST", "/lease", { ownerRunId: "run-aaaaaaaa", maxDurationSeconds: 120 })).status === 200 && (await ask("POST", "/probe", { url: "https://admin.shopify.com/store/x/apps/y" })).status === 200);
    const state = await (await ask("GET", "/state")).text();
    check("server: /state says nothing of the jar's values", !state.includes(VALUE));
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    console.error = realError;
    await server?.close();
    await browser.close();
    await rm(profile, { recursive: true, force: true });
  }
  check("server: in everything it logged, no cookie value", !said.some((line) => line.includes(VALUE) || line.includes(OTHER_VALUE)), `${said.length} lines`);
}

async function forwarder() {
  // @ts-expect-error — plain JavaScript, shared with the container
  const { startForwarder } = await import("../spikes/shopify-session/forwarder.mjs");
  const expectedAuth = `Basic ${Buffer.from("user1234:pass_session-abc").toString("base64")}`;
  const seen: string[] = [];
  let refuseTunnels = 0;
  // A residential upstream in miniature: wants our credentials, tunnels by
  // echoing, and answers a plain request with "out of traffic".
  const upstream = net.createServer((socket) => {
    let head = "";
    socket.on("data", function onData(data) {
      head += data.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.removeListener("data", onData);
      const first = head.split("\r\n")[0];
      const auth = /\r\nproxy-authorization: ([^\r\n]+)/i.exec(head)?.[1];
      seen.push(`${first.split(" ")[0]} ${auth === expectedAuth ? "auth-ok" : "auth-wrong"}`);
      if (first.startsWith("CONNECT")) {
        if (refuseTunnels) return void socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        socket.on("data", (d) => socket.write(d));
        return;
      }
      socket.end("HTTP/1.1 402 Payment Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = (upstream.address() as net.AddressInfo).port;
  const fwd = await startForwarder({ upstream: `http://user1234:pass_session-abc@127.0.0.1:${upPort}`, port: 0, log: () => {} });
  try {
    const tunnel = (target: string) =>
      new Promise<{ status: string; echo: string }>((resolve) => {
        const socket = net.connect(fwd.port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        let buffer = "";
        let status = "";
        socket.on("data", (d) => {
          buffer += d.toString();
          if (!status && buffer.includes("\r\n\r\n")) {
            status = buffer.split("\r\n")[0];
            buffer = buffer.slice(buffer.indexOf("\r\n\r\n") + 4);
            if (/ 200 /.test(status)) socket.write("ping");
            else socket.end();
          }
          if (buffer === "ping") {
            socket.end();
            resolve({ status, echo: buffer });
          }
        });
        socket.on("close", () => resolve({ status, echo: buffer }));
      });
    const ok = await tunnel("admin.shopify.com:443");
    check("forwarder: a tunnel goes through the upstream, with our credentials added", / 200 /.test(ok.status) && ok.echo === "ping" && seen[0] === "CONNECT auth-ok", `${ok.status} ${seen.join(",")}`);
    const plain = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port: fwd.port, path: "http://example.com/", headers: { host: "example.com" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on("error", () => resolve(0));
    });
    check("forwarder: a plain request goes through too, and the upstream's own 402 comes back (the probe's proxy test)", plain === 402 && seen[1] === "GET auth-ok", `${plain} ${seen.join(",")}`);
    refuseTunnels = 1;
    const refused = await tunnel("admin.shopify.com:443");
    check("forwarder: a tunnel the upstream refuses comes back with the upstream's status", / 407 /.test(refused.status), refused.status);
    const relative = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port: fwd.port, path: "/json/version" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on("error", () => resolve(0));
    });
    check("forwarder: it is a proxy and nothing else — a request for itself is refused", relative === 400);
  } finally {
    await fwd.close();
    upstream.close();
  }
}

async function image() {
  const dockerfile = await readFile("spikes/shopify-session/Dockerfile", "utf8");
  const copied = /^COPY (.+) \.\/$/m.exec(dockerfile.split("\n").filter((l) => l.startsWith("COPY") && !l.includes("package")).join("\n"))?.[1].split(/\s+/) ?? [];
  check("image: Chrome is google-chrome-stable from Google, not the base's Chromium", /apt-get install[^\n]*google-chrome-stable/.test(dockerfile) && /dl\.google\.com\/linux\/chrome\/deb/.test(dockerfile));
  const sources = await Promise.all(copied.map(async (f) => [f, await readFile(join("spikes/shopify-session", f), "utf8")] as const));
  const launches = sources.filter(([, text]) => /\.launch(PersistentContext|Server)?\s*\(/.test(text)).map(([f]) => f);
  check("image: nothing in it launches a browser through Playwright — it only attaches", copied.length >= 8 && launches.length === 0, `${copied.join(" ")} | launches: ${launches.join(" ")}`);
  const runner = sources.find(([f]) => f === "runner.mjs")?.[1] ?? "";
  const spawnChrome = /spawn\("\/usr\/bin\/google-chrome-stable"[\s\S]*?\}\),\n\);/.exec(runner)?.[0] ?? "";
  check("image: Chrome starts as a plain process with an environment of its own — no secret in it", spawnChrome.includes("env: { DISPLAY") && !/process\.env/.test(spawnChrome) && !/TOKEN|SECRET|PROXY_URL/.test(spawnChrome), spawnChrome.slice(0, 120));
  check("image: the secrets are taken out of the environment before anything starts", /const take = \(name\) => \{[\s\S]*?delete process\.env\[name\]/.test(runner) && runner.indexOf('take("SESSION_SERVER_TOKEN")') < runner.indexOf('spawn("Xvfb"'));
  const ignore = await readFile("spikes/shopify-session/.dockerignore", "utf8");
  check("image: every file it copies is let into the build, and nothing else", copied.every((f) => ignore.includes(`!${f}`)) && ignore.startsWith("*\n"));
}

async function main() {
  await jarRules();
  await seal();
  await proxy();
  await messages();
  await viewKeys();
  await doors();
  await forwarder();
  await image();
  await serverWithJar();
  say(failures ? `\nverify-session-runner: ${failures} FAILED` : "\nverify-session-runner: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
