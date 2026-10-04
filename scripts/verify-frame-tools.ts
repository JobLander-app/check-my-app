// CHE-373 verification: an app that renders inside a cross-origin iframe is
// visible to the walk and can be used by it — and the test login still goes
// nowhere the owner did not allow.
//
// Found 2026-10-01 in the Shopify admin: Securify renders in
// iframe[name=app-iframe] from its own origin. read_page walked same-origin
// frames only (the app was one "FRAMES: <src>" line), click and fill acted on
// the top page only, and navigate refused every origin but the target's. Only
// the screenshot showed the app.
//
// A real browser, not a stub: whether the tools can reach across an origin
// boundary is a property of the browser, and a stub would answer whatever it
// was written to answer. Three fake origins are served by Playwright route
// fulfilment, so nothing touches the network:
//   https://admin.shop.test   — the host page (the run's target)
//   https://app.embedded.test — the embedded app, framed by the host page
//   https://login.other.test  — a third party's login form, framed too
//   https://pixel.other.test  — a 1×1 tracking frame
//   https://idp.other.test    — an identity provider an app bounces to mid-fill
//   challenges.cloudflare.com — a bot-protection widget, never to be touched
//
// Chromium: Playwright's own build when installed, else the system Chrome
// (GitHub's ubuntu runners carry one). Neither is a FAIL, never a skip.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-frame-tools.ts
//        FRAME_TOOLS_CHANNEL=chrome … to run it on the system Chrome, as CI does

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import type { PrismaClient } from "@/generated/prisma/client";
import { replayJourney } from "@/agent/journey-replay";
import type { AgentEnv } from "@/agent/env";
import { classifyGap, settleStepGap, walkGapEvidence } from "@/agent/gap-classes";
import { createWatchRun, type DueWatch } from "@/agent/scheduler";
import { startSavedApp } from "@/lib/start-saved-app";
import { createRecheckRun } from "@/lib/recheck";
import { errorResponseIn, executeTool, isAllowedOrigin, isTargetHost, prepareAgentPage, type ToolEnv } from "@/agent/tools";
import { shouldAnnounceSelfCheck } from "@/agent/self-hosts";
import { allowedOriginsBlock, walkingSystem } from "@/agent/instructions";
import {
  normalizeAllowedOrigin,
  parseAllowedOrigins,
  parseAllowedOriginsInput,
  serializeAllowedOrigins,
} from "@/lib/allowed-origins";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const TOP = "https://admin.shop.test";
const APP = "https://app.embedded.test";
const LOGIN = "https://login.other.test";
const PIXEL = "https://pixel.other.test";
// The identity provider an embedded app bounces to mid-fill (the credential race).
const IDP = "https://idp.other.test";
// A bot-protection widget's frame: reaching into frames must not become a way
// past one (browser.ts — defeating bot protection is prohibited).
const CHALLENGE = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile";

const PAGES: Record<string, string> = {
  [`${TOP}/`]: `<!doctype html><title>Shop admin</title>
    <h1>Shop admin</h1>
    <button onclick="document.title='menu'">Admin menu</button>
    <iframe name="app-iframe" src="${APP}/" width="800" height="400"></iframe>
    <iframe name="vendor-login" src="${LOGIN}/" width="400" height="200"></iframe>
    <iframe src="${PIXEL}/" width="1" height="1"></iframe>
    <iframe name="challenge" src="${CHALLENGE}/" width="300" height="80"></iframe>
    <div id="host-modal"></div>
    <script>addEventListener("message", (e) => {
      if (e.origin === "${APP}" && e.data === "open-modal") document.getElementById("host-modal").textContent = "Host modal open";
    });</script>`,
  [`${APP}/`]: `<!doctype html><title>Securify</title>
    <h2>Securify settings</h2>
    <p id="status">Report not opened</p>
    <button onclick="document.getElementById('status').textContent='Report ready'">Open report</button>
    <button onclick="parent.postMessage('open-modal', '*')">Open host modal</button>
    <label for="email">Store email</label><input id="email" type="email"
      oninput="document.getElementById('who').textContent = 'Signed in as ' + this.value">
    <p id="who"></p>
    <label for="vault">Vault key</label><input id="vault" type="password">`,
  // Frames with no address of their own: they act for the app that made them
  // (srcdoc, data:) or run opaque (sandbox).
  [`${TOP}/inherit`]: `<!doctype html><title>Shop admin</title><h1>Shop admin</h1>
    <iframe name="app-iframe" src="${APP}/inherit" width="800" height="400"></iframe>`,
  [`${APP}/inherit`]: `<!doctype html><title>Securify</title><h2>Securify editor</h2>
    <iframe name="editor" width="300" height="80"
      srcdoc="<button onclick=&quot;document.body.dataset.pressed='yes'&quot;>Bold</button><label for=e>Editor key</label><input id=e type=password>"></iframe>
    <iframe name="sandboxed" sandbox="allow-scripts" width="300" height="80"
      srcdoc="<label for=k>Sandbox key</label><input id=k type=password>"></iframe>
    <iframe name="datadoc" width="300" height="80"
      src="data:text/html,${encodeURIComponent(`<button onclick="document.body.dataset.pressed='yes'">Italic</button>`)}"></iframe>`,
  // A same-origin frame: read with the page, and since CHE-373 also acted in.
  [`${TOP}/same`]: `<!doctype html><title>Shop admin</title><h1>Shop admin</h1>
    <iframe name="inner" src="${TOP}/inner" width="600" height="200"></iframe>`,
  [`${TOP}/inner`]: `<!doctype html><title>Inner</title><h2>Inner settings</h2>
    <button onclick="document.body.dataset.pressed='yes'">Same-origin action</button>`,
  // The credential race: the app's sign-in bounces to its identity provider,
  // whose page has a field with the same name, focused on load.
  [`${TOP}/race`]: `<!doctype html><title>Shop admin</title><h1>Shop admin</h1>
    <iframe name="app-iframe" src="${APP}/race" width="600" height="200"></iframe>`,
  [`${APP}/race`]: `<!doctype html><title>Securify</title><label for="p">Account password</label><input id="p" type="password">`,
  [`${TOP}/race-top`]: `<!doctype html><title>Shop admin</title><label for="p">Account password</label><input id="p" type="password">`,
  // The same bounce, later: the app shows no field of its own ("Signing you
  // in…"), so the fill is still waiting for one when the provider's arrives.
  [`${TOP}/late`]: `<!doctype html><title>Shop admin</title><h1>Shop admin</h1>
    <iframe name="app-iframe" src="${APP}/late" width="600" height="200"></iframe>`,
  [`${APP}/late`]: `<!doctype html><title>Securify</title><p>Signing you in…</p>`,
  [`${TOP}/late-top`]: `<!doctype html><title>Shop admin</title><p>Signing you in…</p>`,
  [`${IDP}/`]: `<!doctype html><title>Sign in</title><label for="p">Account password</label><input id="p" type="password" autofocus>`,
  [`${LOGIN}/`]: `<!doctype html><title>Vendor login</title>
    <h2>Vendor sign-in</h2>
    <label for="pw">Password</label><input id="pw" type="password">
    <button onclick="document.body.dataset.touched='yes'">Vendor help</button>`,
  [`${PIXEL}/`]: `<!doctype html><button>Track me</button>`,
  [`${CHALLENGE}/`]: `<!doctype html><h2>Verify you are human</h2><label for="cb">I am human</label><input id="cb" type="checkbox" onclick="document.body.dataset.touched='yes'">`,
};

