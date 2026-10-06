// CHE-419: every sentence the store sign-in page shows, in one pure module, so
// the language guards (src/lib/verdict-language.ts: hasEnvironmentLeak,
// hasHomework) run over all of it in scripts/verify-live-view.ts. The page is
// about the person's store and their sign-in — never about the machinery that
// shows it (Codex on #287: "Opening the browser…" was ours, not theirs).
//
// The session host sends a code, never a sentence (viewer.mjs `{t:"error",
// code}`): the words live here, under the guards.

export const SIGN_IN_COPY = {
  title: (store: string) => `Sign in to ${store}`,
  intro:
    "Sign in the way you always do. Checks of this app open it from inside your admin, so they need you signed in; " +
    "when the sign-in ends, we will ask you to come back here.",
  unavailable: "Signing in is not available right now. Try again in a few minutes.",
  connecting: "Opening the sign-in page…",
  live: "Click into the page and sign in. Paste works as usual (⌘V / Ctrl+V).",
  signedIn: (store: string) => `Signed in to ${store}. Checks of this app will open it from your admin. You can close this page —`,
  backToApp: "back to the app",
  connectionEnded: "The connection ended. Reload this page to continue.",
} as const;

export type SignInErrorCode = "busy" | "idle" | "failed" | "closed";

export const SIGN_IN_ERRORS: Record<SignInErrorCode, string> = {
  busy: "A check of this store is running right now. Try again in a few minutes.",
  idle: "Closed after a while without activity. Reload this page to continue.",
  failed: "The sign-in page could not be opened. Try again in a minute.",
  closed: "The sign-in page was closed. Reload this page to continue.",
};

export function signInError(code: unknown): string {
  return typeof code === "string" && code in SIGN_IN_ERRORS ? SIGN_IN_ERRORS[code as SignInErrorCode] : SIGN_IN_COPY.connectionEnded;
}

// Every sentence above, for the guard.
export function allSignInSentences(store = "my-store"): string[] {
  return [
    SIGN_IN_COPY.title(store),
    SIGN_IN_COPY.intro,
    SIGN_IN_COPY.unavailable,
    SIGN_IN_COPY.connecting,
    SIGN_IN_COPY.live,
    SIGN_IN_COPY.signedIn(store),
    SIGN_IN_COPY.backToApp,
    SIGN_IN_COPY.connectionEnded,
    ...Object.values(SIGN_IN_ERRORS),
  ];
}
