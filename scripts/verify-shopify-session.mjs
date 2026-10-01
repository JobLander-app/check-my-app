// CHE-378: the session-host probe names what it sees correctly, and messages
// the owner only when he is needed — once per drop from ok, never for the
// state the host starts in, never twice for the same drop.
//
// Pure rules from spikes/shopify-session; no browser, no network, no env.

import assert from "node:assert/strict";
import { classify, parseLog, shouldNotify } from "../spikes/shopify-session/classify.mjs";
import { cookiesForAdmin, tunnelledWsEndpoint } from "../spikes/shopify-session/portability.mjs";

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

check("a torn last line does not stop the log from being read", () => {
  const lines = parseLog('{"state":"ok"}\n{"state":"login_page","notified":true}\n{"state":"cap');
  assert.deepEqual(lines.map((l) => l.state), ["ok", "login_page"]);
});

// --- portability ----------------------------------------------------------

check("only cookies admin.shopify.com would be sent are carried over", () => {
  const cdp = [
    { name: "a", value: "1", domain: ".shopify.com", path: "/", expires: 1900000000, session: false, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "b", value: "2", domain: "admin.shopify.com", path: "/", expires: -1, session: true, httpOnly: true, secure: true },
    { name: "c", value: "3", domain: "accounts.shopify.com", path: "/", expires: -1, session: true, httpOnly: true, secure: true },
    { name: "d", value: "4", domain: ".example.com", path: "/", expires: -1, session: true, httpOnly: false, secure: false },
    { name: "e", value: "5", domain: ".admin.shopify.com", path: "/", expires: 0, session: false, httpOnly: false, secure: true, sameSite: "Bogus" },
  ];
  const out = cookiesForAdmin(cdp);
  assert.deepEqual(out.map((c) => c.name), ["a", "b", "e"]);
  assert.equal(out[0].sameSite, "Lax");
  assert.equal(out[1].expires, -1);
  assert.equal(out[2].expires, -1);
  assert.equal("sameSite" in out[2], false);
});
check("the DevTools socket is addressed through the local end of the tunnel", () => {
  const ws = tunnelledWsEndpoint({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }, 19222);
  assert.equal(ws, "ws://127.0.0.1:19222/devtools/browser/abc");
});

if (failures) {
  console.log(`\nverify-shopify-session: ${failures} failed`);
  process.exit(1);
}
console.log("\nverify-shopify-session: all passed");
