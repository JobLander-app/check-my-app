// What a page in the Shopify admin says about the session that opened it, and
// whether the owner needs to hear about it. Shared by probe.mjs (on the session
// host, against the human's Chrome) and portability.mjs (from our side, against
// a fresh Cloudflare browser holding the host's cookies), so both name the same
// state the same way. No Playwright import: scripts/verify-shopify-session.mjs
// checks the rules without a browser.

export const TARGET_URL =
  "https://admin.shopify.com/store/prod-release-1/apps/easy-block-customer-ip-country";

export const STATES = ["ok", "login_page", "captcha", "2fa", "error"];

// Whatever the page settles on first: the embedded app's frame (signed in), a
// sign-in field, a captcha, or a one-time-code field.
//
// Two captchas, not one. The sign-in form carries hCaptcha; but on the first
// probe from this host (2026-10-01) accounts.shopify.com answered with a
// Cloudflare Turnstile interstitial ("Your connection needs to be verified")
// before any form at all. Watching for hCaptcha alone filed that as a sign-in
// page after a 45-second wait.
const SETTLED = [
  'iframe[name="app-iframe"]',
  'input[type="password"]',
  'input[type="email"]',
  'input[name="account[email]"]',
  'iframe[src*="hcaptcha"]',
  'input[name="cf-turnstile-response"]',
  'iframe[src*="challenges.cloudflare.com"]',
  'input[autocomplete="one-time-code"]',
].join(", ");

const TWO_FACTOR_PATH = /two[-_]?factor|two[-_]?step|\/tfa\b|\/2fa\b|\/mfa\b|\/otp\b|verif/i;
const TWO_FACTOR_TEXT =
  /two-step|two-factor|2-step|authentication code|verification code|security code|authenticator app|verify it.s you/i;

/**
 * Pure: signals → state.
 *
 * Shopify's sign-in form carries an hCaptcha widget of its own, so a captcha
 * next to an email or password field is still just the sign-in page — the
 * session is gone either way. "captcha" is a challenge standing on its own: on
 * the accounts host with no sign-in field, or anywhere on the admin host. The
 * log keeps url_host, so "challenged on the way to sign-in" (accounts) and
 * "challenged inside a live session" (admin) stay separable afterwards.
 */
export function classify({ url, hasAppIframe, hasCaptchaFrame, hasTurnstile, hasLoginInput, hasOtpInput, text }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "error";
  }
  const host = parsed.hostname;
  const captcha = Boolean(hasCaptchaFrame || hasTurnstile);
  const twoFactor = Boolean(hasOtpInput) || TWO_FACTOR_PATH.test(parsed.pathname) || TWO_FACTOR_TEXT.test(text ?? "");

  if (host === "accounts.shopify.com") {
    if (captcha && !hasLoginInput) return "captcha";
    if (twoFactor && !hasLoginInput) return "2fa";
    return "login_page";
  }
  if (host === "admin.shopify.com") {
    if (captcha) return "captcha";
    if (hasOtpInput) return "2fa";
    if (hasAppIframe) return "ok";
    if (hasLoginInput) return "login_page";
  }
  return "error";
}

/** Which captcha, for the "kinds of challenge" count. Null when none. */
export function challengeKind({ hasCaptchaFrame, hasTurnstile }) {
  if (hasTurnstile) return "turnstile";
  if (hasCaptchaFrame) return "hcaptcha";
  return null;
}

/**
 * Pure: should this probe message the owner?
 *
 * Only on the way down from ok, and once per drop (skill
 * checkmyapp-owner-channel: one message per need, no repeats). The first lines
 * before anyone has ever signed in are not a drop. A single `error` is not one
 * either — a Chrome restart or a slow page would wake him for nothing — but two
 * in a row are, because then the probe cannot see the session at all.
 */
export function shouldNotify(history, state) {
  if (state === "ok") return false;
  let lastOk = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].state === "ok") {
      lastOk = i;
      break;
    }
  }
  if (lastOk < 0) return false;
  const sinceOk = history.slice(lastOk + 1);
  if (sinceOk.some((line) => line.notified)) return false;
  if (state === "error") return sinceOk.length > 0 && sinceOk[sinceOk.length - 1].state === "error";
  return true;
}

export function parseLog(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      // A torn last line from a killed run is not a reason to stop measuring.
    }
  }
  return lines;
}

/**
 * Open TARGET_URL in `page`, wait for it to settle, return
 * { state, url_host, url_path[, challenge] }. Never returns the query string
 * (it can carry tokens) or any page text.
 */
export async function observe(page, { timeoutMs = 45_000 } = {}) {
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(SETTLED, { state: "attached", timeout: timeoutMs }).catch(() => {});
  // The admin redirects to accounts.shopify.com with script, and the sign-in
  // form swaps its first step for the next; let one of those finish.
  await page.waitForTimeout(3_000);

  const has = async (selector) => (await page.locator(selector).count().catch(() => 0)) > 0;
  const signals = {
    url: page.url(),
    hasAppIframe: await has('iframe[name="app-iframe"]'),
    hasCaptchaFrame:
      page.frames().some((frame) => /hcaptcha\.com/.test(frame.url())) || (await has('iframe[src*="hcaptcha"]')),
    hasTurnstile:
      page.frames().some((frame) => /challenges\.cloudflare\.com/.test(frame.url())) ||
      (await has('input[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"]')),
    hasLoginInput: await has('input[type="password"], input[type="email"], input[name="account[email]"]'),
    hasOtpInput: await has('input[autocomplete="one-time-code"]'),
    text: (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 5_000),
  };
  const final = new URL(signals.url);
  const state = classify(signals);
  const observed = { state, url_host: final.hostname, url_path: final.pathname };
  if (state === "captcha") observed.challenge = challengeKind(signals);
  return observed;
}
