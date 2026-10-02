// CHE-389: the rules of the session server, as pure functions and two small
// classes — no socket, no clock of their own. session-server.mjs is the wiring;
// scripts/verify-session-server.mjs drives both.
//
// The browser on this host is the one a person signed in to. A check is a
// visitor in it: it opens its own tabs, works in them, and leaves. Three things
// follow, and each is enforced here rather than trusted to the caller:
//
//   1. One check at a time. Two checks in one profile would read each other's
//      tabs and report each other's state as the product's.
//   2. A check has its own tabs and nothing else. It is never told that the
//      person's tab exists, cannot attach to it, and at the level of the
//      browser may say only the few things opening and closing its own tabs
//      takes. Inside its own tab it can do what a page can do — and a page can
//      sign itself out by walking to the logout address. That last one is not
//      this layer's to stop: it is the tool-level guard's rule for a run of
//      this kind.
//   3. The session's cookies never leave the host as values. A check that can
//      open the admin sees what the admin shows; it does not get the HttpOnly
//      cookie that would let anyone else open it too — not by asking for it,
//      and not in the request headers DevTools reports.
//
// The first version of rule 2 was a list of forbidden method names checked
// against every message. Two reviews of #240 broke it the same way: the list
// looked at the method and never at whose tab the message was addressed to, so
// Target.attachToTarget on the person's tab followed by Page.close on that
// session went straight through. Hence scopes, and an allow-list at the top.

export const LEASE_MIN_SECONDS = 60;
export const LEASE_MAX_SECONDS = 1800;

const RUN_ID = /^[a-zA-Z0-9_-]{8,100}$/;

export function leaseSeconds(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n)) return 600;
  return Math.min(LEASE_MAX_SECONDS, Math.max(LEASE_MIN_SECONDS, Math.floor(n)));
}

// One lease, held by one run. A run takes it at the start of every phase (each
// phase connects afresh), so taking it again is a renewal, not a conflict. The
// session id stays the same across renewals: it names the lease, not the
// connection.
export class LeaseBook {
  constructor(now = Date.now, newId = () => crypto.randomUUID()) {
    this.now = now;
    this.newId = newId;
    this.lease = null;
  }

  current() {
    if (this.lease && this.now() >= this.lease.expiresAt) this.lease = null;
    return this.lease;
  }

  // → { ok: true, lease } | { ok: false, status, error, heldUntil? }
  take(ownerRunId, seconds) {
    if (typeof ownerRunId !== "string" || !RUN_ID.test(ownerRunId)) {
      return { ok: false, status: 422, error: "Run identity required" };
    }
    const held = this.current();
    if (held && held.ownerRunId !== ownerRunId) {
      return { ok: false, status: 409, error: "Another check holds this session", heldUntil: held.expiresAt };
    }
    const expiresAt = this.now() + leaseSeconds(seconds) * 1000;
    this.lease = held ? { ...held, expiresAt } : { sessionId: this.newId(), ownerRunId, expiresAt };
    return { ok: true, lease: this.lease };
  }

  // Only the holder releases. Releasing what is not held is not an error: the
  // caller's cleanup runs after a failure too, and must be able to run twice.
  release(ownerRunId) {
    const held = this.current();
    if (!held) return { ok: true, released: false };
    if (held.ownerRunId !== ownerRunId) return { ok: false, status: 409, error: "Another check holds this session" };
    this.lease = null;
    return { ok: true, released: true };
  }

  admits(sessionId) {
    const held = this.current();
    return Boolean(held && typeof sessionId === "string" && held.sessionId === sessionId);
  }
}

// Ids at or below this belong to the server's own questions to the browser
// (closing a check's tabs, letting go of a tab that is not the check's). A
// check may not use them, and never sees their answers.
export const PRIVATE_ID_BASE = -1_000_000;

export const REDACTED = "[redacted]";

// At the level of the browser a check may say these and nothing else. Target.*
// has its own rules below, the same in every scope.
const BROWSER_SCOPE = new Set(["Browser.getVersion"]);

// Said by Playwright on every connection, about the profile's own context:
// where downloads go. Answered "done" and not passed on — the profile keeps the
// person's setting, and the client keeps working.
const BROWSER_SCOPE_ANSWERED = new Set(["Browser.setDownloadBehavior"]);

