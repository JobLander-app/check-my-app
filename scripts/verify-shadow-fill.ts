// CHE-439 verification: the checker types into a field whose input sits inside
// a custom element's shadow root, in an embedded app on another origin.
//
// Found 2026-10-07 in run cmuy23f79000btg1r7x3x0j6g (otp-plus-sso): four steps
// ended "skipped / our_capability" — "We could not drive the text field this
// run". The Shopify admin embeds the app in a cross-origin frame, and the app's
// fields are web components (<s-text-field label="…">) whose real <input> is
// inside the element. Typing is harmless — nothing is submitted — so a field we
// cannot type into is a gap of ours, and it is also the main kind of app the
// pilot checks.
//
// A real browser, not a stub: whether keys reach an input inside a closed
// shadow root, in a frame of another origin, is a property of the browser.
//   https://admin.shop.test   — the host page (the run's target)
//   https://app.embedded.test — the embedded app, framed by the host page
//
// Chromium: Playwright's own build when installed, else the system Chrome.
// Neither is a FAIL, never a skip.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-shadow-fill.ts
//        SHADOW_FILL_CHANNEL=chrome … to run it on the system Chrome

import { chromium, type Browser, type Page } from "playwright";
import { executeTool, prepareAgentPage, type ToolEnv } from "@/agent/tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const TOP = "https://admin.shop.test";
const APP = "https://app.embedded.test";
const SECRET_PASSWORD = "s3cret-shadow-pass";

// One component, as the embedded apps write them: the name is an attribute of
// the element, the input is inside its shadow root. `echo-<id>` is the app's
// own reaction to what was typed, in the light DOM where the fixture can read
// it whatever the mode of the root.
const COMPONENT = `
  class XField extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: this.getAttribute("mode") });
      const input = document.createElement("input");
      input.type = this.getAttribute("type") || "text";
      input.value = this.getAttribute("initial") || "";
      if (this.hasAttribute("dead")) input.disabled = true;
      // A component with a control beside its input (a clear / reveal button),
      // in the same root: it takes the focus as readily as the input does.
      // "buttononly" is the same component with nothing to type into.
      const button = document.createElement("button");
      button.textContent = "x";
      button.addEventListener("click", () => { document.body.dataset.rootbutton = "yes"; document.body.dataset.rootpresses = String(Number(document.body.dataset.rootpresses || 0) + 1); });
      root.append(...(this.hasAttribute("buttononly") ? [button] : this.hasAttribute("withbutton") ? [input, button] : [input]));
      input.addEventListener("input", () => { document.getElementById("echo-" + this.id).textContent = input.value; });
      // A component usually exposes what it holds. Some do not.
      if (this.hasAttribute("readable")) Object.defineProperty(this, "value", { get: () => input.value });
    }
  }
  customElements.define("x-field", XField);
`;

const field = (id: string, attrs: string) => `<x-field id="${id}" ${attrs}></x-field><p id="echo-${id}"></p>`;

const PAGES: Record<string, string> = {
  [`${TOP}/`]: `<!doctype html><title>Shop admin</title><h1>Shop admin</h1>
    <input aria-label="Admin search" id="admin-search">
    <iframe name="app-iframe" src="${APP}/" width="800" height="500"></iframe>`,
  [`${APP}/`]: `<!doctype html><title>Approved customers</title><h2>Approved customers</h2>
    ${field("billing", 'mode="closed" label="Billing email" readable')}
    ${field("exact", 'mode="closed" label="Email" readable')}
    ${field("open", 'mode="open" label="Approved customers" readable initial="old"')}
    ${field("openblind", 'mode="open" placeholder="Customer tags"')}
    ${field("closed", 'mode="closed" label="Customer email" readable initial="old"')}
    ${field("closedblind", 'mode="closed" label="Internal note"')}
    ${field("closeddead", 'mode="closed" label="Locked field" dead')}
    ${field("closedbutton", 'mode="closed" label="Coupon code" withbutton')}
    ${field("closedbuttonly", 'mode="closed" label="Gift note" buttononly')}
    ${field("openkey", 'mode="open" label="Open key" type="password"')}
    ${field("closedkey", 'mode="closed" label="Closed key" type="password"')}
    <button onclick="document.body.dataset.pressed='yes'">Save</button>
    <script>${COMPONENT}</script>`,
};

async function launch(): Promise<Browser> {
  const channel = process.env.SHADOW_FILL_CHANNEL;
  if (channel) return chromium.launch({ channel });
  try {
    return await chromium.launch();
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch (system) {
      throw new Error(
        `no Chromium to run the shadow-root fixture: Playwright's build (${(bundled as Error).message.split("\n")[0]}) ` +
          `and the system Chrome (${(system as Error).message.split("\n")[0]}) both failed`,
      );
    }
  }
}

async function freshEnv(browser: Browser): Promise<ToolEnv & { page: Page }> {
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const body = PAGES[`${url.origin}${url.pathname}`];
    if (body === undefined) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: "text/html", body });
  });
  const page = await context.newPage();
  const env = {
    page,
    targetOrigin: TOP,
    allowedOrigins: [APP],
    testEmail: "owner-test@example.test",
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
  await page.waitForFunction(() => document.querySelectorAll("iframe").length === 1);
  for (const frame of page.frames()) await frame.waitForLoadState("load");
  return env;
}

const appFrame = (page: Page) => page.frames().find((f) => f.url().startsWith(APP))!;
const echo = (page: Page, id: string) => appFrame(page).textContent(`#echo-${id}`);

