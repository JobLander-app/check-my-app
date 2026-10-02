// CHE-401 verification: a bot-protection challenge is never ours to pass.
//
// Run #301 (prod, 2026-10-02) landed on a sign-in fronted by Cloudflare's
// interstitial and the walk pressed its "Verify you are human" control. The
// widget's frame was already out of reach (CHALLENGE_FRAME, verify-frame-tools);
// the control that was pressed sat in the page itself.
//
// The real tools (src/agent/tools.ts) on a real browser, against a page built
// like that interstitial and against a product that merely talks about
// captchas:
//   1. the words and the markup that say "challenge" — and the ones that do not;
//   2. click refuses the challenge by the name the walk gave it and by what
//      the control is (text, accessible name, the widget it sits in);
//   3. fill refuses a field that asks for a challenge's answer;
//   4. nothing was pressed and nothing was typed;
//   5. a product's own pages about captchas are still pressed and typed into;
//   6. the step the walk then reports lands in the "captcha" gap class.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-human-check.ts
//        HUMAN_CHECK_CHANNEL=chrome … to run it on the system Chrome, as CI does

import { chromium, type Browser, type Page } from "playwright";
import { executeTool, prepareAgentPage, type ToolEnv } from "@/agent/tools";
import { humanCheckIn, humanCheckRefusal, isChallengeAnswerField, isChallengeMarkup, isHumanCheckText } from "@/agent/human-check";
import { classifyGap } from "@/agent/gap-classes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const SITE = "https://accounts.shop.test";
// A press is recorded, and shows on the page — a control that reacts is
// pressed once; one that does nothing would be tried again by other means.
const pressed = "(window.pressed = window.pressed || []).push(this.id); document.body.appendChild(document.createElement('hr'))";

const PAGES: Record<string, string> = {
  // The interstitial as run #301 met it, plus the other shapes a challenge takes
  // in a page's own document.
  [`${SITE}/login`]: `<!doctype html><title>Just a moment...</title>
    <h1>Your connection needs to be verified before you can proceed</h1>
    <button id="start" onclick="${pressed}">Verify you are human</button>
    <div class="cf-turnstile" data-sitekey="0x4AAAAAAA"><div id="box" role="checkbox" tabindex="0" aria-checked="false" style="width:24px;height:24px;border:1px solid" onclick="${pressed}"></div></div>
    <button id="robot" aria-label="I'm not a robot" onclick="${pressed}">☐</button>
    <div class="h-captcha"><span id="inside" onclick="${pressed}">Continue</span></div>
    <button id="hold" onclick="${pressed}">Press &amp; hold to confirm you are human</button>
    <label for="ans">Enter the characters you see in the image</label><input id="ans">
    <textarea id="resp" name="g-recaptcha-response"></textarea>
    <input id="cap" placeholder="Captcha">
    <button id="plain" onclick="${pressed}">Privacy</button>`,
  // A product that is ABOUT bot protection: its pages are the product.
  [`${SITE}/product`]: `<!doctype html><title>Fraud app</title>
    <a id="settings" href="/product/recaptcha">reCAPTCHA settings</a>
    <button id="tab" onclick="${pressed}">Bot protection</button>
    <button id="hc" onclick="${pressed}">hCaptcha integration</button>
    <button id="hr" onclick="${pressed}">Human resources</button>
    <button id="verify" onclick="${pressed}">Verify email</button>
    <label for="key">reCAPTCHA site key</label><input id="key">
    <label for="code">Verification code</label><input id="code">`,
  [`${SITE}/product/recaptcha`]: `<!doctype html><title>reCAPTCHA settings</title><h1>reCAPTCHA settings</h1>`,
};

async function launch(): Promise<Browser> {
  const channel = process.env.HUMAN_CHECK_CHANNEL;
  if (channel) return chromium.launch({ channel });
  try {
    return await chromium.launch();
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch (system) {
      throw new Error(
        `no Chromium to run the fixture: Playwright's build (${(bundled as Error).message.split("\n")[0]}) ` +
          `and the system Chrome (${(system as Error).message.split("\n")[0]}) both failed`,
      );
    }
  }
}

