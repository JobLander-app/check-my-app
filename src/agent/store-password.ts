// Entering a store's storefront password (CHE-372).
//
// A password-protected Shopify store sends every storefront address to
// /password. Runs #281–#283 on securify-demo.myshopify.com walked into that
// page from every journey and verified nothing else. The owner can give us the
// store password the way they give us a test login; this is what uses it.
//
// Done in code, never by the model: the model never sees the value (there is
// no placeholder for it, and scrubSecrets redacts it from everything the tools
// return), and whether the page in front of it is the gate is decided here,
// after every navigation, not by a prompt asking it to notice. Every phase
// builds a fresh browser context — surface scan, smoke, discovery, each walk,
// the replay audit — and the store's unlock cookie lives in that context, so
// each of them passes through here.
//
// What is typed where, and how often:
//   - only into Shopify's own storefront-password form (a form carrying
//     form_type=storefront_password), submitted by POST to the target's own
//     origin over https. An app's ordinary change-password page at /password
//     is not the gate; a gate that would put the password in a URL (GET) is
//     refused rather than leaked into the trail, the logs and the run.
//   - a password the store accepted is entered once per browser context — the
//     unlock lives in that context's cookie, so a new phase enters it again.
//   - a password the store turned away is never submitted again in the run,
//     and neither is one whose outcome we do not know: the run records
//     "pending" BEFORE each submission (Run.storePasswordState), and a
//     submission that threw, or a result we could not record, leaves it there.
//     A write that fails before submitting means nothing is submitted. Fail
//     closed: one lost check is cheaper than a store hammered with a password.
//
// No Playwright runtime here, only its types, so scripts/verify-store-password.ts
// drives the real function against a fake page on plain Node.

import type { Page } from "@cloudflare/playwright";
import { isStoreGateUrl } from "@/lib/store-gate";

/** The slice of a page the unlock uses — a fake can supply it. */
export type UnlockPage = Pick<Page, "url" | "locator" | "waitForURL" | "evaluate">;

export type StoreState = "untried" | "pending" | "accepted" | "rejected";

export type UnlockOutcome =
  /** Not the store's storefront-password page: nothing to do. */
  | "not_gate"
  /** The gate, and no store password on this run. */
  | "no_password"
  /** The gate, and the store already turned our password away this run. */
  | "already_rejected"
  /** The gate, and an earlier submission's outcome is unknown: not resubmitted. */
  | "unconfirmed"
  /** The gate's form would not take it safely (not POST to the store itself). */
  | "unsafe_form"
  /** No password field to fill on the gate. */
  | "no_field"
  /** The field could not be filled, or the attempt could not be recorded first. */
  | "undriven"
  /** Submitted, and the store let us through. */
  | "unlocked"
  /** Submitted, and the store kept us on its password page. */
  | "rejected";

export interface StoreAccess {
  /** Decrypted in memory for this phase only. Undefined = none on this run. */
  password?: string;
  /** Shared by every page of a phase, seeded from Run.storePasswordState. */
  state?: { status: StoreState };
  /** Persists a state on the run. False = the write failed. */
  persist?: (status: Exclude<StoreState, "untried">) => Promise<boolean>;
}

/** How long the store gets to move us off /password after the submit. */
export const STORE_UNLOCK_WAIT_MS = 20_000;

// Shopify's storefront password form, and only it. A plain string so esbuild
// cannot inject helpers into what Playwright serializes.
const GATE_FORM_SCRIPT = `(() => {
  try {
    for (const f of Array.from(document.querySelectorAll('form'))) {
      const t = f.querySelector('input[name="form_type"]');
      if (!t || t.value !== 'storefront_password') continue;
      if (!f.querySelector('input[type="password"]')) continue;
      return { storefront: true, method: (f.getAttribute('method') || 'get').toLowerCase(), action: f.action || location.href };
    }
  } catch (e) {}
  return { storefront: false, method: '', action: '' };
})()`;

const GATE_FIELD = 'form:has(input[name="form_type"][value="storefront_password"]) input[type="password"]';

interface GateForm {
  storefront: boolean;
  method: string;
  action: string;
}

async function gateForm(page: Pick<Page, "evaluate">): Promise<GateForm> {
  const raw = (await page.evaluate(GATE_FORM_SCRIPT).catch(() => null)) as Partial<GateForm> | null;
  return raw && typeof raw === "object" && raw.storefront === true
    ? { storefront: true, method: String(raw.method ?? ""), action: String(raw.action ?? "") }
    : { storefront: false, method: "", action: "" };
}

/** Is the page the store's storefront-password page — its address and Shopify's form? */
export async function onStoreGate(page: Pick<Page, "url" | "evaluate">, target: string): Promise<boolean> {
  if (!isStoreGateUrl(page.url(), target)) return false;
  return (await gateForm(page)).storefront;
}

function postsToStore(form: GateForm, target: string): boolean {
  if (form.method !== "post") return false;
  try {
    return new URL(form.action).origin === new URL(target).origin && new URL(form.action).protocol === "https:";
  } catch {
    return false;
  }
}

export async function unlockStoreGate(
  page: UnlockPage,
  target: string,
  access: StoreAccess,
  waitMs: number = STORE_UNLOCK_WAIT_MS,
): Promise<UnlockOutcome> {
  if (!isStoreGateUrl(page.url(), target)) return "not_gate";
  const form = await gateForm(page);
  if (!form.storefront) return "not_gate";
  if (!access.password) return "no_password";
  const state = access.state ?? { status: "untried" as StoreState };
  if (state.status === "rejected") return "already_rejected";
  if (state.status === "pending") return "unconfirmed";
  if (!postsToStore(form, target)) return "unsafe_form";

  const field = page.locator(GATE_FIELD).first();
  if ((await field.count().catch(() => 0)) === 0) return "no_field";
  try {
    await field.fill(access.password, { timeout: 8_000 });
  } catch (err) {
    // Nothing reached the store: not an attempt.
    console.warn(`[store-password] could not fill the password field: ${errLine(err)}`);
    return "undriven";
  }
  // The attempt is on the run before it happens. If it cannot be recorded,
  // it does not happen.
  if (access.persist && !(await access.persist("pending"))) return "undriven";
  state.status = "pending";
  let submitted = true;
  try {
    await field.press("Enter", { timeout: 8_000 });
  } catch (err) {
    // The submit may or may not have reached the store. Unknown = attempted.
    submitted = false;
    console.warn(`[store-password] the submit did not complete: ${errLine(err)}`);
  }
  // A wrong password re-renders /password; a right one redirects off it. The
  // wait ends early on the redirect and runs out on the re-render.
  await page
    .waitForURL((u) => !isStoreGateUrl(u.toString(), target), { timeout: waitMs, waitUntil: "domcontentloaded" })
    .catch(() => {});
  if (!isStoreGateUrl(page.url(), target)) {
    state.status = "accepted";
    // A lost write leaves "pending" on the run: later phases stay away. Closed.
    await access.persist?.("accepted");
    return "unlocked";
  }
  if (!submitted) return "unconfirmed";
  state.status = "rejected";
  await access.persist?.("rejected");
  return "rejected";
}

function errLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
}

/** True for the two outcomes that leave the store locked because the store refused our password. */
export function storeRefused(outcome: UnlockOutcome): boolean {
  return outcome === "rejected" || outcome === "already_rejected";
}

/** True for the outcomes where the store is locked because of our own hands or bookkeeping. */
export function storeUndriven(outcome: UnlockOutcome): boolean {
  return outcome === "undriven" || outcome === "no_field" || outcome === "unconfirmed" || outcome === "unsafe_form";
}
