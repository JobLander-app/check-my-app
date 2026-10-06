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
  back: "Back",
  reload: "Reload",
  ok: "OK",
  cancel: "Cancel",
} as const;

// /connect/shopify: the link to the app inside the store's admin — the store
// and the app are both read from it (src/lib/shopify-connect.ts).
export const CONNECT_COPY = {
  title: "Check a Shopify app",
  intro:
    "Open your app in your store's Shopify admin and paste its address here. Next you sign in to that store here, the way " +
    "you always do. The app's first check starts right away, and it is checked every day after that.",
  label: "Link to your app in the Shopify admin",
  placeholder: "https://admin.shopify.com/store/my-store/apps/my-app",
  submit: "Continue",
  submitting: "Opening…",
} as const;

// What the customer's agent reads from MCP connect_shopify_app
// (src/lib/mcp/tools.ts): the tool's description and its hints.
export const MCP_CONNECT_COPY = {
  description:
    "Connect a Shopify app — one that lives inside a store's admin (admin.shopify.com). Pass app_url, the link to the app " +
    "in the admin (the store and the app are both read from it); the result's sign_in_url is for the user: they sign in " +
    "to their store on that page (CheckMyApp never asks for their Shopify password, and neither should you), the app is " +
    "picked up and its first check starts there; after that it is checked daily like any app. Use this instead of " +
    "create_app for an app inside the Shopify admin.",
  signIn:
    "Give the user sign_in_url. They sign in to their store there (the way they always do — never ask for their password); " +
    "the app is then picked up and its first check starts on that page; it is checked daily after that. " +
    "Then list_apps shows the app under its own name, and start_check / wait_for_run work as for any app.",
  alreadyConnected: "This app is already connected — list_apps has it; start_check checks it.",
  appUrl:
    "The link to the app inside the store's Shopify admin, as the address bar shows it when the app is open: " +
    "https://admin.shopify.com/store/<store>/apps/<app> (or https://<store>.myshopify.com/admin/apps/<app>)",
} as const;

// What connecting and choosing refuse with (src/lib/shopify-connect.ts).
export const CONNECT_ERRORS = {
  notOpen: "Checking Shopify apps is not open for your team yet.",
  badLink:
    "Paste the link to your app inside your store's admin — open the app in Shopify and copy the address, like https://admin.shopify.com/store/my-store/apps/my-app.",
  notFound: "App not found.",
  otherStore: "That app belongs to another store.",
  alreadyChosen: "This store's app is already chosen.",
  notLinked: "That is not the app you linked to.",
  cannotOpen: "This app cannot be checked: the address it is served from is not one we can open.",
  alreadyConnected: (name: string) => `${name} is already connected.`,
} as const;

export type SignInErrorCode = "busy" | "idle" | "failed" | "closed";

export const SIGN_IN_ERRORS: Record<SignInErrorCode, string> = {
  busy: "A check of this store is running right now. Try again in a few minutes.",
  idle: "Closed after a while without activity. Reload this page to continue.",
  failed: "The sign-in page could not be opened. Try again in a minute.",
  closed: "The sign-in page was closed. Reload this page to continue.",
};

// CHE-333: choosing the app after sign-in (a store connected through
// /connect/shopify, its app not chosen yet).
export const CHOOSE_COPY = {
  signedIn: (store: string) => `Signed in to ${store}.`,
  listing: (store: string) => `Reading the apps installed in ${store}…`,
  question: "Which app should we check?",
  retry: "Try again",
  noApps: "No apps are installed in this store yet. Install yours, then reload this page.",
  picking: (name: string) => `Opening ${name} in your admin…`,
  openIt: "Open it",
  done: (name: string) => `${name} is connected and its first check has started —`,
  connected: (name: string) => `${name} is connected.`,
  watchIt: "watch it",
  daily: "It is checked every day from now on;",
  appPage: "the app's page",
} as const;

export type PickErrorCode = "app_not_open" | "failed" | "expired";
export const PICK_ERRORS: Record<PickErrorCode, string> = {
  expired: "That choice has expired. Choose the app again.",
  app_not_open: "The app did not open inside your admin. Open it once in the page above, then choose it again.",
  failed: "That did not work. Choose the app again in a minute.",
};
export function pickError(code: unknown): string {
  return typeof code === "string" && code in PICK_ERRORS ? PICK_ERRORS[code as PickErrorCode] : PICK_ERRORS.failed;
}

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
    SIGN_IN_COPY.back,
    SIGN_IN_COPY.reload,
    SIGN_IN_COPY.ok,
    SIGN_IN_COPY.cancel,
    ...Object.values(CONNECT_COPY),
    ...Object.values(CONNECT_ERRORS).map((v) => (typeof v === "function" ? v("Securify") : v)),
    ...Object.values(MCP_CONNECT_COPY),
    CHOOSE_COPY.retry,
    ...Object.values(SIGN_IN_ERRORS),
    CHOOSE_COPY.signedIn(store),
    CHOOSE_COPY.listing(store),
    CHOOSE_COPY.question,
    CHOOSE_COPY.noApps,
    CHOOSE_COPY.picking("Securify"),
    CHOOSE_COPY.openIt,
    CHOOSE_COPY.done("Securify"),
    CHOOSE_COPY.connected("Securify"),
    CHOOSE_COPY.watchIt,
    CHOOSE_COPY.daily,
    CHOOSE_COPY.appPage,
    ...Object.values(PICK_ERRORS),
  ];
}
