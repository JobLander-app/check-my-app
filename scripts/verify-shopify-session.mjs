// CHE-378: the Shopify session probe names what it sees correctly, and
// messages the owner only when he is needed — once per drop from ok, never for
// the state a browser starts in, never twice for the same drop. (The messages
// themselves, and the rule over a real D1, are verify-session-runner's.)
//
// Pure rules from session-runner/classify.mjs; no browser, no network, no env.

import assert from "node:assert/strict";
import { STATES, classify, proxyState, shouldNotify } from "../session-runner/classify.mjs";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}\n     ${error.message.split("\n").join("\n     ")}`);
  }
}

const ACCOUNTS = "https://accounts.shopify.com/session-service/login";
const APP = "https://admin.shopify.com/store/prod-release-1/apps/easy-block-customer-ip-country";

// --- classify -------------------------------------------------------------

check("the first real probe: a Turnstile interstitial on accounts is a captcha, not a sign-in page", () => {
  assert.equal(classify({ url: ACCOUNTS, hasTurnstile: true, text: "Your connection needs to be verified before you can proceed" }), "captcha");
});
check("the sign-in form with its own hCaptcha widget is the sign-in page", () => {
  assert.equal(classify({ url: "https://accounts.shopify.com/lookup", hasCaptchaFrame: true, hasLoginInput: true }), "login_page");
});
check("a bare accounts page with nothing on it is the sign-in path", () => {
  assert.equal(classify({ url: "https://accounts.shopify.com/select" }), "login_page");
});
check("a one-time code on accounts is 2fa", () => {
  assert.equal(classify({ url: "https://accounts.shopify.com/two-factor/verify", hasOtpInput: true, text: "Enter the code from your authenticator app" }), "2fa");
});
check("the embedded app frame on the admin is ok", () => {
  assert.equal(classify({ url: APP, hasAppIframe: true }), "ok");
});
check("a captcha inside the admin is a captcha even with the app frame present", () => {
  assert.equal(classify({ url: APP, hasAppIframe: true, hasCaptchaFrame: true }), "captcha");
});
check("the admin without the app frame is not ok", () => {
  assert.equal(classify({ url: APP }), "error");
});
check("anything off Shopify is an error, and so is no URL", () => {
  assert.equal(classify({ url: "https://example.com/", hasAppIframe: true }), "error");
  assert.equal(classify({ url: "" }), "error");
});

// --- shouldNotify ---------------------------------------------------------

const L = (state, extra = {}) => ({ state, ...extra });

check("no message before anyone has ever signed in", () => {
  assert.equal(shouldNotify([], "login_page"), false);
  assert.equal(shouldNotify([L("captcha"), L("login_page")], "captcha"), false);
});
check("one message on the drop from ok", () => {
  assert.equal(shouldNotify([L("captcha"), L("ok")], "login_page"), true);
  assert.equal(shouldNotify([L("ok")], "2fa"), true);
});
check("no repeat for the same drop", () => {
  assert.equal(shouldNotify([L("ok"), L("login_page", { notified: true })], "login_page"), false);
  assert.equal(shouldNotify([L("ok"), L("login_page", { notified: true }), L("captcha")], "2fa"), false);
});
check("a send that failed is retried next hour", () => {
  assert.equal(shouldNotify([L("ok"), L("login_page", { notified: false, notify_error: "telegram HTTP 502" })], "login_page"), true);
});
check("a new drop after the session came back is a new message", () => {
  assert.equal(shouldNotify([L("ok"), L("login_page", { notified: true }), L("ok")], "captcha"), true);
});
check("ok never messages", () => {
  assert.equal(shouldNotify([L("ok"), L("login_page", { notified: true })], "ok"), false);
});
check("one error is a blip; two in a row is a drop", () => {
  assert.equal(shouldNotify([L("ok")], "error"), false);
  assert.equal(shouldNotify([L("ok"), L("error")], "error"), true);
  assert.equal(shouldNotify([L("ok"), L("error"), L("error", { notified: true })], "error"), false);
});

// CHE-453, 2026-10-12: the proxy ran out of paid traffic and the probe told the
// owner to sign in again. The proxy's own answer is its own state and message.
check("the proxy's 402 or 407 is the proxy; anything else is not its answer", () => {
  assert.equal(proxyState(402), "proxy");
  assert.equal(proxyState(407), "proxy");
  for (const s of [200, 301, 403, 502, null]) assert.equal(proxyState(s), null);
});
check("the proxy is said at once, once per outage, whatever came before", () => {
  assert.equal(shouldNotify([], "proxy"), true);
  assert.equal(shouldNotify([L("ok")], "proxy"), true);
  assert.equal(shouldNotify([L("ok"), L("proxy", { notified: true })], "proxy"), false);
  assert.equal(shouldNotify([L("ok"), L("proxy", { notified: false, notify_error: "telegram HTTP 502" })], "proxy"), true);
  assert.equal(shouldNotify([L("proxy", { notified: true }), L("ok")], "proxy"), true);
});
check("a sign-in drop after the proxy was told is still its own message", () => {
  assert.equal(shouldNotify([L("ok"), L("proxy", { notified: true })], "login_page"), true);
  assert.equal(shouldNotify([L("ok"), L("proxy", { notified: true }), L("login_page", { notified: true })], "login_page"), false);
});
check("the proxy is a state the log names", () => assert.ok(STATES.includes("proxy")));

if (failures) {
  console.log(`\nverify-shopify-session: ${failures} failed`);
  process.exit(1);
}
console.log("\nverify-shopify-session: all passed");
