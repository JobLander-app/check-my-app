// Playwright-backed tools the agent loop exposes to the LLM.
//
// Design notes (CHE-7):
// - read_page returns a digest (title, headings, links, forms, buttons, aria
//   roles), never raw HTML — keeps context small and selectors role-based.
// - fill substitutes {{TEST_EMAIL}} / {{TEST_PASSWORD}} server-side, so real
//   credentials never enter the LLM context or the transcript.
// - report_step / write_e2e_test are the persistence hooks: the loop stays
//   model-driven, the harness owns evidence and artifacts.

import type Anthropic from "@anthropic-ai/sdk";
import type { Frame, Locator, Page } from "@cloudflare/playwright";
import { credentialFingerprint } from "@/lib/crypto";
import {
  hasEnvironmentLeak,
  MACHINERY_TERMS,
  NOT_DEFECT_FALLBACK,
  PROBLEM_FALLBACK,
  productProse,
  productStepLabel,
  SELF_CHECK_REFUSED_OBSERVED,
  cutSelfCheckRefusalClaims,
  splitSentences,
  UNVERIFIABLE_FALLBACK,
} from "@/lib/verdict-language";
import { cutNullEffectClauses } from "./findings-gate";
import { isSelfCheckRedirect, isSelfUrl, selfCheckRefusalIn } from "./self-hosts";
import type { GapClass } from "./gap-classes";
import type { ExtensionBrowser } from "./extension-browser";
import { ExtensionRuntimeError } from "./extension-error";
import { extensionToolAllowed } from "./extension-contract";
import { DEFAULT_ACCOUNT_LABEL, normalizeAccountLabel } from "@/lib/test-accounts";
import { isStoreGateUrl } from "@/lib/store-gate";
import { onStoreGate, storeRefused, storeUndriven, unlockStoreGate, type StoreAccess, type UnlockOutcome } from "./store-password";

export interface ToolEnv {
  page: Page;
  extension?: ExtensionBrowser;
  // Origin the agent is allowed to touch. Credential substitution and
  // navigation are hard-refused off this origin (defence vs prompt injection).
  targetOrigin: string;
  // CHE-373: further origins the owner named for this app (App.allowedOrigins,
  // copied onto the run) — an embedded app's host page and its frame. Navigation,
  // credential entry, reading a frame into the digest and acting in one accept
  // them as they accept targetOrigin; the evidence rules count their hosts
  // (exactly, no subdomains) as the product. Normalized origins
  // (src/lib/allowed-origins.ts). Absent or empty = a single-origin run: nothing
  // off the target's origin is opened, read into the prompt, typed into or
  // pressed. (What did change for every run: a frame on the target's own origin
  // is pressed and filled, where page locators used to stop at its boundary.)
  allowedOrigins?: string[];
  testEmail?: string;
  testPassword?: string;
  // CHE-322: the app's named accounts beyond the default one above, decrypted
  // in memory like testPassword and reachable only through the placeholders
  // {{TEST_EMAIL:<label>}} / {{TEST_PASSWORD:<label>}}.
  testAccounts?: AccountSecret[];
  // CHE-322: the account whose placeholder was filled last. A sign-in that is
  // turned away is attributed to it, and a sign-in click is refused only when
  // IT is the account already turned away. Unset = the default account.
  activeAccount?: string;
  networkLog: string[]; // rolling window of "METHOD url → status"
  consoleLog: string[]; // rolling window of console messages
  onScreenshot?: (buffer: Buffer) => Promise<string>; // returns storage URL
  onReportStep?: (step: ReportedStep) => Promise<void>;
  onWriteTest?: (test: { title: string; content: string }) => Promise<void>;
  // Vision (CHE-70): when true, the screenshot tool also captures a compressed
  // JPEG and parks it here; the core loop lifts it into the tool_result as an
  // image block so the model SEES what it photographed, then clears the slot.
  // Off for text-only nav models — the image would be rejected.
  visionScreenshots?: boolean;
  pendingScreenshotJpegB64?: string;
  pendingScreenshotPngB64?: string;
  // CHE-169: vision on demand. With this on (and visionScreenshots off) the
  // screenshot tool parks no JPEG by itself; the harness parks one only at a
  // moment of judgment — an inert click or one that needed a fallback, an
  // error response from the target in the last action's requests (or a 429
  // from anywhere), a page with media/WebRTC signals, or the model asking to
  // look (screenshot with look=true). Set only for nav models that can see.
  visionTriggers?: boolean;
  // CRUD lifecycle checking (CHE-90). writeAllowed comes from App.writeMode;
  // marker is the string every created record must carry so cleanup can only
  // ever touch our own rows.
  writeAllowed?: boolean;
  testMarker?: string;
  onResourceCreated?: (r: { kind: string; marker: string; locationUrl?: string; notes?: string }) => Promise<void>;
  onResourceDeleted?: (r: { marker: string; ok: boolean; note?: string }) => Promise<void>;
  // CHE-100: shared across every journey of a run, seeded from Run.credentials-
  // Rejected so it survives a Workflow replay. Once true, the credential we hold
  // is known-bad: no further sign-in attempt is allowed and nothing behind that
  // login may be reported as the product's fault.
  // CHE-322: `rejected` is "any account was", `accounts` says which ones, so a
  // stale admin password stops the admin sign-in and nothing else. A bare
  // { rejected: true } (a row from before named accounts) means the default.
  credentials?: { rejected: boolean; accounts?: string[] };
  onCredentialRejected?: (signature: string, account: string) => Promise<void>;
  // CHE-129: the machine actions that actually ran since the last report_step.
  // Only navigate/click/fill go here, and only after every refusal gate has let
  // them through and Playwright has done the thing — a refused or errored call
  // never happened, so a replay must not redo it. The step handler drains this
  // into Step.actions.
  actionTrail?: RecordedAction[];
  // CHE-214: controls a fill or a click could not drive since the last
  // report_step. Drained there, where a step that blamed the product for one
  // becomes skipped / our_capability. Optional so a bare ToolEnv still builds;
  // absent = the coercion has nothing to read.
  undrivenControls?: UndrivenControl[];
  // CHE-171: every URL this run has actually SEEN published — the target, every
  // href on every page read, every URL a click or navigate landed on, the
  // survey's pages (CHE-132) and the known map's (CHE-133). Filled by the tools
  // themselves, never by the model. A 404 on a URL outside this set is a 404 on
  // an address nobody linked to: run #142's nav model typed
  // https://joblander.app/landing on its own, called the 404 "the documented
  // landing URL", and JOB-929 was filed on the customer's board off it. Keys
  // are knownUrlKey() strings. Optional so scripts still build a bare ToolEnv;
  // absent = the gate is off.
  knownUrls?: Set<string>;
  // CHE-193: the SELF_CHECK_HOSTS binding — extra hosts that count as ours
  // beside checkmyapp.dev (self-hosts.ts). Whether the target is ours is
  // decided from targetOrigin against that list; this only carries the list.
  selfCheckHosts?: string;
  // CHE-334: our own guard refusing the self-check since the last report_step
  // — the web half's 403 / read-only redirect after a click or navigate, or the
  // click gate refusing a control on our own host. Written by the tools, never
  // by the model; drained by report_step, where the step it belongs to becomes
  // not_applicable and stops counting toward its journey. Optional so a bare
  // ToolEnv still builds.
  selfCheckRefusals?: string[];
  // CHE-372: a password-protected store's storefront password (decrypted in
  // memory like testPassword), the run's state for it and the hook that
  // records it. Never a placeholder the model can type: the tools enter it on
  // the store's password page themselves (store-password.ts), and every tool
  // result goes through scrubSecrets, which redacts it.
  store?: StoreAccess;
  // CHE-372: the walk stood on the store's password page since the last
  // report_step — "refused": the store turned our password away; "missing":
  // the run holds none (both access); "undriven": we could not enter it, or
  // will not risk entering it again (our capability). Written by the tools,
  // drained by report_step (coerceStoreLocked).
  storeLocked?: "refused" | "missing" | "undriven";
}

// CHE-373: may this run navigate to, and type a test login on, this origin?
// The target's own, or one the owner listed. Compared as origins (scheme, host
// and port), never as hosts: a subdomain is not an allowed origin unless named.
// One of OUR hosts is never allowed this way, whatever was stored: the click
// gates that keep a self-check from spending money key on the target, so a
// customer's run let onto our product would walk it with none of them. The
// stored list was checked against the built-in hosts when it was saved; this
// is where the SELF_CHECK_HOSTS binding (staging, previews) is known.
export function isAllowedOrigin(
  env: Pick<ToolEnv, "targetOrigin" | "allowedOrigins" | "selfCheckHosts">,
  origin: string,
): boolean {
  const o = origin.toLowerCase();
  if (o === env.targetOrigin.toLowerCase()) return true;
  return Boolean(env.allowedOrigins?.includes(o)) && !isSelfUrl(o, env.selfCheckHosts);
}

function urlOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

// CHE-193: is this run checking CheckMyApp itself?
function isSelfTarget(env: Pick<ToolEnv, "targetOrigin" | "selfCheckHosts">): boolean {
  return isSelfUrl(env.targetOrigin, env.selfCheckHosts);
}

// CHE-334: remember that our own guard answered, for the step about to be
// reported. Only on our own hosts — a customer's refusal is never ours.
function noteSelfCheckRefusal(env: ToolEnv, evidence: string): void {
  if (!isSelfTarget(env)) return;
  (env.selfCheckRefusals ??= []).push(evidence);
}

// CHE-193: what the model is told when our own product refused the self-check
// — by a 403 on a mutating request, or by a server action redirecting back
// with ?self_check=read_only. Same text either way: the answer is the same.
function selfCheckRefusedText(verb: string, evidence: string): string {
  return (
    `${verb}, and the product refused the action (${evidence}): it is not available to ` +
    `this account. That is the correct answer, not a defect — do NOT report this control as ` +
    `broken or confusing, and do not try it again by another route. Report the step ` +
    `"skipped" with unverifiedReason "not_applicable" and move on.`
  );
}

// CHE-171: one spelling per address — lower-cased origin, path without a
// trailing slash, query kept, fragment dropped. Only http(s); anything else
// (mailto:, javascript:, an unparsable string) is null and never counts.
export function knownUrlKey(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.origin.toLowerCase()}${path}${u.search}`;
}

export function rememberUrls(env: Pick<ToolEnv, "knownUrls">, urls: Iterable<string>, base?: string): void {
  if (!env.knownUrls) return;
  for (const raw of urls) {
    const key = knownUrlKey(raw, base);
    if (key) env.knownUrls.add(key);
  }
}

// CHE-171: the set a walk or a discovery starts with. `published` may mix
// absolute URLs and bare paths ("/pricing"); paths resolve against the target.
export function knownUrlsFrom(targetUrl: string, published: Iterable<string> = []): Set<string> {
  const set = new Set<string>();
  const env = { knownUrls: set };
  rememberUrls(env, [targetUrl]);
  rememberUrls(env, published, targetUrl);
  return set;
}

function isKnownUrl(env: Pick<ToolEnv, "knownUrls">, url: string, base?: string): boolean {
  const key = knownUrlKey(url, base);
  return key !== null && Boolean(env.knownUrls?.has(key));
}

// CHE-129: what a browser can redo without a model. Inputs are the tool's own
// arguments (the fill value keeps its {{TEST_EMAIL}}/{{TEST_PASSWORD}}
// placeholders — the real value is substituted at execution time and is never
// written down), outcome is what the walk observed so a replay can tell
// whether it landed in the same place.
export type RecordedAction =
  | {
      kind: "navigate";
      url: string;
      outcome: { urlAfter: string; status: number | null };
    }
  | {
      kind: "click";
      role?: string;
      name?: string;
      selector?: string;
      // CHE-373: the embedded frame it acted in (frameKey), so a replay acts
      // there too instead of searching afresh. Absent = the page.
      frame?: string;
      surface?: { kind: "native_popup"; extensionId: string; targetId: string };
      outcome: { urlAfter: string; navigated: boolean | null; requests: number | null; mutations: number | null };
    }
  | {
      kind: "fill";
      label?: string;
      selector?: string;
      frame?: string;
      value: string;
      surface?: { kind: "native_popup"; extensionId: string; targetId: string };
      outcome: { urlAfter: string };
    };

function recordAction(env: ToolEnv, raw: RecordedAction): void {
  // CHE-372: the trail becomes Step.actions, a stored column. An address can
  // carry a secret (a form that submits by GET puts its fields in the query),
  // so every address in it is scrubbed like a tool result.
  const action: RecordedAction =
    raw.kind === "navigate"
      ? { ...raw, url: scrubSecrets(env, raw.url), outcome: { ...raw.outcome, urlAfter: scrubSecrets(env, raw.outcome.urlAfter) } }
      : { ...raw, outcome: { ...raw.outcome, urlAfter: scrubSecrets(env, raw.outcome.urlAfter) } } as RecordedAction;
  env.actionTrail?.push(action);
  env.extension?.recordPageAction(action);
}

// ─── CHE-214: a control our own hands could not drive ────────────────────────
//
// Run #159 typed into the "Add login & notes" notes field on our own /check
// page; Playwright's fill timed out after 8 s. The tool returned the bare
// string "Error: locator.fill: Timeout 8000ms exceeded", the model never
// reported a step for the attempt, and synthesis turned the absence into
// "Credential/notes field didn't accept input" — published, with a bottom line
// built on it. Checked by hand in a real Chrome minutes later: the accordion
// opens, the field takes a programmatic value, and typed characters land at
// the caret. The field was fine; our hands were not.
//
// A naked "Error:" is an invitation to interpret. Every other tool that cannot
// do its job says what the failure means and what to report — verify_links has
// UNREACHABLE_INSTRUCTION, the credential gates spell out "skipped /
// missing_access". This is the same for the hands, plus the machine half:
// the failure is recorded, and a step reported as a defect after one becomes
// skipped / our_capability at report time, whatever the model wrote.
export interface UndrivenControl {
  hand: "fill" | "click";
  /** The control as the model named it — a label, a name, or a selector. */
  target: string;
  /** Playwright's own word, trimmed. Machinery: never customer-facing. */
  reason: string;
}

// What the model is told. Tool output, not customer text, so it may name the
// machinery (CHE-190's UNREACHABLE_INSTRUCTION is the precedent).
export const UNDRIVEN_INSTRUCTION =
  "could not be driven from here — that says NOTHING about the control: a field or button we " +
  "cannot reach is our limitation, not a defect of the product. Do not report it broken, risky " +
  'or confusing, and never write that it "did not accept input" or "did nothing". Report the ' +
  'step "skipped" with unverifiedReason "our_capability", or continue with another path.';

// Playwright's vocabulary for "the element would not let me act on it". A
// failure that is NOT one of these (a closed page, a crashed browser) is a
// different animal and keeps the old bare error.
const UNDRIVABLE =
  /timeout .*exceeded|element is not (?:visible|enabled|editable|stable|attached)|not an? (?:<input>|editable)|intercepts pointer events|waiting for (?:locator|element)|strict mode violation/i;

function isUndrivable(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  return name === "TimeoutError" || UNDRIVABLE.test(message);
}

function recordUndriven(env: ToolEnv, hand: "fill" | "click", target: string, err: unknown): string {
  const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
  env.undrivenControls?.push({ hand, target, reason });
  console.warn(`[${hand}] could not drive ${JSON.stringify(target)}: ${reason}`);
  return `The ${target} ${UNDRIVEN_INSTRUCTION}`;
}

// Strip any occurrence of the real test credentials from text leaving the tool
// layer (network/console logs, tool results). The model only ever needs the
// placeholders — actual secret values must never reach context, transcript, or
// the persisted Step columns, even if the tested app echoes them.
export function scrubSecrets(env: ToolEnv, text: string): string {
  let out = text;
  // CHE-322: every account's values, not only the default's — an admin page
  // echoing the admin's email is the same leak as the default one echoing its.
  const accounts = (env.testAccounts ?? []).flatMap((a) => [a.password, a.email]);
  // Longest first, so a password that contains an email is redacted whole.
  const secrets = [env.testPassword, env.testEmail, ...accounts]
    .filter((s): s is string => Boolean(s))
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (secret && secret.length >= 3) {
      out = out.split(secret).join("[redacted]");
      out = out.split(encodeURIComponent(secret)).join("[redacted]");
    }
  }
  return scrubStorePassword(env, out);
}

// CHE-372: the store password, which a page or an address may echo back.
//
// A store password is often a plain word — "demo" on securify-demo.myshopify.com.
// Replaced wherever it occurs, it would rewrite the store's own address in
// every tool result and in the stored trail ("securify-[redacted].myshopify.com"),
// and the walk and every replay would navigate to an address that does not
// exist. So the target's host is never touched, a strong password is redacted
// wherever it stands, and a plain word only where it stands as a value: a
// parameter of a query or a fragment, which is how a form leaks one into an
// address. The value ends where nothing that can continue a value follows — a
// sentence's full stop included, since the model's own step text quotes
// addresses mid-sentence (review of this rule).
//
// Left alone on purpose: a plain word in running text ("the demo store"). It
// cannot be told from the word, and redacting it would rewrite the page.
const STORE_SUBSTRING_MIN = 8;

function scrubStorePassword(env: ToolEnv, text: string): string {
  const secret = env.store?.password;
  if (!secret) return text;
  // As written, percent-encoded, and the way a form writes a space ("+").
  const encoded = encodeURIComponent(secret);
  const forms = [...new Set([secret, encoded, encoded.replace(/%20/g, "+")])];
  let host = "";
  try {
    host = new URL(env.targetOrigin).host;
  } catch {
    /* no target host to protect */
  }
  const SHIELD = "\u0000store-host\u0000";
  let out = host ? text.split(host).join(SHIELD) : text;
  const strong = secret.length >= STORE_SUBSTRING_MIN && !/^[a-z]+$/i.test(secret);
  for (const form of forms) {
    if (strong) {
      out = out.split(form).join("[redacted]");
    } else {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`([?&#][^=&#\\s]*=)${escaped}(?![A-Za-z0-9_%~+-])`, "g"), "$1[redacted]");
    }
  }
  return host ? out.split(SHIELD).join(host) : out;
}

