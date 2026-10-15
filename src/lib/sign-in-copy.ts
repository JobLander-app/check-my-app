// CHE-419: every sentence the store sign-in page shows, in one pure module, so
// the language guards (src/lib/verdict-language.ts: hasEnvironmentLeak,
// hasHomework) run over all of it in scripts/verify-live-view.ts. The page is
// about the person's store and their sign-in — never about the machinery that
// shows it (Codex on #287: "Opening the browser…" was ours, not theirs).
//
// The session host sends a code, never a sentence (viewer.mjs `{t:"error",
// code}`): the words live here, under the guards.

// CHE-482: a dev store is the app's test account. Its checks open the app in
// the store's admin signed in to Shopify as whoever connected the store, so
// each person connects their own, and signs in to Shopify once, here in the
// browser — after that their stores connect without signing in again. The
// connect page, the stores section, this page and MCP all say so.
export const SIGN_IN_COPY = {
  title: (store: string) => `Sign in to ${store}`,
  intro:
    "Sign in the way you always do. Checks of this store open your app from inside its admin, signed in as you; " +
    "when the sign-in ends, we will ask you to come back here.",
  once:
    "You sign in to Shopify once. After that, each of your dev stores connects on its page without signing in again. " +
    "Teammates connect their own stores with their own sign-in.",
  theirs: (person: string | null) =>
    `Checks of this store open it signed in to Shopify as ${person ?? "the teammate who connected it"}, so only they sign in here. ` +
    "To check the app on a store of yours, connect that store on Check a Shopify app.",
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
    "Your dev stores are this app's test accounts: a check opens the app inside a store's admin, signed in to Shopify as you. " +
    "Open your app in one of your stores and paste its address here. The first time, you sign in to Shopify on the next page — " +
    "once; after that, each of your stores connects without signing in again. The app's first check starts right away, and " +
    "it is checked every day after that.",
  label: "Link to your app in the Shopify admin",
  placeholder: "https://admin.shopify.com/store/my-store/apps/my-app",
  submit: "Continue",
  submitting: "Opening…",
} as const;

// What the customer's agent reads from MCP connect_shopify_app
// (src/lib/mcp/tools.ts): the tool's description and its hints.
export const MCP_CONNECT_COPY = {
  description:
    "Connect a Shopify app on one of the user's dev stores — an app that lives inside a store's admin (admin.shopify.com). " +
    "A dev store is the app's test account: its checks open the app in that store's admin signed in to Shopify as the " +
    "person who connected the store, so each person on the team connects their own stores. Pass app_url, the link to the " +
    "app in the admin (the store and the app are both read from it). The result's sign_in_url is for the user: the first " +
    "time, they sign in to Shopify once, on that page (CheckMyApp never asks for their Shopify password, and " +
    "neither should you); the app is picked up and its first check starts there. After that first sign-in, each further " +
    "store of theirs connects on its sign_in_url without signing in again. Use this instead of create_app for an app " +
    "inside the Shopify admin; add_store adds another store to an app already connected.",
  signIn:
    "Give the user sign_in_url. If they have not signed in to Shopify on CheckMyApp before, they sign in once, on that page " +
    "(the way they always do — never ask for their password); if they have, the page connects the store without asking. " +
    "The app's first check starts on that page, and it is checked daily after that. Then list_apps shows the store, and " +
    "start_check / wait_for_run work as for any app.",
  addStore:
    "Add one more dev store to a Shopify app the team already checks — staging, production, a store with the data a " +
    "feature needs. A store is a test account: its checks open the app signed in to Shopify as the person who adds it, so " +
    "a person adds their own stores. Pass shopify_app (list_apps) and the store's name. The person opens the returned " +
    "sign_in_url: the first time, they sign in to Shopify once, on that page; after that, it confirms the app on " +
    "the store without signing in again. The app's team scenarios come with it. Then start_check with shopify_app and " +
    "store checks the app there.",
  alreadyConnected: "This app is already connected — list_apps has it; start_check checks it.",
  ownKey: (origin: string) => `Ask the user for a key of their own: ${origin}/settings/api-keys. Their stores are connected with their own Shopify sign-in.`,
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
  notYours: "A teammate connected this store, and its checks open it signed in as them. Connect a store of your own to check the app there.",
  notOnTeam:
    "A store is connected with the Shopify sign-in of the person connecting it, and this key belongs to someone no longer on the team. Connect it with a key of your own.",
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

// CHE-468: a Shopify app's "Test stores" settings section — its stores, how to
// add one, the store password — and what the "What we check" section says in
// place of the record-creation choice: a check of an app in a store's admin
// reads the store and changes nothing in it (CHE-442 is where a team would opt
// a test store in).
export const STORES_COPY = {
  heading: "Stores",
  // CHE-482: what a store is, and how one is connected.
  how:
    "Each store is a test account for this app: its checks open the app in that store's admin, signed in to Shopify as " +
    "whoever connected it. Everyone connects their own stores. The first time, you sign in to Shopify once, on a store's " +
    "sign-in page here; after that, each of your stores connects without signing in again.",
  signedInAs: (who: { mine: boolean; email: string | null }) =>
    who.mine ? "Signed in as you" : `Signed in as ${who.email ?? "a teammate"}`,
  none: "No store yet: choose the app on the store's sign-in page first.",
  thisPage: "this page",
  signIn: "Sign in",
  addBefore: "Another store of yours: open the app in that store's admin and paste its address on",
  addLink: "Check a Shopify app",
  addAfter: ". Its scenarios come with it.",
  passwordTitle: "Store password",
  passwordWhat: "For a store that shows a password page before anything else.",
  passwordSet: "One is set.",
  passwordRule: "Encrypted at rest, never logged; a blank box keeps the current one.",
  passwordRemove: "Remove the store password",
  passwordSave: "Save store password",
  passwordIsSet: "A store password is set.",
  passwordNone: "No store password.",
  passwordByAdmin: "It is set by an admin of the team.",
  readOnlyTitle: "Test records",
  readOnly: "A check of an app in your store's admin only reads: it never creates, changes or deletes anything in the store.",
} as const;

// Every sentence above, for the guard.
export function allSignInSentences(store = "my-store"): string[] {
  return [
    SIGN_IN_COPY.title(store),
    SIGN_IN_COPY.intro,
    SIGN_IN_COPY.once,
    SIGN_IN_COPY.theirs("teammate@example.test"),
    SIGN_IN_COPY.theirs(null),
    STORES_COPY.signedInAs({ mine: true, email: null }),
    STORES_COPY.signedInAs({ mine: false, email: "teammate@example.test" }),
    STORES_COPY.signedInAs({ mine: false, email: null }),
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
    ...Object.values(MCP_CONNECT_COPY).map((v) => (typeof v === "function" ? v("https://checkmyapp.dev") : v)),
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
    ...Object.values(STORES_COPY).filter((v): v is string => typeof v === "string"),
    `${STORES_COPY.addBefore} ${STORES_COPY.addLink}${STORES_COPY.addAfter}`,
  ];
}
