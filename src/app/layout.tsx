import type { Metadata } from "next";
import Link from "next/link";
import { Bricolage_Grotesque, IBM_Plex_Mono } from "next/font/google";
import { ClerkProvider, Show, UserButton } from "@clerk/nextjs";
import "./globals.css";
import { HOME_PATH, OG_IMAGE, SITE, TAGLINE } from "@/lib/site-metadata";
import { AnalyticsProvider } from "@/components/analytics-provider";

const sans = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

// CHE-108: a link to this product used to paste into LinkedIn or Slack as a
// grey card with one line on it — no page carried the metadata a platform reads
// to build a preview. At launch a post IS the distribution, so the link was
// losing its clicks in the composer, before anyone reached the product at all.
//
// metadataBase makes the relative image below absolute, which every platform
// requires; templated titles let a page name itself without repeating the
// product name. Pages that want their own card use pageMetadata() from
// src/lib/site-metadata.ts — the image has to travel with them, see there.
export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: "CheckMyApp", template: "%s · CheckMyApp" },
  description: TAGLINE,
  openGraph: {
    type: "website",
    siteName: "CheckMyApp",
    title: "CheckMyApp",
    description: TAGLINE,
    url: `${SITE}${HOME_PATH}`,
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "CheckMyApp",
    description: TAGLINE,
    images: [OG_IMAGE.url],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${sans.variable} ${mono.variable}`}>
        <body className="min-h-screen">
          {/* Product analytics (PostHog) — renders nothing; see src/lib/analytics.ts. */}
          <AnalyticsProvider />
          <header className="border-b border-ink-800">
            <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
              {/* The tagline belongs to the brand, not to the menu (owner,
                  2026-09-28: as a tracked caps label beside the links it read
                  as a fifth nav item). A lockup: mark, wordmark, a hairline,
                  then the line in the body face at rest weight. From lg only —
                  below that the nav needs the room. */}
              <div className="flex items-center gap-3.5">
                <Link href="/" aria-label="CheckMyApp home" className="group flex items-center gap-2.5">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 font-mono text-[13px] font-semibold text-accent transition-colors group-hover:bg-accent/25">
                    ✓
                  </span>
                  <span className="hidden font-mono text-sm font-medium tracking-tight text-fg min-[480px]:inline">
                    checkmyapp
                  </span>
                </Link>
                <Show when="signed-out">
                  <span aria-hidden className="hidden h-3.5 w-px bg-ink-600 lg:block" />
                  <span className="hidden font-sans text-[13px] text-fg-faint lg:inline">
                    Product mirror, QA fallout
                  </span>
                </Show>
              </div>
              {/* Signed out, this is a website and the links sell it. Signed in,
                  it is a workspace, and the same links leave the owner with no
                  idea where they are or what else is here. Two different headers
                  for two different people. */}
              {/* With Guides (CHE-318) the signed-out links ran 15px past a
                  375px screen. On phones the wordmark gives way (the ✓ mark
                  stays and still goes home) and the gap tightens a step. */}
              <div className="flex items-center gap-3 whitespace-nowrap sm:gap-4">
                <Show when="signed-out">
                  <Link
                    href="/pricing"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Pricing
                  </Link>
                  <Link
                    href="/guides"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Guides
                  </Link>
                  <Link
                    href="/faq"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    FAQ
                  </Link>
                  <Link
                    href="/about"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    About
                  </Link>
                  {/* CHE-276: a link, not a modal. `SignInButton` cannot carry
                      oidcPrompt — its props pick only redirects, initialValues,
                      withSignUp and oauthFlow out of SignInProps — so a modal
                      sign-in would silently keep reusing the browser's Google
                      account while the page next to it asks properly. One
                      surface, one behaviour. */}
                  <Link
                    href="/sign-in"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Sign in
                  </Link>
                </Show>
                <Show when="signed-in">
                  <Link
                    href="/dashboard"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Your apps
                  </Link>
                  <Link
                    href="/dashboard/accuracy"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Accuracy
                  </Link>
                  <Link
                    href="/"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Check a link
                  </Link>
                  {/* CHE-318: an owner connecting their agent is signed in, so
                      the guides belong in the workspace header too. Hidden
                      on phones, where five links already fill the bar. */}
                  <Link
                    href="/guides"
                    className="hidden font-mono text-[13px] text-fg-muted transition-colors hover:text-fg sm:inline"
                  >
                    Guides
                  </Link>
                  <Link
                    href="/settings/team"
                    className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
                  >
                    Settings
                  </Link>
                  <UserButton />
                </Show>
              </div>
            </div>
          </header>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