async function launch(): Promise<Browser> {
  // CI has no Playwright build and runs the system Chrome, which is newer and
  // does not treat every frame the same way (see the sandboxed frame below).
  // FRAME_TOOLS_CHANNEL=chrome runs this on that browser from a desk.
  const channel = process.env.FRAME_TOOLS_CHANNEL;
  if (channel) return chromium.launch({ channel });
  try {
    return await chromium.launch();
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch (system) {
      throw new Error(
        `no Chromium to run the frame fixture: Playwright's build (${(bundled as Error).message.split("\n")[0]}) ` +
          `and the system Chrome (${(system as Error).message.split("\n")[0]}) both failed`,
      );
    }
  }
}

const SECRET_EMAIL = "owner-test@example.test";
const SECRET_PASSWORD = "s3cret-frame-pass";

async function routedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const body = PAGES[`${url.origin}${url.pathname}`];
    if (body === undefined) return route.fulfill({ status: 404, body: "not found" });
    // The identity provider answers slowly, as a real one does: its navigation
    // is in flight while fill waits for hydration, and commits inside that wait
    // — the frame then reports the provider's address when the origin is read.
    if (url.origin === IDP) await new Promise((r) => setTimeout(r, 300));
    return route.fulfill({ status: 200, contentType: "text/html", body });
  });
  return context;
}

async function freshEnv(browser: Browser, allowedOrigins?: string[]): Promise<ToolEnv & { page: Page }> {
  return envAt(browser, `${TOP}/`, allowedOrigins, 4);
}

async function envAt(browser: Browser, url: string, allowedOrigins: string[] | undefined, iframes: number): Promise<ToolEnv & { page: Page }> {
  const context = await routedContext(browser);
  const page = await context.newPage();
  const env = {
    page,
    targetOrigin: TOP,
    ...(allowedOrigins ? { allowedOrigins } : {}),
    testEmail: SECRET_EMAIL,
    testPassword: SECRET_PASSWORD,
    credentials: { rejected: false },
    networkLog: [],
    consoleLog: [],
    actionTrail: [],
    undrivenControls: [],
  } as unknown as ToolEnv & { page: Page };
  await prepareAgentPage(env);
  const nav = await executeTool(env, "navigate", { url });
  if (!nav.startsWith("Navigated")) throw new Error(`fixture did not load: ${nav}`);
  // Every frame loaded before anything is asserted about it.
  await page.waitForFunction((n) => document.querySelectorAll("iframe").length === n, iframes);
  for (const frame of page.frames()) await frame.waitForLoadState("load");
  return env;
}

// The credential race (cross-review of #222): the document holding the field
// navigates to the identity provider while fill is at work. Three shapes; the
// first two do not depend on timing.
//   hydration — the bounce starts on the document's next animation frame, which
//     is the one fill's own hydration wait asks for: the field was found on the
//     app, and the write that follows the wait meets the provider's document.
//     (A check of the frame's address in Node, made after that wait, still read
//     the app's origin here — which is why there is none.)
//   late — the app has no field yet ("Signing you in…"), so fill is waiting for
//     one when the provider's page arrives with a field of the same name.
//   timed — the bounce starts `delayMs` after fill is called, wherever that
//     lands in fill's work (the sweep the cross-review leaked 4 of 14 on).
// In each, only the check made inside the document, in the same task as the
// write, stands between the password and the provider's field. Whatever the
// tool answers, that field must never hold the password.
const LATE_BOUNCE_MS = 2_500;

