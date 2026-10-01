// What we read from your analytics (CHE-243).
//
// Linked from the Connect button, and written for a founder rather than a
// lawyer. We are asking someone to hand us a window into their users'
// behaviour; the terms have to be short enough that they are actually read, and
// true enough that reading them is worth something.
//
// Every claim on this page is enforced somewhere in code, and
// scripts/verify-analytics-access.ts ties the two together — a page that
// promises what the code does not do is worse than no page, because it converts
// an honest gap into a broken promise.

import Link from "next/link";
import type { Metadata } from "next";
import { POSTHOG_SCOPES } from "@/lib/posthog/oauth";

export const metadata: Metadata = {
  title: "What we read from your analytics",
  description:
    "The exact access CheckMyApp asks for in your PostHog, what it reads, what it never reads, and how to end it.",
};

export default function AnalyticsAccessPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16">
      <p className="section-label">analytics access</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">What we read from your analytics</h1>

      <p className="mt-6 text-fg-muted">
        Connecting PostHog lets a check say how many people actually finish a journey, instead of
        our estimate of how many would. Here is exactly what that costs you.
      </p>

      <section className="mt-10 space-y-3">
        <h2 className="text-lg font-medium">We read counts, never people</h2>
        <p className="text-sm text-fg-muted">
          For each journey we walk, we ask one question: of the people who reached the first page of
          this flow, how many reached the last one? The answer is two numbers — a percentage and how
          many people it is out of.
        </p>
        <p className="text-sm text-fg-muted">
          We do not read, store or receive anyone&apos;s identity: no email addresses, no user ids, no
          person profiles, no session recordings, no event properties beyond the page path. Nothing
          that could identify one of your users reaches us, because we never ask for it.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-lg font-medium">We can only read</h2>
        <p className="text-sm text-fg-muted">
          The access we request is read-only — these four permissions and nothing else:
        </p>
        <ul className="space-y-1">
          {POSTHOG_SCOPES.map((scope) => (
            <li key={scope} className="font-mono text-[13px] text-fg">
              {scope}
            </li>
          ))}
        </ul>
        <p className="text-sm text-fg-muted">
          We cannot create, change or delete anything in your PostHog — not an insight, not a
          dashboard, not a setting. This is not a promise about how we behave: PostHog itself caps
          what any token issued to us can do, and that cap is published at our{" "}
          <Link href="/.well-known/posthog-client.json" className="text-accent hover:underline">
            application document
          </Link>{" "}
          for anyone to check.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-lg font-medium">Disconnecting ends it</h2>
        <p className="text-sm text-fg-muted">
          Press Disconnect and the credentials are deleted — not flagged, not archived. We also tell
          PostHog to revoke them, so we disappear from your own list of connected apps rather than
          sitting there looking harmless.
        </p>
        <p className="text-sm text-fg-muted">
          The completion rates we already measured stay, because they are your product&apos;s history
          and they contain nothing but counts. Checks carry on either way — without analytics they
          fall back to our own estimate, which is how every app works before it connects anything.
        </p>
      </section>

      <section className="mt-10 space-y-3">
        <h2 className="text-lg font-medium">How the keys are held</h2>
        <p className="text-sm text-fg-muted">
          Encrypted before they are stored, the same way we hold every other credential you give us.
          They never appear in a log, in the evidence attached to a check, or in anything a check
          writes down.
        </p>
      </section>

      <p className="mt-12 text-sm text-fg-faint">
        <Link href="/settings/integrations" className="text-accent hover:underline">
          ← Back to your integrations
        </Link>
      </p>
    </main>
  );
}
