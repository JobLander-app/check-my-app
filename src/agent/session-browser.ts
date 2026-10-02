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

import type { Browser, BrowserContext, Locator, Page } from "@cloudflare/playwright";
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
// Is this page a tab inside a person's signed-in session? Asked of the page
// itself — the browser it belongs to — so no caller has to remember to say so.
export function inSignedInSession(page: Page): boolean {
  const browser = page.context().browser();
  return Boolean(browser && sessions.has(browser));
}

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

// Take the lease, or renew it: the same call. → the lease's session id.
async function lease(host: SessionHost, runId: string, fetchImpl: SessionFetch): Promise<string> {
  const leased = await call(host, fetchImpl, "POST", "/lease", { ownerRunId: runId, maxDurationSeconds: SESSION_LEASE_SECONDS });
  if (leased.status === 409) {
    const held = (await leased.json().catch(() => null)) as { heldUntil?: string } | null;
    throw new SessionBusyError(held?.heldUntil ?? null);
  }
  if (!leased.ok) throw new Error(`internal: the session host refused the lease (HTTP ${leased.status})`);
  return ((await leased.json()) as { sessionId: string }).sessionId;
}

// ── waiting for the host ──
//
// The host is one browser, leased to one run for the whole of that run — and
// runs overlap: the scheduler starts several per tick, and a person starts one
// whenever they like. A run that finds the host held is not a failed run. It
// waits its turn BEFORE its first phase, asking again until the lease is its
// own, and only then starts. (Left to a step's ordinary retries, the second
// run gave up after a few minutes while the first could hold the host for the
// length of a whole check — Codex on #248.)
//
// How long between asks: until the holder's lease would lapse, but never long
// — the holder gives the host back the moment it finishes, usually well before
// that, and renews at every phase while it has not.
export const SESSION_WAIT_MIN_SECONDS = 30;
export const SESSION_WAIT_MAX_SECONDS = 180;
// Past this the host is not busy, it is stuck — ours to look at (rule 4: the
// run fails with an internal reason and publishes nothing).
export const SESSION_WAIT_LIMIT_SECONDS = 2 * 60 * 60;

export function sessionWaitSeconds(heldUntil: string | null, now: number): number {
  const left = heldUntil ? Math.ceil((Date.parse(heldUntil) - now) / 1000) + 5 : NaN;
  if (!Number.isFinite(left)) return SESSION_WAIT_MIN_SECONDS;
  return Math.min(SESSION_WAIT_MAX_SECONDS, Math.max(SESSION_WAIT_MIN_SECONDS, left));
}

export type SessionTurn = { taken: true } | { taken: false; waitSeconds: number };

// One ask. The wait is worked out here, next to the clock, so that a Workflow
// can keep the answer as a step's result and replay it unchanged.
export async function askForSession(
  host: SessionHost,
  runId: string,
  fetchImpl: SessionFetch = (input, init) => fetch(input, init),
  now: () => number = Date.now,
): Promise<SessionTurn> {
  try {
    await lease(host, runId, fetchImpl);
    return { taken: true };
  } catch (error) {
    if (error instanceof SessionBusyError) return { taken: false, waitSeconds: sessionWaitSeconds(error.heldUntil, now()) };
    throw error;
  }
}

// The three durable steps of the wait, each under a name of its own — a
// Workflow's step.do / step.sleep in the Worker, the guard's own in Node, so
// that this same loop is driven against the real server.
export interface SessionSteps {
  ask(name: string): Promise<SessionTurn>;
  // Once, the first time the host turns out to be held.
  waiting(name: string): Promise<void>;
  sleep(name: string, seconds: number): Promise<void>;
}

// → how long the run waited. Throws SessionBusyError once the limit is spent.
export async function waitForSession(steps: SessionSteps, limitSeconds = SESSION_WAIT_LIMIT_SECONDS): Promise<number> {
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    const turn = await steps.ask(`session-turn-${attempt}`);
    if (turn.taken) return waited;
    if (waited >= limitSeconds) throw new SessionBusyError(null);
    if (attempt === 1) await steps.waiting("session-waiting");
    await steps.sleep(`session-wait-${attempt}`, turn.waitSeconds);
    waited += turn.waitSeconds;
  }
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
    const sessionId = await lease(host, runId, fetchImpl);

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

