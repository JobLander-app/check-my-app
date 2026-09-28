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
import type { Page } from "@cloudflare/playwright";
import { credentialFingerprint } from "@/lib/crypto";
import {
  hasEnvironmentLeak,
  MACHINERY_TERMS,
  NOT_DEFECT_FALLBACK,
  PROBLEM_FALLBACK,
  productProse,
  productStepLabel,
  SELF_CHECK_REFUSED_OBSERVED,
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

export interface ToolEnv {
  page: Page;
  extension?: ExtensionBrowser;
  // Origin the agent is allowed to touch. Credential substitution and
  // navigation are hard-refused off this origin (defence vs prompt injection).
  targetOrigin: string;
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
      surface?: { kind: "native_popup"; extensionId: string; targetId: string };
      outcome: { urlAfter: string; navigated: boolean | null; requests: number | null; mutations: number | null };
    }
  | {
      kind: "fill";
      label?: string;
      selector?: string;
      value: string;
      surface?: { kind: "native_popup"; extensionId: string; targetId: string };
      outcome: { urlAfter: string };
    };

function recordAction(env: ToolEnv, action: RecordedAction): void {
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
  return out;
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
      "Read a structured digest of the current page: title, headings, links, buttons, form fields, landmarks. Call after navigation or any action that changes the page. Prefer this over screenshots for deciding what to do next.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "click",
    description:
      "Click an element. Identify it by role and accessible name (preferred) or CSS selector.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", description: 'ARIA role, e.g. "button", "link"' },
        name: { type: "string", description: "Accessible name (visible text/label)" },
        selector: { type: "string", description: "CSS selector fallback" },
      },
    },
  },
  {
    name: "fill",
    description:
      "Fill an input. Use placeholders {{TEST_EMAIL}} and {{TEST_PASSWORD}} for the provided test credentials, or {{TEST_EMAIL:<label>}} / {{TEST_PASSWORD:<label>}} for a named test account — never ask for or invent real credentials.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Field label, placeholder or accessible name" },
        selector: { type: "string", description: "CSS selector fallback" },
        value: { type: "string", description: "Text, or {{TEST_EMAIL}} / {{TEST_PASSWORD}}, or {{TEST_EMAIL:<label>}} / {{TEST_PASSWORD:<label>}}" },
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

