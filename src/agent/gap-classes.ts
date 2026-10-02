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
  { match: /file (upload|picker)|download/i, cls: "file_transfer" },
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

function foreignHosts(text: string, targetOrigin: string | undefined, allowedOrigins: readonly string[] = []): string[] {
  if (!targetOrigin) return [];
  const out: string[] = [];
  for (const m of text.matchAll(CITED_HOST)) {
    const host = m[1].toLowerCase();
    if (NOT_A_HOST.test(host) || out.includes(host) || isTargetHost(host, targetOrigin, allowedOrigins)) continue;
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
  /** CHE-373: origins the owner allowed for the app — the product's too, never a third party's. */
  allowedOrigins?: readonly string[];
  /** The run's target URL, path included: a store's /admin as the target is the admin itself. */
  targetUrl?: string;
}

// ─── The Shopify admin (CHE-374) ─────────────────────────────────────────────
//
// The Shopify admin is one capability, whatever door it shows us: the store
// owner's sign-in (admin.shopify.com, accounts.shopify.com) and the admin
// itself (admin.shopify.com, a store's *.myshopify.com/admin). An OAuth hop
// that lands there — another product's "Connect Shopify" included, through
// /admin/oauth/authorize or /store/x/oauth/authorize — is that same sign-in,
// so it is this class too.
//
// Words never decide it. Three review passes over word rules each opened new
// holes — a host in a query string, a "not inside the Shopify admin", a CSV
// "exported from admin.shopify.com". The class rests on two facts the walk
// records and the model does not write:
// - where the step's walk ended, on the machine trail (CHE-129): the address
//   its last action left the page on — parsed with the URL parser and compared
//   by exact hostname, so admin.shopify.com.1337.io is the host it really is;
// - or, for a step with no trail, the run's target.
// And it is the class of being stopped at the admin's DOOR (atAdminGate), not
// of being anywhere in it: inside an app, every other class decides as it
// always did, so this ticket's count can fall once we can sign in.
//
// Known limits, accepted: a store on its own domain; a step whose only contact
// with the admin was a server-side link check (run #283's 403 came from
// verify_links, which leaves no trail); and a link into the admin that opens
// in a new tab, which the walk does not follow (that is new_tab). They keep
// the class the rules below give them.
const ADMIN_HOST = "admin.shopify.com";
const ACCOUNTS_HOST = "accounts.shopify.com";
const STORE_SUFFIX = ".myshopify.com";

function absoluteUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

// A trailing dot names the same host ("admin.shopify.com." resolves there).
function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.$/, "");
}

function isStoreAdmin(u: URL): boolean {
  const host = hostOf(u);
  const path = u.pathname.toLowerCase();
  return host.endsWith(STORE_SUFFIX) && host.length > STORE_SUFFIX.length && (path === "/admin" || path.startsWith("/admin/"));
}

// The statuses a door answers with when it will not let an automated visitor in.
const ADMIN_GATE_STATUSES = new Set([401, 403, 429, 503]);

// Is this address the admin's GATE — the sign-in, or the admin turning us away
// — rather than a page inside it? (Third review pass of PR #217.) The class
// must be able to empty: once a run is signed in and the walk stands inside an
// app (admin.shopify.com/store/<store>/apps/<app>), a camera prompt or a
// third party's 403 there is its own capability again, and counts on its own
// ticket. So "at the admin" means "stopped at its door":
// - accounts.shopify.com, Shopify's sign-in;
// - a store's own /admin… address — signed in, the store sends it on to
//   admin.shopify.com, so standing on it means we never got in;
// - admin.shopify.com answering with a gate status, or anywhere on it outside
//   /store/<store>/… (its /login, an /oauth/authorize grant — another
//   product's "Connect Shopify" included).
function atAdminGate(u: URL, status: number | null): boolean {
  const host = hostOf(u);
  if (host === ACCOUNTS_HOST) return true;
  if (isStoreAdmin(u)) return true;
  if (host !== ADMIN_HOST) return false;
  if (status !== null && ADMIN_GATE_STATUSES.has(status)) return true;
  const path = u.pathname.toLowerCase();
  const inside = /^\/store\/[^/]+(\/|$)/.test(path) && !/\/oauth(\/|$)/.test(path);
  return !inside;
}