// ─── CHE-322: which account a placeholder names ───────────────────────────────
//
// {{TEST_EMAIL}} / {{TEST_PASSWORD}} are the default account, as they always
// were; {{TEST_EMAIL:admin}} / {{TEST_PASSWORD:admin}} are the account labelled
// admin. Labels are matched in their stored spelling (normalizeAccountLabel), so
// "Admin" typed by the model is the same account.

export interface AccountSecret {
  label: string;
  email?: string;
  password?: string;
}

const PLACEHOLDER = /\{\{TEST_(EMAIL|PASSWORD)(?::([^{}]*))?\}\}/g;

function placeholderLabel(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_ACCOUNT_LABEL;
  return normalizeAccountLabel(raw) ?? raw.trim();
}

/** The accounts a value's placeholders name, in order, each once. */
export function placeholderLabels(value: string): string[] {
  return [...new Set([...value.matchAll(PLACEHOLDER)].map((m) => placeholderLabel(m[2])))];
}

/** The account a label names on this run, or null when it has none by that name. */
export function accountFor(env: Pick<ToolEnv, "testEmail" | "testPassword" | "testAccounts">, label: string): AccountSecret | null {
  if (label === DEFAULT_ACCOUNT_LABEL) {
    return env.testEmail || env.testPassword ? { label, email: env.testEmail, password: env.testPassword } : null;
  }
  return env.testAccounts?.find((a) => a.label === label) ?? null;
}

/** Every account this run can sign in as, by label — what a refusal can offer instead. */
export function availableAccounts(env: Pick<ToolEnv, "testEmail" | "testPassword" | "testAccounts">): string[] {
  return [
    ...(env.testEmail && env.testPassword ? [DEFAULT_ACCOUNT_LABEL] : []),
    ...(env.testAccounts ?? []).filter((a) => a.email && a.password).map((a) => a.label),
  ];
}

/** Was THIS account turned away earlier in the run? */
export function accountRejected(credentials: ToolEnv["credentials"], label: string): boolean {
  if (!credentials?.rejected) return false;
  if (!credentials.accounts?.length) return label === DEFAULT_ACCOUNT_LABEL;
  return credentials.accounts.includes(label);
}

/**
 * Record a rejection of `label` in memory. True the first time only, so the
 * caller persists it once (CHE-100: one attempt per account, per run).
 */
export function markAccountRejected(env: Pick<ToolEnv, "credentials">, label: string): boolean {
  if (!env.credentials || accountRejected(env.credentials, label)) return false;
  // A bare { rejected: true } already stood for the default; keep saying so
  // once a second label joins it.
  const before = env.credentials.rejected && !env.credentials.accounts?.length ? [DEFAULT_ACCOUNT_LABEL] : (env.credentials.accounts ?? []);
  env.credentials.rejected = true;
  env.credentials.accounts = [...before, label];
  return true;
}

/**
 * Replace every placeholder with its account's value. `missing` lists the
 * accounts a placeholder named that this run does not have (or has only half
 * of) — the caller refuses rather than typing an empty string into a form.
 */
export function substituteCredentials(
  env: Pick<ToolEnv, "testEmail" | "testPassword" | "testAccounts">,
  value: string,
): { value: string; missing: string[] } {
  const missing = new Set<string>();
  const out = value.replace(PLACEHOLDER, (_whole, field: string, raw: string | undefined) => {
    const label = placeholderLabel(raw);
    const secret = field === "EMAIL" ? accountFor(env, label)?.email : accountFor(env, label)?.password;
    if (!secret) missing.add(label);
    return secret ?? "";
  });
  return { value: out, missing: [...missing] };
}

// The account in the model's words: a named one by its label, the default one
// as "the test account" — which is all it was called before there were others.
function accountPhrase(label: string): string {
  return label === DEFAULT_ACCOUNT_LABEL ? "the test account" : `the "${label}" test account`;
}

export interface ReportedStep {
  label: string;
  status: "ok" | "risky" | "confusing" | "broken" | "exposed" | "skipped";
  attempted: string;
  observed: string;
  consoleExcerpt?: string;
  networkExcerpt?: string;
  // CHE-83: only meaningful when status === "skipped".
  unverifiedReason?: "our_capability" | "missing_access" | "not_applicable";
  // CHE-198: which of our capabilities the step ran into, decided from the
  // model's own words and the machine trail before productizeStep cuts the
  // words (execution.ts onReportStep). Only set with our_capability.
  gapClass?: GapClass;
  // CHE-334: set by coerceSelfCheck403, never by the model — the step is our
  // own guard refusing the self-check. It is written not_applicable and does
  // not count toward its journey's status (countsTowardJourney).
  selfCheckRefused?: boolean;
  // CHE-334: the step met our own guard, refused or not (a step carrying the
  // product's own 5xx/exception beside the refusal keeps its status). The walk
  // reads it to gate its summary.
  selfCheckGuardSeen?: boolean;
}

export const BROWSER_TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate",
    description:
      "Navigate the browser to a URL. Call this to open pages. Returns final URL and HTTP status.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute or relative URL" } },
      required: ["url"],
    },
  },
  {
    name: "read_page",
    description:
      "Read a structured digest of the current page: title, headings, links, buttons, form fields, landmarks. An embedded frame of the target app on another origin follows as its own section, labelled FRAME <n> with its origin; other embedded frames are listed by address only. Call after navigation or any action that changes the page. Prefer this over screenshots for deciding what to do next.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "click",
    description:
      "Click an element. Identify it by role and accessible name (preferred) or CSS selector. The page is searched first, then each embedded frame of the target app in order; pass frame to act inside one FRAME section of read_page. Frames outside the target app are never acted in.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", description: 'ARIA role, e.g. "button", "link"' },
        name: { type: "string", description: "Accessible name (visible text/label)" },
        selector: { type: "string", description: "CSS selector fallback" },
        frame: { type: "string", description: 'Optional: the FRAME number from read_page (e.g. "1"), or part of the frame\'s name or URL' },
      },
    },
  },
  {
    name: "fill",
    description:
      "Fill an input. Use placeholders {{TEST_EMAIL}} and {{TEST_PASSWORD}} for the provided test credentials, or {{TEST_EMAIL:<label>}} / {{TEST_PASSWORD:<label>}} for a named test account — never ask for or invent real credentials. The page is searched first, then each embedded frame of the target app in order; pass frame to fill inside one FRAME section of read_page. Frames outside the target app are never acted in.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Field label, placeholder or accessible name" },
        selector: { type: "string", description: "CSS selector fallback" },
        value: { type: "string", description: "Text, or {{TEST_EMAIL}} / {{TEST_PASSWORD}}, or {{TEST_EMAIL:<label>}} / {{TEST_PASSWORD:<label>}}" },
        frame: { type: "string", description: 'Optional: the FRAME number from read_page (e.g. "1"), or part of the frame\'s name or URL' },
      },
      required: ["value"],
    },
  },
  {
    name: "screenshot",
    description:
      "Capture a screenshot of the current page as evidence. Returns a storage URL. Use at meaningful moments (step completed, something looks broken).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_network_log",
    description:
      "Return the recent network requests (method, URL, status) and console messages observed since the last call. Use to detect failing API calls, external services, and stack signals.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "verify_links",
    description:
      "Verify a batch of outbound links WITHOUT navigating: each URL is fetched " +
      "server-side and reported as OK or BROKEN with its status, or UNREACHABLE when " +
      "it could not be reached from here (a timeout, a connection error, a host that " +
      "refuses automated traffic) — UNREACHABLE says nothing about the link: report " +
      "that step skipped with unverifiedReason our_capability, never broken or risky. " +
      "YouTube links are checked via the oEmbed API, which returns an error for " +
      "deleted/private/unplayable videos — the definitive answer to 'do all these " +
      "video links work'. mailto: links are checked too — the address is validated, " +
      "which is the only thing about one that can be wrong from outside. Use for " +
      "link-heavy pages and for owner concerns about links; up to 60 URLs per call.",
    input_schema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Absolute http(s) or mailto: URLs" },
      },
      required: ["urls"],
    },
  },
  {
    name: "record_created",
    description:
      "Register a record you just created inside the target product (a story, an app, a job posting…). " +
      "Call it IMMEDIATELY after the creation succeeds, before doing anything else — this ledger is what " +
      "guarantees the record gets cleaned up even if the run dies later. Every created record must carry " +
      "the run's test marker in a visible field (name/title), and you must delete it before the journey ends.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", description: 'What it is in the product\'s own words, e.g. "story"' },
        marker: { type: "string", description: "The exact marker text you typed into it" },
        locationUrl: { type: "string", description: "URL where it can be found again" },
        notes: { type: "string", description: "Anything cleanup needs to know" },
      },
      required: ["kind", "marker"],
    },
  },
  {
    name: "record_deleted",
    description:
      "Confirm that a record you created has been removed. Call it after you deleted it AND verified it is " +
      "gone (it left the list, or its URL no longer resolves). If deletion failed or the product offers no " +
      "way to delete, call this with ok=false and say why — that is both a finding about the product and " +
      "something we must clean up.",
    input_schema: {
      type: "object",
      properties: {
        marker: { type: "string", description: "The marker of the record you created" },
        ok: { type: "boolean", description: "true only if you verified it is actually gone" },
        note: { type: "string", description: "How you verified it, or why it could not be removed" },
      },
      required: ["marker", "ok"],
    },
  },
  {
    name: "report_step",
    description:
      "Record one completed journey step with its outcome. Call after each meaningful step while walking a journey. status: ok (works) / risky (works but fragile or abusable) / confusing (user would hesitate) / broken (does not work) / exposed (security issue) / skipped (could not verify). When status is skipped you MUST set unverifiedReason: our_capability if OUR checker could not do it (new-tab links you could not follow, OAuth popups, MFA codes, camera/mic, anything about our own machinery), missing_access if the owner has not given us what is needed (test credentials, a URL), not_applicable if it is deliberately out of scope. our_capability opens a high-priority ticket on OUR board — that is how the checker gets better, so classify honestly.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: 'Short step label, e.g. "Click Get started"' },
        status: {
          type: "string",
          enum: ["ok", "risky", "confusing", "broken", "exposed", "skipped"],
        },
        attempted: { type: "string", description: "What you tried to do" },
        observed: { type: "string", description: "What actually happened" },
        consoleExcerpt: { type: "string" },
        networkExcerpt: { type: "string" },
        unverifiedReason: {
          type: "string",
          enum: ["our_capability", "missing_access", "not_applicable"],
          description: "Required when status is skipped — see the description above.",
        },
      },
      required: ["label", "status", "attempted", "observed"],
    },
  },
  {
    name: "write_e2e_test",
    description:
      "Persist an executable Playwright spec (TypeScript) that formalizes the journey you just walked. Use @playwright/test, role-based locators (getByRole/getByLabel), BASE_URL from process.env.TARGET_URL. The spec must pass against the app in its current state.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: 'Spec title, e.g. "Submit a check"' },
        content: { type: "string", description: "Full TypeScript source of the spec file" },
      },
      required: ["title", "content"],
    },
  },
];

// CHE-169: the same tool list with `look` on the screenshot tool. A separate
// list rather than a flag on BROWSER_TOOLS so that with the harness off the
// request the model receives — tools included, which sit at the head of the
// prompt-cache prefix — is byte for byte what it is today.
const SCREENSHOT_TOOL_VISION_ON_DEMAND: Anthropic.Tool = {
  name: "screenshot",
  description:
    "Capture a screenshot of the current page as evidence. Returns a storage URL. Use at meaningful " +
    "moments (step completed, something looks broken). Set look=true when you need to SEE the page " +
    "to judge a step — costs more, use at judgment moments (an overlay, a media call, something that " +
    "reads wrong in the digest).",
  input_schema: {
    type: "object",
    properties: {
      look: {
        type: "boolean",
        description: "true to have the image shown to you in the result, not just stored",
      },
    },
  },
};

const BROWSER_TOOLS_VISION_ON_DEMAND: Anthropic.Tool[] = BROWSER_TOOLS.map((t) =>
  t.name === "screenshot" ? SCREENSHOT_TOOL_VISION_ON_DEMAND : t,
);

