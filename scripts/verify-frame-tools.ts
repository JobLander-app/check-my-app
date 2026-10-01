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
//   challenges.cloudflare.com — a bot-protection widget, never to be touched
//
// Chromium: Playwright's own build when installed, else the system Chrome
// (GitHub's ubuntu runners carry one). Neither is a FAIL, never a skip.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-frame-tools.ts

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { replayJourney } from "@/agent/journey-replay";
import type { AgentEnv } from "@/agent/env";
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
    <iframe name="challenge" src="${CHALLENGE}/" width="300" height="80"></iframe>`,
  [`${APP}/`]: `<!doctype html><title>Securify</title>
    <h2>Securify settings</h2>
    <p id="status">Report not opened</p>
    <button onclick="document.getElementById('status').textContent='Report ready'">Open report</button>
    <label for="email">Store email</label><input id="email" type="email">`,
  [`${LOGIN}/`]: `<!doctype html><title>Vendor login</title>
    <h2>Vendor sign-in</h2>
    <label for="pw">Password</label><input id="pw" type="password">
    <button onclick="document.body.dataset.touched='yes'">Vendor help</button>`,
  [`${PIXEL}/`]: `<!doctype html><button>Track me</button>`,
  [`${CHALLENGE}/`]: `<!doctype html><h2>Verify you are human</h2><label for="cb">I am human</label><input id="cb" type="checkbox" onclick="document.body.dataset.touched='yes'">`,
};

async function launch(): Promise<Browser> {
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
    return route.fulfill({ status: 200, contentType: "text/html", body });
  });
  return context;
}

async function freshEnv(browser: Browser, allowedOrigins?: string[]): Promise<ToolEnv & { page: Page }> {
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
  const nav = await executeTool(env, "navigate", { url: `${TOP}/` });
  if (!nav.startsWith("Navigated")) throw new Error(`fixture did not load: ${nav}`);
  // Every frame loaded before anything is asserted about it.
  await page.waitForFunction(() => document.querySelectorAll("iframe").length === 4);
  for (const frame of page.frames()) await frame.waitForLoadState("load");
  return env;
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
      check("read_page: a third party's frame is labelled with its own origin", digest.includes(`FRAME 2 (origin ${LOGIN}, name vendor-login)`));
      check("read_page: …and as read only", digest.includes(`FRAME 2 (origin ${LOGIN}, name vendor-login) — outside the target app: read only`));
      check("read_page: the allowed frame says it can be acted in", digest.includes(`name app-iframe) — click/fill inside it with frame "1"`));
      check("read_page: a 1×1 tracking frame is left out", !digest.includes("Track me"));
      check("read_page: a bot-protection frame is never read", !digest.includes("Verify you are human") && !digest.includes("I am human"));

      // A bot-protection widget stays out of reach, named or searched for.
      const challengeByName = await executeTool(env, "fill", { label: "I am human", value: "x", frame: "challenge" });
      check("challenge frame: cannot be picked by name", challengeByName.startsWith('No frame matches "challenge"'), challengeByName);
      const challengeByNumber = await executeTool(env, "click", { role: "checkbox", name: "I am human", frame: "4" });
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

      // A third party's frame is read, never acted in — searched or named.
      const vendorClick = await executeTool(env, "click", { role: "button", name: "Vendor help" });
      check("click: a control only in a third party's frame is refused", vendorClick.startsWith(`Refused: FRAME 2 (${LOGIN}) is outside the target app`), vendorClick);
      const vendorNamed = await executeTool(env, "click", { role: "button", name: "Vendor help", frame: "vendor-login" });
      check("click: …named explicitly, refused too", vendorNamed.startsWith(`Refused: FRAME 2 (${LOGIN}) is outside the target app`), vendorNamed);
      check("click: …and nothing was pressed there", (await loginFrame(env.page).evaluate(() => document.body.dataset.touched ?? "no")) === "no");
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

    // No allowed origins: exactly the single-origin rules of before.
    {
      const env = await freshEnv(browser);
      const nav = await executeTool(env, "navigate", { url: `${APP}/` });
      check("default: navigate to the frame's origin is refused, as before", nav.startsWith(`Refused: ${APP} is outside the target app`), nav);
      const cred = await executeTool(env, "fill", { label: "Store email", value: "{{TEST_EMAIL}}" });
      check("default: no credential into a frame of another origin", cred.startsWith("Refused:") && cred.includes(APP), cred);
      check("default: …nothing typed", (await appFrame(env.page).inputValue("#email")) === "");
      const plain = await executeTool(env, "click", { role: "button", name: "Open report" });
      check("default: a frame of another origin is read only", plain.startsWith(`Refused: FRAME 1 (${APP}) is outside the target app`), plain);
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
