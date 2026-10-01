// Capability-gap classes (CHE-198).
//
// CLAUDE.md rule 2: a step our checker could not verify is a ticket on OUR
// board, deduped by capability and counted across every app that trips it.
// Until 2026-09-06 the capability was guessed at filing time from the step's
// stored text — and since CHE-180 that text is the customer's copy, with every
// sentence naming our machinery already cut. The words the classifier keyed on
// ("opens in a new tab, which our browser cannot follow") were exactly the
// words the scrub removes, so run #154's new-tab link and run #153's slider
// both landed on the one bucket nobody learns from (CHE-86, 20 occurrences,
// no capability named).
//
// The class is now decided where the evidence still exists — at report time,
// from the model's own words and the machine trail of the step — and written
// to the row (Step.gapClass). Filing reads the class; it never guesses again.
// The text rules below still run at filing time for rows written before the
// column existed, and as the last resort when a class was never recorded.
//
// The labels are the dedup identity of the tickets on our board: one class =
// one ticket forever. An existing label must never change spelling, or its
// ticket forks. New classes get new labels.

import type { RecordedAction } from "./tools";
import { isTargetHost } from "./tools";

export type GapClass =
  | "new_tab"
  | "oauth"
  | "passwordless"
  | "verification_code"
  | "media_devices"
  | "captcha"
  | "test_records"
  | "file_transfer"
  | "range_input"
  | "third_party_block"
  | "egress_unreachable"
  | "undriven_control"
  | "extension_runtime"
  | "extension_session_cleanup"
  | "extension_minute_accounting"
  | "unpriced_journey"
  | "unfunnelled_journey"
  | "journey_rotation"
  | "shopify_admin"
  | "unclassified";