// Inside its own tab a check may do what a page can do, and DevTools can do
// much more from a page's session than a page can: whole domains take an
// origin by name (DOMStorage, IndexedDB, CacheStorage read and write any
// origin's data; ServiceWorker stops or unregisters workers the person's tab
// depends on; Storage and Security act on the profile). A list of the bad ones
// was tried and was a list — round 3 of Codex on #240 found the next entries.
// So the domains a walk needs are named, and the rest are refused:
// driving and reading the page, its network, its input, its frames.
const PAGE_SCOPE_DOMAINS = new Set([
  "Page", "Runtime", "DOM", "DOMSnapshot", "CSS", "Input", "Emulation", "Network", "Fetch",
  "Log", "Console", "Accessibility", "Overlay", "Performance", "IO",
]);
const PAGE_MAY_ASK_BROWSER = new Set(["Browser.getVersion", "Browser.getWindowForTarget"]);

// And inside those domains, what still reaches past the page: the cookie jar
// (HttpOnly values a page's own script cannot read or write) and the
// profile's cache. A pattern, not today's method names — Page.setCookie and
// Page.deleteCookie are deprecated aliases that still act, and the next alias
// must not be a hole.
const COOKIE_METHOD = /^[A-Za-z]+\..*cookie/i;

function beyondAPage(method) {
  const domain = method.slice(0, method.indexOf("."));
  if (domain === "Browser") return !PAGE_MAY_ASK_BROWSER.has(method);
  if (!PAGE_SCOPE_DOMAINS.has(domain)) return true;
  return COOKIE_METHOD.test(method) || method === "Network.clearBrowserCache";
}

// A domain list is still too wide at a few methods (cross-review of #240):
// three ways off the page that sit inside allowed domains.
//
// 1. An address. A navigation asked for through DevTools is the browser's own,
//    so it goes where a page's script would be refused: chrome://quit and
//    chrome://inducebrowsercrashforrealz end the browser, chrome://settings can
//    be driven to clear the cookie jar, file:// reads this host's disk. Any
//    command's `url` must be the web's — and about:blank only, since the rest
//    of about: is chrome:// by another name (about:crash).
const WEB_SCHEMES = new Set(["http:", "https:", "data:", "blob:"]);
export function webAddress(url) {
  if (url === "" || url === "about:blank" || url === "about:srcdoc") return true;
  try {
    return WEB_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// 2. A file from this host handed to the page: an upload field or a drop
//    filled from a path reads whatever the browser's user can read — the
//    profile's own Cookies database among it, which on a host with no keyring
//    is as good as plain. That is the cookie reader, refused above, by another
//    door, and it leaves by an ordinary upload. A walk here has no host file
//    to upload.
function handsOverAHostFile(method, params) {
  if (method === "DOM.setFileInputFiles" || method === "Page.handleFileChooser") return true;
  return method === "Input.dispatchDragEvent" && Array.isArray(params?.data?.files) && params.data.files.length > 0;
}

// 3. Where downloads are written: any path the browser's user can write, the
//    profile's own Preferences included. The page-level twin of
//    Browser.setDownloadBehavior — answered, like it, and not passed on.
//
// And the window. A check's tab opens in the person's window, and the Worker's
// client (@cloudflare/playwright) sizes the window to its viewport as part of
// opening any page — Browser.setWindowBounds, from the page's own session.
// Refused, that failed newPage() itself: the first live run (#299) could not
// open a tab at all. Passed on, it would resize the window the person is
// looking at. So it is answered "done" and not passed on: the check's viewport
// is the page's own (Emulation.setDeviceMetricsOverride), the window stays the
// person's. Upstream Playwright over CDP never sends it, which is why the
// guard on a real Chrome did not meet it.
const PAGE_SCOPE_ANSWERED = new Set(["Page.setDownloadBehavior", "Browser.setWindowBounds"]);

function leavesThePage(method, params) {
  if (typeof params?.url === "string" && !webAddress(params.url)) return true;
  return handsOverAHostFile(method, params);
}

// A response the check writes itself can carry Set-Cookie, and the browser
// stores it: a cookie writer by another name.
function forgesCookie(method, params) {
  if (method !== "Fetch.fulfillRequest" && method !== "Fetch.continueResponse") return false;
  const headers = params?.responseHeaders;
  if (Array.isArray(headers) && headers.some((h) => /^set-cookie$/i.test(String(h?.name ?? "")))) return true;
  // binaryResponseHeaders: base64 of "name: value\0name: value".
  if (typeof params?.binaryResponseHeaders === "string") {
    try {
      return /(^|\0)set-cookie\s*:/i.test(atob(params.binaryResponseHeaders));
    } catch {
      return true;
    }
  }
  return false;
}

const isCookieHeader = (name) => /^(set-)?cookie$/i.test(name);

// Cookie values out of one DevTools event's params, in place on a copy. Walks
// the shapes Network.* and Fetch.* events use: header maps, header lists, the
// raw header text, and the cookies DevTools lists beside a request.
function scrubCookies(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      if (item && typeof item === "object" && typeof item.name === "string" && typeof item.value === "string" && isCookieHeader(item.name)) {
        changed = true;
        return { ...item, value: REDACTED };
      }
      const scrubbed = scrubCookies(item, depth + 1);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    return changed ? next : value;
  }
  let copy = null;
  const set = (key, next) => {
    copy ??= { ...value };
    copy[key] = next;
  };
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      if (isCookieHeader(key)) set(key, REDACTED);
      else if (/headersText$/i.test(key) && /^(set-)?cookie:/im.test(item)) set(key, item.replace(/^((?:set-)?cookie:).*$/gim, `$1 ${REDACTED}`));
      else if (key === "cookieLine") set(key, REDACTED);
      continue;
    }
    // {cookie: {name, value, …}} beside a request, and bare cookie objects.
    if (key === "cookie" && item && typeof item === "object" && typeof item.value === "string") {
      set(key, { ...item, value: REDACTED });
      continue;
    }
    const scrubbed = scrubCookies(item, depth + 1);
    if (scrubbed !== item) set(key, scrubbed);
  }
  return copy ?? value;
}

