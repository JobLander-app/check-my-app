// CHE-419: a person signs in to their store on a page of checkmyapp.dev, not in
// a VNC console. This is the host half: a live view of ONE tab of the session
// browser — its frames out, the person's mouse, keys and pasted text in.
//
// Why not VNC (2026-10-05/06): the owner's sign-in took forty minutes; Cmd+V
// arrived as Super and did nothing until x11vnc was told to remap it, and the
// clipboard only crossed through noVNC's side panel. Here the person's own
// browser catches the paste and sends its text, so Cmd+V works by
// construction, and there is no console, no key remapping, no side panel.
//
// What the viewer can do is a closed list, not DevTools: mouse events at a
// point, key presses, text to insert, an answer to a page dialog, back and
// reload. It cannot open an address, read the page, run script or reach any
// tab but the one it was given (and a pop-up that tab opens — a "sign in with
// …" window). The person drives a browser that is theirs; nothing here lets
// the page they see reach anything else of ours.
//
// Who may connect: whoever holds a view token — HMAC-SHA256 over
// {v, slot, store, exp} with SESSION_VIEW_SECRET, minted by checkmyapp.dev for a
// signed-in person allowed to connect that store — and whose page is one of
// VIEW_ORIGINS. Served on its own port (not the session server's), published
// through the tunnel as its own hostname without Cloudflare Access: the token
// is the gate. One viewer at a time; a new one replaces the old.
//
// The passkey prompt: Shopify's sign-in asks the browser for a passkey, and
// Chrome answers with its own window, which no screencast shows (the owner was
// stuck on it, 2026-10-05). The viewer gives the tab a virtual authenticator
// holding no keys, so the request fails at once and Shopify offers the other
// ways to sign in — the person never meets a window they cannot see.
//
// Frames go out as binary WebSocket messages (JPEG bytes); everything else is
// JSON:
//   out: {t:"meta", w, h}  {t:"page", host, path}  {t:"signed_in", store}
//        {t:"dialog", kind, message}  {t:"busy"}  {t:"error", message}
//   in:  {t:"mouse", type, x, y, button, clickCount, deltaX, deltaY, modifiers}
//        {t:"key", type, key, code, keyCode, text, modifiers, commands}
//        {t:"text", text}  {t:"dialog", accept, promptText}  {t:"nav", action}

import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { openDoor } from "./door.mjs";

export const VIEW_TOKEN_VERSION = 1;
const MAX_IN = 64 * 1024;
const MAX_TEXT = 4096;

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

export function signViewToken(secret, payload) {
  const body = b64url(JSON.stringify({ v: VIEW_TOKEN_VERSION, ...payload }));
  return `${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;
}

// The payload, or null for anything not signed by us, expired, or of another
// version. `now` in milliseconds; `exp` in the token is in seconds.
export function verifyViewToken(secret, token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.v !== VIEW_TOKEN_VERSION) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  if (typeof payload.slot !== "string" || typeof payload.store !== "string") return null;
  return payload;
}

// A store is a *.myshopify.com handle; its admin address is derived, never
// taken from the token as a URL.
export function storeAdminUrl(store) {
  const handle = String(store).toLowerCase().replace(/\.myshopify\.com$/, "");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(handle)) return null;
  return `https://admin.shopify.com/store/${handle}`;
}