async function main() {
  const browser = await launch();
  try {
    const env = await freshEnv(browser);
    const page = env.page;
    const undriven = () => (env.undrivenControls ?? []).length;
    const into = `inside FRAME 1 (${APP})`;

    check(
      "fixture: the app is in a frame of another origin",
      (await page.evaluate(() => (document.querySelector("iframe[name=app-iframe]") as HTMLIFrameElement).contentDocument)) === null,
    );
    check(
      "fixture: a page-level label finds nothing — the name is the element's attribute",
      (await appFrame(page).getByLabel("Approved customers").count()) === 0,
    );

    // Open root: the real input is found inside the element and filled.
    const open = await executeTool(env, "fill", { label: "Approved customers", value: "ada@example.test" });
    check("open root: filled", open === `Filled ${into}.`, open);
    check("open root: …the app saw exactly the value (the old one replaced)", (await echo(page, "open")) === "ada@example.test", String(await echo(page, "open")));

    // Named by its placeholder, and by a selector that names the element.
    const byPlaceholder = await executeTool(env, "fill", { label: "Customer tags", value: "vip" });
    check("open root: found by the element's placeholder", byPlaceholder === `Filled ${into}.` && (await echo(page, "openblind")) === "vip", byPlaceholder);
    const bySelector = await executeTool(env, "fill", { selector: "x-field#open", value: "grace@example.test" });
    check("open root: a selector naming the element reaches its input", bySelector === `Filled ${into}.` && (await echo(page, "open")) === "grace@example.test", bySelector);

    // Closed root: nothing outside can see the input; keys are what is left.
    const closed = await executeTool(env, "fill", { label: "Customer email", value: "linus@example.test" });
    check("closed root: filled", closed === `Filled ${into}.`, closed);
    check("closed root: …the app saw exactly the value (the old one replaced)", (await echo(page, "closed")) === "linus@example.test", String(await echo(page, "closed")));
    const blind = await executeTool(env, "fill", { label: "Internal note", value: "called back" });
    check("closed root, a component that does not expose its value: filled by the keys", blind === `Filled ${into}.` && (await echo(page, "closedblind")) === "called back", blind);
    const byHostSelector = await executeTool(env, "fill", { selector: "x-field#closed", value: "ken@example.test" });
    check("closed root: a selector naming the element is typed into too", byHostSelector === `Filled ${into}.` && (await echo(page, "closed")) === "ken@example.test", byHostSelector);

    // The exact name wins over an earlier element whose name merely contains it.
    const exact = await executeTool(env, "fill", { label: "email", value: "exact@example.test" });
    check("exact name first: not the earlier 'Billing email'", exact === `Filled ${into}.` && (await echo(page, "exact")) === "exact@example.test" && (await echo(page, "billing")) === "", exact);

    // One closed root, an input and a button: the keys must reach the input.
    const withButton = await executeTool(env, "fill", { label: "Coupon code", value: "SAVE 10" });
    check(
      "closed root holding an input and a button: the input got the value",
      withButton === `Filled ${into}.` && (await echo(page, "closedbutton")) === "SAVE 10",
      withButton,
    );
    check("…and the button in that root was not pressed", (await appFrame(page).evaluate(() => document.body.dataset.rootpresses ?? "0")) === "0");

    check("nothing so far was recorded as a control we could not drive", undriven() === 0, JSON.stringify(env.undrivenControls));

    // A field that takes nothing must not be reported as filled: a "Filled"
    // that did not happen is worse than the gap.
    const dead = await executeTool(env, "fill", { label: "Locked field", value: "x" });
    check("closed root that takes no focus: not claimed as filled", !dead.startsWith("Filled"), dead);
    check("…and said to be our limit, never the product's", /our_capability/.test(dead) && undriven() === 1, dead);
    check("…and nothing was typed anywhere", (await echo(page, "closeddead")) === "" && (await echo(page, "closed")) === "ken@example.test");

    // A root whose only focusable part is a button: focus is there, typing is
    // not possible, and a space typed would press it. Not "Filled".
    const buttonOnly = await executeTool(env, "fill", { label: "Gift note", value: "a b c" });
    check("closed root with only a button: not claimed as filled", !buttonOnly.startsWith("Filled") && /our_capability/.test(buttonOnly), buttonOnly);
    // The press that gives focus lands on the button — once; a space typed
    // into it would be a second.
    check("…and the typing did not press the button again", (await appFrame(page).evaluate(() => document.body.dataset.rootpresses ?? "0")) === "1");

    // The host page is not where the keys go when the field is in the frame.
    check("the host page's own field was not touched", (await page.inputValue("#admin-search")) === "");

    // A credential: only ever written by the check made inside the document.
    const openKey = await executeTool(env, "fill", { label: "Open key", value: "{{TEST_PASSWORD}}" });
    check("credential, open root: written to the real input", openKey === `Filled ${into} (credential substituted server-side).` && (await echo(page, "openkey")) === SECRET_PASSWORD, openKey);
    const closedKey = await executeTool(env, "fill", { label: "Closed key", value: "{{TEST_PASSWORD}}" });
    check("credential, closed root: never sent as keys", !closedKey.startsWith("Filled") && (await echo(page, "closedkey")) === "", closedKey);
    check("…and said to be our limit", /our_capability/.test(closedKey), closedKey);

    // The tool's answer reaches the model; the secret must not.
    check("no answer carries the password", ![open, closed, openKey, closedKey].some((r) => r.includes(SECRET_PASSWORD)));
    const trail = JSON.stringify(env.actionTrail);
    check("the recorded trail keeps the placeholder, never the password", !trail.includes(SECRET_PASSWORD) && trail.includes("{{TEST_PASSWORD}}"));

    // Pressing into the component must not have pressed anything else.
    check("no button was pressed", (await appFrame(page).evaluate(() => document.body.dataset.pressed ?? "no")) === "no");

    await page.context().close();
  } finally {
    await browser.close();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll shadow-root fill checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
