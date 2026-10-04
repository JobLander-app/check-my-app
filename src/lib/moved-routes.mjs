// The signed-in app's old addresses and where each one lives now (CHE-351,
// CHE-348 "Redirects"). Plain JS because next.config.mjs imports it before any
// TypeScript is compiled; src/lib/app-shell.ts re-exports it for the app.
//
// next.config.mjs serves these as permanent redirects. One old address needs
// more than a pattern and is handled by its own page: /watch/[slug] names an
// app by slug (a lookup). /dashboard#balance, the top-up link of old e-mails,
// lands on /home like any /dashboard: a fragment never reaches a server, and
// every "top up" we hand out now is BALANCE_PATH (src/lib/balance-links.ts).
// scripts/verify-app-shell.ts walks every one of them to a page that exists.

/** @type {{ from: string; to: string }[]} */
export const MOVED_ROUTES = [
  { from: "/dashboard", to: "/home" },
  { from: "/dashboard/accuracy", to: "/health/accuracy" },
  { from: "/dashboard/:appId", to: "/health/apps/:appId/settings" },
  { from: "/team", to: "/settings/team" },
];
