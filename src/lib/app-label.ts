// CHE-457: what an app is called, in one place.
//
// An app's address key (`appSlug`) is what its watch, its checks and its
// history hang on, so it never changes, and it reads badly for the apps that
// need a name most: "admin.shopify.com" for an app connected before #288,
// "shopify:8mrftg-tk/otp-plus-sso" after. `App.name` is what the team calls
// it; when it is unset, an extension is called by its own name and anything
// else by its address, as before.
//
// A Shopify app is an app checked inside the Shopify admin (targetKind
// "session" — the only apps that kind holds). Every list marks each app with
// what it is: a Shopify app, an extension, a website.

import { extensionDisplayName } from "@/lib/extension-target";

export const APP_NAME_MAX = 60;

/** The name as written: trimmed, inner whitespace collapsed; "" clears it (null). */
export function checkAppName(raw: string): { ok: true; name: string | null } | { ok: false; error: string } {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { ok: true, name: null };
  if ([...name].length > APP_NAME_MAX) return { ok: false, error: `An app's name is at most ${APP_NAME_MAX} characters.` };
  return { ok: true, name };
}

type Labelled = { name?: string | null; appSlug: string; targetKind: string; targetUrl: string };

export function appLabel(app: Labelled, extensionEvidence?: string | null): string {
  if (app.name?.trim()) return app.name.trim();
  return app.targetKind === "extension" ? extensionDisplayName(app.targetUrl, extensionEvidence) : app.appSlug;
}

// What the mark beside the name shows (src/components/app-mark.tsx). Anything
// that is neither checked inside the Shopify admin nor an extension is a website.
export type AppKind = "shopify" | "extension" | "web";

export function appKind(app: { targetKind: string }): AppKind {
  return app.targetKind === "session" ? "shopify" : app.targetKind === "extension" ? "extension" : "web";
}
