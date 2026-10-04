// Clerk auth middleware. Uses the classic `middleware.ts` (Edge runtime) rather
// than Next 16's `proxy.ts`, because proxy.ts is Node-runtime-only and the
// OpenNext Cloudflare adapter rejects Node middleware. clerkMiddleware +
// @clerk/backend run on Edge/V8.
//
// Only owner-facing areas require a session. The entire anonymous free-run
// funnel — `/`, `/run/*`, `/verdict/*`, sign-in/up — stays public.
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// CHE-351: the signed-in app's own addresses (src/lib/app-shell.ts) are
// protected here too. The old /dashboard and /team redirect before this runs.
const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/onboarding(.*)",
  "/watch(.*)",
  "/home(.*)",
  "/health(.*)",
  "/release(.*)",
  "/product(.*)",
  "/settings(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
});

export const config = {
  // Everything that reaches the Worker, with no file-extension escape hatch
  // (CHE-44). Clerk's stock matcher skips paths that look like static files —
  // safe on Vercel, wrong here: on Workers a *missing* /favicon.ico or /foo.png
  // is not short-circuited, it falls through to Next, which renders the 404 page
  // inside the root layout, whose <ClerkProvider> throws
  // "auth() was called but Clerk can't detect usage of clerkMiddleware()".
  // Every such 404 came back as a 500. Real assets are served by the Workers
  // ASSETS binding before the Worker runs, so they never reach this.
  matcher: ["/(.*)"],
};
