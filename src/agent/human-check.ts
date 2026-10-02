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
// challenge page, PerimeterX, Arkose/FunCaptcha, DataDome, GeeTest. Names a
// provider gave its own widget — each says "captcha" or names the provider.
const CHALLENGE_WIDGET =
  /(?:^|[^a-z0-9])(?:g-recaptcha|grecaptcha|recaptcha-(?:anchor|checkbox)|rc-anchor|h-captcha|hcaptcha|cf-turnstile|cf-challenge|cf-chl[a-z0-9_-]*|px-captcha|arkose|funcaptcha|fc-token|datadome|ddcaptcha|geetest[a-z0-9_-]*|captcha-(?:box|container|checkbox|widget))(?:$|[^a-z0-9])/i;

// Cloudflare's interstitial also uses names that are ordinary words —
// #challenge-form, #challenge-stage, .challenge-running, challenge-platform —
// and so does a quiz or a coding-challenge product, whose every control would
// then be refused (Codex on #252). On their own they say nothing; next to a
// provider's own mark they are the interstitial.
const GENERIC_CHALLENGE = /(?:^|[^a-z0-9])challenge-(?:stage|form|running|platform|body-text|error-text)(?:$|[^a-z0-9])/i;
const PROVIDER_MARK = /(?:^|[^a-z0-9])(?:data-sitekey|cf-[a-z0-9_-]+|ray-id|turnstile|(?:re|h)?captcha[a-z0-9_-]*)(?:$|[^a-z0-9])/i;

// How a FIELD names itself as the place for a challenge's answer: its id, its
// name, its class — "captcha", "captcha_code", "txtCaptcha", "captchaInput".
// Wider than the widget names on purpose, and asked of fields only: typing into
// a field called captcha is answering one, while a link whose id is
// "captcha-settings" is a page of the product (Codex on #252).
const ANSWER_FIELD_MARK = /captcha/i;
// A name that says "this is about configuring one": the product's own page,
// whatever provider it names — #hcaptcha-settings, .g-recaptcha-config,
// recaptcha_site_key (Codex on #252, twice).
const SETTING_MARK = /(?:site|secret|public|private|api)[-_ ]?key|settings?|config|options?|preferences|provider|enabled?|threshold|score|docs?|help/i;

// Markup is judged one name at a time: a class list or a selector holds
// several, and among them "h-captcha" is the widget while "hcaptcha-settings"
// is a page about it.
const namesIn = (markup: string): string[] => markup.split(/[\s>+~,]+/).filter(Boolean);
const widgetName = (name: string): boolean => CHALLENGE_WIDGET.test(name) && !SETTING_MARK.test(name);
// (data-sitekey is the provider's own attribute, not a setting's name.)
const providerName = (name: string): boolean => name === "data-sitekey" || (PROVIDER_MARK.test(name) && !SETTING_MARK.test(name));
const widgetIn = (markup: string): string | null => namesIn(markup).find(widgetName) ?? null;

// A field that asks for a challenge's answer.
const CHALLENGE_ANSWER = new RegExp(
  [
    String.raw`\b(?:enter|type|write)\b[^.]{0,40}\b(?:characters?|letters?|text|code|words?|numbers?)\b[^.]{0,40}\b(?:image|picture|see|shown|displayed|above|below)\b`,
    // "Captcha", "CAPTCHA code", "Enter captcha" — the field's whole point; not
    // "reCAPTCHA site key", which is a product's setting. A label's own
    // decoration does not change what it asks for: "CAPTCHA *", "Captcha:",
    // "Captcha (required)".
    String.raw`\b(?:re|h)?captcha\s*(?:code|answer|text|response|solution)?(?:[\s*:：.]|\((?:required|mandatory|obligatory)\))*$`,
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
  return Boolean(markup && widgetIn(markup));
}

const said = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 80);

/** → what about the control says it is a challenge, or null. */
export function humanCheckIn(control: ControlSeen): string | null {
  const text = control.texts.find((t) => HUMAN_CHECK_PHRASE.test(t));
  if (text) return said(text);
  const marks = (control.marks ?? []).flatMap(namesIn);
  const widget = marks.find(widgetName);
  if (widget) return said(widget);
  // An ordinary word for a container counts only beside a provider's own mark.
  const generic = marks.find((m) => GENERIC_CHALLENGE.test(m));
  return generic && marks.some(providerName) ? said(generic) : null;
}

/**
 * → what about a FIELD says it is where a challenge's answer goes, or null:
 * everything a control can say (above), its label or placeholder, and its own
 * id / name / class saying "captcha" — unless they say it is a setting
 * ("recaptcha_site_key"), which is the product's.
 */
export function challengeAnswerIn(field: ControlSeen): string | null {
  const asControl = humanCheckIn(field);
  if (asControl) return asControl;
  const text = field.texts.find((t) => isChallengeAnswerField(t));
  if (text) return said(text);
  // The field's OWN id, name and class — a container's class is not the field's name.
  const own = (field.own ?? []).flatMap(namesIn).find((m) => ANSWER_FIELD_MARK.test(m) && !SETTING_MARK.test(m));
  return own ? said(own) : null;
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