// One connection's view of the browser: which tabs and contexts are the
// check's, which DevTools sessions it may speak on, and what to do with every
// message in either direction.
//
//   outgoing(message) → "forward" | "refuse" | "disconnect" | "acknowledge"
//   incoming(message) → { client: [messages for the check, in order],
//                         browser: [the server's own commands] }
//
// A message in `client` that is the very object passed in was not changed.
export class Gate {
  constructor() {
    this.targets = new Set(); // the check's tabs
    this.contexts = new Set(); // browser contexts the check made
    this.sessions = new Map(); // DevTools session id → "browser" | "target"
    this.pending = new Map(); // "<sessionId>:<id>" → what the answer will teach us
    this.creating = 0; // Target.createTarget commands not yet answered
    this.attachingToBrowser = 0; // Target.attachToBrowserTarget, likewise
    this.held = []; // tabs that attached while one of those was open
    this.discovers = false; // whether the check asked to be told of its tabs coming and going
    this.privateId = PRIVATE_ID_BASE;
  }

  // The server's first message to the browser on every connection.
  discover() {
    return { id: this.nextPrivateId(), method: "Target.setDiscoverTargets", params: { discover: true } };
  }

  static key(message) {
    return `${message.sessionId ?? ""}:${message.id}`;
  }

  nextPrivateId() {
    return this.privateId--;
  }

  owns(targetId) {
    return typeof targetId === "string" && this.targets.has(targetId);
  }

  scope(sessionId) {
    return sessionId === undefined ? "browser" : this.sessions.get(sessionId);
  }