const EXTENSION_TOOLS: Anthropic.Tool[] = [
  ...[
    ["extension_open", "Open the installed extension through Chrome's native action on the owned target tab; returns its current controls."],
    ["extension_read", "Read the native popup and obtain fresh control references. References are consumed after one action."],
    ["extension_screenshot", "Capture a redacted screenshot of the native extension popup."],
    ["extension_close", "Close the native popup and return to its exact target tab for page tools."],
    ["extension_audio_preflight", "Validate the synthetic microphone before a session. Run with the native popup closed."],
    ["extension_account_preflight", "Read the test account's visible minute balance and session history before a paid session. Uses the saved test credentials, with the native popup closed."],
    ["extension_start_session", "Start the extension session with an owned deadline and verified local Stop sequence. Requires explicit owner permission, a test account and audio preflight. Open the native popup first."],
    ["extension_prepare_practice", "Prepare the practice page with the selected coach and language before any session. Requires account preflight and the native popup closed."],
    ["extension_start_practice", "Start the prepared practice with its microphone on and an owned Stop deadline. In a combined scenario start the extension first, then start practice. Requires account and audio preflight and session permission."],
    ["extension_observe_session", "Wait up to 25 seconds for the owned session and read its new question/answer, Stop and minute accounting. Repeat until complete. The local deadline ends and confirms the session automatically, allowing the full allotted duration and post-Stop balance check."],
    ["extension_stop_sessions", "Stop every session owned by this attempt through its local confirmation sequence. Browser disposal is separate."],
  ].map(([name, description]): Anthropic.Tool => ({ name, description, input_schema: { type: "object", properties: name === "extension_screenshot" ? { look: { type: "boolean", description: "Attach the redacted image for visual inspection when vision is available." } } : {}, required: [] } })),
  { name: "extension_click", description: "Click a fresh native popup control by its observed reference. Session and purchase controls are guarded.", input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "extension_fill", description: "Fill an observed native popup field. Use {{TEST_EMAIL}} / {{TEST_PASSWORD}} for credentials; substitution is confined to the installed extension.", input_schema: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" } }, required: ["ref", "value"] } },
];

export function browserToolsFor(env: Pick<ToolEnv, "visionTriggers" | "extension">): Anthropic.Tool[] {
  const base = env.visionTriggers ? BROWSER_TOOLS_VISION_ON_DEMAND : BROWSER_TOOLS;
  return env.extension ? [...base, ...EXTENSION_TOOLS.filter(tool => extensionToolAllowed(env.extension!.identity, tool.name))] : base;
}

// ─── Executor ────────────────────────────────────────────────────────────────

// CHE-372: every result leaves through scrubSecrets — not only the network log
// and the fill value. A page can echo a secret anywhere (a URL, a heading, an
// error), and what this returns goes to the model, the transcript and the run.
export async function executeTool(
  env: ToolEnv,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  return scrubSecrets(env, await executeToolUnscrubbed(env, name, input));
}

async function executeToolUnscrubbed(
  env: ToolEnv,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    const extensionResult = await env.extension?.tool(env, name, input);
    if (extensionResult !== undefined) return extensionResult;
    switch (name) {
      case "navigate":
        return await navigate(env, String(input.url));
      case "read_page":
        return await readPage(env);
      case "click":
        return await click(env, input);
      case "fill":
        return await fill(env, input);
      case "screenshot":
        return await screenshot(env, input);
      case "get_network_log":
        return scrubSecrets(env, drainLogs(env));
      case "verify_links":
        return await verifyLinks(input, env.targetOrigin, env.allowedOrigins);
      case "record_created": {
        if (!env.onResourceCreated) return "No ledger available — do not create records in this run.";
        const marker = String(input.marker ?? "");
        if (env.testMarker && !marker.includes(env.testMarker)) {
          return (
            `Refused: the record must carry this run's marker "${env.testMarker}" in a visible field. ` +
            `Cleanup may only ever remove records carrying it — a record without it cannot be safely removed. ` +
            `Rename the record to include the marker, then call record_created again.`
          );
        }
        await env.onResourceCreated({
          kind: String(input.kind ?? "record"),
          marker,
          locationUrl: input.locationUrl ? String(input.locationUrl) : undefined,
          notes: input.notes ? String(input.notes) : undefined,
        });
        return "Recorded. You MUST delete this record before the journey ends, then call record_deleted.";
      }
      case "record_deleted": {
        if (!env.onResourceDeleted) return "No ledger available.";
        await env.onResourceDeleted({
          marker: String(input.marker ?? ""),
          ok: Boolean(input.ok),
          note: input.note ? String(input.note) : undefined,
        });
        return input.ok
          ? "Cleanup recorded."
          : "Recorded as NOT removed — report this as a finding (a user who creates this cannot remove it).";
      }
      case "report_step": {
        const step = input as unknown as ReportedStep;
        // CHE-372: the step's words become stored columns; a secret the page
        // showed the model never lands in one.
        for (const key of ["label", "attempted", "observed", "consoleExcerpt", "networkExcerpt"] as const) {
          if (typeof step[key] === "string") step[key] = scrubSecrets(env, step[key] as string);
        }
        // The model occasionally invents enum values — coerce to the schema.
        const valid = ["ok", "risky", "confusing", "broken", "exposed", "skipped"];
        if (!valid.includes(step.status)) step.status = "confusing";
        // CHE-334: only coerceSelfCheck403 may say a step was our own guard.
        delete step.selfCheckRefused;
        delete step.selfCheckGuardSeen;
        // CHE-171 first: a step it rewrites is already skipped/not_applicable
        // by the time classifyUnverified looks, and that one leaves a step
        // with a reason alone.
        coerceUnpublished404(step, env);
        // CHE-193: on our own hosts a refused create/mark is not a defect.
        coerceSelfCheck403(step, env);
        // CHE-214: a defect reported after a control our own hands could not
        // drive is our gap. Before classifyUnverified, which leaves an
        // already-reasoned skipped step alone.
        coerceUndrivenControl(step, env);
        if (env.undrivenControls) env.undrivenControls.length = 0;
        // CHE-372: a step on the store's locked password page is about access
        // or our own hands, never the store. Before classifyUnverified, which
        // leaves a reasoned skipped step alone.
        coerceStoreLocked(step, env);
        classifyUnverified(step);
        // CHE-190 after both: a risky step is never judged (CHE-169) and never
        // classified above, so a link we could not reach had no gate at all.
        coerceUnreachable(step, env);
        // CHE-180: the step leaves here with the model's words intact — the
        // judge (CHE-169) rules on them. productizeStep runs in the walk's
        // onReportStep, after the judge and before the row is written.
        await env.onReportStep?.(step);
        return "Step recorded.";
      }
      case "write_e2e_test": {
        await env.onWriteTest?.({
          title: String(input.title),
          content: String(input.content),
        });
        return "Spec saved.";
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    if (err instanceof ExtensionRuntimeError) throw err;
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function navigate(env: ToolEnv, url: string): Promise<string> {
  const target = new URL(url, env.page.url() || undefined);
  // Hard origin guard: the system prompt says "stay on origin", but a malicious
  // page could instruct the model to navigate off-site and exfiltrate creds.
  // CHE-373: the origins the owner listed for this app are part of the target.
  if (!isAllowedOrigin(env, target.origin)) {
    const others = env.allowedOrigins?.length ? ` or the origins allowed for it (${env.allowedOrigins.join(", ")})` : "";
    return `Refused: ${target.origin} is outside the target app (${env.targetOrigin})${others}. Stay on the target.`;
  }
  const logBefore = env.networkLog.length;
  let res = await env.page.goto(target.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  // Give client JS a real chance to hydrate: clicking a not-yet-interactive
  // button is the #1 source of false "broken" findings on React/Next targets.
  await waitForHydration(env.page, 3_000);
  // CHE-372: a password-protected store answered with its /password page. The
  // store password is entered here, by code, before anything is recorded — so
  // the trail says where the navigation really ended (the product page behind
  // the gate, or the gate itself when the store refused us), and the model
  // never meets the gate unless the password we hold was turned away.
  const store = await passStoreGate(env);
  // The store sends an unlocked visitor to its home page, not to the address
  // they asked for, and `res` is still the gate's answer. A person would go on
  // to that address, and so does the walk: the status everything below reads
  // (the unpublished-404 guard among it) is the destination's, never the
  // gate's 200 — and "/cart" does not read as a redirect to "/".
  if (store === "unlocked") {
    res = await env.page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
    await waitForHydration(env.page, 3_000);
  }
  const status = res?.status() ?? null;
  // Resolved, not as the model typed it: a relative URL only means something
  // next to the page it was typed on, and a replay starts from a blank one.
  recordAction(env, {
    kind: "navigate",
    url: target.toString(),
    outcome: { urlAfter: env.page.url(), status },
  });
  const gateNote = storeGateNote(store);
  if (gateNote) {
    console.warn(`[navigate] store password page (${store}): ${scrubSecrets(env, env.page.url())}`);
    return `Navigated to ${env.page.url()} (status ${status ?? "?"}). ${gateNote}`;
  }
  // CHE-171: a 404/410 on an address nothing has published is not a fact
  // about the product — no user arrives there. Decided against the set, not
  // the model's story about the URL ("the documented landing URL" was the
  // story in run #142). The refusal is the answer; there is nothing on such a
  // page for the CHE-169 look to judge, and the address is NOT remembered,
  // so typing it twice does not make it real.
  if ((status === 404 || status === 410) && env.knownUrls && !isKnownUrl(env, target.toString())) {
    console.warn(`[navigate] ${status} on an unpublished address: ${scrubSecrets(env, target.toString())}`);
    return (
      `Navigated to ${env.page.url()} (status ${status}). This address is not linked from any ` +
      `page you have read or from the site's own map — a 404 here says nothing about the ` +
      `product; do not report it as broken. If you meant a real page, find its link in the ` +
      `page digest first.`
    );
  }
  // Where the navigation ended up is published by definition (a redirect target
  // is the product's own choice), unless the product said the address is gone.
  if (status !== 404 && status !== 410) rememberUrls(env, [env.page.url()]);
  // CHE-193: a server action on our own product answered the self-check by
  // redirecting back with ?self_check=read_only. Not a page to judge.
  if (isSelfTarget(env) && isSelfCheckRedirect(env.page.url(), env.selfCheckHosts)) {
    console.warn(`[navigate] self-check refused by the product: ${scrubSecrets(env, env.page.url())}`);
    noteSelfCheckRefusal(env, `redirected back as read-only: ${env.page.url()}`);
    return selfCheckRefusedText(`Navigated to ${env.page.url()}`, "redirected back as read-only");
  }
  // CHE-169: a page that answered with an error, or loaded a media/WebRTC
  // surface, is a place where the digest alone has misled the walk before.
  const looked = await lookIfJudgmentMoment(env, {
    requests: env.networkLog.slice(logBefore),
    status,
  });
  return `Navigated to ${env.page.url()} (status ${status ?? "?"})${looked}`;
}

// ─── CHE-372: the store's password page ──────────────────────────────────────

// What the model is told when the store keeps us on its password page because
// the store password we hold was turned away. Tool output, not customer text.
export const STORE_PASSWORD_REFUSED =
  "This is the store's password page, and the store password we hold was not accepted, so nothing " +
  "behind it can be checked this run. That is the store refusing a wrong password — correct " +
  "behaviour, not a defect. Do NOT type anything into this password form. Report this step " +
  '"skipped" with unverifiedReason "missing_access" and say that the store password was not accepted.';

// The observed sentence a step on the locked store is written with
// (coerceStoreLocked). Customer-facing: an ask for access, nothing about us.
export const STORE_LOCKED_OBSERVED =
  "The store password was not accepted, so the store behind its password page could not be checked this run.";

// What the model is told when we hold a store password and could not enter it
// (the field would not fill, the form would not submit, no field to fill).
// Our hands, not the store (CHE-214's rule for an undriven control).
export const STORE_UNLOCK_UNDRIVEN =
  "This is the store's password page. The store password we hold could not be entered here — " +
  "that is our limitation and says nothing about the store. Do not judge this page, and do not " +
  'report it as broken, risky or confusing. Report this step "skipped" with unverifiedReason "our_capability".';

// The observed sentence for a step we could not take past the gate ourselves.
// Customer-facing coverage language; the gap is ours and goes to our board.
export const STORE_UNDRIVEN_OBSERVED =
  "We could not get past the store's password page this run, so the store behind it was not checked.";

// What the model is told on the gate when the run holds no store password.
export const STORE_PASSWORD_MISSING =
  "This is the store's password page, and no store password was given for this run, so nothing " +
  "behind it can be checked. That is the store being password-protected, not a defect. Do NOT type " +
  'anything into this password form. Report this step "skipped" with unverifiedReason ' +
  '"missing_access" and say that the store password is needed.';

// The observed sentence for a step on a gate we hold no password for.
// Customer-facing: the ask for access CLAUDE.md rule 2 permits, by name.
export const STORE_MISSING_OBSERVED =
  "This store is password-protected and no store password was given, so the store behind its password page could not be checked this run.";

async function passStoreGate(env: ToolEnv): Promise<UnlockOutcome> {
  const outcome = await unlockStoreGate(env.page, env.targetOrigin, env.store ?? {});
  if (outcome === "unlocked") await waitForHydration(env.page, 3_000);
  if (storeRefused(outcome)) env.storeLocked = "refused";
  if (outcome === "no_password") env.storeLocked = "missing";
  if (storeUndriven(outcome)) env.storeLocked = "undriven";
  return outcome;
}

// What the model is told for an outcome that leaves it on the gate; null when
// the gate is behind us or was never there.
function storeGateNote(outcome: UnlockOutcome): string | null {
  if (storeRefused(outcome)) return STORE_PASSWORD_REFUSED;
  if (outcome === "no_password") return STORE_PASSWORD_MISSING;
  if (storeUndriven(outcome)) return STORE_UNLOCK_UNDRIVEN;
  return null;
}

/**
 * A step reported while the walk stood on the store's locked password page is
 * about the gate and nothing else: whatever the model called it — "ok"
 * included, since the one page that rendered was the lock, not the product —
 * it is written skipped. With the store password turned away or missing,
 * missing_access with the sentence that names the input; with a password we
 * could not (or would not risk) entering, our_capability — a gap on our board,
 * never the store's defect. A step that already carries the right reason keeps
 * its own words. Drains the flag.
 */
export function coerceStoreLocked(step: ReportedStep, env: Pick<ToolEnv, "storeLocked">): void {
  const locked = env.storeLocked;
  if (!locked) return;
  env.storeLocked = undefined;
  const reason = locked === "undriven" ? "our_capability" : "missing_access";
  if (step.status === "skipped" && step.unverifiedReason === reason) return;
  step.status = "skipped";
  step.unverifiedReason = reason;
  if (locked === "missing") {
    step.observed = STORE_MISSING_OBSERVED;
  } else if (locked === "refused") {
    step.observed = STORE_LOCKED_OBSERVED;
  } else {
    step.observed = STORE_UNDRIVEN_OBSERVED;
    step.gapClass = "undriven_control";
  }
}

// ─── CHE-169: vision on demand ───────────────────────────────────────────────
// The JPEG the model sees. One capture, shared by the screenshot tool (CHE-70),
// the on-demand triggers below and the judge (judge.ts): password fields are
// blurred first, the quality matches the CHE-70 setting so the token cost per
// image is the one COSTS.md measured.
export async function captureJpeg(page: Pick<Page, "screenshot" | "evaluate">): Promise<string> {
  await blurPasswordFields(page);
  const jpeg = await page.screenshot({ fullPage: false, type: "jpeg", quality: 55 });
  return Buffer.from(jpeg).toString("base64");
}

// Park a JPEG for the core loop to attach to the current tool's result, and
// say why. Best-effort: a failed capture costs the model its look, never the
// step. The returned suffix tells the model the image is there — a text-only
// walk has no reason to expect one.
async function attachLook(env: ToolEnv, reason: string): Promise<string> {
  if (!env.visionTriggers) return "";
  try {
    env.pendingScreenshotJpegB64 = await captureJpeg(env.page);
    console.log(`[harness] screenshot attached: ${reason}`);
    return " The page as it looks right now is attached to this result — look at it before judging.";
  } catch (err) {
    console.warn(`[harness] screenshot capture failed (${reason}): ${err instanceof Error ? err.message : err}`);
    return "";
  }
}

// An error response in the requests the last action produced: a 429 from
// anywhere (CLAUDE.md rule 3: our own volume, and the recovery UX is what the
// model must judge by eye), or a 4xx/5xx from the target itself. The CHE-100
// credential rejection is excluded — it has its own path and its own text.
export function errorResponseIn(entries: string[], targetOrigin: string, allowedOrigins: readonly string[] = []): string | null {
  for (const line of entries) {
    const m = line.match(/^([A-Z]+)\s+(\S+)\s+→\s+(\d{3})$/);
    if (!m) continue;
    const [, , url, status] = m;
    const code = Number(status);
    if (code === 429) return line;
    if (code < 400) continue;
    if (credentialRejection([line])) continue;
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch {
      continue;
    }
    if (origin === targetOrigin || allowedOrigins.includes(origin)) return line;
  }
  return null;
}

// Signs of a media or WebRTC surface: a <video>/<audio> element, or inline
// script that reaches for the microphone/camera or a peer connection. Kept as
// a plain string so esbuild cannot inject helpers into it (see
// MUTATION_COUNTER_SCRIPT). Scripts loaded by URL have no text here, so this
// is best-effort by design — the element check carries most real cases.
const MEDIA_SIGNAL_SCRIPT = `(() => {
  try {
    if (document.querySelector('video, audio')) return true;
    for (const s of Array.from(document.scripts)) {
      const t = s.textContent || '';
      if (/getUserMedia|RTCPeerConnection/.test(t)) return true;
    }
  } catch (e) {}
  return false;
})()`;

async function mediaSignals(env: ToolEnv): Promise<boolean> {
  const found = await env.page.evaluate(MEDIA_SIGNAL_SCRIPT).catch(() => false);
  return found === true;
}

// After navigate/click: attach a look when the requests carried an error or
// the page shows media signals. One image at most per action.
async function lookIfJudgmentMoment(
  env: ToolEnv,
  action: { requests: string[]; status?: number | null },
): Promise<string> {
  if (!env.visionTriggers) return "";
  const err =
    errorResponseIn(action.requests, env.targetOrigin, env.allowedOrigins) ??
    (action.status != null && action.status >= 400 ? `HTTP ${action.status} on navigate` : null);
  if (err) return attachLook(env, `error response (${err})`);
  if (await mediaSignals(env)) return attachLook(env, "media/WebRTC signals on the page");
  return "";
}

// Hydration gate before interacting: full load, then a double-rAF tick (lets
// the framework flush the effects that attach event listeners), then a capped
// network-idle wait (hydration chunks still in flight). Every wait is
// best-effort — a chatty page must not stall the walk.
// CHE-373: a frame hydrates on its own schedule, so the gate runs in whichever
// document the control lives in — the page, or the frame it was found in.
async function waitForHydration(page: Pick<Page, "waitForLoadState" | "evaluate">, networkIdleMs: number): Promise<void> {
  await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => {});
  await page
    .evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    .catch(() => {});
  if (networkIdleMs > 0) {
    await page.waitForLoadState("networkidle", { timeout: networkIdleMs }).catch(() => {});
  }
}

interface ReactionSnapshot {
  net: number;
  mut: number;
  url: string;
  // CHE-373: set when the control is inside a frame. `mut` is then the frame's
  // counter and `hostMut` the page's.
  frameUrl?: string;
  hostMut?: number;
}

const mutationCount = (doc: Page | Frame) =>
  doc.evaluate("window.__cmaMutations || 0").then((n) => Number(n) || 0, () => 0);

// CHE-392: text that appeared in a document, by running number (see
// MUTATION_COUNTER_SCRIPT). A piece longer than this is a region re-rendering,
// not a message — and stays on the page for read_page to find.
const APPEARED_MAX_CHARS = 200;
const APPEARED_MAX_ITEMS = 6;

// Starts the watch in one document and returns where its log stands.
const appearedMark = (doc: Page | Frame) =>
  doc.evaluate("window.__cmaWatch ? window.__cmaWatch() : 0").then((n) => Number(n) || 0, () => 0);

const appearedAfter = (doc: Page | Frame, mark: number): Promise<string[]> =>
  doc
    .evaluate(`(window.__cmaAppeared || []).filter((e) => e.n > ${mark}).map((e) => e.t)`)
    .then((list) => (Array.isArray(list) ? list.map(String) : []), () => []);

// What a click made the page say, as one sentence for the model — or "" when
// it said nothing new. The last few pieces win: a confirmation comes after the
// spinner that preceded it.
export function appearedSentence(texts: string[]): string {
  const unique = texts.filter((t, i) => t && texts.indexOf(t) === i);
  if (!unique.length) return "";
  const quoted = unique.slice(-APPEARED_MAX_ITEMS).map((t) => JSON.stringify(t)).join(", ");
  return (
    ` Text that appeared on the page right after the click: ${quoted}.` +
    ` It may be gone again by the next read — a confirmation shown briefly still counts as shown.`
  );
}

// CHE-373: the mutation counters of every document a click can move. A click
// inside an embedded app changes the frame's DOM — or, when the app talks to
// its host (postMessage, a host-rendered modal), only the page's. Counted in
// one document alone, either reads as "did not react AT ALL": our blindness,
// written up as their dead button.
async function snapshotReaction(env: ToolEnv, frame?: Frame | null): Promise<ReactionSnapshot> {
  const net = env.networkLog.length;
  const url = env.page.url();
  if (!frame) return { net, mut: await mutationCount(env.page), url };
  const [mut, hostMut] = await Promise.all([mutationCount(frame), mutationCount(env.page)]);
  return { net, mut, url, frameUrl: frame.url(), hostMut };
}

interface Reaction {
  requests: number;
  mutations: number;
  navigated: boolean;
}

// Let the page settle after an interaction, then measure what it did: network
// requests, DOM mutations, navigation. Navigation resets the mutation counter
// (fresh document), so it is reported as its own definitive signal.
async function settleAndMeasure(env: ToolEnv, before: ReactionSnapshot, frame?: Frame | null): Promise<Reaction> {
  await env.page.waitForLoadState("domcontentloaded").catch(() => {});
  await env.page.waitForTimeout(1_200);
  const after = await snapshotReaction(env, frame);
  const pageNavigated = after.url !== before.url;
  const navigated = pageNavigated || after.frameUrl !== before.frameUrl;
  // A fresh document starts its counter at zero, so after a navigation its
  // whole count is the reaction.
  const delta = (now: number, then: number, fresh: boolean) => (fresh ? now : Math.max(now - then, 0));
  const hostMutations = frame ? delta(after.hostMut ?? 0, before.hostMut ?? 0, pageNavigated) : 0;
  return {
    requests: Math.max(after.net - before.net, 0),
    mutations: delta(after.mut, before.mut, navigated) + hostMutations,
    navigated,
  };
}

const isInert = (r: Reaction) => r.requests === 0 && r.mutations === 0 && !r.navigated;

// CHE-100: an auth endpoint answering 401/403 to a credential we submitted is
// the product working CORRECTLY — refusing bad input. Read as a machine fact
// from the request log, never from how the page phrased it: the phrasing is
// precisely what we got wrong before, when "Invalid email or password" was
// reported as a broken login and cost a customer two false tickets.
// Segment-bounded so /api/authors/12 is not mistaken for an auth route, but
// tolerant of the shapes providers actually ship: Clerk posts to
// /v1/client/sign_ins, others to /auth/login, /api/session, /oauth/token.
const AUTH_PATH =
  /(^|[/_-])(auth|log[-_]?in|sign[-_]?in|session|token|oauth|identity)s?([/_-]|$|[?.])/i;
// Narrow on purpose. Once the credential is known-bad the whole run must stop
// trying, but "continue" and "submit" appear all over a product and blocking
// them would quietly cost coverage everywhere else.
const SIGN_IN_LABEL = /\b(log ?in|sign ?in|log-in|sign-in)\b/i;

export function credentialRejection(entries: string[]): string | null {
  for (const line of entries) {
    const m = line.match(/^([A-Z]+)\s+(\S+)\s+→\s+(\d{3})$/);
    if (!m) continue;
    const [, method, url, status] = m;
    // A rejected GET is an unauthenticated page read (a guest hitting a
    // session check), not a sign-in we attempted.
    if (method === "GET" || (status !== "401" && status !== "403")) continue;
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      /* relative or malformed — match against the raw string */
    }
    if (!AUTH_PATH.test(path)) continue;
    return `${method} ${path} → ${status}`;
  }
  return null;
}

// CHE-37: on Browser Rendering, clicks that work in every real browser come
// back inert (0 requests). Strategy ladder, escalating only while the page
// shows ZERO reaction (no requests, no DOM mutations, no navigation):
//   1. locator.click — trusted pointer sequence with full actionability checks
//      (scroll into view, visible, stable, receives events). Always first.
//   2. form.requestSubmit(button) — when the target is a submit button whose
//      trusted click was inert: fires a real cancelable `submit` event, so
//      framework onSubmit handlers run exactly as if the user submitted.
//   3. synthetic pointer/mouse event sequence via dispatchEvent — untrusted
//      events, labeled as such; last resort for listeners that ignore the
//      trusted click in this environment.
// The result text records WHICH strategy produced a reaction, so transcripts
// (and the synthesis pass) can see when only a fallback worked.
// Buttons that leave state behind. Deterministic refusal beats instruction:
// run #108 created a real app during discovery, where the prompt had already
// said read-only — and never ledgered it, so cleanup could not see it either.
const CREATE_VERBS =
  /\b(create|register|sign ?up|save|add|publish|post|submit|send|order|buy|subscribe|book|invite|start watching|place order)\b/i;
// Submits that only read: never blocked.
const SAFE_SUBMITS = /\b(search|filter|apply filter|log ?in|sign ?in|continue|next|show|find|preview|refresh)\b/i;

// Controls that flip the state of something that ALREADY exists — someone
// else's record, not ours. Refused in every mode, including runs allowed to
// create: permission to add a test record was never permission to resume a
// paused subscription, cancel a plan or re-enable a watch. Our own self-check
// re-enabled a watch its owner had paused (CHE-98) and quietly spent $1.26
// re-checking a domain nobody wanted checked.
const STATE_TOGGLE_VERBS =
  /\b(enable|disable|resume|reactivate|activate|deactivate|pause|unpause|cancel|upgrade|downgrade|subscribe|unsubscribe|renew|restore|archive|revoke|start watching|turn (on|off))\b/i;

// CHE-193: controls on OUR OWN product that act on real users' data. The
// self-check of 2026-09-05 (run #146) pressed "Re-check now" on a stranger's
// public verdict page and created two real runs (#147, #148), then pressed
// "Looks right ✓" and graded a stranger's verdict. None of these labels is a
// create or a toggle in the CREATE_VERBS / STATE_TOGGLE_VERBS sense, so a new
// list, applied only when the target is one of our hosts (self-hosts.ts) — on
// a customer's app "Export" or "Check now" is theirs to have pressed. The web
// half answers 403 to the same actions when the self-check header is present;
// this gate keeps the walk from even asking. The list is the ticket's: the $1
// check, a re-check, the verdict lens ("Looks right", "Something's off",
// "That's fine", "Mark as fixed", "Dispute"), tickets and exports. "Enable
// Daily Watch" is caught by STATE_TOGGLE_VERBS, in every mode.
export const SELF_HOST_GUARDED_VERBS =
  /\b(re-?check|check now|run check|run (this one|it|one) now|run now|looks right|something'?s off|that'?s fine|mark as|dispute|file ticket|create ticket|export)\b/i;

async function click(env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  const label = [input.name, input.selector].filter(Boolean).map(String).join(" ");
  if (label && SELF_HOST_GUARDED_VERBS.test(label) && isSelfTarget(env)) {
    console.warn(`[click] refused self-host guarded click: ${label}`);
    noteSelfCheckRefusal(env, `click gate: ${label}`);
    return (
      `Refused: "${label}" acts on real data of this product's users — a check that costs ` +
      `money, a verdict that belongs to someone else, a ticket on someone's board. That is ` +
      `never ours to press. Confirm the control is present and reachable, report the step ` +
      `"skipped" with unverifiedReason "not_applicable", and say in the step that acting on ` +
      `it would have changed another user's data.`
    );
  }
  // CHE-100: five attempts with a stale password locked a customer's account
  // and refused a real user. One rejection is the whole answer for the run.
  // CHE-322: per account — the one whose credentials are in the form now.
  const signingInAs = env.activeAccount ?? DEFAULT_ACCOUNT_LABEL;
  if (label && SIGN_IN_LABEL.test(label) && accountRejected(env.credentials, signingInAs)) {
    console.warn(`[click] refused repeat sign-in as "${signingInAs}" after credential rejection: ${label}`);
    return (
      `Refused: the credential we hold for ${accountPhrase(signingInAs)} was already rejected by ` +
      `this product's auth endpoint earlier in this run. Trying again cannot succeed and repeated ` +
      `failures lock real accounts. Report this step "skipped" with unverifiedReason ` +
      `"missing_access" and move on to what can be checked without that account. Nothing behind ` +
      `this login is verifiable as that account this run, and none of it may be described as failing.`
    );
  }
  if (label && STATE_TOGGLE_VERBS.test(label) && !SAFE_SUBMITS.test(label)) {
    console.warn(`[click] refused state-toggling click: ${label}`);
    // CHE-334: on our own host this refusal is the self-check guard, like the
    // one above; on a customer's app it is not ours to note.
    noteSelfCheckRefusal(env, `click gate: ${label}`);
    return (
      `Refused: "${label}" would change the state of something that already exists in this ` +
      `product — a subscription, a schedule, a setting someone deliberately set. That is never ` +
      `ours to touch, whatever this run is allowed to create. Confirm the control is present ` +
      `and reachable, report the step "skipped" with unverifiedReason "not_applicable", and ` +
      `say in the step that acting on it would have changed the owner's own state.`
    );
  }
  if (!env.writeAllowed && label && CREATE_VERBS.test(label) && !SAFE_SUBMITS.test(label)) {
    console.warn(`[click] refused create-shaped click in read-only run: ${label}`);
    noteSelfCheckRefusal(env, `click gate: ${label}`);
    return (
      `Refused: "${label}" looks like it would create or send something, and this run is read-only ` +
      `(the owner has not enabled record creation). You have confirmed the form accepts input — ` +
      `that is the whole check here. Report this step "skipped" with unverifiedReason ` +
      `"not_applicable" and move on. If you believe this button only reads data, click it by CSS ` +
      `selector instead and say why in the step.`
    );
  }
  // CHE-373: the page first, then each embedded frame.
  const located = await locateAcrossFrames(env, "click", input, (scope) => resolveClickTarget(scope, input));
  if (typeof located === "string") return located;
  const target = located.locator.first();
  const inFrame = located.frame;
  const where = located.label ? ` inside ${located.label}` : "";
  const sessionRefusal = await env.extension?.guardClick(target);
  if (sessionRefusal) return sessionRefusal;
  // Never interact before hydration: a click landing before listeners attach
  // is indistinguishable from a dead button.
  await waitForHydration(inFrame ?? env.page, 1_500);
  const before = await snapshotReaction(env, inFrame);
  // CHE-392: where each document's "text that appeared" log stands now — the
  // frame's and, as with mutations, the page hosting it.
  const watched: (Page | Frame)[] = inFrame ? [inFrame, env.page] : [env.page];
  const marks = await Promise.all(watched.map(appearedMark));

  // CHE-214: a click that could not be PERFORMED is our limitation and says
  // nothing about the control. A click that was performed and produced nothing
  // is a different animal and keeps its fallbacks below.
  try {
    await target.click({ timeout: 8_000 });
  } catch (err) {
    if (!isUndrivable(err)) throw err;
    return recordUndriven(env, "click", label ?? String(input.selector ?? "control"), err);
  }
  let reaction = await settleAndMeasure(env, before, inFrame);
  let strategy = "trusted click";
  const tried = [strategy];

  if (isInert(reaction)) {
    // Re-querying could hit a different node than the visually-labeled one —
    // both fallbacks reuse the SAME locator's element.
    const handle = await target.elementHandle({ timeout: 2_000 }).catch(() => null);
    if (handle) {
      const submitted = await handle
        .evaluate((el: Element) => {
          const btn = (el.closest('button, input[type="submit"]') ?? el) as HTMLElement;
          const form = btn.closest("form");
          if (!form) return false;
          const isSubmit =
            (btn instanceof HTMLButtonElement && btn.type === "submit") ||
            (btn instanceof HTMLInputElement && btn.type === "submit");
          if (!isSubmit) return false;
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit(btn as HTMLButtonElement);
          } else {
            (form as HTMLFormElement).submit();
          }
          return true;
        })
        .catch(() => false);
      if (submitted) {
        tried.push("form.requestSubmit()");
        reaction = await settleAndMeasure(env, before, inFrame);
        if (!isInert(reaction)) strategy = "form.requestSubmit() fallback (trusted click was inert)";
      }
      if (isInert(reaction)) {
        const dispatched = await handle
          .evaluate((el: Element) => {
            const r = el.getBoundingClientRect();
            const opts = {
              bubbles: true,
              cancelable: true,
              composed: true,
              button: 0,
              clientX: r.x + r.width / 2,
              clientY: r.y + r.height / 2,
            };
            for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
              el.dispatchEvent(
                type.startsWith("pointer")
                  ? new PointerEvent(type, opts)
                  : new MouseEvent(type, opts),
              );
            }
            return true;
          })
          .catch(() => false);
        if (dispatched) {
          tried.push("synthetic event dispatch");
          reaction = await settleAndMeasure(env, before, inFrame);
          if (!isInert(reaction))
            strategy = "synthetic event dispatch fallback (untrusted events; trusted click was inert)";
        }
      }
    }
  }

  // CHE-372: a click can land on the store's password page too (a link to the
  // cart of a locked store). Same pass as after a navigation.
  const store = isStoreGateUrl(env.page.url(), env.targetOrigin) ? await passStoreGate(env) : "not_gate";
  // CHE-129: the click happened (whatever the page made of it), so it is part
  // of the path. Recorded before the rejection/inert returns below because
  // those are readings of the outcome, not reasons the action did not run.
  recordAction(env, {
    kind: "click",
    ...(input.role ? { role: String(input.role) } : {}),
    ...(input.name ? { name: String(input.name) } : {}),
    ...(input.selector ? { selector: String(input.selector) } : {}),
    ...(inFrame ? { frame: frameKey(inFrame) } : {}),
    outcome: {
      urlAfter: env.page.url(),
      navigated: reaction.navigated,
      requests: reaction.requests,
      mutations: reaction.mutations,
    },
  });
  // CHE-171: wherever a click lands, the product itself took the user there.
  rememberUrls(env, [env.page.url()]);
  const gateNote = storeGateNote(store);
  if (gateNote) return `Clicked. Current URL: ${env.page.url()}. ${gateNote}`;

  // CHE-100: before anything is said about the product, check whether what just
  // happened was our own credential being turned away. Sliced from the tail so
  // the rolling window's trim can never shift the range.
  // CHE-172: this reading is trusted because fill() strips the whitespace the
  // model puts around a placeholder before the secret is substituted — the
  // only credential that can reach an auth endpoint from here is the clean
  // one, so a 401 to it is about the credential, not about our typing.
  const fresh = reaction.requests > 0 ? env.networkLog.slice(-reaction.requests) : [];
  const rejection = credentialRejection(fresh);
  if (rejection) {
    // CHE-322: the account whose credentials were just submitted is the one
    // turned away — named, so the owner is asked for the right password.
    if (markAccountRejected(env, signingInAs)) {
      await env.onCredentialRejected?.(rejection, signingInAs);
    }
    const others = availableAccounts(env).filter((l) => l !== signingInAs && !accountRejected(env.credentials, l));
    return (
      `The credential we hold for ${accountPhrase(signingInAs)} was REJECTED (${rejection}). An ` +
      `auth endpoint answering that to a submitted password is the product working correctly — it ` +
      `is refusing bad input, which is what it should do. This is our access problem, not a defect ` +
      `of theirs.\n` +
      `Do NOT try again with that account: repeated failures lock real accounts. Do NOT report the ` +
      `login, or anything behind it, as broken or confusing. Report this step "skipped" with ` +
      `unverifiedReason "missing_access", say plainly that the sign-in details we were given for ` +
      `${accountPhrase(signingInAs)} no longer work, and spend the rest of this run on what ` +
      (others.length
        ? `a signed-out visitor, or the other test account${others.length === 1 ? "" : "s"} (${others.map((l) => `"${l}"`).join(", ")}), can reach.`
        : `a signed-out visitor can reach.`)
    );
  }
  // CHE-193: on our own hosts, a mutating request answered 403 — or a server
  // action redirecting back with ?self_check=read_only — is the product
  // refusing the self-check by contract (the header), not a defect. Read after
  // the credential rejection so a sign-in 403 on our own Clerk keeps its CHE-100
  // meaning. A customer's 403 never reaches here — the guard is self-host only.
  if (isSelfTarget(env)) {
    const selfRefusal =
      selfCheckRefusalIn(fresh, env.selfCheckHosts) ??
      (isSelfCheckRedirect(env.page.url(), env.selfCheckHosts) ? `redirected back as read-only: ${env.page.url()}` : null);
    if (selfRefusal) {
      console.warn(`[click] self-check refused by the product: ${selfRefusal}`);
      noteSelfCheckRefusal(env, selfRefusal);
      return selfCheckRefusedText("Clicked", selfRefusal);
    }
  }

  const observed = `${reaction.requests} network request${reaction.requests === 1 ? "" : "s"}, ${reaction.mutations} DOM mutation${reaction.mutations === 1 ? "" : "s"}${reaction.navigated ? ", navigated" : ""}`;
  if (isInert(reaction)) {
    // CHE-169: an inert click is the judgment moment vision was turned on for
    // (CHE-70) — an overlay, a consent layer, a media control that only looks
    // dead. The model gets the page in front of it exactly here.
    const looked = await attachLook(env, "inert click");
    // Honest zero-reaction signal (CHE-37): the model must see "the page did
    // nothing at all" instead of silence, and must not translate it straight
    // into "broken" — this environment is known to be ignored by some apps.
    return (
      `Clicked${where}, but the page did not react AT ALL: 0 network requests and 0 DOM mutations ` +
      `(strategies tried: ${tried.join(", ")}). Current URL: ${env.page.url()}. ` +
      `This is either a genuinely dead control or this test browser being ignored ` +
      `(overlay/consent layer, bot gating). Check for overlays with read_page/screenshot; ` +
      `if it stays inert while other JS on the page works, report it as unresponsive ` +
      `IN THIS TEST BROWSER — not as broken for real users.${looked}`
    );
  }
  const note =
    reaction.requests === 0 && !reaction.navigated
      ? " No network request followed, but the DOM changed — likely an in-page reaction (validation message, menu, state change); re-read the page to see what happened."
      : "";
  const ledgerNudge =
    env.writeAllowed && label && CREATE_VERBS.test(label) && !SAFE_SUBMITS.test(label)
      ? ` If that created something, call record_created NOW (marker "${env.testMarker}") — before anything else.`
      : "";
  // CHE-169: a click that only a fallback strategy could land, an error in
  // what it requested, or a media surface — each is a place the digest has
  // misread before, so the model looks before it judges.
  const looked =
    strategy !== "trusted click"
      ? await attachLook(env, `click needed a fallback (${strategy})`)
      : await lookIfJudgmentMoment(env, { requests: fresh });
  // CHE-392: no special case for "navigated". A click that loads a new
  // document leaves nothing to report — the new document's log is empty and
  // nobody started a watch in it — while a client-side route change (the URL
  // moves, the document stays) keeps what it showed, which is the common case
  // of a confirmation shown on the way to the next screen.
  const appeared = appearedSentence((await Promise.all(watched.map((doc, i) => appearedAfter(doc, marks[i])))).flat());
  return `Clicked${where} (strategy: ${strategy}). Current URL: ${env.page.url()} (${observed}).${appeared}${note}${ledgerNudge}${looked}`;
}

// CHE-172: a placeholder the model padded with whitespace — " {{TEST_EMAIL}}",
// "{{TEST_PASSWORD}} ", "\t{{TEST_EMAIL}}\n". Run #142's nav model wrote both
// with a leading space; the substitution kept it, the product answered 401 to
// a password that began with a space, and the CHE-100 one-attempt rule then
// did exactly what it should with a rejection — except the rejection was ours.
// The placeholder IS the value in every such case, so it is collapsed to the
// bare placeholder before anything reads it. A placeholder next to other text
// ("{{TEST_EMAIL}}x") is left alone: odd, but it is what the model meant.
// CHE-322: a named account's placeholder is padded the same way.
const PADDED_PLACEHOLDER = /^\s*(\{\{TEST_(?:EMAIL|PASSWORD)(?::[^{}]*)?\}\})\s*$/;

export function normalizeFillValue(raw: string): string {
  const m = raw.match(PADDED_PLACEHOLDER);
  return m ? m[1] : raw;
}

async function fill(env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  // CHE-372: the store's password form is filled by code, with the store
  // password, and by nothing else — password held or not. Not a guess, and
  // never a placeholder: {{TEST_PASSWORD}} typed here would hand the test
  // login's password to a form it does not belong to. Checked before any
  // substitution, on the page's own form rather than its address alone.
  if (await onStoreGate(env.page, env.targetOrigin)) {
    if (env.store?.state?.status === "rejected") return `Refused: ${STORE_PASSWORD_REFUSED}`;
    if (!env.store?.password) return `Refused: ${STORE_PASSWORD_MISSING}`;
    return (
      "Refused: this is the store's password page. The store password is entered automatically " +
      "when a page of the store leads here — navigate to the page you want instead of filling this form."
    );
  }
  // CHE-373: the same lock met on an origin the app declared (allowed_origins).
  // The store password is entered only on the target's own gate; no store's
  // password form is typed into by the model, on any origin the run may act in
  // — a placeholder resolved here would hand a test login to that form.
  for (const origin of env.allowedOrigins ?? []) {
    if (await onStoreGate(env.page, origin)) {
      return (
        "Refused: this is a store's password page. Nothing is typed into it. Report this step " +
        '"skipped" with unverifiedReason "missing_access" and say that the store is password-protected.'
      );
    }
  }
  // CHE-172: before any gate, any record, any substitution.
  let value = normalizeFillValue(String(input.value));
  // CHE-129: what gets recorded is the value as the model wrote it, placeholders
  // intact, scrubbed once more in case the model pasted a real value it had
  // seen echoed by the page. The substituted value below is never written down.
  const recordedValue = scrubSecrets(env, value);
  // CHE-322: which accounts this value names — the default for a bare
  // placeholder, the labelled one for {{TEST_PASSWORD:admin}}.
  const accounts = placeholderLabels(value);
  const usedSecret = accounts.length > 0;
  // Never type real credentials into an off-origin form (prompt-injection
  // exfiltration): the substituted value would be the decrypted password.
  // CHE-373: "off-origin" is off every origin this run may act on; the frame
  // the field sits in is held to the same rule below, once it is found.
  if (usedSecret) {
    try {
      if (!isAllowedOrigin(env, new URL(env.page.url()).origin)) {
        return `Refused: will not enter test credentials on ${env.page.url()} (outside the target app).`;
      }
    } catch {
      return "Refused: cannot determine the current origin for credential entry.";
    }
  }
  // No test credentials provided → the placeholders resolve to empty, which
  // used to fill the field with "" and let the model click submit on an
  // effectively empty form. Validation then (correctly) blocks the submit, and
  // the model misread that no-op as "Sign in doesn't respond" — the #1
  // false-positive on credential journeys (CHE-37; e.g. JOB-904). Refuse
  // instead, and tell the model to skip, not submit.
  // CHE-100: the strongest half of the one-attempt rule. Refusing the click is
  // easy to route around (a different button, a keyboard Enter); refusing to put
  // the known-bad password into a field again is not.
  // CHE-322: per account — a stale admin password does not stop the free user.
  const rejectedHere = accounts.find((l) => accountRejected(env.credentials, l));
  if (rejectedHere) {
    return (
      `Refused: this product's auth endpoint already rejected the credential we hold for ` +
      `${accountPhrase(rejectedHere)}, earlier in this run. Filling it again cannot succeed and ` +
      'repeated failures lock real accounts. Report this step "skipped" with unverifiedReason ' +
      '"missing_access" and continue with what a signed-out visitor can reach.'
    );
  }
  const substituted = usedSecret ? substituteCredentials(env, value) : { value, missing: [] };
  if (substituted.missing.length) {
    const unknown = substituted.missing.filter((l) => l !== DEFAULT_ACCOUNT_LABEL && !accountFor(env, l));
    if (unknown.length) {
      const offer = availableAccounts(env);
      return (
        `There is no test account called ${unknown.map((l) => `"${l}"`).join(", ")} for this run, so ` +
        `this field cannot be filled. ` +
        (offer.length
          ? `The accounts this run can sign in as: ${offer.map((l) => (l === DEFAULT_ACCOUNT_LABEL ? "{{TEST_EMAIL}} / {{TEST_PASSWORD}}" : `"${l}" ({{TEST_EMAIL:${l}}} / {{TEST_PASSWORD:${l}}})`)).join(", ")}. `
          : "") +
        `If a scenario needs an account that is not provided, do NOT submit the form — report the ` +
        `step "skipped" with unverifiedReason "missing_access" and name the account it needed.`
      );
    }
    return "No test credentials were provided for this run, so this field cannot be filled. Do NOT click the login/submit button on an empty form — a form that refuses empty input is working correctly. Report this step as \"skipped\" (no test credentials), never \"broken\" or \"confusing\".";
  }
  value = substituted.value;

  const label = input.label ? String(input.label) : undefined;
  // CHE-373: the page first, then each embedded frame.
  const located = await locateAcrossFrames(env, "fill", input, async (scope) =>
    input.selector
      ? scope.locator(String(input.selector))
      : label
        ? scope
            .getByLabel(label)
            .or(scope.getByPlaceholder(label))
            .or(scope.getByRole("textbox", { name: label }))
        : scope.locator("input:visible"),
  );
  if (typeof located === "string") return located;
  if (usedSecret) env.activeAccount = accounts[accounts.length - 1];
  // Fingerprint only (sha256 prefix + length), never the value: lets a cred
  // mismatch be localized to save vs store vs fill without exposing anything.
  for (const account of usedSecret ? accounts : []) {
    const password = accountFor(env, account)?.password;
    if (password) console.log(`[fill] substituting test password for "${account}": ${credentialFingerprint(password)}`);
  }

  const field = located.locator.first();
  const fixtureRefusal = await env.extension?.guardFixtureControl(field);
  if (fixtureRefusal) return fixtureRefusal;
  // Same hydration gate as click: values typed before listeners attach are
  // silently dropped by controlled inputs.
  await waitForHydration(located.frame ?? env.page, 1_000);
  const named = label ?? (input.selector ? String(input.selector) : "field");
  const landed = () => {
    recordAction(env, {
      kind: "fill",
      ...(label ? { label } : {}),
      ...(input.selector ? { selector: String(input.selector) } : {}),
      ...(located.frame ? { frame: frameKey(located.frame) } : {}),
      value: recordedValue,
      outcome: { urlAfter: env.page.url() },
    });
    const where = located.label ? ` inside ${located.label}` : "";
    return usedSecret ? `Filled${where} (credential substituted server-side).` : `Filled${where}.`;
  };

  if (usedSecret) return fillSecret(env, field, value, named, landed);

  try {
    await field.fill(value, { timeout: 8_000 });
  } catch (err) {
    if (!isUndrivable(err)) throw err;
    // CHE-214, the "retried by another means" half. fill() sets the value in
    // one shot and waits for the element to be editable; typing does what a
    // person does, and by hand on run #159's field that is exactly what worked.
    // Two seconds of focus, five of typing: cheaper than the fill that just
    // failed, and it either lands or we say so.
    console.warn(`[fill] fill() could not drive ${JSON.stringify(named)} — typing instead`);
    try {
      await field.focus({ timeout: 2_000 });
      await field.pressSequentially(value, { timeout: 5_000, delay: 15 });
    } catch (typingErr) {
      return recordUndriven(env, "fill", named, typingErr);
    }
    const typed = await field.inputValue().catch(() => null);
    if (typed !== null && !typed.includes(value)) {
      return recordUndriven(env, "fill", named, new Error(`typed value did not stick in ${named}`));
    }
    // Typing landed, and this path RETURNS. Falling through to the hydration
    // retry below would call the very fill() that was just proven undrivable
    // for this control, and on a field that held anything before we typed
    // (a default, a leftover) `stuck !== value` is true — so the retry would
    // fail, record the control as undriven, and throw away input that worked.
    // That is the false negative CHE-214 exists to remove, reintroduced one
    // block later.
    return landed();
  }
  // React controlled inputs silently drop values typed before hydration —
  // verify the value stuck and retry once if not. Only after a fill() that
  // itself succeeded: this is a hydration race, not an undrivable control.
  const stuck = await field.inputValue().catch(() => null);
  if (stuck !== null && stuck !== value) {
    await env.page.waitForTimeout(600);
    try {
      await field.fill(value, { timeout: 8_000 });
    } catch (err) {
      if (!isUndrivable(err)) throw err;
      return recordUndriven(env, "fill", named, err);
    }
  }
  return landed();
}

// CHE-373: a substituted credential is written by one function running inside
// the field's own document, which first checks that this document is on an
// origin the run may act on. That is the ONLY place the question can be asked
// truthfully. Asked in Node and then typed, question and write are apart in
// time, and a locator follows its frame through a navigation: an embedded app
// that bounces to its identity provider while we wait for hydration had the
// provider's "Password" field receive the real test password while the tool
// said it filled the app (4 of 14 timed runs in the cross-review of #222). The
// address Node holds for a frame lags the document as well — it was still the
// app's with the provider's page already in place — so there is no check in
// Node beside this one to disagree with it. One synchronous task in the page
// cannot be split by a navigation.
//
// insertText is what a keyboard does (beforeinput/input, so frameworks see
// it); the value setter plus input/change is the fallback for a field that
// refuses it. Returns "ok", "not-stuck", or "elsewhere <origin>" with nothing
// written.
//
// location.origin, not self.origin: Location is unforgeable, while
// window.origin is replaceable by the page's own script — a stranger's page
// could set it to an origin we allow. The price is that a field inside a
// srcdoc/about:blank frame of the app reads "null" and is refused too; a login
// form living in such a frame has not been met, and refusing is the safe side.
const WRITE_SECRET = (el: Element, arg: { value: string; origins: string[] }): string => {
  if (!el.isConnected || !arg.origins.includes(location.origin)) return `elsewhere ${location.origin}`;
  const text = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
  (el as HTMLElement).focus();
  if (text) text.select();
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, arg.value);
  } catch {
    inserted = false;
  }
  if (!text) return inserted && (el.textContent ?? "").includes(arg.value) ? "ok" : "not-stuck";
  if (!inserted || text.value !== arg.value) {
    const proto = text instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(text, arg.value);
    else text.value = arg.value;
    text.dispatchEvent(new Event("input", { bubbles: true }));
    text.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return text.value === arg.value ? "ok" : "not-stuck";
};

