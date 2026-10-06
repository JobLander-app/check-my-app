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
//        {t:"dialog", kind, message}  {t:"error", message}
//        {t:"apps", apps:[{handle, name}]}  {t:"picked", handle, origin, token} | {t:"picked", handle, error}
//   in:  {t:"mouse", type, x, y, button, clickCount, deltaX, deltaY, modifiers}
//        {t:"key", type, key, code, keyCode, text, modifiers, commands}
//        {t:"text", text}  {t:"dialog", accept, promptText}  {t:"nav", action}
//        {t:"apps"}  {t:"pick", handle}
//
// "apps" and "pick" are the onboarding's two questions, answered by the viewer
// itself in a tab of its own beside the person's: which apps the store has
// installed, and which origin the chosen one is served from inside the admin.
// The answer to "pick" is signed (signPick), so the page that carries it back
// to checkmyapp.dev cannot change what is saved.

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

// The installed apps, from the admin's own list (settings/apps): each link
// carries the app's handle, its text the app's name. Measured on prod-release-1,
// 2026-10-06: /store/<store>/settings/apps/app_installations/app/<handle>.
export const APP_LINK = /\/apps\/app_installations\/app\/([a-z0-9][a-z0-9-]{0,99})(?:[/?#]|$)/;
export function appsFromLinks(links) {
  const apps = [];
  for (const link of Array.isArray(links) ? links : []) {
    const handle = APP_LINK.exec(String(link?.href ?? ""))?.[1];
    const name = String(link?.text ?? "").trim().slice(0, 80);
    if (handle && name && !apps.some((a) => a.handle === handle)) apps.push({ handle, name });
  }
  return apps.slice(0, 50);
}

// What the viewer read for the person, signed so checkmyapp.dev can save it
// without trusting the page that carried it: the app's handle and the origin
// its iframe is served from.
export function signPick(secret, { slot, store, handle, name, origin, now = Date.now() }) {
  return signViewToken(secret, { kind: "pick", slot, store, handle, name, origin, exp: Math.floor(now / 1000) + 30 * 60 });
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
  // Whether an address is the token's store signed in; the guard names its
  // fixture's page.
  signedIn = (href, store) => signedInStore(href) === storeAdminUrl(store)?.split("/").pop(),
  signedInSettleMs = 3_000,
  commandTimeoutMs = 5_000,
  log = (line) => console.log(`[viewer] ${JSON.stringify(line)}`),
} = {}) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("A view secret of at least 32 characters is required");
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_IN });
  let current = null; // { end() }
  // Which store each tab the door opened for a viewer was opened for: a
  // sign-in address names no store, so this is the only way to know whose a
  // half-finished sign-in is (door.mjs signInIsOurs).
  const openedFor = new Map();

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
      out({ t: "error", code: "idle" });
      log({ viewer: "idle" });
      void end();
    }, Math.min(30_000, idleMs));
    idle.unref();

    const out = (value) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
    };
    // Every command gets an answer or gives up: a command sent to a tab that
    // closed meanwhile (the click that closes a pop-up, sent to the pop-up) is
    // never answered, and input waits in order — so one such click held every
    // later key and paste back for good (CI, 2026-10-06; Linux closes the
    // window faster than the click's answer).
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        if (!upstream || upstream.readyState !== WebSocket.OPEN) return reject(new Error("browser connection closed"));
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: no answer`));
        }, commandTimeoutMs);
        timer.unref?.();
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
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
      // The shown tab behaves as focused whatever the window system thinks:
      // after a pop-up closes, a browser whose window focus went elsewhere
      // takes the person's click and drops their typing (seen on CI's
      // headless Chrome, 2026-10-06).
      await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {});
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
      if (!signedInSent && !confirming && signedIn(href, store)) void confirmSignedIn();
    }

    // Codex on #287: the admin's own address is requested before Shopify
    // answers it with the sign-in page, so seeing it once proves nothing — the
    // person would be told "signed in" and close the page. Signed in is THIS
    // store's admin still loaded, and loaded completely, a few seconds later.
    //
    // An admin that is still loading is looked at again (Codex on #287: load
    // completion fires no navigation, so one look at a slow admin left the
    // person on the sign-in instructions for good) — for as long as the
    // address stays this store's admin, up to two minutes.
    let confirming = false;
    async function confirmSignedIn() {
      confirming = true;
      try {
        for (let look = 0; look < Math.ceil(120_000 / signedInSettleMs); look++) {
          await new Promise((resolve) => setTimeout(resolve, signedInSettleMs));
          const shown = top();
          if (!shown || ended || signedInSent) return;
          const { result } = await send("Runtime.evaluate", { expression: "[location.href, document.readyState]", returnByValue: true }, shown.sessionId).catch(() => ({ result: {} }));
          const [href, ready] = Array.isArray(result?.value) ? result.value : [];
          if (typeof href !== "string" || !signedIn(href, store)) return;
          if (ready === "complete") {
            signedInSent = true;
            out({ t: "signed_in", store });
            return;
          }
        }
      } finally {
        confirming = false;
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
          out({ t: "error", code: "busy" });
          log({ viewer: "refused", reason: "lease held" });
          void end();
          return;
        }
        const line = await openDoor({
          cdp,
          leaseHeld,
          storeUrl: adminUrl,
          log: doorLog,
          signInIsOurs: (tab) => openedFor.get(tab.id) === adminUrl,
          opened: (targetId, url) => {
            openedFor.set(targetId, url);
            // A record for every tab ever opened would only grow; the recent ones matter.
            if (openedFor.size > 50) openedFor.delete(openedFor.keys().next().value);
          },
        });
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
        out({ t: "error", code: "failed" });
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
          out({ t: "error", code: "closed" });
          void end();
        } else if (wasTop) {
          const back = top();
          void send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 }, back.sessionId).catch(() => {});
          void send("Target.activateTarget", { targetId: back.targetId }).catch(() => {});
          void send("Page.bringToFront", {}, back.sessionId).catch(() => {});
          // Where the tab is now: a "sign in with …" window often moves its
          // opener to the admin before it closes, and that navigation was not
          // the shown tab's while the window was on top (Codex on #287).
          void send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, back.sessionId)
            .then(({ result }) => { if (typeof result?.value === "string") page(result.value); })
            .catch(() => {});
        }
      }
    }

    // A page of the admin opened beside the person's tab, read, and closed —
    // never their tab, which keeps showing what they were doing.
    async function aside(url, read) {
      const { targetId } = await send("Target.createTarget", { url, background: true });
      try {
        const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
        return await read(sessionId);
      } finally {
        await send("Target.closeTarget", { targetId }).catch(() => {});
      }
    }
    const evaluate = async (sessionId, expression) =>
      (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId).catch(() => ({})))?.result?.value;
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function listApps() {
      const apps = await aside(`${adminUrl}/settings/apps`, async (sessionId) => {
        let found = [];
        // The list renders after the admin's own scripts; settled when two
        // looks a second apart agree.
        for (let i = 0; i < 40 && !ended; i++) {
          await pause(1000);
          const links = await evaluate(sessionId, `[...document.querySelectorAll('a[href]')].map(a => ({ href: a.getAttribute('href'), text: (a.innerText || a.getAttribute('aria-label') || '').trim() }))`);
          const now = appsFromLinks(links);
          if (now.length && now.length === found.length) return now;
          found = now;
        }
        return found;
      });
      for (const app of apps) names.set(app.handle, app.name);
      out({ t: "apps", apps });
    }

    async function pick(handle) {
      if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(String(handle))) return;
      const origin = await aside(`${adminUrl}/apps/${handle}`, async (sessionId) => {
        for (let i = 0; i < 30 && !ended; i++) {
          await pause(1000);
          // Cross-origin, so the frame tree has the frame but not its address;
          // the element's src has it.
          const src = await evaluate(sessionId, `document.querySelector('iframe[name="app-iframe"]')?.src ?? null`);
          if (typeof src === "string" && src.startsWith("https://")) return new URL(src).origin;
        }
        return null;
      });
      if (!origin) {
        out({ t: "picked", handle, code: "app_not_open" });
        return;
      }
      out({ t: "picked", handle, origin, token: signPick(secret, { slot, store, handle, name: String(names.get(handle) ?? handle), origin }) });
    }
    const names = new Map();
    let busy = false;
    async function action(run) {
      if (busy) return;
      busy = true;
      try {
        await run();
      } catch (error) {
        log({ action: "failed", detail: String(error?.message ?? error).slice(0, 200) });
        out({ t: "picked", code: "failed" });
      } finally {
        busy = false;
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
      if (message?.t === "apps") {
        void action(() => listApps());
        return;
      }
      if (message?.t === "pick") {
        void action(() => pick(message.handle));
        return;
      }
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
