// Browser Rendering helpers (CHE-14). Wraps @cloudflare/playwright on the
// MYBROWSER binding. The __name shim is required — esbuild injects __name(...)
// into functions Playwright serializes for page.evaluate (proven in spike
// CHE-20). Surface scan is deterministic (no LLM): load, detect stack, count
// links, first screenshot for the live screen.

import { connect, launch } from "@cloudflare/playwright";
import type { Browser, BrowserContext, Page } from "@cloudflare/playwright";
import { detectTech } from "@/lib/tech-signals";
import { putScreenshot, type AgentBindings, type AgentEnv } from "./env";
import { announceSelfCheckOn } from "./self-hosts";
import { ExtensionBrowser, extensionBrowserFor } from "./extension-browser";
import { extensionInput, type ExtensionIdentity, type ExtensionTarget, type ExtensionRunnerInput } from "./extension-contract";
import { persistExtensionPhase } from "./extension-evidence";
import { ExtensionRuntimeError } from "./extension-error";
import { unlockStoreGate } from "./store-password";
import { storeAccessFor } from "./credentials";
import { closedDoor, deepAddresses, opensBehindDoor, DOOR_DEEP_TRIES, DOOR_RETRY_WAIT_MS, type ClosedDoor } from "./closed-door";
import { isSessionTarget, SessionBrowser, sessionBrowserFor, sessionHost, type SessionConnect } from "./session-browser";
import { landedOutside, whereItSettled } from "./signed-out";
import { parseAllowedOrigins } from "@/lib/allowed-origins";

export async function launchAgentBrowser(env: AgentEnv, target?: { run: ExtensionTarget; phase: string; expected?: ExtensionIdentity; scenario?: ExtensionRunnerInput["scenario"] }): Promise<Browser> {
  // CHE-389: an app checked inside a signed-in session runs in the session
  // host's browser. One lease per run, renewed by every phase.
  if (target && isSessionTarget(target.run)) {
    return (await SessionBrowser.open(sessionHost(env.bindings), target.run.id, connect as unknown as SessionConnect)).browser;
  }
  const input = target ? extensionInput(target.run, target.phase, target.scenario) : null;
  if (input) {
    try { return (await ExtensionBrowser.open(env, input, target?.expected)).browser; }
    catch (error) { throw new ExtensionRuntimeError(error instanceof Error ? error.message : String(error)); }
  }
  return launch(env.bindings.MYBROWSER);
}

export async function closeAgentBrowser(browser: Browser, evidence?: { env: AgentEnv; runId: string; phase: string }): Promise<void> {
  const session = sessionBrowserFor(browser);
  if (session) {
    await session.close();
    return;
  }
  const extension = extensionBrowserFor(browser);
  if (extension) {
    let failure: unknown;
    try { await extension.finish(); } catch (error) { failure = error; }
    try {
      if (evidence) await persistExtensionPhase(evidence.env, evidence.runId, evidence.phase, extension.identity, await extension.finalEvidence());
    } catch (error) { failure ??= error; }
    if (failure) throw new ExtensionRuntimeError(failure instanceof Error ? failure.message : String(failure));
  }
  else await browser.close();
}

export async function newAgentPage(browser: Browser, context: BrowserContext): Promise<Page> {
  // CHE-389: in a signed-in session the context is the person's; a run gets a
  // tab of its own and never one that was already there.
  const session = sessionBrowserFor(browser);
  if (session) return session.newPage();
  return extensionBrowserFor(browser)?.page ?? context.newPage();
}

export async function closeAgentContext(browser: Browser, context: BrowserContext): Promise<void> {
  // CHE-389: the person's context is never closed — only the tabs this run
  // opened in it.
  const session = sessionBrowserFor(browser);
  if (session) {
    await session.closePages();
    return;
  }
  // Closing the persistent profile before the runner's Stop sequence would
  // destroy the only surface capable of ending its paid application session.
  if (!extensionBrowserFor(browser)) await context.close();
}

// Context options for testing customers' OWN apps (they consented to the run).
// Browser Rendering's defaults advertise "HeadlessChrome/…" in the UA and an
// 800x600 viewport — enough for frameworks, consent gates and analytics
// wrappers to silently no-op handlers, which is our #1 false-positive source
// (CHE-37: inert clicks/submits that work in every real browser). We present a
// normal desktop Chrome profile instead; the UA is derived from the actual
// engine version, so it stays truthful (Chrome's UA-reduction freezes the
// platform/minor tokens anyway). Deliberately NOT touched: navigator.webdriver
// and other fingerprint surfaces — defeating third-party bot protection is out
// of scope and prohibited.
export function agentContextOptions(browser: Browser): NonNullable<Parameters<Browser["newContext"]>[0]> {
  const major = browser.version().split(".")[0] || "126";
  return {
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  };
}

// CHE-193 + CHE-212: the context every run is walked in. Identical to
// agentContextOptions in every case; when the run targets one of OUR hosts
// (self-hosts.ts) it also announces itself with the x-checkmyapp-checker
// header, which the web app answers with 403 on every creating/mutating API —
// the deterministic half of "a self-check never creates a run for a stranger's
// app or marks a stranger's verdict" (run #146 did both).
//
// The announcement is attached PER REQUEST, not to the context. CHE-193's
// first version used extraHTTPHeaders, which rides on every request the
// context makes: the Clerk bundle on clerk.checkmyapp.dev then became a
// preflighted cross-origin script request, the preflight met a 307, Clerk
// never loaded, and run #156 reported our own sign-in page as blank. A run of
// a customer's app installs no routing at all.
export async function newAgentContext(
  browser: Browser,
  targetUrl: string,
  bindings: Pick<AgentBindings, "SELF_CHECK_HOSTS">,
): Promise<BrowserContext> {
  // CHE-389: the signed-in profile's own context — no options of ours on it,
  // and no self-check announcement (our own hosts are never checked this way).
  const session = sessionBrowserFor(browser);
  if (session) return session.context();
  if (extensionBrowserFor(browser)) return browser.contexts()[0];
  const context = await browser.newContext(agentContextOptions(browser));
  // The routing itself lives in self-hosts.ts (pure, Playwright-free), so the
  // verify script drives the real handler on plain Node.
  await announceSelfCheckOn(context, targetUrl, bindings.SELF_CHECK_HOSTS);
  return context;
}

