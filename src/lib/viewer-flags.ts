// Feature flags for the person looking at a page (CHE-320). The flag logic
// lives in src/lib/feature-flags.ts; this file only answers "who is asking",
// from the same places every page already uses: Clerk for the session, the
// D1 mirror for the e-mail and the test-account mark.

import { getOptionalUser } from "./auth";
import { getDbFromContext } from "./db";
import {
  evaluateFlag,
  HOME_EXTENSION_CHECK_FLAG,
  LENS_MARKETING_FLAG,
  LENS_PRODUCT_FLAG,
  LENS_RELEASE_FLAG,
} from "./feature-flags";

type FlagUser = { clerkUserId: string; email: string; isTestAccount: boolean };

function flagFor(key: string, user: FlagUser | null): Promise<boolean> {
  return evaluateFlag(
    key,
    user ? { distinctId: user.clerkUserId, email: user.email, isTestAccount: user.isTestAccount } : null,
  );
}

/**
 * May this person start a Chrome-extension check from the UI? Off for the
 * public (owner, 2026-09-27) and for test accounts, which see what a stranger
 * sees (CHE-334); on for the owner. For pages that already hold the user row.
 */
export function extensionCheckFor(user: FlagUser | null): Promise<boolean> {
  return flagFor(HOME_EXTENSION_CHECK_FLAG, user);
}

/** The same answer for a public page, which may have no one signed in. */
export async function viewerExtensionCheck(): Promise<boolean> {
  return extensionCheckFor(await getOptionalUser(await getDbFromContext()));
}

/**
 * Does this person see the Product lens (CHE-352)? On for the owner only; off
 * for the public and for test accounts. When off, the sidebar has no Product
 * group and its routes answer 404.
 */
export function productLensFor(user: FlagUser | null): Promise<boolean> {
  return flagFor(LENS_PRODUCT_FLAG, user);
}

/** The Marketing lens (CHE-352): off for everyone, and not rendered at all while off. */
export function marketingLensFor(user: FlagUser | null): Promise<boolean> {
  return flagFor(LENS_MARKETING_FLAG, user);
}

/** The Release lens (CHE-367): on for the owner only until it is proven, then public. */
export function releaseLensFor(user: FlagUser | null): Promise<boolean> {
  return flagFor(LENS_RELEASE_FLAG, user);
}