export async function executeTool(
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
        return await verifyLinks(input, env.targetOrigin);
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
        // The model occasionally invents enum values — coerce to the schema.
        const valid = ["ok", "risky", "confusing", "broken", "exposed", "skipped"];
        if (!valid.includes(step.status)) step.status = "confusing";
        // CHE-334: only coerceSelfCheck403 may say a step was our own guard.
        delete step.selfCheckRefused;
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
  if (target.origin !== env.targetOrigin) {
    return `Refused: ${target.origin} is outside the target app (${env.targetOrigin}). Stay on the target.`;
  }
  const logBefore = env.networkLog.length;
  const res = await env.page.goto(target.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  // Give client JS a real chance to hydrate: clicking a not-yet-interactive
  // button is the #1 source of false "broken" findings on React/Next targets.
  await waitForHydration(env.page, 3_000);
  const status = res?.status() ?? null;
  // Resolved, not as the model typed it: a relative URL only means something
  // next to the page it was typed on, and a replay starts from a blank one.
  recordAction(env, {
    kind: "navigate",
    url: target.toString(),
    outcome: { urlAfter: env.page.url(), status },
  });
  // CHE-171: a 404/410 on an address nothing has published is not a fact
  // about the product — no user arrives there. Decided against the set, not
  // the model's story about the URL ("the documented landing URL" was the
  // story in run #142). The refusal is the answer; there is nothing on such a
  // page for the CHE-169 look to judge, and the address is NOT remembered,
  // so typing it twice does not make it real.
  if ((status === 404 || status === 410) && env.knownUrls && !isKnownUrl(env, target.toString())) {
    console.warn(`[navigate] ${status} on an unpublished address: ${target.toString()}`);
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
    console.warn(`[navigate] self-check refused by the product: ${env.page.url()}`);
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
export function errorResponseIn(entries: string[], targetOrigin: string): string | null {
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
    if (origin === targetOrigin) return line;
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
    errorResponseIn(action.requests, env.targetOrigin) ??
    (action.status != null && action.status >= 400 ? `HTTP ${action.status} on navigate` : null);
  if (err) return attachLook(env, `error response (${err})`);
  if (await mediaSignals(env)) return attachLook(env, "media/WebRTC signals on the page");
  return "";
}

// Hydration gate before interacting: full load, then a double-rAF tick (lets
// the framework flush the effects that attach event listeners), then a capped
// network-idle wait (hydration chunks still in flight). Every wait is
// best-effort — a chatty page must not stall the walk.
async function waitForHydration(page: Page, networkIdleMs: number): Promise<void> {
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
}

async function snapshotReaction(env: ToolEnv): Promise<ReactionSnapshot> {
  const mut = await env.page.evaluate("window.__cmaMutations || 0").catch(() => 0);
  return { net: env.networkLog.length, mut: Number(mut) || 0, url: env.page.url() };
}

interface Reaction {
  requests: number;
  mutations: number;
  navigated: boolean;
}

// Let the page settle after an interaction, then measure what it did: network
// requests, DOM mutations, navigation. Navigation resets the mutation counter
// (fresh document), so it is reported as its own definitive signal.
async function settleAndMeasure(env: ToolEnv, before: ReactionSnapshot): Promise<Reaction> {
  await env.page.waitForLoadState("domcontentloaded").catch(() => {});
  await env.page.waitForTimeout(1_200);
  const after = await snapshotReaction(env);
  const navigated = after.url !== before.url;
  return {
    requests: Math.max(after.net - before.net, 0),
    mutations: navigated ? after.mut : Math.max(after.mut - before.mut, 0),
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
  const target = (await resolveClickTarget(env.page, input)).first();
  const sessionRefusal = await env.extension?.guardClick(target);
  if (sessionRefusal) return sessionRefusal;
  // Never interact before hydration: a click landing before listeners attach
  // is indistinguishable from a dead button.
  await waitForHydration(env.page, 1_500);
  const before = await snapshotReaction(env);

  // CHE-214: a click that could not be PERFORMED is our limitation and says
  // nothing about the control. A click that was performed and produced nothing
  // is a different animal and keeps its fallbacks below.
  try {
    await target.click({ timeout: 8_000 });
  } catch (err) {
    if (!isUndrivable(err)) throw err;
    return recordUndriven(env, "click", label ?? String(input.selector ?? "control"), err);
  }
  let reaction = await settleAndMeasure(env, before);
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
        reaction = await settleAndMeasure(env, before);
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
          reaction = await settleAndMeasure(env, before);
          if (!isInert(reaction))
            strategy = "synthetic event dispatch fallback (untrusted events; trusted click was inert)";
        }
      }
    }
  }

  // CHE-129: the click happened (whatever the page made of it), so it is part
  // of the path. Recorded before the rejection/inert returns below because
  // those are readings of the outcome, not reasons the action did not run.
  recordAction(env, {
    kind: "click",
    ...(input.role ? { role: String(input.role) } : {}),
    ...(input.name ? { name: String(input.name) } : {}),
    ...(input.selector ? { selector: String(input.selector) } : {}),
    outcome: {
      urlAfter: env.page.url(),
      navigated: reaction.navigated,
      requests: reaction.requests,
      mutations: reaction.mutations,
    },
  });
  // CHE-171: wherever a click lands, the product itself took the user there.
  rememberUrls(env, [env.page.url()]);

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
      `Clicked, but the page did not react AT ALL: 0 network requests and 0 DOM mutations ` +
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
  return `Clicked (strategy: ${strategy}). Current URL: ${env.page.url()} (${observed}).${note}${ledgerNudge}${looked}`;
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
  if (usedSecret) {
    try {
      if (new URL(env.page.url()).origin !== env.targetOrigin) {
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
  if (usedSecret) env.activeAccount = accounts[accounts.length - 1];
  // Fingerprint only (sha256 prefix + length), never the value: lets a cred
  // mismatch be localized to save vs store vs fill without exposing anything.
  for (const label of usedSecret ? accounts : []) {
    const password = accountFor(env, label)?.password;
    if (password) console.log(`[fill] substituting test password for "${label}": ${credentialFingerprint(password)}`);
  }

  const page = env.page;
  const label = input.label ? String(input.label) : undefined;
  const locator = input.selector
    ? page.locator(String(input.selector))
    : label
      ? page
          .getByLabel(label)
          .or(page.getByPlaceholder(label))
          .or(page.getByRole("textbox", { name: label }))
      : page.locator("input:visible");

  const field = locator.first();
  const fixtureRefusal = await env.extension?.guardFixtureControl(field);
  if (fixtureRefusal) return fixtureRefusal;
  // Same hydration gate as click: values typed before listeners attach are
  // silently dropped by controlled inputs.
  await waitForHydration(page, 1_000);
  const named = label ?? (input.selector ? String(input.selector) : "field");
  const landed = () => {
    recordAction(env, {
      kind: "fill",
      ...(label ? { label } : {}),
      ...(input.selector ? { selector: String(input.selector) } : {}),
      value: recordedValue,
      outcome: { urlAfter: env.page.url() },
    });
    return usedSecret ? "Filled (credential substituted server-side)." : "Filled.";
  };

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

// Exact accessible name first (CHE-79): getByRole's `name` matches SUBSTRINGS,
// so clicking "Continue" on a Clerk modal picked "Continue with Google" (it
// sits above the form in DOM order) and bounced the agent into OAuth — a false
// broken/high on our own sign-in. When an exact-name match exists it wins;
// the substring behavior stays as the fallback for the model's loose labels.
async function resolveClickTarget(page: Page, input: Record<string, unknown>) {
  if (input.role && input.name) {
    const exact = page.getByRole(String(input.role) as Parameters<Page["getByRole"]>[0], {
      name: String(input.name),
      exact: true,
    });
    if ((await exact.count().catch(() => 0)) > 0) return exact;
  }
  return resolveLocator(page, input);
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
export function isTargetHost(hostname: string, targetOrigin: string): boolean {
  let target: string;
  try {
    target = bareHost(new URL(targetOrigin).hostname);
  } catch {
    return false;
  }
  const host = bareHost(hostname);
  return host === target || host.endsWith(`.${target}`);
}

function evidenceAgainstProduct(text: string, targetOrigin: string): boolean {
  for (const sentence of splitSentences(text)) {
    if (CONSOLE_EVIDENCE.test(sentence)) return true;
    if (!HTTP_ERROR_STATUS.test(sentence) || /\bUNREACHABLE\b/.test(sentence)) continue;
    const hosts = citedHosts(sentence);
    const foreign = hosts.filter((h) => !isTargetHost(h, targetOrigin));
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

export function coerceUnreachable(step: ReportedStep, env: Pick<ToolEnv, "targetOrigin">): void {
  if (step.status !== "risky" && step.status !== "confusing" && step.status !== "broken") return;
  const text = `${step.observed ?? ""} ${step.attempted ?? ""}`;
  if (!EGRESS_PHRASE.test(text)) return;
  const foreign = citedHosts(text).filter((h) => !isTargetHost(h, env.targetOrigin));
  // A timeout with no foreign host named is about the product itself unless
  // the tool's own word is there — verify_links names UNREACHABLE and nothing
  // else does.
  if (foreign.length === 0 && !/\bUNREACHABLE\b/.test(text)) return;
  if (evidenceAgainstProduct(text, env.targetOrigin)) return;
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
  // belongs to.
  if (step.status === "ok" || step.status === "exposed") return;
  // Otherwise the refusals noted since the last report belong to this step
  // and to no later one, whatever is decided below — including the log lines
  // they came from, which stay in the rolling log and must not be read again
  // as the next step's evidence.
  const noted = env.selfCheckRefusals?.splice(0) ?? [];
  const attributed = attributedRefusals(env);
  for (const line of noted) attributed.add(line);
  const text = `${step.observed ?? ""} ${step.attempted ?? ""}`;
  // A server error or an exception is the product's own word; a 403 next to
  // it is not the story.
  if (/\b5\d{2}\b/.test(step.observed ?? "")) return;
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
  } else if (PRODUCT_OWN_EVIDENCE.test(step.observed ?? "")) {
    return;
  }
  console.warn(
    `[report_step] "${step.label}": ${step.status} on our own self-check guard (${noted[0] ?? "a refusal in the step or the log"}) → skipped`,
  );
  step.status = "skipped";
  step.unverifiedReason = "not_applicable";
  step.gapClass = undefined;
  step.selfCheckRefused = true;
  step.observed = SELF_CHECK_REFUSED_OBSERVED;
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

async function verifyLinks(input: Record<string, unknown>, targetOrigin: string): Promise<string> {
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
        (res.status === 429 || !answeredBy || !isTargetHost(answeredBy, targetOrigin));
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

function resolveLocator(page: Page, input: Record<string, unknown>) {
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
async function blurPasswordFields(page: Pick<Page, "evaluate">): Promise<void> {
  await page
    .evaluate(() => {
      document
        .querySelectorAll<HTMLInputElement>(
          'input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[name*="pass" i]',
        )
        .forEach((el) => {
          el.style.filter = "blur(6px)";
        });
    })
    .catch(() => {});
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

// Structured page digest — the agent's primary "eyes".
async function readPage(env: ToolEnv): Promise<string> {
  const digest = await env.page.evaluate(() => {
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
    };
  });
  // CHE-171: the page read is published (it rendered), and so is everything
  // it links to. Relative hrefs the stub or an old digest may carry resolve
  // against the page itself.
  rememberUrls(env, [digest.url, ...(digest.hrefs ?? [])], digest.url);

  return [
    `URL: ${digest.url}`,
    `TITLE: ${digest.title}`,
    `HEADINGS:\n${digest.headings.join("\n") || "(none)"}`,
    `LINKS:\n${digest.links.join("\n") || "(none)"}`,
    `BUTTONS:\n${digest.buttons.join("\n") || "(none)"}`,
    `FORM FIELDS:\n${digest.fields.join("\n") || "(none)"}`,
    ...(digest.shadowText?.length ? [`SHADOW PANELS:\n${digest.shadowText.join("\n").slice(0, 8000)}`] : []),
    ...(digest.frameUrls?.length ? [`FRAMES:\n${digest.frameUrls.join("\n")}`] : []),
  ].join("\n\n");
}

// Counts every DOM mutation from document creation onward. Gives interactions
// a second honest reaction signal besides the network log: "0 requests AND 0
// mutations" means the page truly ignored us (CHE-37), while "0 requests but
// N mutations" is client-side validation / in-page state change — a real
// difference the model previously could not see. Kept as a plain string so
// esbuild cannot inject helpers into it.
const MUTATION_COUNTER_SCRIPT = `(() => {
  window.__cmaMutations = 0;
  try {
    window.__cmaMutationObserver?.disconnect();
    const observer = new MutationObserver((records) => { window.__cmaMutations += records.length; });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__cmaMutationObserver = observer;
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
