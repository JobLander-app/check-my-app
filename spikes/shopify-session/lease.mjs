// CHE-389: the rules of the session server, as pure functions and one small
// class — no socket, no clock of their own. session-server.mjs is the wiring;
// scripts/verify-session-server.mjs drives both.
//
// The browser on this host is the one a person signed in to. A check is a
// visitor in it, exactly like the hourly probe: it opens its own tabs, works in
// them, and leaves. Two things follow, and both are enforced here rather than
// trusted to the caller:
//
//   1. One check at a time. Two checks in one profile would read each other's
//      tabs and report each other's state as the product's.
//   2. A check can end nothing it did not start: not the browser, not the
//      person's tab, not the cookies that are the session.

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

// What a check may never do to the profile, whatever its code believes: these
// end the person's session or rewrite it. Reading is not on the list — a check
// that can open the admin can see what the admin shows.
const SESSION_ENDING = new Set([
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Network.clearBrowserCookies",
  "Network.deleteCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Storage.clearCookies",
  "Storage.setCookies",
  "Storage.clearDataForOrigin",
  "Storage.clearDataForStorageKey",
]);

// Everything one connection opened: its tabs (and the tabs those tabs opened)
// and its browser contexts. Closing is allowed inside this set and refused
// outside it; when the connection goes, the tabs in it are closed for it.
export class Owned {
  constructor() {
    this.targets = new Set();
    this.contexts = new Set();
    this.pending = new Map(); // "<sessionId>:<id>" → "target" | "context"
  }

  static key(message) {
    return `${message.sessionId ?? ""}:${message.id}`;
  }

  // A message from the check → "forward" | "disconnect" | "refuse".
  outgoing(message) {
    const { method, params } = message;
    if (method === "Browser.close") return "disconnect";
    if (SESSION_ENDING.has(method)) return "refuse";
    if (method === "Target.closeTarget") return this.targets.has(params?.targetId) ? "forward" : "refuse";
    if (method === "Target.disposeBrowserContext") return this.contexts.has(params?.browserContextId) ? "forward" : "refuse";
    if (method === "Target.createTarget") this.pending.set(Owned.key(message), "target");
    if (method === "Target.createBrowserContext") this.pending.set(Owned.key(message), "context");
    return "forward";
  }

  // A message from the browser: learn what the check has just opened.
  incoming(message) {
    if (message.id !== undefined) {
      const kind = this.pending.get(Owned.key(message));
      if (!kind) return;
      this.pending.delete(Owned.key(message));
      if (kind === "target" && message.result?.targetId) this.targets.add(message.result.targetId);
      if (kind === "context" && message.result?.browserContextId) this.contexts.add(message.result.browserContextId);
      return;
    }
    if (message.method === "Target.targetCreated" || message.method === "Target.attachedToTarget") {
      const info = message.params?.targetInfo;
      // A tab one of the check's tabs opened (a link in a new tab, a popup) is
      // the check's too — otherwise every run would leave one behind — and so
      // is any tab in a context the check made.
      if (info?.type === "page" && (this.targets.has(info.openerId) || this.contexts.has(info.browserContextId))) {
        this.targets.add(info.targetId);
      }
      return;
    }
    if (message.method === "Target.targetDestroyed") this.targets.delete(message.params?.targetId);
  }
}

export function refusal(message) {
  const reply = { id: message.id, error: { code: -32000, message: "Not allowed in a signed-in session: this check did not open it" } };
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