async function fillSecret(
  env: ToolEnv,
  field: Locator,
  value: string,
  named: string,
  landed: () => string,
): Promise<string> {
  // Every origin this run may act on, as the document itself will spell its own.
  const origins = [env.targetOrigin, ...(env.allowedOrigins ?? [])]
    .map((o) => o.toLowerCase())
    .filter((o) => isAllowedOrigin(env, o));
  for (let attempt = 0; attempt < 2; attempt++) {
    // Like the plain fill's retry: a controlled input can drop a value written
    // before it hydrated.
    if (attempt) await env.page.waitForTimeout(600);
    let outcome: string;
    try {
      outcome = await field.evaluate(WRITE_SECRET, { value, origins }, { timeout: 8_000 });
    } catch (err) {
      if (!isUndrivable(err)) throw err;
      return recordUndriven(env, "fill", named, err);
    }
    if (outcome.startsWith("elsewhere")) {
      // The field was found on the app and its document is another one now (a
      // sign-in that bounced to its identity provider), or it never had an
      // address of its own (srcdoc, about:blank, data:, sandboxed — "null",
      // which cannot be told from a stranger's). The credential stays with us.
      const at = outcome.slice("elsewhere ".length);
      const where = at && at !== "null" ? at : "an embedded document with no address of its own";
      return (
        `Refused: will not enter test credentials on ${where} (outside the target app). Nothing was typed. ` +
        `If the page moved, read it again before deciding what the step is.`
      );
    }
    if (outcome === "ok" && (await field.inputValue().catch(() => value)) === value) return landed();
  }
  return recordUndriven(env, "fill", named, new Error(`the value did not stick in ${named}`));
}

