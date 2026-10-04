import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site-metadata";

// Until 2026-09-17 the site had no robots.txt of its own; what a crawler got
// was Cloudflare's managed content-signals preamble and nothing else — no
// sitemap pointer, and every owner-only route open to be crawled and 302'd
// to sign-in.
//
// What is kept out is what has no reader on a search results page: an
// owner's workspace (redirects to sign-in for a crawler anyway), Clerk's
// auth screens, the API, a live run (transient — it becomes a verdict) and
// Stripe's return page. Verdicts stay crawlable: an anonymous check is public
// by decision (2026-09-05) and its page is the product's one shareable
// artifact. They are still not in the sitemap — see sitemap.ts.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/dashboard",
        "/home",
        "/health",
        "/release",
        "/product",
        "/onboarding",
        "/settings",
        "/team",
        "/invite",
        "/watch",
        "/analytics-access",
        "/sign-in",
        "/sign-up",
        "/run/",
        "/paid",
      ],
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