// What a signed-in admin looks like from its address alone.
export function signedInStore(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "admin.shopify.com") return null;
    return /^\/store\/([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

const MOUSE_TYPES = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
const BUTTONS = new Set(["none", "left", "middle", "right"]);
const KEY_TYPES = new Set(["keyDown", "keyUp"]);
const COMMANDS = new Set(["selectAll", "undo", "redo", "copy", "cut"]);
const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

// One message from the viewer → the DevTools command it stands for, or null.
// Pure, so the guard reads the same list the server acts on.
export function translate(message) {
  if (!message || typeof message !== "object") return null;
  if (message.t === "mouse" && MOUSE_TYPES.has(message.type)) {
    const button = BUTTONS.has(message.button) ? message.button : "none";
    const params = {
      type: message.type,
      x: num(message.x, 0, 10_000),
      y: num(message.y, 0, 10_000),
      button,
      buttons: button === "left" ? 1 : button === "right" ? 2 : button === "middle" ? 4 : 0,
      clickCount: num(message.clickCount, 0, 3),
      modifiers: num(message.modifiers, 0, 15),
    };
    if (message.type === "mouseWheel") Object.assign(params, { deltaX: num(message.deltaX, -5000, 5000), deltaY: num(message.deltaY, -5000, 5000) });
    return { method: "Input.dispatchMouseEvent", params };
  }
  if (message.t === "key" && KEY_TYPES.has(message.type)) {
    const text = str(message.text, 4);
    const keyCode = num(message.keyCode, 0, 255);
    const params = {
      type: message.type === "keyDown" ? (text ? "keyDown" : "rawKeyDown") : "keyUp",
      key: str(message.key, 32),
      code: str(message.code, 32),
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers: num(message.modifiers, 0, 15),
    };
    if (text && message.type === "keyDown") Object.assign(params, { text, unmodifiedText: text });
    const commands = Array.isArray(message.commands) ? message.commands.filter((c) => COMMANDS.has(c)) : [];
    if (commands.length && message.type === "keyDown") params.commands = commands;
    return { method: "Input.dispatchKeyEvent", params };
  }
  if (message.t === "text") {
    const text = str(message.text, MAX_TEXT);
    return text ? { method: "Input.insertText", params: { text } } : null;
  }
  if (message.t === "dialog") {
    return { method: "Page.handleJavaScriptDialog", params: { accept: message.accept === true, promptText: str(message.promptText, MAX_TEXT) } };
  }
  if (message.t === "nav" && message.action === "back") return { method: "Runtime.evaluate", params: { expression: "history.back()" } };
  if (message.t === "nav" && message.action === "reload") return { method: "Page.reload", params: {} };
  return null;
}

export async function startViewer({
  secret,
  origins = ["https://checkmyapp.dev"],
  cdp = "http://127.0.0.1:9222",
  port = 9091,
  host = "127.0.0.1",
  slot = "main",
  // The guard points a store at its own fixture; on the host it is always
  // the real admin address.
  adminUrlFor = storeAdminUrl,
  leaseHeld = async () => false,
  doorLog = "/var/lib/session-host/door.jsonl",
  now = Date.now,
  idleMs = 10 * 60_000,
  log = (line) => console.log(`[viewer] ${JSON.stringify(line)}`),
} = {}) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("A view secret of at least 32 characters is required");
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_IN });
  let current = null; // { end() }

  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://viewer");
    const payload = url.pathname === "/v1/view" ? verifyViewToken(secret, url.searchParams.get("token"), now()) : null;
    const origin = req.headers.origin ?? "";
    const adminUrl = payload ? adminUrlFor(payload.store) : null;
    if (!payload || payload.slot !== slot || !adminUrl || !origins.includes(origin)) {
      log({ refused: !payload ? "token" : payload.slot !== slot ? "slot" : !adminUrl ? "store" : "origin" });
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      void current?.end();
      current = attach(client, adminUrl, payload.store);
    });
  });

  function attach(client, adminUrl, store) {
    let upstream = null;
    let ended = false;
    let nextId = 1;
    const pending = new Map();
    const stack = []; // [{targetId, sessionId}] — the tab, then pop-ups it opened
    const top = () => stack[stack.length - 1] ?? null;
    let lastMeta = "";
    let lastPage = "";
    let signedInSent = false;
    let input = Promise.resolve();
    // A person who walked away must not hold checks out: ten quiet minutes and
    // the view closes (the page says how to come back).
    let lastInput = now();
    const idle = setInterval(() => {
      if (now() - lastInput < idleMs) return;
      out({ t: "error", message: "Closed after a while without activity. Reload this page to continue." });
      log({ viewer: "idle" });
      void end();
    }, Math.min(30_000, idleMs));
    idle.unref();

    const out = (value) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        if (!upstream || upstream.readyState !== WebSocket.OPEN) return reject(new Error("browser connection closed"));
        const id = nextId++;
        pending.set(id, { resolve, reject });
        upstream.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    const end = async () => {
      if (ended) return;
      ended = true;
      clearInterval(keep);
      clearInterval(idle);
      if (current?.end === end) current = null;
      for (const { sessionId } of stack) await send("Page.stopScreencast", {}, sessionId).catch(() => {});
      upstream?.close();
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close();
    };

    // No keys: a passkey request fails at once (NotAllowedError, after which
    // Shopify offers the other ways in) instead of opening a window the person
    // cannot see. Chrome drops a tab's virtual authenticators whenever ANY
    // other DevTools client detaches from it — the hourly probe and every check
    // do — so it is looked for every few seconds and put back when gone
    // (measured 2026-10-06: added, a second client attached and left, the next
    // request answered as if there were no authenticator at all).
    function keyless(entry) {
      if (!entry || ended) return Promise.resolve();
      entry.keying ??= keylessOnce(entry).finally(() => { entry.keying = null; });
      return entry.keying;
    }
    async function keylessOnce(entry) {
      if (entry.authenticatorId) {
        const alive = await send("WebAuthn.getCredentials", { authenticatorId: entry.authenticatorId }, entry.sessionId).then(() => true, () => false);
        if (alive) return;
      }
      await send("WebAuthn.enable", { enableUI: false }, entry.sessionId).catch(() => {});
      const added = await send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      }, entry.sessionId).catch((error) => ({ error }));
      entry.authenticatorId = added.authenticatorId ?? null;
      if (added.error) log({ authenticator: String(added.error.message).slice(0, 200) });
    }
    const keep = setInterval(() => { for (const entry of stack) void keyless(entry); }, 3_000);
    keep.unref();

    async function show(targetId) {
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const previous = top();
      if (previous) await send("Page.stopScreencast", {}, previous.sessionId).catch(() => {});
      stack.push({ targetId, sessionId });
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId).catch(() => {});
      await keyless(stack[stack.length - 1]);
      await send("Target.activateTarget", { targetId }).catch(() => {});
      await send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 }, sessionId);
      const { result } = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId).catch(() => ({ result: {} }));
      if (typeof result?.value === "string") page(result.value);
    }

    function page(href) {
      let u;
      try {
        u = new URL(href);
      } catch {
        return;
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") return;
      const key = `${u.hostname}${u.pathname}`;
      if (key !== lastPage) {
        lastPage = key;
        out({ t: "page", host: u.hostname, path: u.pathname });
      }
      const signed = signedInStore(href);
      if (signed && !signedInSent) {
        signedInSent = true;
        out({ t: "signed_in", store: signed });
      }
    }

    void (async () => {
      try {
        // A check working in this browser keeps it until it is done: the
        // person is told, not given a tab beside a measurement (Codex on #287).
        // From here on the session server refuses a new check while the
        // person is present (present() below), so the check cannot start in
        // between.
        if (await leaseHeld()) {
          out({ t: "error", message: "A check is running in this browser right now. Try again in a few minutes." });
          log({ viewer: "refused", reason: "lease held" });
          void end();
          return;
        }
        const line = await openDoor({ cdp, leaseHeld, storeUrl: adminUrl, log: doorLog });
        if (!line.keep) throw new Error(line.error ?? "no tab to show");
        const version = await (await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(5_000) })).json();
        upstream = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
        await new Promise((resolve, reject) => {
          upstream.once("open", resolve);
          upstream.once("error", reject);
        });
        if (ended) {
          upstream.close();
          return;
        }
        upstream.on("message", (raw) => onUpstream(raw));
        upstream.on("close", () => void end());
        upstream.on("error", () => void end());
        await send("Target.setDiscoverTargets", { discover: true });
        await show(line.keep);
        log({ viewer: "attached", store });
      } catch (error) {
        out({ t: "error", message: "The browser could not be opened. Try again in a minute." });
        log({ viewer: "failed", detail: String(error?.message ?? error).split("\n")[0].slice(0, 200) });
        void end();
      }
    })();

    function onUpstream(raw) {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result ?? {});
        return;
      }
      const shown = top();
      const { method, params = {} } = message;
      if (method === "Page.screencastFrame" && message.sessionId === shown?.sessionId) {
        void send("Page.screencastFrameAck", { sessionId: params.sessionId }, message.sessionId).catch(() => {});
        const meta = `${params.metadata?.deviceWidth}x${params.metadata?.deviceHeight}`;
        if (meta !== lastMeta) {
          lastMeta = meta;
          out({ t: "meta", w: params.metadata?.deviceWidth, h: params.metadata?.deviceHeight });
        }
        if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 4 * 1024 * 1024) client.send(Buffer.from(params.data, "base64"), { binary: true });
        return;
      }
      if (method === "Page.frameNavigated" && message.sessionId === shown?.sessionId && !params.frame?.parentId) {
        page(params.frame?.url ?? "");
        return;
      }
      if (method === "Page.javascriptDialogOpening" && message.sessionId === shown?.sessionId) {
        out({ t: "dialog", kind: params.type, message: str(params.message, 500) });
        return;
      }
      // A pop-up the shown tab opened ("sign in with …") is shown instead,
      // until it closes.
      if (method === "Target.targetCreated" && params.targetInfo?.type === "page" && params.targetInfo.openerId === shown?.targetId) {
        void show(params.targetInfo.targetId).catch(() => {});
        return;
      }
      if (method === "Target.targetDestroyed") {
        const index = stack.findIndex((s) => s.targetId === params.targetId);
        if (index === -1) return;
        const wasTop = index === stack.length - 1;
        stack.splice(index, 1);
        if (stack.length === 0) {
          out({ t: "error", message: "The tab was closed. Reload this page to get a new one." });
          void end();
        } else if (wasTop) {
          const back = top();
          void send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 }, back.sessionId).catch(() => {});
          void send("Target.activateTarget", { targetId: back.targetId }).catch(() => {});
        }
      }
    }

    client.on("message", (data, binary) => {
      if (binary || ended) return;
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      lastInput = now();
      const command = translate(message);
      if (!command) return;
      // In order, and a press — the thing that can start a passkey request —
      // only after the tab is known to hold its keyless authenticator.
      const press = command.params.type === "mousePressed" || command.params.type === "keyDown" || command.params.type === "rawKeyDown";
      input = input.then(async () => {
        const target = top();
        if (!target) return;
        if (press) await keyless(target);
        await send(command.method, command.params, target.sessionId).catch(() => {});
      });
    });
    client.on("close", () => void end());
    client.on("error", () => void end());

    return { end };
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    port: server.address().port,
    // A person is in the browser: the session server gives no check the lease
    // while this is true.
    present: () => current !== null,
    async close() {
      await current?.end();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