  outgoing(message) {
    const { method, params } = message;
    if (typeof method !== "string") return "refuse";
    if (typeof message.id === "number" && message.id <= PRIVATE_ID_BASE) return "refuse";
    const scope = this.scope(message.sessionId);
    // A session the check was never given: there is nothing behind it for it.
    if (!scope) return "refuse";
    if (method.startsWith("Target.")) return this.targetMethod(message);
    if (scope === "browser") {
      if (method === "Browser.close") return "disconnect";
      if (BROWSER_SCOPE.has(method)) return "forward";
      // Only about the profile's own context. For a context the check made it
      // is the check's business.
      if (BROWSER_SCOPE_ANSWERED.has(method)) return this.contexts.has(params?.browserContextId) ? "forward" : "acknowledge";
      return "refuse";
    }
    // Before the refusals: what is answered is never passed on, whatever it asks.
    if (PAGE_SCOPE_ANSWERED.has(method)) return "acknowledge";
    if (beyondAPage(method) || forgesCookie(method, params) || leavesThePage(method, params)) return "refuse";
    // An answer can carry response headers as well as an event can
    // (Network.loadNetworkResource returns them): scrubbed on the way back.
    if (method.startsWith("Network.") || method.startsWith("Fetch.")) this.pending.set(Gate.key(message), "scrub");
    return "forward";
  }

  targetMethod(message) {
    const { method, params } = message;
    const expect = (what) => this.pending.set(Gate.key(message), what);
    switch (method) {
      case "Target.setDiscoverTargets":
        // The server keeps discovery on for its own bookkeeping from the first
        // message to the last (DISCOVER, sent by session-server.mjs): it is
        // how a tab opened by a check's tab is known to be the check's. A
        // check that switched it off could leave such a tab behind in the
        // person's profile. So the check's wish only decides what it is told.
        this.discovers = params?.discover === true;
        return "acknowledge";
      case "Target.setAutoAttach":
      case "Target.getBrowserContexts":
        return "forward";
      case "Target.getTargets":
        expect("targets");
        return "forward";
      case "Target.createTarget":
        if (typeof params?.url === "string" && !webAddress(params.url)) return "refuse";
        expect("target");
        this.creating++;
        return "forward";
      case "Target.createBrowserContext":
        // A context of its own, yes; one whose traffic goes through a proxy of
        // the check's choosing, or whose origins are let past the same-origin
        // rule, no.
        if (params?.proxyServer !== undefined || params?.proxyBypassList !== undefined || params?.originsWithUniversalNetworkAccess !== undefined) return "refuse";
        expect("context");
        return "forward";
      case "Target.attachToBrowserTarget":
        expect("browserSession");
        this.attachingToBrowser++;
        return "forward";
      case "Target.getTargetInfo":
        // Without a target it describes the session's own — the browser, or
        // the check's tab.
        return params?.targetId === undefined || this.owns(params.targetId) ? "forward" : "refuse";
      case "Target.attachToTarget":
      case "Target.closeTarget":
      case "Target.activateTarget":
        return this.owns(params?.targetId) ? "forward" : "refuse";
      case "Target.disposeBrowserContext":
        return this.contexts.has(params?.browserContextId) ? "forward" : "refuse";
      case "Target.detachFromTarget":
        return this.sessions.has(params?.sessionId) ? "forward" : "refuse";
      default:
        return "refuse";
    }
  }

  incoming(message) {
    const out = { client: [], browser: [] };
    if (typeof message.id === "number" && message.id <= PRIVATE_ID_BASE) return out;
    if (message.id !== undefined) return this.answer(message, out);
    const scope = this.scope(message.sessionId);
    if (!scope) return out; // an event from a tab that is not the check's
    const { method, params } = message;
    switch (method) {
      case "Target.attachedToTarget":
        return this.attached(message, scope, out);
      case "Target.detachedFromTarget":
        if (this.sessions.delete(params?.sessionId)) out.client.push(message);
        return out;
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
        this.learn(params?.targetInfo);
        if (this.discovers && this.owns(params?.targetInfo?.targetId)) out.client.push(message);
        return out;
      case "Target.targetDestroyed":
      case "Target.targetCrashed":
        if (this.owns(params?.targetId)) {
          if (this.discovers) out.client.push(message);
          if (method === "Target.targetDestroyed") this.targets.delete(params.targetId);
        }
        return out;
      default: {
        if (typeof method === "string" && (method.startsWith("Network.") || method.startsWith("Fetch."))) {
          const scrubbed = scrubCookies(params);
          out.client.push(scrubbed === params ? message : { ...message, params: scrubbed });
        } else {
          out.client.push(message);
        }
        return out;
      }
    }
  }