// Exact accessible name first (CHE-79): getByRole's `name` matches SUBSTRINGS,
// so clicking "Continue" on a Clerk modal picked "Continue with Google" (it
// sits above the form in DOM order) and bounced the agent into OAuth — a false
// broken/high on our own sign-in. When an exact-name match exists it wins;
// the substring behavior stays as the fallback for the model's loose labels.
async function resolveClickTarget(page: LocatorScope, input: Record<string, unknown>): Promise<Locator> {
  if (input.role && input.name) {
    const exact = page.getByRole(String(input.role) as Parameters<Page["getByRole"]>[0], {
      name: String(input.name),
      exact: true,
    });
    if ((await exact.count().catch(() => 0)) > 0) return exact;
  }
  return resolveLocator(page, input);
}

// ─── CHE-373: embedded frames ────────────────────────────────────────────────
//
// A Shopify app renders inside admin.shopify.com in iframe[name=app-iframe],
// served from the app's own origin. Playwright's page locators stop at a frame
// boundary, same-origin or not, and read_page could open only a same-origin
// frame's document — so the app itself was a "FRAMES: <src>" line the walk
// could neither read nor press. Playwright reaches every frame through the
// browser, whatever its origin; these helpers give the tools that reach.
//
// A frame is named by its 1-based position among the page's child frames
// (page.frames() without the main frame), the same list for read_page and for
// click/fill, so "FRAME 2" in a digest is the frame a following click means.

// The four ways a tool finds a control, which a Page and a Frame both offer.
type LocatorScope = Pick<Page, "getByRole" | "getByText" | "getByLabel" | "getByPlaceholder" | "locator">;

// Reaching into frames is not a way past bot protection, which is out of scope
// and prohibited (browser.ts, agentContextOptions): a challenge widget's frame
// is never listed, so it can be neither read, searched nor picked — the walk
// meets it exactly as it did before frames were reachable at all.
const CHALLENGE_FRAME =
  /^https:\/\/(?:[a-z0-9-]+\.)*(?:google\.com|recaptcha\.net)\/recaptcha\/|^https:\/\/(?:[a-z0-9-]+\.)*(?:hcaptcha\.com|arkoselabs\.com|funcaptcha\.com|captcha-delivery\.com)\/|^https:\/\/challenges\.cloudflare\.com\//i;