export const GAP_CLASSES: Record<GapClass, { label: string; why: string }> = {
  journey_rotation: {
    label: "Checker cannot keep every journey of a large app checked",
    why: "An app with more journeys than a run can walk gets a rotation, and a journey at the back of a long queue can age past the point where its last check still means anything. The owner is paying for their app to be checked, and part of it was not — a bigger app must not quietly buy less coverage.",
  },
  unfunnelled_journey: {
    label: "Checker cannot turn a journey it walked into a measurable funnel",
    why: "How many people finish a journey is measured along the path they take through it, and that path is supposed to come from the walk itself so the owner is never asked to define one. A journey we walked but could not reduce to an ordered path is one we can describe and cannot measure — and measuring it wrongly would be worse, because a funnel built from our wandering reports the owner's product converting badly when what converted badly was our browsing.",
  },
  unpriced_journey: {
    label: "Checker cannot say what a journey costs its user",
    why: "The price of a journey — how many actions it takes and how many people finish — is the sentence an outside observer is paid for, and the one a green check mark cannot replace. A journey we walked end to end and left unpriced is a judgement we owe the owner and did not deliver.",
  },
  extension_minute_accounting: {
    label: "Checker cannot establish each extension session's minute usage",
    why: "A balance that settles after Stop proves cessation, but does not establish minute-by-minute charges or independently rounded session totals. Missing UI evidence must remain a coverage gap, never a billing pass or a customer defect.",
  },
  extension_runtime: {
    label: "Checker cannot complete an installed Chrome extension check",
    why: "The Store listing cannot establish whether the installed extension works. Installation identity, its native controls and target tab must remain available throughout the check.",
  },
  extension_session_cleanup: {
    label: "Checker cannot confirm extension session cleanup",
    why: "An application may continue billing after its browser closes. Every owned session needs a timely native Stop and separate evidence that usage ceased before a verdict can be published.",
  },
  new_tab: {
    label: "Checker cannot follow links that open in a new tab",
    why: "Outbound links are a large share of what owners worry about. verify_links resolves them server-side — the walker must reach for it automatically instead of leaving the step unverified.",
  },
  oauth: {
    label: "Checker cannot complete third-party OAuth sign-in",
    why: "Any app whose only login is Google/GitHub is unverifiable behind the login wall — a whole class of customers we cannot serve end to end.",
  },
  passwordless: {
    label: "Checker cannot complete passwordless / magic-link sign-in",
    why: "Magic-link products have NO password to hand us — no amount of owner input unblocks it. We need a mailbox the agent can read for test accounts; until then the entire signed-in half of every passwordless app is invisible to us.",
  },
  verification_code: {
    label: "Checker cannot complete an emailed/SMS verification code step",
    why: "MFA-protected accounts stop the walk at the door. Needs a mailbox/code channel the agent can read for test accounts.",
  },
  media_devices: {
    label: "Checker has no camera/microphone for media flows",
    why: "Video/voice products cannot be walked past the device prompt without synthetic media devices.",
  },
  captcha: {
    label: "Checker is blocked by CAPTCHA/bot protection on the target",
    why: "Owners must be able to allowlist us, or we silently lose coverage of their signup/login.",
  },
  test_records: {
    label: "Checker leaves test records behind in the customer's product",
    why: "Cleanup is the whole basis on which owners let us create anything. One orphan and the permission is rightly withdrawn — and the product fills with our junk (our own self-check left a live app plus a daily watch on your-app.com).",
  },
  file_transfer: {
    label: "Checker cannot drive file upload/download flows",
    why: "Upload-centric products (documents, images, CVs) have their core action unverified.",
  },
  range_input: {
    label: "Checker cannot drag a range input (slider)",
    why: "A range input takes a value from fill but the product listens for the drag — the walk set the value and nothing the user would see happened (run #153, joblander.app settings sliders). Every preference, volume, opacity or price-range control is unverified until the walker can drag.",
  },
  third_party_block: {
    label: "Checker is turned away by a bot challenge or 403 on a third-party host",
    why: "A host the product hands the user to (a domain broker, a video site, a share widget) refuses traffic from where we run. The journey stops at their door, not the product's — the step must be verified from a path that host accepts, or from the product's side of the hand-off.",
  },
  egress_unreachable: {
    label: "Checker cannot reach a host from where it runs",
    why: "A fetch that times out or is reset from our network says nothing about the link (CHE-190). Until the check can go out through a path the host answers, every outbound link to it is coverage we do not have.",
  },
  undriven_control: {
    label: "Checker cannot drive a control that a person can operate by hand",
    why: "Run #159: typing into the notes field on the /check page timed out, and the run published \"the field didn't accept input\" about a field that takes a programmatic value and typed characters in an ordinary browser. Every control our hands cannot reach is either a coverage hole or, worse, a defect we invent for someone else — the walk needs a way to drive what a person can (CHE-214).",
  },
  // CHE-374: CHE-333 was opened by hand before this class existed, so the
  // ticket's link row is seeded (scripts/seed-gap-link-che-333.ts) under this
  // label's dedup key. The label is that key: changing it detaches CHE-333.
  shopify_admin: {
    label: "Checker cannot check an app that lives inside the Shopify admin",
    why: "An embedded Shopify app lives in an iframe inside admin.shopify.com, behind the store owner's Shopify sign-in. Until the walk can sign in to a test store's admin and use the app there, every Shopify app's product is a page we cannot open — a whole platform of customers we cannot serve.",
  },
  unclassified: {
    label: "Checker could not verify a step for an unclassified reason",
    why: "Unclassified coverage gaps are the ones we learn least from — the step text below should become its own capability entry.",
  },
};

export function isGapClass(value: string | null | undefined): value is GapClass {
  return typeof value === "string" && value in GAP_CLASSES;
}

// ─── Text rules ──────────────────────────────────────────────────────────────
//
// The eight original classes keep their patterns and their order (the first
// match wins, so reordering would move a step that matches two). The three new
// classes come after them, and the machine-trail rules after the text.

