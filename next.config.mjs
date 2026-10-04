import { MOVED_ROUTES } from "./src/lib/moved-routes.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Agent worktrees share one node_modules through a symlink (a full install
  // per worktree filled the disk, 2026-10-01). Turbopack refuses a symlink that
  // leaves the project root, so a worktree's dev server names a root that holds
  // both: TURBOPACK_ROOT=/path/to/Projects npx next dev. Unset everywhere else.
  ...(process.env.TURBOPACK_ROOT ? { turbopack: { root: process.env.TURBOPACK_ROOT } } : {}),
  // CHE-108: www.checkmyapp.dev is a custom domain on the same Worker, so it
  // would serve the product as a second copy of the site — two canonical URLs
  // for every page, two link previews, split rankings. This folds it back onto
  // the apex with a permanent redirect that keeps path and query.
  //
  // Lives here and not in a Cloudflare redirect rule because the deploy token
  // cannot create rulesets. The OpenNext adapter evaluates these redirects
  // from the routes manifest before middleware runs, `has: host` included
  // (@opennextjs/aws core/routing/matcher.js, routeHasMatcher), so Clerk's
  // middleware never sees a www request.
  //
  // Two rules, not one `/:path*`: when the source captures no params the
  // adapter copies the destination verbatim, so `/` on www would have gone to
  // a literal "https://checkmyapp.dev/:path*". Verified in `wrangler dev`.
  //
  // CHE-351: the signed-in app moved into the sidebar shell. Its old addresses
  // are in emails, bookmarks and agents' notes, so each one answers with a
  // permanent redirect to where it lives now (src/lib/moved-routes.mjs).
  async redirects() {
    const WWW = [{ type: "host", value: "www.checkmyapp.dev" }];
    return [
      { source: "/", has: WWW, destination: "https://checkmyapp.dev/", permanent: true },
      {
        source: "/:path+",
        has: WWW,
        destination: "https://checkmyapp.dev/:path+",
        permanent: true,
      },
      ...MOVED_ROUTES.map((r) => ({ source: r.from, destination: r.to, permanent: true })),
    ];
  },
  // CHE-315: the remote MCP server's public address is /mcp — the line people
  // paste is `claude mcp add --transport http checkmyapp https://checkmyapp.dev/mcp`.
  // The handler lives under /api so the route registry
  // (scripts/verify-route-scopes.ts walks src/app/api) sees it like every
  // other endpoint; a route outside /api would be invisible to that guard.
  async rewrites() {
    return [{ source: "/mcp", destination: "/api/mcp" }];
  },
};

export default nextConfig;

// OpenNext/Cloudflare: lets getCloudflareContext() resolve bindings under
// `next dev` too (no-op in production builds). `wrangler dev` gets bindings
// from wrangler.jsonc directly and doesn't need this.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