// A bare ToolEnv in a script carries a stub page with no frames at all.
function childFrames(page: Page): Frame[] {
  if (typeof page.frames !== "function" || typeof page.mainFrame !== "function") return [];
  const main = page.mainFrame();
  return page.frames().filter((f) => f !== main && !f.isDetached() && !insideChallenge(f));
}

// The challenge's own frame, or any frame it nests.
function insideChallenge(frame: Frame): boolean {
  for (let f: Frame | null = frame; f; f = f.parentFrame()) {
    if (CHALLENGE_FRAME.test(f.url())) return true;
  }
  return false;
}

function frameLabel(frame: Frame, index: number): string {
  return `FRAME ${index + 1} (${urlOrigin(frame.url()) ?? frame.url()})`;
}

// "1" / "frame 1" / "FRAME 1 (…)" by number; "top" / "main" / "0" for the page
// itself; otherwise the first frame whose name or URL contains the text.
function pickFrame(page: Page, wanted: string): { frame: Frame | null; label: string | null } | null {
  const text = wanted.trim();
  if (/^(?:0|top|main|page)$/i.test(text)) return { frame: null, label: null };
  const frames = childFrames(page);
  const numbered = text.match(/^(?:frame\s*)?(\d+)\b/i);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    return frames[index] ? { frame: frames[index], label: frameLabel(frames[index], index) } : null;
  }
  const needle = text.toLowerCase();
  const index = frames.findIndex((f) => f.name().toLowerCase().includes(needle) || f.url().toLowerCase().includes(needle));
  return index >= 0 ? { frame: frames[index], label: frameLabel(frames[index], index) } : null;
}

async function hasMatch(locator: Locator): Promise<boolean> {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

// The origin a frame acts for: its own, or — for about:blank and srcdoc, which
// take their creator's, and data:, whose content its creator wrote — the
// nearest ancestor's that has one. That is enough to press a button in it. A
// credential is held to more: the secret write asks the document itself for
// its location.origin (WRITE_SECRET), which is "null" in every one of these.
function frameOrigin(frame: Frame): string | null {
  for (let f: Frame | null = frame; f; f = f.parentFrame()) {
    const origin = urlOrigin(f.url());
    if (origin) return origin;
  }
  return null;
}

// Reading a frame is looking at the page; acting in one is acting on whoever
// serves it. A payment field, a chat widget, an ad, a vendor's login: none of
// them is the owner's to have us press, so click and fill act only in frames
// on an origin this run may act on — the target's or one the owner allowed —
// exactly as navigate and credential entry do.
function mayActIn(env: ToolEnv, frame: Frame): boolean {
  const origin = frameOrigin(frame);
  return origin !== null && isAllowedOrigin(env, origin);
}

// Rule 2: a control we will not act in is OUR limit, never the customer's
// homework. The answer names no setting for them to change — allowed origins
// are theirs to set deliberately, not something a step solicits (the first
// version of this text told the model to say the origin "would have to be
// allowed for this app", which is an ask in every step that meets a widget).
// And the machine half, as for any control our hands did not drive (CHE-214):
// the refusal is recorded, so a step that blames the product after it becomes
// skipped / our_capability at report time, whatever the model wrote.
function outsideFrameRefusal(
  env: ToolEnv,
  hand: "fill" | "click",
  input: Record<string, unknown>,
  label: string,
  frame: Frame,
): string {
  const origin = frameOrigin(frame) ?? frame.url();
  const target = String(input.name ?? input.label ?? input.selector ?? "control");
  env.undrivenControls?.push({ hand, target, reason: `inside an embedded frame outside the target app (${origin})` });
  console.warn(`[${hand}] refused ${JSON.stringify(target)}: ${label} is outside the target app`);
  return (
    `Refused: ${label} is outside the target app (${origin}) — the checker does not act inside another ` +
    `party's embedded frame, and that says NOTHING about the control. Do not report it broken, risky or ` +
    `confusing. If the step needs this control, report it "skipped" with unverifiedReason ` +
    `"our_capability". If it is a third party's widget the journey does not depend on (chat, ads, a ` +
    `social embed), report it "skipped" with unverifiedReason "not_applicable" or leave it out.`
  );
}

// How a recorded action names its frame for a replay (journey-replay.ts): the
// frame's name, else its address without the query — the number is a position
// on one page load, and an embedded app's query carries its session.
function frameKey(frame: Frame): string {
  if (frame.name()) return frame.name();
  try {
    const u = new URL(frame.url());
    return `${u.origin}${u.pathname}`;
  } catch {
    return frame.url();
  }
}

// The head of the answer when a named frame is not on the page. A replay reads
// it as nothing having been pressed (journey-replay.ts classifyResult).
export const NO_FRAME_MATCH = "No frame matches";

interface Located {
  locator: Locator;
  frame: Frame | null;
  label: string | null;
}

// Where a click or a fill acts. With `frame` named, there and nowhere else.
// Without it: the page when the control is there — so a page with no frames
// resolves exactly as it always did, and a page whose control is on top never
// reaches into a frame — otherwise the first frame, in order, that has it and
// may be acted in. A control found only in frames outside the target app is
// refused, saying so. A control found nowhere resolves on the page, so the miss
// reads as it always has (the click's own timeout, the fill's undriven-control
// answer).
async function locateAcrossFrames(
  env: ToolEnv,
  hand: "fill" | "click",
  input: Record<string, unknown>,
  build: (scope: LocatorScope) => Promise<Locator>,
): Promise<Located | string> {
  const wanted = input.frame === undefined || input.frame === null ? "" : String(input.frame).trim();
  if (wanted) {
    const picked = pickFrame(env.page, wanted);
    if (!picked) {
      return (
        `${NO_FRAME_MATCH} "${wanted}" on this page. read_page lists the embedded frames as ` +
        `FRAME <n> with their origin; pass that number, or leave frame out to search the page and every frame.`
      );
    }
    if (picked.frame && !mayActIn(env, picked.frame)) {
      return outsideFrameRefusal(env, hand, input, picked.label ?? "that frame", picked.frame);
    }
    return { locator: await build(picked.frame ?? env.page), ...picked };
  }
  const top = await build(env.page);
  const frames = childFrames(env.page);
  if (frames.length === 0 || (await hasMatch(top))) return { locator: top, frame: null, label: null };
  let outside: { frame: Frame; label: string } | null = null;
  for (let i = 0; i < frames.length; i++) {
    const inFrame = await build(frames[i]).catch(() => null);
    if (!inFrame || !(await hasMatch(inFrame))) continue;
    if (mayActIn(env, frames[i])) return { locator: inFrame, frame: frames[i], label: frameLabel(frames[i], i) };
    outside ??= { frame: frames[i], label: frameLabel(frames[i], i) };
  }
  if (outside) return outsideFrameRefusal(env, hand, input, outside.label, outside.frame);
  return { locator: top, frame: null, label: null };
}

// CHE-82/83. An interaction that produced nothing for US is not a product
// defect — it is an unverified step and a gap in our own checker. Coerce it
// (the model still slips into "confusing: the button did nothing") and make
// sure every skipped step carries a reason, so the capability filer can open a
// ticket against us instead of the customer reading an excuse.
const CAPABILITY_PATTERNS =
  /(target=_?"?_blank|new tab|popup|pop-up|oauth|headless|our (test )?browser|verification code|2fa|mfa|camera|microphone|media device|could not follow|cannot follow|no (network )?requests?|0 requests|magic link|passwordless|email link|sign-?in link)/i;

export function classifyUnverified(step: ReportedStep): void {
  const text = `${step.observed ?? ""} ${step.attempted ?? ""}`;
  const environmental = CAPABILITY_PATTERNS.test(text);
  const hardEvidence = /\b(4\d{2}|5\d{2})\b|console error|exception|stack|crash/i.test(
    step.observed ?? "",
  );
  // "broken/confusing" justified only by our own inability → unverified.
  if ((step.status === "broken" || step.status === "confusing") && environmental && !hardEvidence) {
    step.status = "skipped";
    step.unverifiedReason = "our_capability";
    return;
  }
  if (step.status !== "skipped") {
    step.unverifiedReason = undefined;
    return;
  }
  if (!step.unverifiedReason) {
    // Passwordless flows are OUR gap, not the owner's: there is no password to
    // give us, so "add test credentials" would be a lie. Checked before the
    // credentials wording, which such steps almost always also mention.
    const passwordless = /magic link|passwordless|email link|sign-?in link|login link/i.test(text);
    step.unverifiedReason = passwordless
      ? "our_capability"
      : /credential|password|test account|sign-?in details/i.test(text)
        ? "missing_access"
        : environmental
          ? "our_capability"
          : "not_applicable";
  }
}

// CHE-180. Step.attempted / Step.observed are read on the verdict page, and
// verdict-language.ts guarded only findings and the bottom line: run #144
// wrote "requires camera/mic access unavailable in our test environment" into
// a step. Pure helper; the walk (execution.ts onReportStep) calls it LAST —
// after coerceUnpublished404 and classifyUnverified, which read the machinery
// phrases to classify a skipped step honestly, and after the judge (CHE-169),
// whose ruling rests on exactly those words — and before the row is written.
// Status and unverifiedReason are untouched; only the words change. When
// nothing product-facing survives, a fixed sentence stands in: coverage for a
// skipped step, the judge's sentence for an ok one, and for a problem the
// first sentence with its machinery clause cut, so the evidence that made it
// a problem is not thrown away together with the excuse. The label has no
// product-facing substitute, so a label made only of machinery words (never
// seen in a run) stays as written.
export function productizeStep(step: ReportedStep): void {
  step.label = productStepLabel(step.label);
  step.attempted = productProse(step.attempted) ?? step.label;
  step.observed = productProse(step.observed) ?? observedFallback(step);
}

const CLAUSE_BREAK = /\s+[—–]+\s+|\s+-\s+|;\s+|,\s+(?=(?:it|which|because|since|as|so|but|and|though|although|while)\b)/i;

function observedFallback(step: ReportedStep): string {
  if (step.status === "skipped") return UNVERIFIABLE_FALLBACK;
  if (step.status === "ok") return NOT_DEFECT_FALLBACK;
  const first = splitSentences((step.observed ?? "").trim())[0] ?? "";
  const clauses = first
    .split(CLAUSE_BREAK)
    .map((c) => c.trim())
    .filter((c) => c && !hasEnvironmentLeak(c) && !MACHINERY_TERMS.test(c));
  if (clauses.length === 0) return PROBLEM_FALLBACK;
  const out = clauses.join(", ").replace(/[,;:\s]+$/, "");
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

// CHE-171. The navigate refusal tells the model; this makes sure the step
// cannot say otherwise. A broken/confusing step whose evidence is a 404/410 on
// an address the run never saw published becomes skipped/not_applicable: not
// our capability gap (we reached it fine), not the product's defect (nobody is
// sent there) — a path no user takes. The addresses come from two machine
// sources: the navigate actions recorded since the last report_step (CHE-129)
// and the URLs/paths the step text cites. One known address among them keeps
// the step as written — a 404 on a page the product links to is a real
// dead-end. And when the trail is there and holds no typed-in 404, the step is
// left alone whatever the text says: that 404 came from something the product
// did (a click's own request to /api/…), which is exactly the evidence a real
// user hits.
const CITED_URL = /https?:\/\/[^\s"'<>)\]]+/gi;
const CITED_PATH = /(?:^|[\s"'`(])(\/[a-z0-9][a-z0-9_\-./]*)/gi;
const NOT_FOUND = /\b(404|410)\b|\bnot found\b/i;
const TRAILING_PUNCT = /[.,;:]+$/;

function citedAddresses(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITED_URL)) out.push(m[0].replace(TRAILING_PUNCT, ""));
  for (const m of text.matchAll(CITED_PATH)) out.push(m[1].replace(TRAILING_PUNCT, ""));
  return out;
}

function isGoneNavigate(a: RecordedAction): a is Extract<RecordedAction, { kind: "navigate" }> {
  return a.kind === "navigate" && (a.outcome.status === 404 || a.outcome.status === 410);
}

export function coerceUnpublished404(
  step: ReportedStep,
  env: Pick<ToolEnv, "knownUrls" | "targetOrigin" | "actionTrail">,
): void {
  if (!env.knownUrls) return;
  if (step.status !== "broken" && step.status !== "confusing") return;
  const text = `${step.observed ?? ""} ${step.attempted ?? ""}`;
  if (!NOT_FOUND.test(text)) return;
  // A server error is the product's own word; a 404 next to it is not the story.
  if (/\b5\d{2}\b/.test(step.observed ?? "")) return;
  const typed = env.actionTrail?.filter(isGoneNavigate).map((a) => a.url);
  if (typed && typed.length === 0) return;
  const addresses = [...(typed ?? []), ...citedAddresses(text)];
  if (addresses.length === 0) return;
  if (addresses.some((url) => isKnownUrl(env, url, env.targetOrigin))) return;
  console.warn(`[report_step] "${step.label}": ${step.status} on an unpublished 404 → skipped`);
  step.status = "skipped";
  step.unverifiedReason = "not_applicable";
  const observed = (step.observed ?? "").trim();
  step.observed = `${observed}${observed && !/[.!?]$/.test(observed) ? "." : ""} This address is not part of the product's navigation.`.trim();
}

// CHE-190. Run #147 (theins.ru): verify_links fetched vk.com/share.php and
// connect.ok.ru/offer from the worker, both stalled past the 10 s limit, the
// tool called that "BROKEN fetch-error", and the model wrote a risky step and
// the finding "VK and Odnoklassniki share links did not resolve". The verdict
// went to needs_attention; run #148 twenty minutes later found nothing and
// went mostly_ok. From a residential connection both links answer 302 into the
// share widgets — those hosts refuse or stall datacenter egress, which is a
// fact about where we fetch from, not about the link. CLAUDE.md rule 3:
// silence is not evidence; rule 8: our incapacity is never their defect.
//
// Two mechanisms. verifyLinks (below) now answers UNREACHABLE for a fetch
// error, a timeout, or a 403/429/503 from a host other than the target, with
// the instruction to report such a step skipped. And here, because a tool
// result is still only a sentence to the model: a risky/confusing/broken step
// whose words rest on a host we could not reach is written skipped /
// our_capability. `risky` is included deliberately — the judge (CHE-169) does
// not see it and classifyUnverified (CHE-82) does not touch it, which is
// exactly how #147's step reached the verdict untested.
//
// The step is left alone when it also cites a real 4xx/5xx about the product
// itself — its own host, a bare path, or a status with no host named — or a
// console exception: that is evidence a user would hit, and a timeout beside
// it is not the story. A status in a sentence naming only a foreign host
// ("HTTP 403 from vk.com") is that host gating us and does not count.
const EGRESS_PHRASE =
  /\bUNREACHABLE\b|\btimed?[\s-]?out\b|\bcould not be reached\b|\bunreachable\b|\bconnection (?:reset|refused|failed|error|closed)\b|\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH)\b/i;
const CITED_HOST = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi;
// "share.php" and "index.html" match the host shape; they are file names.
const NOT_A_HOST = /\.(?:php|html?|x?html|js|mjs|ts|tsx|css|json|xml|png|jpe?g|gif|svg|webp|ico|txt|pdf|aspx?|jsp|map|woff2?)$/i;
const BARE_PATH = /(?:^|[\s"'`(])\/[a-z0-9][a-z0-9_\-./]*/i;
const CONSOLE_EVIDENCE = /console error|exception|uncaught|stack trace|\bcrash/i;
const HTTP_ERROR_STATUS = /\b[45]\d{2}\b/;

function citedHosts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITED_HOST)) {
    const host = m[1].toLowerCase();
    if (!NOT_A_HOST.test(host) && !out.includes(host)) out.push(host);
  }
  return out;
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

// The target and anything under it (api.target.test is theirs); www. is not a
// different site.
// CHE-373: an origin the owner allowed for this app is the product too — the
// embedding page an app lives in is where its users meet it. Its host EXACTLY:
// an allowed admin.shopify.com does not make every *.shopify.com the product,
// and a suffix that slipped past validation (allowed-origins.ts) cannot make a
// whole namespace of strangers' sites evidence against the customer (rule 8).
export function isTargetHost(hostname: string, targetOrigin: string, allowedOrigins: readonly string[] = []): boolean {
  const host = bareHost(hostname);
  try {
    const own = bareHost(new URL(targetOrigin).hostname);
    if (host === own || host.endsWith(`.${own}`)) return true;
  } catch {
    // A target that is not a URL owns no host; the allowed list still applies.
  }
  const exact = hostname.toLowerCase();
  return allowedOrigins.some((origin) => {
    try {
      return new URL(origin).hostname.toLowerCase() === exact;
    } catch {
      return false;
    }
  });
}

function evidenceAgainstProduct(text: string, targetOrigin: string, allowedOrigins: readonly string[] = []): boolean {
  for (const sentence of splitSentences(text)) {
    if (CONSOLE_EVIDENCE.test(sentence)) return true;
    if (!HTTP_ERROR_STATUS.test(sentence) || /\bUNREACHABLE\b/.test(sentence)) continue;
    const hosts = citedHosts(sentence);
    const foreign = hosts.filter((h) => !isTargetHost(h, targetOrigin, allowedOrigins));
    if (foreign.length === 0) return true;
    if (foreign.length < hosts.length || BARE_PATH.test(sentence)) return true;
  }
  return false;
}

function listHosts(hosts: string[]): string {
  if (hosts.length <= 1) return hosts[0] ?? "this link";
  return `${hosts.slice(0, -1).join(", ")} and ${hosts[hosts.length - 1]}`;
}

// CHE-214, the machine half. The instruction above is a request; this is what
// happens whatever the model does with it. A step reported as a defect after a
// control we could not drive, with no hard evidence of the product's own doing,
// becomes skipped / our_capability — which files a ticket on OUR board every
// run it happens (CLAUDE.md rule 2), so the capability gets built instead of
// being re-discovered as somebody else's bug.
//
// Hard evidence wins: an HTTP error, a console exception or a crash beside the
// failed interaction is the product's own answer, and a step carrying one is
// left exactly as the model wrote it.
// A bare three-digit number is not a status code. We walk arbitrary customer
// forms, and "typed 499.00 into the price field and nothing happened" is a
// price — read as hard evidence it would leave the step published as the
// product's defect, which is the rule-8 failure this whole change exists to
// close. So the number must come with the vocabulary of a response: HTTP, a
// status, an error/response beside it, or a method and a path.
const INTERACTION_HARD_EVIDENCE = new RegExp(
  [
    // "HTTP 500", "status 403", "responded 502", "→ 500", "returned a 500 error"
    String.raw`\b(?:http|https|status(?:\s+code)?|code|returned|returns|answered|responded|responds|replied|gave|with|→|->)\s*:?\s*(?:an?\s+)?[45]\d{2}\b`,
    // "500 error", "403 response", "404 status", "502 from the API"
    String.raw`\b[45]\d{2}\s+(?:error|response|status|from\b)`,
    // "GET /api/orders 500", "POST /checkout → 422"
    String.raw`\b(?:GET|POST|PUT|PATCH|DELETE|HEAD)\b[^.]{0,80}?\b[45]\d{2}\b`,
    // Everything that is not a number at all.
    String.raw`console error|exception|stack trace|crashed?\b|server error|internal error`,
  ].join("|"),
  "i",
);

export function coerceUndrivenControl(
  step: ReportedStep,
  env: Pick<ToolEnv, "undrivenControls">,
): void {
  const undriven = env.undrivenControls ?? [];
  if (undriven.length === 0) return;
  if (step.status !== "broken" && step.status !== "risky" && step.status !== "confusing") return;
  if (INTERACTION_HARD_EVIDENCE.test(step.observed ?? "")) return;
  const first = undriven[0];
  console.warn(
    `[report_step] "${step.label}": ${step.status} after a ${first.hand} we could not drive ` +
      `(${first.target}) → skipped/our_capability`,
  );
  step.status = "skipped";
  step.unverifiedReason = "our_capability";
  step.gapClass = "undriven_control";
  // The status was the easy half. Step.observed is rendered to the owner word
  // for word on the verdict page, so leaving the model's sentence in place and
  // appending ours means they still read that their field refused input, now
  // with a caveat after it. Same cut as CHE-219, one level down: the clause
  // asserting our interaction produced nothing goes, what we actually saw
  // stays ("The field is present"), and our sentence follows it. When nothing
  // of the observation survives, the fixed coverage sentence stands in rather
  // than a bare caveat.
  const claim = cutNullEffectClauses(step.observed);
  if (claim.cut.length) {
    console.warn(`[report_step] "${step.label}": cut our own claim from the step — ${claim.cut.join(" / ")}`);
  }
  const observed = (claim.text ?? "").trim();
  step.observed = observed
    ? `${observed}${/[.!?]$/.test(observed) ? "" : "."} This control could not be exercised this run.`
    : UNVERIFIABLE_FALLBACK;
}

export function coerceUnreachable(step: ReportedStep, env: Pick<ToolEnv, "targetOrigin" | "allowedOrigins">): void {
  if (step.status !== "risky" && step.status !== "confusing" && step.status !== "broken") return;
  const text = `${step.observed ?? ""} ${step.attempted ?? ""}`;
  if (!EGRESS_PHRASE.test(text)) return;
  const allowed = env.allowedOrigins ?? [];
  const foreign = citedHosts(text).filter((h) => !isTargetHost(h, env.targetOrigin, allowed));
  // A timeout with no foreign host named is about the product itself unless
  // the tool's own word is there — verify_links names UNREACHABLE and nothing
  // else does.
  if (foreign.length === 0 && !/\bUNREACHABLE\b/.test(text)) return;
  if (evidenceAgainstProduct(text, env.targetOrigin, allowed)) return;
  console.warn(`[report_step] "${step.label}": ${step.status} on an unreachable host (${listHosts(foreign)}) → skipped`);
  step.status = "skipped";
  step.unverifiedReason = "our_capability";
  const observed = (step.observed ?? "").trim();
  step.observed = `${observed}${observed && !/[.!?]$/.test(observed) ? "." : ""} Could not confirm ${listHosts(foreign)} this run.`.trim();
}

// CHE-193. The click result tells the model; this makes sure the step cannot
// say otherwise. On one of our own hosts, a broken/confusing step whose
// evidence is the read-only guard answering the self-check — a 403 on a
// mutating request, or a server action redirecting back with
// ?self_check=read_only — becomes skipped/not_applicable, the same pattern as
// coerceUnpublished404. The refusal must be visible to the machine: a mutating
// 403 to one of our hosts in the request log, a recorded action that landed on
// the redirect, or the step text citing 403/forbidden/self_check=read_only.
// Only self hosts: a customer's 403 stays whatever the model and the existing
// rules say.
//
// CHE-334. Run #260 (checkmyapp.dev, 2026-09-28) shows what that left open.
// The walk clicked "Show me my app", our guard answered POST /api/checks → 403,
// and the model reported the step *skipped* itself — so this rule, which only
// looked at broken/confusing, never ran. The step kept the model's words ("the
// check is not available to an unauthenticated account"), the skip rolled the
// journey up to "partial", the summary said "'Show me my app' returns 403 for
// this account", and the bottom line called it a bot-check gate refusing the
// core promise — our own guard, shown to a prospect as the product's defect.
// So now:
//   - the tools note every refusal of our own guard as it happens
//     (noteSelfCheckRefusal: the web half's 403 or read-only redirect, and the
//     click gate refusing a control on our host), and the step reported next
//     is that refusal whatever status the model gave it, unless it is ok or
//     carries the product's own hard evidence (a 5xx, a console exception);
//   - without that note, the machine evidence rule above still applies — to a
//     skipped or risky step only when the text cites the refusal AND the log
//     or trail shows it, so a skip that merely says "forbidden" is left alone;
//   - the step's words are replaced, not appended to: the model's sentence is
//     exactly the misreading ("unauthenticated account", "bot-check"), and a
//     sentence saying the product refused this account was what synthesis
//     turned into "returns 403 for this account";
//   - selfCheckRefused marks the step for the roll-up (countsTowardJourney)
//     and the summary gates.
const FORBIDDEN = /\b403\b|\bforbidden\b|self_check=read_only/i;
// The refusals already written onto a step, per walk (one ToolEnv per journey).
const ATTRIBUTED = new WeakMap<object, Set<string>>();
function attributedRefusals(env: object): Set<string> {
  let set = ATTRIBUTED.get(env);
  if (!set) ATTRIBUTED.set(env, (set = new Set()));
  return set;
}
const PRODUCT_OWN_EVIDENCE = /\b5\d{2}\b|console error|exception|stack trace|\bcrash/i;

export function coerceSelfCheck403(
  step: ReportedStep,
  env: Pick<ToolEnv, "targetOrigin" | "selfCheckHosts" | "networkLog" | "actionTrail" | "selfCheckRefusals">,
): void {
  if (!isSelfTarget(env)) return;
  // An ok step is never rewritten, and it does not use up a refusal: the
  // model often reports "the form accepts input" before the step the refusal
  // belongs to. Every other status — "exposed" included, a 403 of ours is no
  // security finding — is decided below.
  if (step.status === "ok") return;
  // Otherwise the refusals noted since the last report belong to this step
  // and to no later one, whatever is decided below — including the log lines
  // they came from, which stay in the rolling log and must not be read again
  // as the next step's evidence.
  const noted = env.selfCheckRefusals?.splice(0) ?? [];
  const attributed = attributedRefusals(env);
  for (const line of noted) attributed.add(line);
  const text = `${step.observed ?? ""} ${step.attempted ?? ""}`;
  // A server error or an exception is the product's own word; a 403 next to
  // it is not the story — wherever the step carries it, its prose or the
  // console/network excerpts it attached. The step keeps its status; when a
  // refusal of ours was noted for it, the clauses retelling that refusal are
  // cut from its words and the walk is told it met the guard (Codex review of
  // #205: "submission returned 403, then /api/runs returned 502" must keep the
  // 502 and lose the 403).
  const ownEvidence =
    /\b5\d{2}\b/.test(step.observed ?? "") ||
    /(?:→|->|:|\s)\s*5\d{2}\s*$/m.test(step.networkExcerpt ?? "") ||
    CONSOLE_EVIDENCE.test(step.consoleExcerpt ?? "") ||
    (noted.length > 0 && PRODUCT_OWN_EVIDENCE.test(step.observed ?? ""));
  if (ownEvidence) {
    if (noted.length > 0) {
      step.selfCheckGuardSeen = true;
      step.observed = withoutGuardClauses(step.observed);
    }
    return;
  }
  if (noted.length === 0) {
    const cited = FORBIDDEN.test(text);
    const unattributed = (env.networkLog ?? []).filter((line) => !attributed.has(line));
    const logged =
      selfCheckRefusalIn(unattributed, env.selfCheckHosts) !== null ||
      (env.actionTrail ?? []).some((a) => isSelfCheckRedirect(a.outcome.urlAfter, env.selfCheckHosts));
    if (step.status === "broken" || step.status === "confusing") {
      if (!cited && !logged) return;
      // The log is a rolling window: a refusal from an earlier click must not
      // erase a step that stands on its own evidence (a crash, an exception,
      // some other error response the step actually cites).
      if (!cited && /\b4\d{2}\b|console error|exception|stack|crash/i.test(step.observed ?? "")) return;
    } else if (!cited || !logged) {
      return;
    }
  }
  console.warn(
    `[report_step] "${step.label}": ${step.status} on our own self-check guard (${noted[0] ?? "a refusal in the step or the log"}) → skipped`,
  );
  step.status = "skipped";
  step.unverifiedReason = "not_applicable";
  step.gapClass = undefined;
  step.selfCheckRefused = true;
  step.selfCheckGuardSeen = true;
  step.observed = SELF_CHECK_REFUSED_OBSERVED;
}

// A step that met our guard AND carries the product's own evidence: the
// clauses retelling the refusal go, the ones with the evidence stay. Clause
// boundaries are the ones every other cut in this file uses.
const GUARD_CLAUSE_BREAK = /(,\s+(?:then|and|but|after\s+which|while)\s+|;\s+|\s+[—–]\s+|,\s+)/i;
function withoutGuardClauses(observed: string): string {
  const out: string[] = [];
  for (const sentence of splitSentences(observed ?? "")) {
    const parts = sentence.split(GUARD_CLAUSE_BREAK);
    const kept: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const clause = parts[i];
      if (cutSelfCheckRefusalClaims(clause).cut.length && !PRODUCT_OWN_EVIDENCE.test(clause)) continue;
      kept.push(clause.trim());
    }
    const joined = kept.join(", ").replace(/[\s,;:—–-]+$/, "").trim();
    if (!joined) continue;
    const cap = joined.charAt(0).toUpperCase() + joined.slice(1);
    out.push(/[.!?]$/.test(cap) ? cap : `${cap}.`);
  }
  return out.join(" ").trim() || PROBLEM_FALLBACK;
}

// CHE-334: a step our own guard refused is not part of what its journey says
// about the product — "journeys that exist only to start a check are judged up
// to the guard". execution.ts rolls up only the steps this lets through.
export function countsTowardJourney(step: Pick<ReportedStep, "selfCheckRefused">): boolean {
  return step.selfCheckRefused !== true;
}

// Bulk outbound-link verification (CHE-81 follow-up). Run #92 inventoried 200+
// YouTube links on meetbashar.com but could not "open" any (target=_blank in a
// headless page) and had to punt to "spot-check in a real browser". Links are a
// server-side fact: fetch each one. YouTube gets the oEmbed endpoint — it 4xxes
// for deleted/private/unplayable videos, which is exactly the owner's question.
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch|shorts|embed|live)|youtu\.be\/)/i;