// Where the step's walk ended: the address the LAST recorded action left the
// page on. Not any address on the way — an early hop through the admin's
// sign-in followed by the storefront and a third party's timeout is that third
// party's gap. The landing decides; the address a navigation merely asked for
// stands in only when no landing was recorded (a store's /admin that redirects
// to its /password page landed on the store's own lock, not on the admin).
function lastLanding(actions: RecordedAction[]): { url: URL; status: number | null } | null {
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    const url = absoluteUrl(a.outcome.urlAfter) ?? (a.kind === "navigate" ? absoluteUrl(a.url) : null);
    if (url) return { url, status: a.kind === "navigate" ? (a.outcome.status ?? null) : null };
  }
  return null;
}

// With a trail, its last landing decides. Without one (a step skipped before
// anything was done) the run's target does, by the same rule.
function atShopifyAdmin(evidence: GapEvidence): boolean {
  const landing = lastLanding(evidence.actions ?? []);
  if (landing) return atAdminGate(landing.url, landing.status);
  const target = absoluteUrl(evidence.targetUrl ?? evidence.targetOrigin);
  return target !== null && atAdminGate(target, null);
}

// Never null: "unclassified" is the last resort, and it still files.
export function classifyGap(evidence: GapEvidence): GapClass {
  const text = evidence.text;
  // Stopped at the admin's door: whatever the step set out to do — its label
  // may say "Import products from CSV" — it never got there.
  if (atShopifyAdmin(evidence)) return "shopify_admin";
  const textHit = TEXT_RULES.find((r) => r.match.test(text))?.cls;
  // A challenge or gate status naming a host other than the target is that
  // host's door, whatever else the words say — checked before the captcha
  // rule above would claim it for the target.
  if ((CHALLENGE.test(text) || GATE_STATUS.test(text)) && foreignHosts(text, evidence.targetOrigin, evidence.allowedOrigins).length > 0) {
    return "third_party_block";
  }
  if (textHit) return textHit;
  if (CHALLENGE.test(text)) return "captcha";
  if (EGRESS.test(text)) return "egress_unreachable";
  return trailClass(evidence.actions ?? []) ?? "unclassified";
}

// CHE-373: the evidence a walked step is classified on, built from the walk's
// own tool env so the origins the tools act on are the origins the classifier
// counts as the product. Built in one place: the call in execution.ts that
// spelled the fields by hand could drop allowedOrigins with every guard green,
// and an allowed origin's challenge then filed as a third party's block.
export function walkGapEvidence(
  env: { targetOrigin: string; allowedOrigins?: readonly string[] },
  text: string,
  actions: RecordedAction[],
): GapEvidence {
  return { text, actions, targetOrigin: env.targetOrigin, allowedOrigins: env.allowedOrigins ?? [] };
}

// Report time (execution.ts): the capability is named on the model's own words
// and the step's machine trail, and the trail is then handed over and emptied
// for the next step. One function, so the classification can never be given a
// trail that was already drained — the order used to be pinned only by a
// pattern over the caller's source, which a rearranged caller satisfied while
// classifying an empty trail (third review pass of PR #217).
export function settleStepGap(input: {
  /** The step as the model reported it. */
  reported: { label?: string; attempted?: string; observed?: string };
  /** The step as it will be written (the judge may have replaced its words). */
  step: { unverifiedReason?: string | null; observed?: string; gapClass?: GapClass };
  /** A class the tools already decided from the machine (CHE-214). */
  machineClass: GapClass | undefined;
  /** The live trail of the step; emptied here. */
  actionTrail: RecordedAction[];
  /** The walk's own tool env: the origins its tools act on (CHE-373). */
  env: { targetOrigin: string; allowedOrigins?: readonly string[] };
  targetUrl?: string | null;
}): RecordedAction[] {
  const { reported, step, actionTrail } = input;
  if (step.unverifiedReason === "our_capability") {
    step.gapClass =
      input.machineClass ??
      classifyGap({
        ...walkGapEvidence(
          input.env,
          gapEvidenceText(reported.label, reported.attempted, reported.observed, step.observed),
          actionTrail,
        ),
        // CHE-374: the origin drops the path, and a store's /admin as the
        // target is the Shopify admin itself.
        targetUrl: input.targetUrl ?? undefined,
      });
  } else {
    step.gapClass = undefined;
  }
  return actionTrail.splice(0);
}

// The words a step carries, in one string, for the rules above. Every field
// the step has; the caller decides whether they are the model's or the
// customer's copy.
export function gapEvidenceText(
  ...parts: Array<string | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