async function raceOnce(
  browser: Browser,
  where: "frame" | "page",
  shape: "timed" | "late" | "hydration",
  delayMs: number,
): Promise<{ result: string; leaked: boolean; detail: string }> {
  const inFrame = where === "frame";
  const path = shape === "late" ? (inFrame ? "/late" : "/late-top") : inFrame ? "/race" : "/race-top";
  const env = await envAt(browser, `${TOP}${path}`, [APP], inFrame ? 1 : 0);
  const doc = inFrame ? appFrame(env.page) : env.page.mainFrame();
  if (shape === "hydration") {
    await doc.evaluate((to) => {
      window.requestAnimationFrame = () => {
        location.href = to;
        return 0;
      };
    }, `${IDP}/`);
  } else {
    await doc.evaluate(([to, ms]) => {
      setTimeout(() => {
        location.href = to as string;
      }, ms as number);
    }, [`${IDP}/`, delayMs] as const);
  }
  const result = await executeTool(env, "fill", { label: "Account password", value: "{{TEST_PASSWORD}}", ...(inFrame ? { frame: "app-iframe" } : {}) });
  // Let the navigation finish wherever it was (the provider answers 300ms after
  // it is asked, see routedContext), then look at the provider's field.
  let idp: Frame | undefined;
  for (let i = 0; i < 50 && !idp; i++) {
    idp = env.page.frames().find((f) => f.url().startsWith(IDP));
    if (!idp) await env.page.waitForTimeout(100);
  }
  const tag = `${where}, ${shape} +${delayMs}ms`;
  // A race that never reached the provider proves nothing: say so, do not pass.
  if (!idp) {
    await env.page.context().close();
    return { result, leaked: true, detail: `${tag} → the provider never loaded; the fixture did not race` };
  }
  await idp.waitForLoadState("load").catch(() => {});
  const idpValue = await idp.inputValue("#p").catch(() => "");
  await env.page.context().close();
  return { result, leaked: idpValue === SECRET_PASSWORD, detail: `${tag} → ${result.slice(0, 120)} | idp field ${idpValue ? "FILLED" : "empty"}` };
}

const appFrame = (page: Page) => page.frames().find((f) => f.url().startsWith(APP))!;
const loginFrame = (page: Page) => page.frames().find((f) => f.url().startsWith(LOGIN))!;