function youtubeOembedUrl(url: string): string {
  return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
}

// CHE-104: a mailto: link cannot be fetched, but it is not unverifiable either
// — the thing that can be wrong with one is the address, and that is readable.
// Whether mail actually arrives is invisible from outside the product and is
// not a gap of ours to file. Left unhandled, run #126 reported a plain mailto:
// contact link as an unverified step, which the gap classifier then filed
// against us as "cannot complete magic-link sign-in" — a capability we do lack,
// but not the one that was in front of it.
const MAILTO_ADDRESS = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

function checkMailto(url: string): string {
  const address = url.slice("mailto:".length).split("?")[0].trim();
  if (!address) return `BROKEN empty-address ${url}`;
  const bad = address.split(",").map((a) => a.trim()).filter((a) => !MAILTO_ADDRESS.test(a));
  return bad.length ? `BROKEN malformed-address (${bad.join(", ")}) ${url}` : `OK mailto ${url}`;
}

// CHE-190: what the model is told when a link could not be reached. The line
// is tool output, not customer text — it may say "from here".
export const UNREACHABLE_INSTRUCTION =
  "could not be reached from here — that says nothing about the link; report those steps " +
  "skipped (unverifiedReason our_capability), never broken or risky.";

// CHE-190: the statuses a host uses to turn away traffic it does not like —
// a datacenter address, a missing browser fingerprint, too many of us. From
// the target itself a 403 or 503 is the product's own answer and stays
// BROKEN; from any other host it says where we fetched from, not whether the
// link works. A 429 is our own request volume wherever it comes from
// (CLAUDE.md rule 3) and is never BROKEN.
const GATING_STATUSES = new Set([403, 429, 503]);

function unreachableReason(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|abort/i.test(message)) return "timed out";
  return `connection failed: ${message.slice(0, 60)}`;
}

async function verifyLinks(input: Record<string, unknown>, targetOrigin: string, allowedOrigins: readonly string[] = []): Promise<string> {
  const raw = Array.isArray(input.urls) ? input.urls.map(String) : [];
  const mailtos = [...new Set(raw)].filter((u) => /^mailto:/i.test(u)).slice(0, 60);
  const urls = [...new Set(raw)].filter((u) => /^https?:\/\//i.test(u)).slice(0, 60);
  if (!urls.length && mailtos.length) {
    const results = mailtos.map(checkMailto);
    const broken = results.filter((r) => r.startsWith("BROKEN")).length;
    return `Checked ${results.length} mailto links — ${broken} malformed.\n${results.join("\n")}`;
  }
  if (!urls.length) return "No valid http(s) or mailto: URLs given.";

  const checkOne = async (url: string): Promise<string> => {
    const isYt = YOUTUBE_RE.test(url);
    const target = isYt ? youtubeOembedUrl(url) : url;
    try {
      const res = await fetch(target, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CheckMyApp link check)" },
      });
      const ok = res.status >= 200 && res.status < 400;
      const via = isYt ? " (via YouTube oEmbed)" : "";
      if (ok) return `OK ${res.status}${via} ${url}`;
      // The host that answered is the one after redirects, when known.
      let answeredBy = "";
      try {
        answeredBy = new URL(res.url || target).hostname;
      } catch {
        answeredBy = "";
      }
      const gated =
        GATING_STATUSES.has(res.status) &&
        (res.status === 429 || !answeredBy || !isTargetHost(answeredBy, targetOrigin, allowedOrigins));
      if (gated) return `UNREACHABLE (HTTP ${res.status} from ${answeredBy || "the host"}) ${url}`;
      return `BROKEN ${res.status}${via} ${url}`;
    } catch (err) {
      return `UNREACHABLE (${unreachableReason(err)}) ${url}`;
    }
  };

  // Small batches: workerd caps concurrent outbound connections.
  const results: string[] = [];
  for (let i = 0; i < urls.length; i += 5) {
    results.push(...(await Promise.all(urls.slice(i, i + 5).map(checkOne))));
  }
  results.push(...mailtos.map(checkMailto));
  const broken = results.filter((r) => r.startsWith("BROKEN")).length;
  const unreachable = results.filter((r) => r.startsWith("UNREACHABLE")).length;
  const summary = `Checked ${results.length} links — ${broken} broken, ${unreachable} unreachable.`;
  const note = unreachable ? `\n${unreachable} ${UNREACHABLE_INSTRUCTION}` : "";
  return `${summary}${note}\n${results.join("\n")}`;
}

function resolveLocator(page: LocatorScope, input: Record<string, unknown>): Locator {
  if (input.selector) return page.locator(String(input.selector));
  if (input.role) {
    return page.getByRole(String(input.role) as Parameters<Page["getByRole"]>[0], {
      name: input.name ? String(input.name) : undefined,
    });
  }
  if (input.name) return page.getByText(String(input.name), { exact: false });
  throw new Error("click needs role+name, name, or selector");
}