// ── the person's sign-in is not ours to end ──
//
// A run in this browser stands inside a sign-in a person made by hand, past a
// captcha we never solve. One click on "Log out" — or one visit to a sign-out
// address — clears it for every later phase and every later run, until that
// person comes back. So a session run never signs out, never switches the
// account, and never opens an address that does: refused in the tools, by what
// the control IS (its text, its accessible name, where it leads, the form it
// submits), not by what the model called it (Codex on #248).
//
// Known limit, said so it is not mistaken for coverage: a control whose text
// and address say nothing of signing out, and whose script signs out anyway,
// is not seen here.
const SIGN_OUT_WORDS =
  /\b(log\s?-?out|sign\s?-?out|log\s?-?off|sign\s?-?off|switch (accounts?|users?)|change accounts?|use (a different|another) account|(remove|forget) (this |the )?account|sign in (as|with) (a different|another))\b/i;
// "/logout", "/auth/sign_out", "/users/sign-out", "?action=logout" — a path
// segment or a query value, never a word inside a longer one ("/blog/outline").
const SIGN_OUT_ADDRESS = /(^|[/._=?&-])(log[-_]?out|sign[-_]?out|log[-_]?off|sign[-_]?off)([/._=?&#-]|$)/i;

export function isSignOutText(text: string | null | undefined): boolean {
  return Boolean(text && SIGN_OUT_WORDS.test(text));
}

export function isSignOutAddress(url: string | null | undefined, base?: string): boolean {
  if (!url) return false;
  let address = url;
  try {
    const parsed = new URL(url, base);
    address = `${parsed.pathname}${parsed.search}`;
  } catch {
    /* not an address we can resolve — judged as written */
  }
  return SIGN_OUT_ADDRESS.test(address);
}

export interface ControlSeen {
  texts: string[];
  addresses: string[];
  base?: string;
}

// → what about the control says "this signs out", or null.
export function signOutIn(control: ControlSeen): string | null {
  const text = control.texts.find((t) => isSignOutText(t));
  if (text) return text.trim().replace(/\s+/g, " ").slice(0, 80);
  const address = control.addresses.find((a) => isSignOutAddress(a, control.base));
  return address ? address.slice(0, 120) : null;
}

// What a control is, read off the page: its own text and name, those of the
// link / button / menu item it sits in, where it leads, and — for a submit —
// the form it sends. Null when it could not be read (the click that follows
// then fails or not on its own account).
export async function controlSeen(locator: Locator): Promise<ControlSeen | null> {
  return locator
    .evaluate(
      (el) => {
        const texts: string[] = [];
        const addresses: string[] = [];
        let node: Element | null = el;
        for (let depth = 0; node && depth < 5; depth++) {
          if (depth === 0 || node.matches("a, button, summary, [role=button], [role=menuitem], [role=link], [role=option]")) {
            texts.push(
              (node as HTMLElement).innerText ?? node.textContent ?? "",
              node.getAttribute("aria-label") ?? "",
              node.getAttribute("title") ?? "",
              node.getAttribute("value") ?? "",
            );
            addresses.push(node.getAttribute("href") ?? "", node.getAttribute("formaction") ?? "", node.getAttribute("data-href") ?? "", node.getAttribute("data-url") ?? "");
          }
          node = node.parentElement;
        }
        const form = el.closest("form");
        if (form && el.closest("button, input[type=submit], input[type=image]")) addresses.push(form.getAttribute("action") ?? "");
        return {
          texts: texts.map((t) => t.trim().slice(0, 200)).filter(Boolean),
          addresses: addresses.filter(Boolean),
          base: document.baseURI,
        };
      },
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => null);
}

// What the walk is told. It names the product's control and nothing of ours.
export function signOutRefusal(what: string): string {
  return (
    `Refused: "${what}" would sign this account out, and every check of this app runs inside that ` +
    `sign-in. Signing out, switching the account and opening a sign-out address are never done. ` +
    `Confirm the control is present and reachable, report the step "skipped" with unverifiedReason ` +
    `"not_applicable", and go on with what can be checked while signed in.`
  );
}

// End of the run: give the host back. Safe to call when nothing is held.
export async function releaseSession(host: SessionHost, runId: string, fetchImpl: SessionFetch = (input, init) => fetch(input, init)): Promise<boolean> {
  const response = await call(host, fetchImpl, "DELETE", "/lease", { ownerRunId: runId });
  if (!response.ok) return false;
  return ((await response.json().catch(() => null)) as { released?: boolean } | null)?.released === true;
}
