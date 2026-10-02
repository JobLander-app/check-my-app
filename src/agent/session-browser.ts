// CHE-389: a check that runs inside a browser a person signed in to.
//
// Some products cannot be reached by signing in: the Shopify admin's sign-in
// has a captcha, which we never solve. A person signs in once on the session
// host (spikes/shopify-session); a run of an app whose kind is "session" then
// works in that browser — in its own tab, through the host's session server,
// which gives a check its own tabs and nothing else (lease.mjs there).
//
// This is the Worker's half: take the lease, connect, open tabs of our own,
// leave. The server speaks the address shape the extension runner speaks, so
// the client is @cloudflare/playwright's `connect` — injected, so that the
// guard (scripts/verify-session-browser.ts) can run this same class in Node
// against the real server and a real Chrome.
//
// What is NOT here, on purpose: any way to take a page this run did not open.
// The context is the person's; the only pages a run may touch are the ones
// `newPage` handed out.

import type { Browser, BrowserContext, Page } from "@cloudflare/playwright";
import type { AgentBindings } from "./env";

export const SESSION_KIND = "session";

export function isSessionTarget(run: { targetKind?: string | null }): boolean {
  return run.targetKind === SESSION_KIND;
}

export interface SessionHost {
  url: string;
  accessClientId: string;
  accessClientSecret: string;
  token: string;
}

// The four values arrive together or the kind cannot run at all — an internal
// error (rule 4), never something a customer reads.
export function sessionHost(
  bindings: Pick<AgentBindings, "SESSION_HOST_URL" | "SESSION_ACCESS_CLIENT_ID" | "SESSION_ACCESS_CLIENT_SECRET" | "SESSION_SERVER_TOKEN">,
): SessionHost {
  const url = bindings.SESSION_HOST_URL?.trim().replace(/\/+$/, "");
  const accessClientId = bindings.SESSION_ACCESS_CLIENT_ID?.trim();
  const accessClientSecret = bindings.SESSION_ACCESS_CLIENT_SECRET?.trim();
  const token = bindings.SESSION_SERVER_TOKEN?.trim();
  if (!url || !/^https:\/\//.test(url) || !accessClientId || !accessClientSecret || !token) {
    throw new Error("internal: the session host is not configured");
  }
  return { url, accessClientId, accessClientSecret, token };
}

// Another run holds the host. Not a verdict and not a failure of the product:
// the caller waits and tries again (the Workflow step's own retry).
export class SessionBusyError extends Error {
  constructor(readonly heldUntil: string | null) {
    super(`internal: the session host is held by another check${heldUntil ? ` until ${heldUntil}` : ""}`);
    this.name = "SessionBusyError";
  }
}

export type SessionFetch = (input: string, init?: RequestInit) => Promise<Response>;
// @cloudflare/playwright's `connect`, by shape.
export type SessionConnect = (
  endpoint: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
  options: { sessionId: string; persistent: boolean },
) => Promise<Browser>;

// One lease per run, renewed by every phase; long enough for the longest
// phase, short enough that a run that died frees the host by itself.
export const SESSION_LEASE_SECONDS = 1500;
const VIEWPORT = { width: 1366, height: 900 };

const sessions = new WeakMap<Browser, SessionBrowser>();
export const sessionBrowserFor = (browser: Browser) => sessions.get(browser);

function headers(host: SessionHost, extra?: HeadersInit): Headers {
  const out = new Headers(extra);
  out.set("CF-Access-Client-Id", host.accessClientId);
  out.set("CF-Access-Client-Secret", host.accessClientSecret);
  out.set("Authorization", `Bearer ${host.token}`);
  return out;
}

async function call(host: SessionHost, fetchImpl: SessionFetch, method: string, path: string, body: unknown): Promise<Response> {
  const h = headers(host, { "Content-Type": "application/json" });
  return fetchImpl(`${host.url}${path}`, { method, headers: h, body: JSON.stringify(body) });
}

export class SessionBrowser {
  // The tabs this run opened in this phase. Nothing else in the context is ours.
  private readonly pages = new Set<Page>();

  private constructor(
    readonly browser: Browser,
    readonly runId: string,
  ) {}

  static async open(
    host: SessionHost,
    runId: string,
    connect: SessionConnect,
    fetchImpl: SessionFetch = (input, init) => fetch(input, init),
  ): Promise<SessionBrowser> {
    const leased = await call(host, fetchImpl, "POST", "/lease", { ownerRunId: runId, maxDurationSeconds: SESSION_LEASE_SECONDS });
    if (leased.status === 409) {
      const held = (await leased.json().catch(() => null)) as { heldUntil?: string } | null;
      throw new SessionBusyError(held?.heldUntil ?? null);
    }
    if (!leased.ok) throw new Error(`internal: the session host refused the lease (HTTP ${leased.status})`);
    const { sessionId } = (await leased.json()) as { sessionId: string };

    // The client asks a placeholder host for /v1/devtools/browser/<id>; the
    // request goes to the session host instead, with the three credentials.
    const endpoint = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const asked = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const inherited = typeof input === "string" || input instanceof URL ? undefined : input.headers;
        return fetchImpl(`${host.url}${asked.pathname}${asked.search}`, { ...init, headers: headers(host, init?.headers ?? inherited) });
      },
    };
    const browser = await connect(endpoint, { sessionId, persistent: true });
    const session = new SessionBrowser(browser, runId);
    sessions.set(browser, session);
    return session;
  }

  // The person's profile: the one context there is. Never closed by us.
  context(): BrowserContext {
    const context = this.browser.contexts()[0];
    if (!context) throw new Error("internal: the session host's browser has no context");
    return context;
  }

  // A tab of our own. The context cannot carry our viewport (it is not ours to
  // configure), so the page does.
  async newPage(): Promise<Page> {
    const page = await this.context().newPage();
    this.pages.add(page);
    await page.setViewportSize(VIEWPORT).catch(() => {});
    return page;
  }

  // End of a phase's use of the context: our tabs go, the context stays.
  async closePages(): Promise<void> {
    const mine = [...this.pages];
    this.pages.clear();
    await Promise.all(mine.map((page) => page.close().catch(() => {})));
  }

  // End of a phase: our tabs, then the connection. The server closes whatever
  // a tab of ours opened and we lost track of. The lease stays — the next
  // phase of the same run renews it.
  async close(): Promise<void> {
    await this.closePages();
    await this.browser.close().catch(() => {});
  }
}

// End of the run: give the host back. Safe to call when nothing is held.
export async function releaseSession(host: SessionHost, runId: string, fetchImpl: SessionFetch = (input, init) => fetch(input, init)): Promise<boolean> {
  const response = await call(host, fetchImpl, "DELETE", "/lease", { ownerRunId: runId });
  if (!response.ok) return false;
  return ((await response.json().catch(() => null)) as { released?: boolean } | null)?.released === true;
}