const TEXT_RULES: { match: RegExp; cls: GapClass }[] = [
  { match: /new tab|target=_?"?_blank|could not follow|cannot follow|opens? in a new/i, cls: "new_tab" },
  { match: /oauth|continue with google|social login|sign in with (google|github|apple)/i, cls: "oauth" },
  // CHE-104: "email link" alone used to land here, so an ordinary mailto:
  // contact link on nkem.dev was filed as a missing sign-in capability. The
  // match needs sign-in context; mailto: is handled by verify_links and is not
  // a gap at all.
  {
    match: /magic link|passwordless|(email|sign-?in|login)[ -]link (sign|log)[ -]?in|sign-?in (by|via) email/i,
    cls: "passwordless",
  },
  // CHE-374: bounded, because "otp" is inside "footprint".
  { match: /verification code|\b2fa\b|\bmfa\b|one-?time (code|password)|\botp\b/i, cls: "verification_code" },
  { match: /camera|microphone|media device|getusermedia|webrtc/i, cls: "media_devices" },
  { match: /captcha|turnstile|recaptcha|bot (check|protection)/i, cls: "captcha" },
  { match: /leaves its test records|records still present|cleanup audit/i, cls: "test_records" },
  // CHE-374: an import, a CSV upload or a drop zone is the same missing hand
  // as a file picker — "Import did nothing" was left to whatever else the
  // step happened to mention.
  {
    match: /file (upload|picker)|download|\bupload(?:s|ed|ing)?\b|\bimport(?:s|ed|ing)?\b|drag[ -]and[ -]drop/i,
    cls: "file_transfer",
  },
  {
    match: /\bsliders?\b|range (input|control|slider)|input\[type=["']?range|type="range"|\bdrag(ged|ging)?\b(?![ -]and[ -]drop)/i,
    cls: "range_input",
  },
  // CHE-214, last so every named capability above still wins: a slider we
  // could not drag is the range-input gap, not this one. The class is normally
  // decided at report time from the machine failure (tools.ts
  // coerceUndrivenControl) and carried on the row; this rule is the fallback
  // for rows written before that, and for a step whose words are all we have.
  {
    match: /could not be (?:driven|exercised)|\bundriven\b|could not (?:drive|reach) (?:the |this )?(?:control|field|button)/i,
    cls: "undriven_control",
  },
];

// A host turning us away: a challenge page, or the statuses a host uses for
// traffic it does not like (CHE-190). With a host other than the target named
// it is the third party's door; on the target itself it is the CAPTCHA class.
// 429 is deliberately not here: it is our own request volume (CLAUDE.md rule
// 3), not that host's policy — a foreign-host 429 is "we could not reach it
// from here" (egress_unreachable), and the ticket must say so.
const CHALLENGE =
  /captcha|turnstile|recaptcha|hcaptcha|bot (?:check|protection|challenge|detection)|cloudflare|security (?:verification|challenge|check)|challenge page|blocking automated|automated (?:access|traffic)|access denied|just a moment|verify you are human|refuses automated/i;
const GATE_STATUS = /\b(?:403|503)\b/;
// A host we could not reach at all: verify_links' own word, a timeout, a reset,
// and the sentence coerceUnreachable appends — the one that survives the
// customer-copy scrub.
const EGRESS =
  /\bUNREACHABLE\b|\bcould not be reached\b|\bunreachable\b|\btimed?[\s-]?out\b|\bconnection (?:reset|refused|failed|error|closed)\b|\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH)\b|\bcould not confirm (?:[a-z0-9-]+\.)+[a-z]{2,}\b[^.]*\bthis run\b/i;

const CITED_HOST = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi;
const NOT_A_HOST = /\.(?:php|html?|x?html|js|mjs|ts|tsx|css|json|xml|png|jpe?g|gif|svg|webp|ico|txt|pdf|aspx?|jsp|map|woff2?)$/i;

function foreignHosts(text: string, targetOrigin: string | undefined): string[] {
  if (!targetOrigin) return [];
  const out: string[] = [];
  for (const m of text.matchAll(CITED_HOST)) {
    const host = m[1].toLowerCase();
    if (NOT_A_HOST.test(host) || out.includes(host) || isTargetHost(host, targetOrigin)) continue;
    out.push(host);
  }
  return out;
}

// ─── Machine-trail rules ─────────────────────────────────────────────────────
//
// What the walk executed for the step (CHE-129), read when the words say
// nothing. A click on a slider role or a fill into a range input is the
// range-input class. A link click that neither navigated nor produced a
// request nor changed the page is a link the page opened somewhere we are not
// looking — the new-tab class (run #154: role "link", 0 requests, 0 mutations,
// same URL after).

function trailClass(actions: RecordedAction[]): GapClass | null {
  for (const a of actions) {
    if (a.kind === "click" && a.role?.toLowerCase() === "slider") return "range_input";
    if (a.kind === "fill" && /type=["']?range/i.test(a.selector ?? "")) return "range_input";
  }
  for (const a of actions) {
    if (
      a.kind === "click" &&
      a.role?.toLowerCase() === "link" &&
      !a.outcome.navigated &&
      a.outcome.requests === 0 &&
      a.outcome.mutations === 0
    ) {
      return "new_tab";
    }
  }
  return null;
}

export interface GapEvidence {
  /** The step's words: label, attempted, observed — the model's own where available. */
  text: string;
  /** The machine trail recorded for the step (CHE-129). */
  actions?: RecordedAction[] | null;
  /** The product's origin, so a host named in the text can be told from a third party's. */
  targetOrigin?: string;
}

// ─── The Shopify admin (CHE-374) ─────────────────────────────────────────────
//
// The Shopify admin is one capability, whatever door it shows us. Run #283's
// merchant sign-in link answered 403 from admin.shopify.com and was filed as a
// third-party block (CHE-309); its sign-in page reads as OAuth, and anything
// else in it as unclassified — one missing capability counted on three
// tickets, none of them CHE-333.
//
// Evidence that the step was AT the admin, never a mention of it:
// - a URL whose parsed hostname is exactly admin.shopify.com, or a store's
//   *.myshopify.com host with the /admin segment — parsed, not matched, so
//   admin.shopify.com.1337.io, https://admin.shopify.com@evil.io and
//   evil.io/?next=admin.shopify.com are the hosts they really are. Read from
//   the machine trail (where the walk went) and from the words (where
//   verify_links was turned away, which leaves no trail);
// - accounts.shopify.com, Shopify's login for every Shopify property, only
//   when the target is a Shopify store or the admin: a community forum's
//   sign-in or another product's "Connect Shopify" hop is OAuth, as is an
//   admin.shopify.com/oauth/ hop from a product that is not a store;
// - words that put the walk inside the admin, only on a Shopify target: a
//   SaaS page that "syncs orders to the Shopify admin" is not in it.
//
// What wins, once the step is at the admin:
// - a gate there (403/503 or a challenge, with the admin host named or a
//   navigation to it refused) is the blocking cause: it outranks new-tab
//   wording ("we could not follow the link" is the raw sentence for exactly
//   that 403) unless the trail shows a new tab too, and any mechanism the
//   trail alone suggests;
// - otherwise the doors (sign-in, codes, CAPTCHA) are the admin's doors;
// - a mechanism in the words (an upload, a slider, a camera, a new tab, a
//   control we cannot drive, a record left behind) is its own capability
//   wherever it happened, and so is a trail mechanism the words leave open.
const SHOPIFY_DOORS: ReadonlySet<GapClass> = new Set(["oauth", "passwordless", "verification_code", "captcha"]);
const ADMIN_HOST = "admin.shopify.com";
const ACCOUNTS_HOST = "accounts.shopify.com";
const STORE_SUFFIX = ".myshopify.com";
const IN_THE_ADMIN = [
  /\b(?:inside|within)\s+(?:the\s+|a\s+|its\s+|their\s+)?(?:store'?s?\s+)?shopify\s+admin\b/i,
  /\b(?:sign(?:ing|ed)?|log(?:ging|ged)?)[\s-]*in(?:to)?\s+(?:to\s+)?(?:the\s+|a\s+|its\s+|their\s+)?(?:store'?s?\s+)?shopify\s+admin\b/i,
  /\bembedded\s+shopify\s+app\b/i,
];
const GATE_STATUS_CODES = new Set([403, 503]);

// A whitespace-separated token as the URL it names, or null. Bare hosts get a
// scheme so the WHATWG parser decides the hostname — userinfo, IDN, path and
// query handled the way a browser would handle them.
function tokenUrl(token: string): URL | null {
  const cleaned = token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}/]+$/u, "");
  if (!cleaned.includes(".")) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.$/, "");
}

function isStoreHost(host: string): boolean {
  return host.endsWith(STORE_SUFFIX) && host.length > STORE_SUFFIX.length;
}

function isShopifyTarget(targetOrigin: string | undefined): boolean {
  const u = targetOrigin ? tokenUrl(targetOrigin) : null;
  if (!u) return false;
  const host = hostOf(u);
  return host === ADMIN_HOST || isStoreHost(host);
}

function isAdminUrl(u: URL, shopifyTarget: boolean): boolean {
  const host = hostOf(u);
  const path = u.pathname.toLowerCase();
  if (host === ADMIN_HOST) return shopifyTarget || !/^\/oauth(?:\/|$)/.test(path);
  if (host === ACCOUNTS_HOST) return shopifyTarget;
  return isStoreHost(host) && (path === "/admin" || path.startsWith("/admin/"));
}

function trailUrls(actions: RecordedAction[]): { url: string; status: number | null }[] {
  const out: { url: string; status: number | null }[] = [];
  for (const a of actions) {
    if (a.kind === "navigate") {
      out.push({ url: a.url, status: a.outcome.status }, { url: a.outcome.urlAfter, status: a.outcome.status });
    } else {
      out.push({ url: a.outcome.urlAfter, status: null });
    }
  }
  return out;
}

function shopifyAdmin(evidence: GapEvidence): { at: boolean; gated: boolean } {
  const shopifyTarget = isShopifyTarget(evidence.targetOrigin);
  const admin = (raw: string) => {
    const u = tokenUrl(raw);
    return u !== null && isAdminUrl(u, shopifyTarget);
  };
  const trail = trailUrls(evidence.actions ?? []).filter((t) => admin(t.url));
  const named = evidence.text.split(/\s+/).some(admin);
  const said = shopifyTarget && IN_THE_ADMIN.some((rule) => rule.test(evidence.text));
  const gated =
    trail.some((t) => t.status !== null && GATE_STATUS_CODES.has(t.status)) ||
    (named && (CHALLENGE.test(evidence.text) || GATE_STATUS.test(evidence.text)));
  return { at: trail.length > 0 || named || said, gated };
}

// Never null: "unclassified" is the last resort, and it still files.
export function classifyGap(evidence: GapEvidence): GapClass {
  const text = evidence.text;
  const textHit = TEXT_RULES.find((r) => r.match.test(text))?.cls;
  const shopify = shopifyAdmin(evidence);
  if (shopify.at) {
    const trail = trailClass(evidence.actions ?? []);
    if (shopify.gated) {
      if (textHit === "new_tab") return trail === "new_tab" ? "new_tab" : "shopify_admin";
      return textHit && !SHOPIFY_DOORS.has(textHit) ? textHit : "shopify_admin";
    }
    if (!textHit) return trail ?? "shopify_admin";
    return SHOPIFY_DOORS.has(textHit) ? "shopify_admin" : textHit;
  }
  // A challenge or gate status naming a host other than the target is that
  // host's door, whatever else the words say — checked before the captcha
  // rule above would claim it for the target.
  if ((CHALLENGE.test(text) || GATE_STATUS.test(text)) && foreignHosts(text, evidence.targetOrigin).length > 0) {
    return "third_party_block";
  }
  if (textHit) return textHit;
  if (CHALLENGE.test(text)) return "captcha";
  if (EGRESS.test(text)) return "egress_unreachable";
  return trailClass(evidence.actions ?? []) ?? "unclassified";
}

// The words a step carries, in one string, for the rules above. Every field
// the step has; the caller decides whether they are the model's or the
// customer's copy.
export function gapEvidenceText(
  ...parts: Array<string | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