async function screenshot(env: ToolEnv, input: Record<string, unknown> = {}): Promise<string> {
  await blurPasswordFields(env.page);
  const buffer = await env.page.screenshot({ fullPage: false });
  const url = env.onScreenshot ? await env.onScreenshot(buffer) : null;
  // CHE-169: under vision on demand the model gets the image only when it asks
  // for it — the tool's `look` flag is the model's own judgment moment.
  const wanted = env.visionScreenshots || (env.visionTriggers && input.look === true);
  if (wanted) {
    // Second capture as compressed JPEG for the model's own eyes (CHE-70):
    // evidence stays full-quality PNG, context gets ~10x smaller bytes.
    env.pendingScreenshotJpegB64 = await captureJpeg(env.page);
    if (env.visionTriggers) console.log("[harness] screenshot attached: model asked (look=true)");
    return url
      ? `Screenshot saved: ${url} — the image follows in this result; look at it before judging the step.`
      : "Screenshot captured (not persisted) — the image follows in this result.";
  }
  return url ? `Screenshot saved: ${url}` : "Screenshot captured (not persisted).";
}

// Privacy §5: blur password fields before any screenshot. Covers native
// type=password plus "show password" toggles that flip it to type=text.
// CHE-373: in every frame too — fill now types the test password into an
// embedded frame, and the screenshot shows that frame as part of the page.
async function blurPasswordFields(page: Pick<Page, "evaluate"> & Partial<Pick<Page, "frames" | "mainFrame">>): Promise<void> {
  const blur = () => {
    document
      .querySelectorAll<HTMLInputElement>(
        'input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[name*="pass" i]',
      )
      .forEach((el) => {
        el.style.filter = "blur(6px)";
      });
  };
  await page.evaluate(blur).catch(() => {});
  const frames = typeof page.frames === "function" ? childFrames(page as Page) : [];
  await Promise.all(frames.map((frame) => withinMs(frame.evaluate(blur), FRAME_EVALUATE_MS, undefined)));
}

// CHE-373: a frame still loading has no document to evaluate in yet, and
// Playwright waits for one. No read of a frame may hold the walk up.
const FRAME_EVALUATE_MS = 3_000;

function withinMs<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function drainLogs(env: ToolEnv): string {
  const net = env.networkLog.splice(0).slice(-60);
  const cons = env.consoleLog.splice(0).slice(-30);
  return [
    "NETWORK (recent):",
    net.length ? net.join("\n") : "(none)",
    "",
    "CONSOLE (recent):",
    cons.length ? cons.join("\n") : "(none)",
  ].join("\n");
}

// Structured page digest — the agent's primary "eyes". One reader for the page
// and for each embedded frame (CHE-373): evaluated inside whichever document it
// is handed, so a frame from another origin is read from within, as itself.
const PAGE_DIGEST = () => {
    const clip = (s: string | null | undefined, n = 80) =>
      (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const roots: Array<Document | ShadowRoot> = [document];
    const shadowText: string[] = [];
    const frameUrls: string[] = [];
    // Extension UI often lives in an open shadow root. Reading only document
    // controls hides its result panel even though locators can click it.
    for (let index = 0; index < roots.length && index < 50; index++) {
      for (const element of Array.from(roots[index].querySelectorAll("*")).slice(0, 10_000)) {
        if (element.shadowRoot) {
          roots.push(element.shadowRoot);
          const text = clip(element.shadowRoot.textContent, 4000);
          if (text) shadowText.push(text);
        }
        if (element instanceof HTMLIFrameElement) {
          if (element.src) frameUrls.push(element.src);
          try { if (element.contentDocument) roots.push(element.contentDocument); } catch { /* A cross-origin frame remains separately identified. */ }
        }
      }
    }
    const select = (selector: string) => roots.slice(0, 50).flatMap(root => Array.from(root.querySelectorAll(selector)));

    const headings = select("h1,h2,h3")
      .slice(0, 20)
      .map((h) => `${h.tagName.toLowerCase()}: ${clip(h.textContent)}`);

    const anchors = select("a[href]");
    const links = anchors
      .slice(0, 40)
      .map((a) => `"${clip(a.textContent, 50)}" → ${a.getAttribute("href")}`);
    // CHE-171: every href on the page, resolved by the browser, not only the
    // 40 the digest prints — a page the site links to from its footer or its
    // 200th anchor is still published.
    const hrefs = Array.from(new Set(anchors.map((a) => (a as HTMLAnchorElement).href)));

    const buttons = select('button,[role="button"],input[type="submit"]')
      .slice(0, 25)
      .map((b) => `"${clip(b.textContent || (b as HTMLInputElement).value, 50)}"${(b as HTMLButtonElement).disabled ? " (disabled)" : ""}`);

    const fields = select("input,textarea,select")
      .slice(0, 25)
      .map((i) => {
        const el = i as HTMLInputElement;
        const labelEl = el.id ? (el.getRootNode() as Document | ShadowRoot).querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        const label = clip(labelEl?.textContent ?? el.getAttribute("aria-label"), 50);
        const placeholder = clip(el.placeholder, 50);
        // Distinguish label vs placeholder — generated specs must target
        // placeholder-only fields with getByPlaceholder, not getByLabel.
        return `${el.tagName.toLowerCase()}[type=${el.type ?? "text"}]${
          label ? ` label="${label}"` : ""
        }${placeholder ? ` placeholder="${placeholder}"` : ""}${
          !label && !placeholder ? " (unlabeled)" : ""
        }`;
      });

    return {
      url: location.href,
      title: document.title,
      headings,
      links,
      hrefs,
      buttons,
      fields,
      shadowText,
      frameUrls,
      // CHE-373: shown for a frame only (see frameSections) — an embedded app's
      // status line or empty state is often plain text with no heading.
      text: clip(document.body?.innerText, 1500),
    };
};

type PageDigest = ReturnType<typeof PAGE_DIGEST>;

function digestSections(digest: PageDigest): string[] {
  return [
    `URL: ${digest.url}`,
    `TITLE: ${digest.title}`,
    `HEADINGS:\n${digest.headings.join("\n") || "(none)"}`,
    `LINKS:\n${digest.links.join("\n") || "(none)"}`,
    `BUTTONS:\n${digest.buttons.join("\n") || "(none)"}`,
    `FORM FIELDS:\n${digest.fields.join("\n") || "(none)"}`,
    ...(digest.shadowText?.length ? [`SHADOW PANELS:\n${digest.shadowText.join("\n").slice(0, 8000)}`] : []),
    ...(digest.frameUrls?.length ? [`FRAMES:\n${digest.frameUrls.join("\n")}`] : []),
  ];
}

async function readPage(env: ToolEnv): Promise<string> {
  const digest = await env.page.evaluate(PAGE_DIGEST);
  // CHE-171: the page read is published (it rendered), and so is everything
  // it links to. Relative hrefs the stub or an old digest may carry resolve
  // against the page itself.
  rememberUrls(env, [digest.url, ...(digest.hrefs ?? [])], digest.url);

  return [...digestSections(digest), ...(await frameSections(env, digest.url))].join("\n\n");
}

// CHE-373: how much of a frame the digest carries. Three frames is more than
// any embedded app has shown us (the app, perhaps a payment or chat widget);
// past that it is ads and trackers, and the context is the walk's budget.
const MAX_FRAMES_READ = 3;
const FRAME_SECTION_CHARS = 5_000;
// Smaller than this on either side is a pixel, a beacon or a hidden helper.
const MIN_FRAME_SIDE_PX = 20;

// A frame whose document the page reader already walked into: same origin as
// the page all the way up (an about:blank or srcdoc frame takes its parent's
// origin). Reading it again would print its controls twice.
function readWithPage(frame: Frame, pageOrigin: string | null): boolean {
  for (let f: Frame | null = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const origin = urlOrigin(f.url());
    if (origin === null) continue;
    if (origin !== pageOrigin) return false;
  }
  return true;
}

// A frame worth showing: big enough to be seen. When its size cannot be read
// the frame is kept — losing an app costs more than printing a widget.
async function visibleFrame(frame: Frame): Promise<boolean> {
  const element = await withinMs(frame.frameElement(), FRAME_EVALUATE_MS, null);
  if (!element) return true;
  const box = await withinMs(element.boundingBox(), FRAME_EVALUATE_MS, undefined);
  await element.dispose().catch(() => {});
  if (box === undefined) return true;
  return box !== null && box.width >= MIN_FRAME_SIDE_PX && box.height >= MIN_FRAME_SIDE_PX;
}

function meaningfulDigest(d: PageDigest): boolean {
  return Boolean(
    d.headings.length || d.links.length || d.buttons.length || d.fields.length || d.shadowText.length || (d.text ?? "").length >= 20,
  );
}

async function frameSections(env: ToolEnv, pageUrl: string): Promise<string[]> {
  const frames = childFrames(env.page);
  const pageOrigin = urlOrigin(pageUrl);
  const sections: string[] = [];
  for (let i = 0; i < frames.length && sections.length < MAX_FRAMES_READ; i++) {
    const frame = frames[i];
    if (readWithPage(frame, pageOrigin)) continue;
    // Only the product's own documents enter the prompt: the target's origin or
    // one the owner allowed. A chat widget, a payment field, a vendor's login
    // stay the "FRAMES: <src>" line they always were — their words in front of
    // the model invite findings about a third party's widget (rule 8).
    if (!mayActIn(env, frame)) continue;
    if (!(await visibleFrame(frame))) continue;
    const digest = await withinMs(frame.evaluate(PAGE_DIGEST), FRAME_EVALUATE_MS, null);
    if (!digest || !meaningfulDigest(digest)) continue;
    // What an embedded app links to is published by it, like the page's own.
    rememberUrls(env, [digest.url, ...(digest.hrefs ?? [])], digest.url);
    const name = frame.name() ? `, name ${frame.name()}` : "";
    const header = `FRAME ${i + 1} (origin ${frameOrigin(frame) ?? frame.url()}${name}) — click/fill inside it with frame "${i + 1}":`;
    const body = [...digestSections(digest), ...(digest.text ? [`TEXT:\n${digest.text}`] : [])].join("\n\n");
    // The frame's TEXT is the whole visible document, which is where an app
    // shows "signed in as …" — the test account's email never reaches the model.
    sections.push(scrubSecrets(env, `${header}\n${body}`).slice(0, FRAME_SECTION_CHARS));
  }
  return sections;
}

// Counts every DOM mutation from document creation onward. Gives interactions
// a second honest reaction signal besides the network log: "0 requests AND 0
// mutations" means the page truly ignored us (CHE-37), while "0 requests but
// N mutations" is client-side validation / in-page state change — a real
// difference the model previously could not see. Kept as a plain string so
// esbuild cannot inject helpers into it.
//
// CHE-392: it also keeps the last few pieces of TEXT that appeared — a label
// that flips to "copied ✓" for a second and a half, a toast, a validation line
// that clears. A count says the page reacted; only the text says how, and by
// the next read_page it is gone: run #294 reported "no Copied confirmation" on
// a button that had shown one, because nothing we had could see it. Each entry
// carries a running number so a click can ask for what came after it.
//
// Text is recorded only while a click is watching (__cmaWatch, a few seconds),
// and "appeared" means: a text node a person could see now that they could not
// see when the watch began. The unit is the text node, asked one by one —
// a visible block can hold a hidden or transparent error beside its "Saved",
// and a container's own text would name both. Four ways text gets there, all
// common, each one a way to report a confirmation as missing if left out:
//   - a node is added, or its text changes;
//   - a node that was in the page all along is revealed (hidden removed, a
//     class or style changed) — hence the list of what was visible at the start;
//   - a node arrives transparent and fades in — hence the second look;
//   - an accessible name changes on an icon button.
// What appeared together (one added block, one revealed block) is one piece,
// and a piece too long to be a message is a region re-rendering: read_page's.
const MUTATION_COUNTER_SCRIPT = `(() => {
  window.__cmaMutations = 0;
  window.__cmaAppeared = [];
  window.__cmaAppearedSeq = 0;
  try {
    window.__cmaMutationObserver?.disconnect();
    let watchUntil = 0;
    let baseline = null;
    let later = [];
    let timer = 0;
    const visible = (el) => !!el && el.isConnected && !el.closest('script,style,noscript,template') &&
      (typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    const shown = (textNode) => visible(textNode.parentElement || (textNode.parentNode && textNode.parentNode.host));
    const note = (raw) => {
      const text = String(raw == null ? '' : raw).replace(/\\s+/g, ' ').trim();
      if (!text || text.length > ${APPEARED_MAX_CHARS}) return;
      const log = window.__cmaAppeared;
      if (log.length && log[log.length - 1].t === text) return;
      log.push({ n: ++window.__cmaAppearedSeq, t: text });
      if (log.length > 40) log.splice(0, log.length - 40);
    };
    // Mutations do not cross a shadow boundary, and neither does a tree walk:
    // a copy button inside a web component would change its label unseen and
    // uncounted. Every open shadow root met on a walk is walked too, and
    // watched from then on. (A closed one is closed to us as to any script.)
    const OPTIONS = { subtree: true, childList: true, attributes: true, characterData: true };
    const watched = new WeakSet();
    const enter = (shadow, limit, found) => {
      if (!watched.has(shadow)) { watched.add(shadow); observer.observe(shadow, OPTIONS); }
      walk(shadow, limit, found);
    };
    const walk = (root, limit, found) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let steps = 0;
      while (found.length < limit && steps++ < limit * 20 && walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeType === 3) { if (node.data.trim()) found.push(node); }
        else if (node.shadowRoot) enter(node.shadowRoot, limit, found);
      }
    };
    const textNodes = (root, limit) => {
      if (root.nodeType === 3) return root.data.trim() ? [root] : [];
      if (root.nodeType !== 1) return [];
      const found = [];
      if (root.shadowRoot) enter(root.shadowRoot, limit, found);
      walk(root, limit, found);
      return found;
    };
    const say = (nodes) => {
      const seen = nodes.filter(shown);
      if (seen.length) note(seen.map((n) => n.data).join(' '));
      return seen.length > 0;
    };
    const consider = (nodes) => {
      if (nodes.length && !say(nodes) && later.length < 100) later.push(nodes);
    };
    const lookAgain = () => {
      timer = 0;
      later = later.filter((nodes) => nodes.some((n) => n.isConnected) && !say(nodes));
      if (later.length && Date.now() < watchUntil) timer = setTimeout(lookAgain, 250);
      else later = [];
    };
    const REVEALS = { class: 1, style: 1, hidden: 1, 'aria-hidden': 1, open: 1 };
    const observer = new MutationObserver((records) => {
      window.__cmaMutations += records.length;
      if (Date.now() > watchUntil) return;
      for (const r of records) {
        try {
          if (r.type === 'characterData') consider(textNodes(r.target, 1));
          else if (r.type === 'childList') {
            for (const added of r.addedNodes) consider(textNodes(added, 400));
          } else if (r.attributeName === 'aria-label' || r.attributeName === 'title') {
            if (visible(r.target)) note(r.target.getAttribute(r.attributeName));
          } else if (baseline && REVEALS[r.attributeName]) {
            consider(textNodes(r.target, 4000).filter((n) => !baseline.has(n)));
          }
        } catch (e) {}
      }
      if (later.length && !timer) timer = setTimeout(lookAgain, 120);
    });
    observer.observe(document, OPTIONS);
    window.__cmaMutationObserver = observer;
    window.__cmaWatch = () => {
      watchUntil = Date.now() + 6000;
      later = [];
      baseline = null;
      try {
        // This walk is also what finds the shadow roots there are now.
        const all = textNodes(document.documentElement, 30000);
        // A page too large to list is one where "revealed" cannot be told from
        // "was there": reveals are then not reported at all, rather than wrongly.
        if (all.length < 30000) {
          baseline = new WeakSet();
          for (const node of all) if (shown(node)) baseline.add(node);
        }
      } catch (e) {}
      return window.__cmaAppearedSeq;
    };
  } catch (e) {}
})();`;

// Prepare a fresh page for agent use: the __name shim works around esbuild
// (tsx) injecting `__name(...)` helper calls into functions that Playwright
// serializes for page.evaluate — without it every evaluate throws
// "ReferenceError: __name is not defined" in the browser.
export async function prepareAgentPage(env: ToolEnv): Promise<void> {
  await env.page.addInitScript("window.__name = (fn) => fn;");
  await env.page.addInitScript(MUTATION_COUNTER_SCRIPT);
  if (env.extension) {
    await env.page.evaluate("window.__name = (fn) => fn;");
    await env.page.evaluate(MUTATION_COUNTER_SCRIPT);
  }
  attachLogCapture(env);
}

// Wire rolling network/console capture into a page. Call once per context.
export function attachLogCapture(env: ToolEnv): void {
  env.page.on("response", (res) => {
    env.networkLog.push(`${res.request().method()} ${res.url()} → ${res.status()}`);
    if (env.networkLog.length > 200) env.networkLog.splice(0, 100);
  });
  env.page.on("console", (msg) => {
    env.consoleLog.push(`[${msg.type()}] ${msg.text().slice(0, 300)}`);
    if (env.consoleLog.length > 100) env.consoleLog.splice(0, 50);
  });
}