async function main() {
  // ─── Pure parts: what an allowed origin is ────────────────────────────────
  check("an https origin is allowed", normalizeAllowedOrigin("https://admin.shopify.com/") === "https://admin.shopify.com");
  check("http is not", normalizeAllowedOrigin("http://admin.shopify.com") === null);
  check("a path is not", normalizeAllowedOrigin("https://admin.shopify.com/store/x") === null);
  check("a wildcard is not", normalizeAllowedOrigin("https://*.myshopify.com") === null);
  check("credentials in the URL are not", normalizeAllowedOrigin("https://u:p@admin.shopify.com") === null);
  check("our own host is not", normalizeAllowedOrigin("https://checkmyapp.dev") === null);
  check("…nor a subdomain of it", normalizeAllowedOrigin("https://www.checkmyapp.dev") === null);
  const bad = parseAllowedOriginsInput(["https://admin.shopify.com", "http://x.test"]);
  check("one bad origin refuses the whole list", !bad.ok);
  const good = parseAllowedOriginsInput(["https://admin.shopify.com", "https://ADMIN.shopify.com/", APP]);
  check("a good list is deduped", good.ok && good.origins.length === 2, JSON.stringify(good));
  check("an empty list clears the column", serializeAllowedOrigins([]) === null);
  check(
    "a stored list round-trips; garbage in it is dropped",
    JSON.stringify(parseAllowedOrigins(JSON.stringify([APP, "http://evil.test", 7, "https://checkmyapp.dev"]))) === JSON.stringify([APP]),
  );
  check("an unparsable column reads as no origins", parseAllowedOrigins("{not json").length === 0);

  // Our staging/preview hosts come from the SELF_CHECK_HOSTS binding, which the
  // web app cannot see when the list is saved — the run refuses them itself.
  const staging = "https://preview.cma-staging.test";
  check("a SELF_CHECK_HOSTS host passes the save-time check (it cannot see the binding)", normalizeAllowedOrigin(staging) === staging);
  check(
    "isAllowedOrigin: an allowed origin that is one of our SELF_CHECK_HOSTS is refused at run time",
    !isAllowedOrigin({ targetOrigin: TOP, allowedOrigins: [staging, APP], selfCheckHosts: "cma-staging.test" }, staging),
  );
  check(
    "isAllowedOrigin: …while the other allowed origins stay allowed",
    isAllowedOrigin({ targetOrigin: TOP, allowedOrigins: [staging, APP], selfCheckHosts: "cma-staging.test" }, APP),
  );
  check(
    "parseAllowedOrigins: the run drops our SELF_CHECK_HOSTS before tools, evidence or prompt see the list",
    JSON.stringify(parseAllowedOrigins(JSON.stringify([staging, APP]), "cma-staging.test")) === JSON.stringify([APP]),
  );
  check(
    "isAllowedOrigin: our own target is still our target (the self-check)",
    isAllowedOrigin({ targetOrigin: "https://checkmyapp.dev", allowedOrigins: [] }, "https://checkmyapp.dev"),
  );

  check("isTargetHost: the target", isTargetHost("admin.shop.test", TOP));
  check("isTargetHost: an allowed origin's host", isTargetHost("app.embedded.test", TOP, [APP]));
  check("isTargetHost: without the list it is foreign, as before", !isTargetHost("app.embedded.test", TOP));

  // Public suffixes: a namespace of strangers' sites is never "the product".
  for (const suffix of ["https://com.au", "https://co.uk", "https://github.io", "https://myshopify.com", "https://vercel.app", "https://com"]) {
    check(`public suffix refused: ${suffix}`, normalizeAllowedOrigin(suffix) === null);
  }
  check("one site under a shared namespace is allowed", normalizeAllowedOrigin("https://my-store.myshopify.com") === "https://my-store.myshopify.com");
  check("…and a stored public suffix is dropped on read", parseAllowedOrigins(JSON.stringify(["https://github.io", APP])).join() === APP);
  check("isTargetHost: an allowed origin's host is matched exactly, not as a suffix", !isTargetHost("api.app.embedded.test", TOP, [APP]));
  check("isTargetHost: a suffix that got stored anyway makes no stranger the product", !isTargetHost("evil-shop.com.au", TOP, ["https://com.au"]));
  check("isTargetHost: …nor anyone.github.io", !isTargetHost("anyone.github.io", TOP, ["https://me.github.io"]));
  check("isTargetHost: the target keeps its subdomains", isTargetHost("api.admin.shop.test", TOP, [APP]));

  // The walk classifies a step on the origins its tools act on (execution.ts).
  const gapText = "app.embedded.test answered 403 to the sign-in";
  check(
    "gap class: a 403 from an allowed origin is not a third party's block",
    classifyGap(walkGapEvidence({ targetOrigin: TOP, allowedOrigins: [APP] }, gapText, [])) !== "third_party_block",
  );
  check(
    "gap class: …while without the list it is (the fixture discriminates)",
    classifyGap(walkGapEvidence({ targetOrigin: TOP }, gapText, [])) === "third_party_block",
  );
  // Report time classifies through settleStepGap (CHE-374), which builds its
  // evidence with walkGapEvidence from the env it is handed — run here with
  // the origins, not pattern-matched.
  {
    const settle = (allowedOrigins?: string[]) => {
      const step: { unverifiedReason: string; observed: string; gapClass?: string } = { unverifiedReason: "our_capability", observed: gapText };
      settleStepGap({ reported: { label: "Sign in", observed: gapText }, step: step as never, machineClass: undefined, actionTrail: [], env: { targetOrigin: TOP, allowedOrigins }, targetUrl: `${TOP}/` });
      return step.gapClass;
    };
    check("gap class, at report time: an allowed origin's 403 is not a third party's block", settle([APP]) !== "third_party_block", String(settle([APP])));
    check("gap class, at report time: …while without the list it is", settle() === "third_party_block", String(settle()));
    // The walk itself cannot be driven here (it is the model's loop), so the
    // one thing left to its call site is held by shape: it hands settleStepGap
    // the walk's own tool env and classifies nothing itself.
    const walk = readFileSync(join(import.meta.dirname, "..", "src/agent/execution.ts"), "utf8");
    check("gap class: the walk settles the step on its tool env's origins (execution.ts)",
      /settleStepGap\(\{[^}]*\benv:\s*toolEnv\s*,/.test(walk) && !/\bclassifyGap\(/.test(walk));
  }

  // Every way a run is created carries the app's allowed origins; without them
  // no production run would get any, with every check above still green.
  {
    const stored = JSON.stringify([APP]);
    const created: Record<string, unknown>[] = [];
    let serial = 0;
    const noSpend = { aggregate: async () => ({ _sum: { priceUsd: 0, priceFromTopupUsd: 0 } }), findMany: async () => [] };
    const app = {
      id: "app", ownerId: "owner", teamId: "team_owner", appSlug: "admin.shop.test", targetUrl: `${TOP}/`, targetKind: "website",
      extensionId: null, extensionConfig: null, testEmail: null, testPasswordEnc: null, scopeHints: null, userNotes: null, focusAreas: null,
      allowedOrigins: stored,
    };
    const db = {
      counter: { upsert: async () => ({ value: ++serial }) },
      team: { findUnique: async () => ({ topupUsd: 0 }) },
      testAccount: { findMany: async () => [] },
      app: { findFirst: async () => app },
      run: {
        ...noSpend,
        findFirst: async () => null,
        findUnique: async () => ({
          ...app, id: "old-run", appId: "app", status: "completed", ephemeral: false, watchId: null, notifyEmail: null,
          testAccounts: null, paidCheckoutSessionId: null, team: { plan: "business" },
        }),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: `r${serial}`, publicId: `p${serial}` };
        },
      },
    } as unknown as PrismaClient;
    await startSavedApp(db, { id: "owner", teamId: "team_owner", plan: "business" }, "app", { trigger: async () => {}, siteCap: () => 20 });
    check("run creation: a dashboard/MCP start carries the app's allowed origins", created.at(-1)?.allowedOrigins === stored, String(created.at(-1)?.allowedOrigins));
    await createRecheckRun(db, "p-old", {}, {
      canMutate: async () => true, trigger: async () => {}, siteCap: () => 20, now: () => new Date("2026-10-01T00:00:00Z"), ephemeralTtlDays: () => 7,
    });
    check("run creation: a re-check carries the run's allowed origins", created.length === 2 && created.at(-1)?.allowedOrigins === stored, String(created.at(-1)?.allowedOrigins));
    const watch: DueWatch = {
      id: "watch", appSlug: app.appSlug, targetUrl: app.targetUrl, notifyEmail: null, testEmail: null, testPasswordEnc: null,
      appId: "app", ownerId: "owner", teamId: "team_owner",
      app: { scopeHints: null, userNotes: null, focusAreas: null, allowedOrigins: stored, targetKind: "website", extensionId: null, extensionConfig: null },
    };
    await createWatchRun({ db } as unknown as AgentEnv, watch, null);
    check("run creation: a watch's run carries the app's allowed origins", created.length === 3 && created.at(-1)?.allowedOrigins === stored, String(created.at(-1)?.allowedOrigins));
  }
  check("errorResponseIn: a 500 from an allowed origin is the product's", errorResponseIn([`GET ${APP}/api → 500`], TOP, [APP]) !== null);
  check("errorResponseIn: …and not without the list", errorResponseIn([`GET ${APP}/api → 500`], TOP) === null);

  // Self-check routing keys on the target and our own hosts only: an allowed
  // origin never starts receiving our header.
  check(
    "self-check header: a customer's run never announces itself to an allowed origin",
    !shouldAnnounceSelfCheck(`${TOP}/`, { url: `${APP}/api`, method: "POST", initiatorUrl: `${APP}/` }),
  );
  check(
    "self-check header: our own run does not announce itself to another origin either",
    !shouldAnnounceSelfCheck("https://checkmyapp.dev/", {
      url: "https://admin.shopify.com/api",
      method: "POST",
      initiatorUrl: "https://admin.shopify.com/",
    }),
  );

  const promptRun = { scopeHints: null, userNotes: null, targetUrl: `${TOP}/` };
  check("prompt: no allowed origins → no block", allowedOriginsBlock({ allowedOrigins: null }) === "");
  check(
    "prompt: no allowed origins → the walking prompt is byte for byte the same",
    walkingSystem({ ...promptRun, allowedOrigins: null }, "J", ["a"]) === walkingSystem(promptRun, "J", ["a"]),
  );
  check("prompt: allowed origins are named", allowedOriginsBlock({ allowedOrigins: JSON.stringify([APP]) }).includes(APP));

  // ─── The browser ──────────────────────────────────────────────────────────
  const browser = await launch();
  try {
    // The fixture is what the ticket says it is: the app's controls are out of
    // reach of everything the tools used before.
    {
      const env = await freshEnv(browser);
      const page = env.page;
      check("fixture: the app frame is cross-origin (no contentDocument from the page)",
        (await page.evaluate(() => (document.querySelector("iframe[name=app-iframe]") as HTMLIFrameElement).contentDocument)) === null);
      check("fixture: a page locator does not reach the app's button",
        (await page.getByRole("button", { name: "Open report" }).count()) === 0);
      await page.context().close();
    }

    // read_page
    {
      const env = await freshEnv(browser, [APP]);
      const digest = await executeTool(env, "read_page", {});
      const frameAt = digest.indexOf(`FRAME 1 (origin ${APP}, name app-iframe)`);
      check("read_page: the app frame is a labelled section", frameAt > 0, digest.slice(0, 200));
      check("read_page: …carrying the app's button", frameAt > 0 && digest.indexOf('"Open report"', frameAt) > frameAt);
      check("read_page: …and its text", digest.includes("Report not opened"));
      check("read_page: the page itself reads as before", digest.startsWith(`URL: ${TOP}/`) && digest.includes('"Admin menu"'));
      // Decision 1a: a third party's frame enters the prompt as its address only.
      check("read_page: a third party's frame is listed by address", digest.includes(`FRAMES:\n`) && digest.includes(`${LOGIN}/`));
      check("read_page: …and none of its words reach the prompt", !digest.includes("Vendor sign-in") && !digest.includes("Vendor help"), digest.slice(digest.indexOf("FRAME 1")));
      check("read_page: …nor a section for it", !digest.includes(`(origin ${LOGIN}`));
      check("read_page: the allowed frame says it can be acted in", digest.includes(`name app-iframe) — click/fill inside it with frame "1"`));
      check("read_page: a 1×1 tracking frame is left out", !digest.includes("Track me"));
      check("read_page: a bot-protection frame is never read", !digest.includes("Verify you are human") && !digest.includes("I am human"));

      // A bot-protection widget stays out of reach, named or searched for.
      // Two locks on it. Asked for in words that say what it is, the control is
      // refused before any frame is looked for (CHE-401, verify-human-check)…
      const challengeByWords = await executeTool(env, "fill", { label: "I am human", value: "x", frame: "challenge" });
      check("challenge: refused by what it is called, before any frame is picked", challengeByWords.startsWith("Refused:") && /human-verification challenge/.test(challengeByWords), challengeByWords);
      const challengeClickByWords = await executeTool(env, "click", { role: "checkbox", name: "I am human", frame: "4" });
      check("challenge: the same for a click", challengeClickByWords.startsWith("Refused:") && /human-verification challenge/.test(challengeClickByWords), challengeClickByWords);
      // …and asked for in words that say nothing, its frame still cannot be picked.
      const challengeByName = await executeTool(env, "fill", { selector: "#cb", value: "x", frame: "challenge" });
      check("challenge frame: cannot be picked by name", challengeByName.startsWith('No frame matches "challenge"'), challengeByName);
      const challengeByNumber = await executeTool(env, "click", { selector: "input", frame: "4" });
      check("challenge frame: cannot be picked by number", challengeByNumber.startsWith('No frame matches "4"'), challengeByNumber);
      const challengeFrame = env.page.frames().find((f) => f.url().startsWith(CHALLENGE))!;
      check("challenge frame: untouched", (await challengeFrame.evaluate(() => document.body.dataset.touched ?? "no")) === "no");

      // click, found by search: the page first, then the frames in order
      const clicked = await executeTool(env, "click", { role: "button", name: "Open report" });
      check("click: found inside the frame and pressed", clicked.startsWith(`Clicked inside FRAME 1 (${APP})`), clicked.slice(0, 120));
      check("click: the frame's reaction is measured (not 'did not react')", !clicked.includes("did not react AT ALL"), clicked);
      check("click: the app really changed", (await appFrame(env.page).textContent("#status")) === "Report ready");
      const trail = (env.actionTrail ?? []) as Array<{ kind: string; frame?: string }>;
      check("click: the recorded action names its frame, for a replay", trail.at(-1)?.kind === "click" && trail.at(-1)?.frame === "app-iframe", JSON.stringify(trail.at(-1)));

      // An embedded app that answers through the host page (postMessage → a
      // host-rendered modal) changes nothing in its own document. Counted in
      // the frame alone, that real reaction read as a dead control.
      const viaHost = await executeTool(env, "click", { role: "button", name: "Open host modal" });
      check("click: the host page's reaction is the frame click's reaction too", viaHost.startsWith("Clicked inside FRAME 1") && !viaHost.includes("did not react AT ALL"), viaHost.slice(0, 300));
      check("click: …the host modal really opened", (await env.page.textContent("#host-modal")) === "Host modal open");

      // A third party's frame is never acted in — searched or named.
      const vendorClick = await executeTool(env, "click", { role: "button", name: "Vendor help" });
      check("click: a control only in a third party's frame is refused", vendorClick.startsWith(`Refused: FRAME 2 (${LOGIN}) is outside the target app`), vendorClick);
      const vendorNamed = await executeTool(env, "click", { role: "button", name: "Vendor help", frame: "vendor-login" });
      check("click: …named explicitly, refused too", vendorNamed.startsWith(`Refused: FRAME 2 (${LOGIN}) is outside the target app`), vendorNamed);
      // Rule 2: our limit is our ticket, never homework for the customer.
      check("click: the refusal files our own gap (our_capability)", vendorClick.includes('"our_capability"'), vendorClick);
      check(
        "click: …and never asks the customer for access or to allow an origin",
        !vendorClick.includes("missing_access") && !/would have to be allowed|allow (?:it|this|the origin)/i.test(vendorClick),
        vendorClick,
      );
      check("click: …and nothing was pressed there", (await loginFrame(env.page).evaluate(() => document.body.dataset.touched ?? "no")) === "no");
      // The machine half: whatever the model then writes about that control,
      // the step cannot blame the product for a press we refused to make.
      const blamed = { label: "Open vendor help", status: "broken", attempted: "Pressed Vendor help.", observed: "The Vendor help button did nothing when pressed." };
      await executeTool(env, "report_step", blamed);
      check(
        "report_step: a step blaming the product after that refusal becomes skipped / our_capability",
        blamed.status === "skipped" && (blamed as { unverifiedReason?: string }).unverifiedReason === "our_capability",
        JSON.stringify(blamed),
      );
      check("report_step: …and no longer says the button did nothing", !/did nothing/i.test(blamed.observed), blamed.observed);
      // A widget the journey does not depend on, reported as such, stays as such.
      await executeTool(env, "click", { role: "button", name: "Vendor help" });
      const aside = { label: "Vendor help widget", status: "skipped", unverifiedReason: "not_applicable", attempted: "Looked at the vendor's help widget.", observed: "A vendor help widget is embedded on the page." };
      await executeTool(env, "report_step", aside);
      check("report_step: a third party's widget reported not_applicable stays not_applicable", aside.status === "skipped" && aside.unverifiedReason === "not_applicable", JSON.stringify(aside));
      const vendorFill = await executeTool(env, "fill", { label: "Password", value: "not a secret" });
      check("fill: plain text is refused in a third party's frame too", vendorFill.startsWith(`Refused: FRAME 2 (${LOGIN}) is outside the target app`), vendorFill);
      check("fill: …nothing typed", (await loginFrame(env.page).inputValue("#pw")) === "");

      const onTop = await executeTool(env, "click", { role: "button", name: "Admin menu" });
      check("click: a control on the page resolves on the page, as before", onTop.startsWith("Clicked (strategy"), onTop.slice(0, 80));

      const named = await executeTool(env, "click", { role: "button", name: "Open report", frame: "1" });
      check("click: an explicit frame number works", named.startsWith("Clicked inside FRAME 1"), named.slice(0, 80));
      const byName = await executeTool(env, "click", { role: "button", name: "Open report", frame: "app-iframe" });
      check("click: a frame named by its name works", byName.startsWith("Clicked inside FRAME 1"), byName.slice(0, 80));
      const nowhere = await executeTool(env, "click", { role: "button", name: "Open report", frame: "9" });
      check("click: a frame that does not exist is said, not guessed", nowhere.startsWith('No frame matches "9"'), nowhere);

      // fill
      const filled = await executeTool(env, "fill", { label: "Store email", value: "shop@example.test" });
      check("fill: plain text lands inside the frame", filled === `Filled inside FRAME 1 (${APP}).`, filled);
      check("fill: …the value is there", (await appFrame(env.page).inputValue("#email")) === "shop@example.test");

      const cred = await executeTool(env, "fill", { label: "Store email", value: "{{TEST_EMAIL}}" });
      check("fill: a credential goes into an ALLOWED frame", cred === `Filled inside FRAME 1 (${APP}) (credential substituted server-side).`, cred);
      check("fill: …substituted server-side", (await appFrame(env.page).inputValue("#email")) === SECRET_EMAIL);
      // The app now echoes the account ("Signed in as …") as frame text.
      check("fixture: the app echoes the account it was given", (await appFrame(env.page).textContent("#who")) === `Signed in as ${SECRET_EMAIL}`);
      const echoed = await executeTool(env, "read_page", {});
      check("read_page: the frame's echo is read…", echoed.includes("Signed in as"), echoed.slice(echoed.indexOf("FRAME 1"), echoed.indexOf("FRAME 1") + 400));
      check("read_page: …with the test account's email scrubbed out", !echoed.includes(SECRET_EMAIL));

      // A password typed into a frame is blurred in the frame before a screenshot.
      const vault = await executeTool(env, "fill", { label: "Vault key", value: "{{TEST_PASSWORD}}" });
      check("fill: a password lands in the allowed frame", vault.startsWith("Filled inside FRAME 1") && (await appFrame(env.page).inputValue("#vault")) === SECRET_PASSWORD, vault);
      await executeTool(env, "screenshot", {});
      check(
        "screenshot: the frame's password field is blurred first",
        (await appFrame(env.page).evaluate(() => (document.getElementById("vault") as HTMLInputElement).style.filter)) === "blur(6px)",
      );

      const stolen = await executeTool(env, "fill", { label: "Password", value: "{{TEST_PASSWORD}}" });
      check("fill: a credential is refused in a frame from a non-allowed origin", stolen.startsWith("Refused:") && stolen.includes(LOGIN), stolen);
      check("fill: …and nothing was typed there", (await loginFrame(env.page).inputValue("#pw")) === "");
      const stolenNamed = await executeTool(env, "fill", { label: "Password", value: "{{TEST_PASSWORD}}", frame: "2" });
      check("fill: …named explicitly, still refused", stolenNamed.startsWith("Refused:") && stolenNamed.includes(LOGIN), stolenNamed);
      check("fill: …still nothing typed", (await loginFrame(env.page).inputValue("#pw")) === "");

      // navigate
      const toApp = await executeTool(env, "navigate", { url: `${APP}/` });
      check("navigate: an allowed origin opens", toApp.startsWith(`Navigated to ${APP}/`), toApp);
      const toLogin = await executeTool(env, "navigate", { url: `${LOGIN}/` });
      check("navigate: a non-allowed origin is refused", toLogin.startsWith(`Refused: ${LOGIN} is outside the target app`), toLogin);
      await env.page.context().close();
    }

    // A replay acts in the frame the walk acted in (journey-replay.ts). The
    // second step names a frame that is not there: replayed in it, the click
    // has nowhere to land; replayed without it, "Admin menu" on the page would
    // be pressed and the step would count as reproduced.
    {
      const agentEnv = {
        db: { run: { findUnique: async () => ({ credentialsRejected: false }), update: async () => ({}) } },
      } as unknown as AgentEnv;
      const result = await replayJourney(
        agentEnv,
        browser as unknown as Parameters<typeof replayJourney>[1],
        { id: "run_frames", targetUrl: `${TOP}/`, allowedOrigins: JSON.stringify([APP]) },
        {
          id: "journey_frames",
          title: "Open the app's report",
          steps: [
            {
              order: 0,
              label: "Open the report inside the app",
              actions: JSON.stringify([
                { kind: "navigate", url: `${TOP}/`, outcome: { urlAfter: `${TOP}/`, status: 200 } },
                { kind: "click", role: "button", name: "Open report", frame: "app-iframe", outcome: { urlAfter: `${TOP}/`, navigated: false, requests: 0, mutations: 1 } },
              ]),
            },
            {
              order: 1,
              label: "A control in a frame that is gone",
              actions: JSON.stringify([
                { kind: "click", role: "button", name: "Admin menu", frame: "gone-frame", outcome: { urlAfter: `${TOP}/`, navigated: false, requests: 0, mutations: 1 } },
              ]),
            },
          ],
        },
        async (b) =>
          (await routedContext(b as unknown as Browser)) as unknown as Awaited<ReturnType<Parameters<typeof replayJourney>[4]>>,
      );
      const [first, second] = result.steps;
      check("replay: the click recorded in a frame is replayed in it", first?.status === "ok", JSON.stringify(first));
      check(
        "replay: a recorded frame is honoured, not searched around — and its absence is not a reproduction",
        second?.status === "diverged" && (second?.detail ?? "").includes('No frame matches "gone-frame"'),
        JSON.stringify(second),
      );
      check("replay: …so the journey is not reproduced", result.status === "diverged", result.status);
    }

    // Frames that inherit the app's origin are the app's; a sandboxed one runs
    // opaque and never receives a credential, whatever its parent is.
    {
      const env = await envAt(browser, `${TOP}/inherit`, [APP], 1);
      // envAt waited for the page's frames; the app's own nested ones load after.
      await env.page.waitForFunction(() => window.frames.length === 1 && window.frames[0].frames.length === 3).catch(() => {});
      for (const frame of env.page.frames()) await frame.waitForLoadState("load");
      check("fixture: the app's three nested frames are there", env.page.frames().length === 5, String(env.page.frames().length));
      const bold = await executeTool(env, "click", { role: "button", name: "Bold", frame: "editor" });
      check("srcdoc frame: takes the allowed app's origin and is acted in", bold.startsWith("Clicked inside FRAME"), bold.slice(0, 160));
      const editor = env.page.frames().find((f) => f.name() === "editor");
      check("srcdoc frame: …the press landed", (await editor?.evaluate(() => document.body.dataset.pressed ?? "no")) === "yes");
      const italic = await executeTool(env, "click", { role: "button", name: "Italic", frame: "datadoc" });
      check("data: frame: acts for the allowed app that wrote it", italic.startsWith("Clicked inside FRAME"), italic.slice(0, 160));
      const datadoc = env.page.frames().find((f) => f.name() === "datadoc");
      check("data: frame: …the press landed", (await datadoc?.evaluate(() => document.body.dataset.pressed ?? "no")) === "yes");
      // A credential is another matter: a document with no address of its own
      // cannot be told from a stranger's at the write, so it gets none.
      const editorKey = await executeTool(env, "fill", { label: "Editor key", value: "{{TEST_PASSWORD}}", frame: "editor" });
      check(
        "srcdoc frame: a credential is refused (no address of its own)",
        editorKey.startsWith("Refused: will not enter test credentials on an embedded document with no address of its own"),
        editorKey,
      );
      check("srcdoc frame: …and nothing was written", (await editor?.inputValue("#e")) === "");
      // Found by its field, not by its name: Chrome 154 (the system Chrome CI
      // runs this on) puts a sandboxed frame in a process of its own, and
      // Playwright then holds neither a name nor an address for it — picked as
      // frame "sandboxed" it was "No frame matches" there and found here.
      const sandboxed = await executeTool(env, "fill", { label: "Sandbox key", value: "{{TEST_PASSWORD}}" });
      let box: Frame | undefined;
      for (const frame of env.page.frames()) {
        if ((await frame.locator("#k").count().catch(() => 0)) > 0) box = frame;
      }
      check("fixture: the sandboxed frame is on the page", box !== undefined);
      check(
        "sandboxed frame: a credential is refused (opaque origin)",
        sandboxed.startsWith("Refused: will not enter test credentials on an embedded document with no address of its own"),
        sandboxed,
      );
      check("sandboxed frame: …and nothing was written", (await box?.inputValue("#k")) === "");
      await env.page.context().close();
    }

    // A same-origin frame: read with the page (as before) and, new with
    // CHE-373, clicked — page locators stop at every frame boundary.
    {
      const env = await envAt(browser, `${TOP}/same`, undefined, 1);
      const digest = await executeTool(env, "read_page", {});
      check("same-origin frame: read with the page", digest.includes("Inner settings"));
      const pressed = await executeTool(env, "click", { role: "button", name: "Same-origin action" });
      check("same-origin frame: a control in it is pressed", pressed.startsWith(`Clicked inside FRAME 1 (${TOP})`), pressed.slice(0, 120));
      await env.page.context().close();
    }

    // The credential race, in a frame and on the page (see raceOnce).
    for (const where of ["frame", "page"] as const) {
      for (const delay of [0, 40, 120, 300, 800]) {
        const race = await raceOnce(browser, where, "timed", delay);
        check(`credential race (${where}, +${delay}ms): the provider's field never gets the password`, !race.leaked, race.detail);
      }
      // Each deterministic shape must end in the refusal that names the
      // provider — the write met the provider's document and stopped there — or
      // the fixture raced nothing and "never gets the password" proves nothing.
      const metProvider = `Refused: will not enter test credentials on ${IDP} (outside the target app)`;
      const hydration = await raceOnce(browser, where, "hydration", 0);
      check(`credential race (${where}, the bounce lands in the hydration wait): the password is not written`, !hydration.leaked, hydration.detail);
      check(`credential race (${where}, the bounce lands in the hydration wait): …refused in the provider's document`, hydration.result.startsWith(metProvider), hydration.result);
      const late = await raceOnce(browser, where, "late", LATE_BOUNCE_MS);
      check(`credential race (${where}, the field arrives with the provider): the password is not written`, !late.leaked, late.detail);
      check(`credential race (${where}, the field arrives with the provider): …refused in the provider's document`, late.result.startsWith(metProvider), late.result);
    }

    // No allowed origins: another origin's frame is an address in the digest and
    // nothing more — not read, not opened, not typed into, not pressed. The one
    // thing that did change for such an app is above: a frame on the target's
    // OWN origin is now pressed and filled, where it used to be read only.
    {
      const env = await freshEnv(browser);
      const plainDigest = await executeTool(env, "read_page", {});
      check("default: a cross-origin frame is listed by address only", plainDigest.includes(`${APP}/`) && !plainDigest.includes("Securify settings") && !plainDigest.includes("Report not opened"));
      const nav = await executeTool(env, "navigate", { url: `${APP}/` });
      check("default: navigate to the frame's origin is refused, as before", nav.startsWith(`Refused: ${APP} is outside the target app`), nav);
      const cred = await executeTool(env, "fill", { label: "Store email", value: "{{TEST_EMAIL}}" });
      check("default: no credential into a frame of another origin", cred.startsWith("Refused:") && cred.includes(APP), cred);
      check("default: …nothing typed", (await appFrame(env.page).inputValue("#email")) === "");
      const plain = await executeTool(env, "click", { role: "button", name: "Open report" });
      check("default: a frame of another origin is not acted in", plain.startsWith(`Refused: FRAME 1 (${APP}) is outside the target app`), plain);
      check("default: …the app untouched", (await appFrame(env.page).textContent("#status")) === "Report not opened");
      await env.page.context().close();
    }
  } finally {
    await browser.close();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll frame-tool checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