async function envAt(browser: Browser, path: string): Promise<ToolEnv & { page: Page }> {
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const body = PAGES[`${url.origin}${url.pathname}`];
    return body === undefined ? route.fulfill({ status: 404, body: "not found" }) : route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
  const page = await context.newPage();
  const env = { page, targetOrigin: SITE, credentials: { rejected: false }, networkLog: [], consoleLog: [], actionTrail: [], undrivenControls: [], writeAllowed: true } as unknown as ToolEnv & { page: Page };
  await prepareAgentPage(env);
  const opened = await executeTool(env, "navigate", { url: `${SITE}${path}` });
  if (!opened.startsWith("Navigated")) throw new Error(`fixture did not load: ${opened}`);
  return env;
}

const pressedOn = (page: Page) => page.evaluate(() => ((window as unknown as { pressed?: string[] }).pressed ?? []).join(","));

async function main() {
  // ── 1 — the words and the markup ─────────────────────────────────────────
  const CHALLENGE_WORDS = [
    "Verify you are human", "Verify that you're human", "verify I am human", "I am human", "I'm not a robot", "I’m not a robot",
    "Prove you are human", "Confirm you're not a bot", "Human verification", "Solve the CAPTCHA", "Complete the security check",
    "Press & hold to confirm you are human", "Turnstile checkbox", "reCAPTCHA checkbox", "Start puzzle",
  ];
  const PRODUCT_WORDS = [
    "reCAPTCHA settings", "hCaptcha integration", "Bot protection", "Human resources", "Verify email", "Verify your identity", "Verification code",
    "Turnstile", "Captcha", "Block bots", "I am a merchant", "Security", "Continue", "Robot vacuum", "Humans of the store",
  ];
  check("words: the ways a page says 'prove you are a person'", CHALLENGE_WORDS.every(isHumanCheckText), CHALLENGE_WORDS.filter((w) => !isHumanCheckText(w)).join(" | "));
  check("words: a product's own vocabulary about bots and captchas is not a challenge", !PRODUCT_WORDS.some(isHumanCheckText), PRODUCT_WORDS.filter(isHumanCheckText).join(" | "));
  const WIDGET_MARKUP = [".cf-turnstile [role=checkbox]", "#g-recaptcha", "div.h-captcha > iframe", "#challenge-stage input", ".recaptcha-checkbox-border", "#px-captcha", "[class*='cf-chl-widget']", "#cf-chl-widget-abc12_response"];
  const PRODUCT_MARKUP = ["#settings", "a[href='/product/recaptcha']", ".captcha-settings-link", "#turnstile-docs", "button.verify", "#human-resources", ".challenges-list"];
  check("markup: a challenge widget's selectors, ids and classes", WIDGET_MARKUP.every(isChallengeMarkup), WIDGET_MARKUP.filter((m) => !isChallengeMarkup(m)).join(" | "));
  check("markup: a product page's own selectors are not a widget", !PRODUCT_MARKUP.some(isChallengeMarkup), PRODUCT_MARKUP.filter(isChallengeMarkup).join(" | "));
  const ANSWER_FIELDS = ["Enter the characters you see in the image", "Type the text shown above", "Captcha", "CAPTCHA code", "Enter captcha", "reCAPTCHA response"];
  const PRODUCT_FIELDS = ["reCAPTCHA site key", "Verification code", "Email", "hCaptcha secret key", "Enter the code we sent you", "Captcha provider name (optional)"];
  check("fields: the ways a field asks for a challenge's answer", ANSWER_FIELDS.every(isChallengeAnswerField), ANSWER_FIELDS.filter((f) => !isChallengeAnswerField(f)).join(" | "));
  check("fields: a product's settings and an ordinary code field are not one", !PRODUCT_FIELDS.some(isChallengeAnswerField), PRODUCT_FIELDS.filter(isChallengeAnswerField).join(" | "));
  check("a control is judged by its text first, then by the widget it sits in",
    humanCheckIn({ texts: ["Verify you are human"], addresses: [] }) === "Verify you are human" &&
      humanCheckIn({ texts: ["Continue"], addresses: [], marks: ["box", "cf-turnstile", "data-sitekey"] }) === "cf-turnstile" &&
      humanCheckIn({ texts: ["reCAPTCHA settings"], addresses: ["/product/recaptcha"], marks: ["settings"] }) === null);

  const browser = await launch();
  try {
    // ── 2 — click ──────────────────────────────────────────────────────────
    const env = await envAt(browser, "/login");
    const refusedClick = async (name: string, input: Record<string, unknown>) => {
      const result = await executeTool(env, "click", input);
      check(`click refused: ${name}`, result.startsWith("Refused:") && /human-verification challenge/.test(result) && /our_capability/.test(result), result.slice(0, 120));
    };
    await refusedClick("\"Verify you are human\" by its name — run #301's click", { role: "button", name: "Verify you are human" });
    await refusedClick("the same control by selector, whatever it was called", { selector: "#start" });
    await refusedClick("a checkbox with no words of its own, inside a widget marked cf-turnstile", { selector: "#box" });
    await refusedClick("the widget addressed by its own markup", { selector: ".cf-turnstile [role=checkbox]" });
    await refusedClick("an icon button whose accessible name is \"I'm not a robot\"", { selector: "#robot" });
    await refusedClick("an innocent-looking \"Continue\" inside a widget marked h-captcha", { selector: "#inside" });
    await refusedClick("\"Press & hold to confirm you are human\"", { selector: "#hold" });

    // ── 3 — fill ───────────────────────────────────────────────────────────
    const refusedFill = async (name: string, input: Record<string, unknown>) => {
      const result = await executeTool(env, "fill", { ...input, value: "x7Kp2" });
      check(`fill refused: ${name}`, result.startsWith("Refused:") && /human-verification challenge/.test(result), result.slice(0, 120));
    };
    await refusedFill("a field labelled \"Enter the characters you see in the image\"", { label: "Enter the characters you see in the image" });
    await refusedFill("the same field by selector, whatever it was called", { selector: "#ans" });
    await refusedFill("a response field named g-recaptcha-response", { selector: "#resp" });
    await refusedFill("a field whose placeholder is \"Captcha\", by selector", { selector: "#cap" });

    // ── 4 — nothing happened ───────────────────────────────────────────────
    check("nothing on the challenge page was pressed", (await pressedOn(env.page)) === "", await pressedOn(env.page));
    check("nothing was typed into it",
      (await env.page.evaluate(() => ["ans", "resp", "cap"].map((id) => (document.getElementById(id) as HTMLInputElement).value).join("|"))) === "||");
    const plain = await executeTool(env, "click", { selector: "#plain" });
    check("an ordinary control on the same page is still pressed — the refusal is the challenge's, not the page's",
      plain.startsWith("Clicked") && (await pressedOn(env.page)) === "plain", plain.slice(0, 80));
    await env.page.context().close();

    // ── 5 — a product about captchas ───────────────────────────────────────
    const product = await envAt(browser, "/product");
    for (const [what, input] of [
      ["\"Bot protection\"", { selector: "#tab" }],
      ["\"hCaptcha integration\"", { role: "button", name: "hCaptcha integration" }],
      ["\"Human resources\"", { role: "button", name: "Human resources" }],
      ["\"Verify email\"", { role: "button", name: "Verify email" }],
    ] as const) {
      const result = await executeTool(product, "click", { ...input });
      check(`a product's own control is pressed: ${what}`, result.startsWith("Clicked"), result.slice(0, 90));
    }
    check("…all four were", (await pressedOn(product.page)) === "tab,hc,hr,verify", await pressedOn(product.page));
    for (const label of ["reCAPTCHA site key", "Verification code"]) {
      const result = await executeTool(product, "fill", { label, value: "abc123" });
      check(`a product's own field is typed into: "${label}"`, result.startsWith("Filled"), result.slice(0, 90));
    }
    const link = await executeTool(product, "click", { role: "link", name: "reCAPTCHA settings" });
    check("a link to the product's captcha settings is followed", link.startsWith("Clicked") && product.page.url() === `${SITE}/product/recaptcha`, `${link.slice(0, 60)} → ${product.page.url()}`);
    await product.page.context().close();
  } finally {
    await browser.close();
  }

  // ── 6 — what the walk is told, and where the step then lands ─────────────
  const refusal = humanCheckRefusal("Verify you are human");
  check("the refusal: not pressed, not typed into, no way round, no retry — a gap of ours, never a failure of the product",
    /do not press it/.test(refusal) && /do not type into it/.test(refusal) && /another way round/.test(refusal) && /do not\s+reload/.test(refusal) &&
      /"our_capability"/.test(refusal) && /Nothing behind the challenge may be\s+described as failing/.test(refusal), refusal);
  check("the step it reports lands in the captcha class on our board",
    classifyGap({ text: "The page asked for human verification (Verify you are human) before the sign-in form; it was not passed.", targetOrigin: SITE, allowedOrigins: [] }) === "captcha");

  console.log(failures === 0 ? "\nverify-human-check: all checks passed" : `\nverify-human-check: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