  answer(message, out) {
    const key = Gate.key(message);
    const expected = this.pending.get(key);
    this.pending.delete(key);
    let reply = message;
    if (expected === "target") {
      this.creating--;
      if (message.result?.targetId) this.targets.add(message.result.targetId);
      // The tab's own "attached" must reach the check before this answer:
      // Playwright looks the new page up by the id in the answer.
      this.release(out);
    } else if (expected === "context" && message.result?.browserContextId) {
      this.contexts.add(message.result.browserContextId);
    } else if (expected === "browserSession") {
      this.attachingToBrowser--;
      if (message.result?.sessionId) this.sessions.set(message.result.sessionId, "browser");
    } else if (expected === "targets" && Array.isArray(message.result?.targetInfos)) {
      reply = { ...message, result: { ...message.result, targetInfos: message.result.targetInfos.filter((info) => this.owns(info?.targetId)) } };
    } else if (expected === "scrub" && message.result) {
      const scrubbed = scrubCookies(message.result);
      if (scrubbed !== message.result) reply = { ...message, result: scrubbed };
    }
    out.client.push(reply);
    return out;
  }

  // A tab is the check's if the check opened it, if one of the check's tabs
  // opened it (a link in a new tab, a popup — otherwise every run would leave
  // one behind), or if it lives in a context the check made.
  learn(info) {
    if (info?.type === "page" && (this.owns(info.openerId) || this.contexts.has(info.browserContextId))) {
      this.targets.add(info.targetId);
    }
  }

  attached(message, scope, out) {
    const { targetInfo: info, sessionId: child } = message.params ?? {};
    if (scope === "target") {
      // Something inside one of the check's tabs: a frame from another origin,
      // a worker.
      this.sessions.set(child, "target");
      out.client.push(message);
      return out;
    }
    // A second session on the browser itself, which the check has just asked
    // for (Playwright's newBrowserCDPSession): the browser reports it here
    // before it answers. The same rules apply on it as with no session at all.
    if (info?.type === "browser" && this.attachingToBrowser > 0) {
      this.sessions.set(child, "browser");
      out.client.push(message);
      return out;
    }
    this.learn(info);
    if (this.owns(info?.targetId)) {
      this.sessions.set(child, "target");
      out.client.push(message);
      return out;
    }
    // The browser reports a new tab before it answers the command that
    // created it. While such a command is open, a tab nobody owns yet may be
    // the check's own.
    if (info?.type === "page" && this.creating > 0) {
      this.held.push(message);
      return out;
    }
    this.letGo(message, out);
    return out;
  }

  release(out) {
    const still = [];
    for (const held of this.held) {
      if (this.owns(held.params.targetInfo.targetId)) {
        this.sessions.set(held.params.sessionId, "target");
        out.client.push(held);
      } else if (this.creating > 0) {
        still.push(held);
      } else {
        this.letGo(held, out);
      }
    }
    this.held = still;
  }

  // Not the check's: the person's tab, the hourly probe's, a service worker.
  // The check is not told. The browser attached this connection to it because
  // the check asked to be attached to whatever opens; a tab attached that way
  // may be standing still waiting for a debugger, so it is started and let go.
  letGo(message, out) {
    const { sessionId: child, waitingForDebugger } = message.params ?? {};
    const via = message.sessionId === undefined ? {} : { sessionId: message.sessionId };
    if (waitingForDebugger) out.browser.push({ id: this.nextPrivateId(), sessionId: child, method: "Runtime.runIfWaitingForDebugger" });
    out.browser.push({ id: this.nextPrivateId(), ...via, method: "Target.detachFromTarget", params: { sessionId: child } });
  }
}

export function refusal(message) {
  const reply = { id: message.id, error: { code: -32000, message: "Not allowed in a signed-in session: outside this check's own tabs" } };
  if (message.sessionId) reply.sessionId = message.sessionId;
  return reply;
}

export function acknowledged(message) {
  const reply = { id: message.id, result: {} };
  if (message.sessionId) reply.sessionId = message.sessionId;
  return reply;
}

// The address a check connects to: /v1/devtools/browser/<sessionId>, the same
// shape the extension runner serves, so the Worker's client is the same client.
export function sessionIdFromPath(pathname) {
  const match = /^\/v1\/devtools\/browser\/([^/]+)$/.exec(pathname);
  return match ? match[1] : null;
}