export async function applyNameShim(page: Page): Promise<void> {
  await page.addInitScript("window.__name = (fn) => fn;");
}

export interface SurfaceScanResult {
  status: number | null;
  techSignals: string[];
  internalLinkCount: number;
  screenshotUrl: string | null;
  /** CHE-390: the first page turned us away, twice, and showed nothing of the product. */
  door: ClosedDoor | null;
  /**
   * CHE-389: in a signed-in session, the app's address led somewhere that is
   * not the app — the host it led to. The sign-in has ended (signed-out.ts).
   * Null for every other run, and for a session run that reached the app.
   */
  signedOut: string | null;
}

export async function surfaceScan(
  env: AgentEnv,
  browser: Browser,
  // CHE-372: the run, so the scan reads a password-protected store and not its
  // /password page — the store password and its state are loaded here, from
  // the run. Both fields required, so a caller that drops them does not compile.
  // CHE-389: and the origins allowed for it, so a session run that ends on one
  // of them is not taken for a sign-in that has ended.
  run: { targetUrl: string; id: string; storePasswordEnc: string | null; allowedOrigins?: string | null },
  // CHE-390: addresses the app is already known to have (the survey's pages),
  // tried before its first page is called a closed door.
  known: string[] = [],
): Promise<SurfaceScanResult> {
  const targetUrl = run.targetUrl;
  const store = await storeAccessFor(env, run);
  const context = await newAgentContext(browser, targetUrl, env.bindings);
  // CHE-389: through the same door as every other phase, so a run inside a
  // signed-in session scans in a tab of its own (for an extension run this
  // function is not called at all).
  const inSession = Boolean(sessionBrowserFor(browser));
  const page = inSession ? await newAgentPage(browser, context) : await context.newPage();
  await applyNameShim(page);
  try {
    let response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if ((await unlockStoreGate(page, targetUrl, store)) === "unlocked") {
      response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    // CHE-389: where the address ended up, once the page has had its say — a
    // product may send a visitor who is not signed in to its sign-in from a
    // script, after the first document has loaded. Decided here, before a model
    // sees anything; the caller ends the run on it.
    let signedOut: string | null = null;
    if (inSession) {
      const allowed = parseAllowedOrigins(run.allowedOrigins, env.bindings.SELF_CHECK_HOSTS);
      // "Loaded" is not the end of it, and neither is the first address that
      // is not the app: the address is watched until it has stayed put
      // (whereItSettled, signed-out.ts).
      signedOut = await whereItSettled(
        () => page.url(),
        (url) => landedOutside(url, targetUrl, allowed),
        (ms) => page.waitForTimeout(ms),
      );
    }
    // The signal tables live in lib/tech-signals (CHE-132) so the free page
    // survey reads the same stack off a plain fetch that this scan reads off
    // the browser response.
    const signals = detectTech(response?.headers() ?? {}, await page.content());

    const origin = new URL(targetUrl).origin;
    const countInternalLinks = () =>
      page
        .evaluate((o: string) => {
          const hrefs = Array.from(document.querySelectorAll("a[href]"))
            .map((a) => {
              try {
                return new URL(a.getAttribute("href") ?? "", location.href).href;
              } catch {
                return null;
              }
            })
            .filter((h): h is string => Boolean(h && h.startsWith(o)));
          return new Set(hrefs).size;
        }, origin)
        .catch(() => 0);
    let internalLinkCount = await countInternalLinks();

    // CHE-390: a first page that answers 401/403 and shows nothing of the
    // product may be a closed door — or a challenge that lets a browser through
    // once its script has run. Asked once more after a pause; only the same
    // answer twice is a door (closed-door.ts).
    let door: ClosedDoor | null = null;
    const firstStatus = response?.status() ?? null;
    if (closedDoor(firstStatus, firstStatus, internalLinkCount)) {
      await page.waitForTimeout(DOOR_RETRY_WAIT_MS);
      const again = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
      if (again) {
        response = again;
        internalLinkCount = await countInternalLinks();
      }
      door = closedDoor(firstStatus, again?.status() ?? null, internalLinkCount);
      // An app we have looked at before may keep its first page closed and its
      // product open: an address it is known to have decides.
      if (door) {
        for (const url of deepAddresses(targetUrl, known).slice(0, DOOR_DEEP_TRIES)) {
          const deep = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
          if (opensBehindDoor(deep?.status() ?? null)) {
            door = null;
            break;
          }
        }
      }
    }

    let screenshotUrl: string | null = null;
    try {
      const shot = await page.screenshot({ fullPage: false });
      screenshotUrl = (await putScreenshot(env, shot)).storageUrl;
    } catch {
      /* screenshot failure must not fail the scan */
    }

    return {
      status: response?.status() ?? null,
      techSignals: signals,
      internalLinkCount,
      screenshotUrl,
      // A sign-in that ended is not a closed door: it is access, not a gap.
      door: signedOut ? null : door,
      signedOut,
    };
  } finally {
    await closeAgentContext(browser, context);
  }
}
