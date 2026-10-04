"use server";

import { cookies } from "next/headers";
import { refuseSelfCheck } from "@/lib/self-check-action";
import { parseTheme, THEME_COOKIE, type Theme } from "@/lib/theme";

// Remembers the theme in this browser (CHE-414). No account is consulted: the
// cookie is the whole record, and it is the browser's, so nothing here needs
// the person to be anyone in particular. Setting a cookie in an action makes
// Next re-render the open page from the root, which is where <html> reads it —
// the colours change in place, with no reload and no second paint.
export async function setThemeAction(theme: Theme): Promise<void> {
  // Writes nothing of ours — but every action starts with the guard, so that
  // "stores nothing" is never a claim an action gets to make for itself.
  await refuseSelfCheck("/settings/account");
  const jar = await cookies();
  const chosen = parseTheme(theme);
  if (chosen === "system") {
    jar.delete(THEME_COOKIE);
    return;
  }
  jar.set(THEME_COOKIE, chosen, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    // A year, like the active team: a preference, not a credential.
    maxAge: 60 * 60 * 24 * 365,
  });
}
