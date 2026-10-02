// A bot-protection challenge is never ours to pass (CHE-401).
//
// Run #301 landed on a sign-in fronted by Cloudflare's interstitial — "Your
// connection needs to be verified before you can proceed", with a "Verify you
// are human" control — and the walk pressed it. The rule that a challenge
// widget's FRAME is never listed, read or pressed (CHALLENGE_FRAME, tools.ts)
// held: the checkbox inside it could not be driven. The control that pressed
// was in the page itself, one element outside that rule.
//
// Passing a challenge, or trying to, is out of scope and prohibited for every
// kind of run and every customer: it is the site telling automated visitors to
// stay out, the terms of the platforms we check forbid going round it, and the
// account that pays for it is our customer's. An instruction to a model saying
// so is not a mechanism. This is: the click and fill tools refuse a control
// that says it is a human-verification challenge — by the name the walk gave
// it, and by what the control is (its text, its accessible name, how the
// widget it sits in is marked up).
//
// What is NOT refused, on purpose: a product's own pages ABOUT captchas. An
// anti-fraud app has a "reCAPTCHA settings" link and a "Bot protection" tab,
// and those are the product under test. So the bare word is not enough for a
// press; the control has to say it is the challenge, or sit in a widget that is.
//
// No Playwright here: scripts/verify-human-check.ts drives these functions and
// the real tools.

import type { ControlSeen } from "./session-browser";

// "Verify you are human", "I'm not a robot", "Prove you're human", "Human
// verification", "Solve the CAPTCHA", "Press & hold to confirm you are human".
const HUMAN_CHECK_PHRASE = new RegExp(
  [
    String.raw`\bverify\s+(?:that\s+)?(?:you\s+are|you['’]re|i\s+am|i['’]m)\s+(?:a\s+)?human\b`,
    String.raw`\b(?:i\s+am|i['’]m)\s+(?:a\s+)?human\b`,
    String.raw`\b(?:i\s+am|i['’]m|you\s+are|you['’]re)\s+not\s+a\s+(?:ro)?bot\b`,
    String.raw`\b(?:prove|confirm)\s+(?:that\s+)?(?:you\s+are|you['’]re|i\s+am|i['’]m)\s+(?:a\s+)?(?:human|not\s+a\s+(?:ro)?bot)\b`,
    String.raw`\bhuman\s+verification\b`,
    String.raw`\b(?:solve|complete|pass|start|begin)\s+(?:the\s+|a\s+|this\s+)?(?:(?:re|h)?captcha|security\s+(?:check|challenge)|verification\s+challenge|puzzle)\b`,
    String.raw`\b(?:re|h)?captcha\s+(?:checkbox|challenge|widget|puzzle)\b`,
    String.raw`\bturnstile\s+(?:checkbox|challenge|widget)\b`,
  ].join("|"),
  "i",
);

// How challenge widgets are marked up — in a selector the walk wrote, or on
// the element and what it sits in: reCAPTCHA, hCaptcha, Turnstile, Cloudflare's
// challenge page, PerimeterX, Arkose/FunCaptcha, DataDome, GeeTest.
const CHALLENGE_WIDGET =
  /(?:^|[^a-z0-9])(?:g-recaptcha|grecaptcha|recaptcha-(?:anchor|checkbox)|rc-anchor|h-captcha|hcaptcha|cf-turnstile|cf-challenge|cf-chl[a-z0-9_-]*|challenge-(?:stage|form|running|platform)|px-captcha|arkose|funcaptcha|fc-token|datadome|ddcaptcha|geetest[a-z0-9_-]*|captcha-(?:box|container|checkbox|widget))(?:$|[^a-z0-9])/i;

// A field that asks for a challenge's answer.
const CHALLENGE_ANSWER = new RegExp(
  [
    String.raw`\b(?:enter|type|write)\b[^.]{0,40}\b(?:characters?|letters?|text|code|words?|numbers?)\b[^.]{0,40}\b(?:image|picture|see|shown|displayed|above|below)\b`,
    // "Captcha", "CAPTCHA code", "Enter captcha" — the field's whole point; not
    // "reCAPTCHA site key", which is a product's setting.
    String.raw`\b(?:re|h)?captcha\s*(?:code|answer|text|response|solution)?\s*$`,
    String.raw`\b(?:g-recaptcha-response|h-captcha-response|cf-turnstile-response)\b`,
  ].join("|"),
  "i",
);

/** Do these words — a name the walk gave a control, the control's own text — say "human-verification challenge"? */
export function isHumanCheckText(text: string | null | undefined): boolean {
  return Boolean(text && HUMAN_CHECK_PHRASE.test(text));
}

/**
 * Is this markup a challenge widget's — a selector the walk wrote, an id, a
 * class? Asked of markup only, never of visible words: "hCaptcha settings" is
 * a page of the product, `.h-captcha` is the widget.
 */
export function isChallengeMarkup(markup: string | null | undefined): boolean {
  return Boolean(markup && CHALLENGE_WIDGET.test(markup));
}

/** → what about the control says it is a challenge, or null. */
export function humanCheckIn(control: ControlSeen): string | null {
  const text = control.texts.find((t) => HUMAN_CHECK_PHRASE.test(t));
  if (text) return text.trim().replace(/\s+/g, " ").slice(0, 80);
  const mark = (control.marks ?? []).find((m) => CHALLENGE_WIDGET.test(m));
  return mark ? mark.trim().replace(/\s+/g, " ").slice(0, 80) : null;
}

/** Is this a field that asks for a challenge's answer? By the label or placeholder the walk named it by. */
export function isChallengeAnswerField(text: string | null | undefined): boolean {
  return Boolean(text && (CHALLENGE_ANSWER.test(text) || HUMAN_CHECK_PHRASE.test(text)));
}

// What the walk is told. The step it then reports is a gap of ours (rule 2),
// in the class the board already has for it — never a finding about the product.
export function humanCheckRefusal(what: string): string {
  return (
    `Refused: "${what}" is a human-verification challenge. Passing one, or trying to, is never done ` +
    `here — do not press it, do not type into it, do not look for another way round it, and do not ` +
    `reload the page to try again. What lies behind it was not checked this run: report the step ` +
    `"skipped" with unverifiedReason "our_capability", say that the page asked for human verification, ` +
    `and go on with what can be checked without passing it. Nothing behind the challenge may be ` +
    `described as failing.`
  );
}
