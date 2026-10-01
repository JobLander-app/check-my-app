// Entering a store's storefront password (CHE-372).
//
// A password-protected Shopify store sends every storefront address to
// /password. Runs #281–#283 on securify-demo.myshopify.com walked into that
// page from every journey and verified nothing else. The owner can give us the
// store password the way they give us a test login; this is what uses it.
//
// Done in code, never by the model: the model never sees the value (it is not
// a placeholder it may type — scrubSecrets redacts it from everything the tools
// return), and whether the page in front of it is the gate is decided here,
// after every navigation, not by a prompt asking it to notice. Every phase
// builds a fresh browser context — surface scan, smoke, discovery, each walk,
// the replay audit — and the store's unlock cookie lives in that context, so
// each of them passes through here (the scan and the smoke directly, the rest
// through the navigate tool).
//
// One attempt per run, like a test login (CHE-100, src/agent/credentials.ts):
// a store password the store turns away is recorded on the run
// (Run.storePasswordRejected) and never submitted again by any later phase.
// The run then says which input to fix — "the store password was not
// accepted" — instead of retrying it on every page.
//
// No Playwright runtime here, only its types, so scripts/verify-store-password.ts
// drives the real function against a fake page on plain Node.

import type { Page } from "@cloudflare/playwright";
import { isStoreGateUrl } from "@/lib/store-gate";

/** The slice of a page the unlock uses — a fake can supply it. */
export type UnlockPage = Pick<Page, "url" | "locator" | "waitForURL">;

export type UnlockOutcome =
  /** Not the store's password page: nothing to do. */
  | "not_gate"
  /** The gate, and no store password on this run. */
  | "no_password"
  /** The gate, and the store already turned our password away this run. */
  | "already_rejected"
  /** The gate's address, but no password field on it to fill. */
  | "no_field"
  /** The field could not be filled or submitted — our hands, not the store. */
  | "undriven"
  /** Submitted, and the store let us through. */
  | "unlocked"
  /** Submitted, and the store kept us on its password page. */
  | "rejected";

export interface StoreAccess {
  /** Decrypted in memory for this phase only. Undefined = none on this run. */
  password?: string;
  /** Shared by every page of a phase, seeded from Run.storePasswordRejected. */
  state?: { rejected: boolean };
  /** Persists the rejection on the run, so the next phase starts knowing it. */
  onRejected?: () => Promise<void>;
}

/** How long the store gets to move us off /password after the submit. */
export const STORE_UNLOCK_WAIT_MS = 20_000;

const PASSWORD_FIELD = 'input[type="password"]';

export async function unlockStoreGate(
  page: UnlockPage,
  target: string,
  access: StoreAccess,
  waitMs: number = STORE_UNLOCK_WAIT_MS,
): Promise<UnlockOutcome> {
  if (!isStoreGateUrl(page.url(), target)) return "not_gate";
  if (!access.password) return "no_password";
  if (access.state?.rejected) return "already_rejected";

  const field = page.locator(PASSWORD_FIELD).first();
  if ((await field.count().catch(() => 0)) === 0) return "no_field";
  try {
    await field.fill(access.password, { timeout: 8_000 });
    await field.press("Enter", { timeout: 8_000 });
  } catch (err) {
    // Nothing reached the store, so nothing was turned away: not a rejection.
    console.warn(`[store-password] could not submit the password form: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    return "undriven";
  }
  // A wrong password re-renders /password; a right one redirects off it. The
  // wait ends early on the redirect and runs out on the re-render.
  await page
    .waitForURL((u) => !isStoreGateUrl(u.toString(), target), { timeout: waitMs, waitUntil: "domcontentloaded" })
    .catch(() => {});
  if (!isStoreGateUrl(page.url(), target)) return "unlocked";

  if (access.state) access.state.rejected = true;
  await access.onRejected?.();
  return "rejected";
}

/** True for the two outcomes that leave the store locked because of our password. */
export function storeRefused(outcome: UnlockOutcome): boolean {
  return outcome === "rejected" || outcome === "already_rejected";
}
