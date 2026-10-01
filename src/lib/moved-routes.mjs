// The signed-in app's old addresses and where each one lives now (CHE-351,
// CHE-348 "Redirects"). Plain JS because next.config.mjs imports it before any
// TypeScript is compiled; src/lib/app-shell.ts re-exports it for the app.
//
// next.config.mjs serves these as permanent redirects. Two old addresses need
// more than a pattern and are handled by their own page: /watch/[slug] names an
// app by slug (a lookup), and /dashboard#balance carries its meaning in a
// fragment, which never reaches a server (/home sends it on to Billing).
// scripts/verify-app-shell.ts walks every one of them to a page that exists.

/** @type {{ from: string; to: string }[]} */
export const MOVED_ROUTES = [
  { from: "/dashboard", to: "/home" },
  { from: "/dashboard/accuracy", to: "/health/accuracy" },
  { from: "/dashboard/:appId", to: "/health/apps/:appId/settings" },
  { from: "/team", to: "/settings/team" },
];
