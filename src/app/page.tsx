import type { Metadata } from "next";
import Link from "next/link";
import { SubmitForm } from "@/components/submit-form";
import { TrackedLink } from "@/components/track";
import { EXAMPLE_VERDICT_PATH } from "@/lib/example-verdict";
import { CONNECT_GUIDE_PATH } from "@/lib/agent-connect";
import { HOME_PATH, canonical } from "@/lib/site-metadata";
import { PLAN_LIMITS } from "@/lib/plans";
import { viewerExtensionCheck } from "@/lib/viewer-flags";

// The home page is the form. It lived at /check from the first scaffold
// (2026-06-10, "no landing page in MVP — go straight to the submit screen")
// with `/` redirecting to it, and nothing ever needed the extra address:
// Search Console filed the pair as duplicates, every visit paid a redirect,
// and the brand query showed a path instead of the domain. Owner decision,
// 2026-09-17: there is no /check. Title and card come from the root layout;
// this page adds only its address, so `?url=` prefills and http:// resolve
// here instead of competing with it in a search index.
export const metadata: Metadata = { alternates: canonical(HOME_PATH) };

// ?url= prefills the input (CHE-39) so saved/shared links land ready to go.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const { url } = await searchParams;
  // CHE-320: the Chrome-extension check is not for the public yet. Decided
  // here, before the HTML is sent, so the option never flashes and vanishes.
  const extensionCheck = await viewerExtensionCheck();
  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center px-4 py-16">
      <SubmitForm initialUrl={url ?? ""} extensionCheck={extensionCheck} />
      {/* Issue #9: someone deciding whether to paste their own link wants to
          see what they would get first. One quiet line, under the form, to a
          public verdict of someone else's product. */}
      <p className="mt-10 w-full max-w-xl text-center font-mono text-[13px] leading-6 text-fg-faint">
        Not ready to paste your own link?{" "}
        <TrackedLink
          event="example_verdict_clicked"
          href={EXAMPLE_VERDICT_PATH}
          className="text-accent transition-colors hover:underline"
        >
          See an example verdict →
        </TrackedLink>
      </p>
      {/* CHE-324: the coding agent is the interface (CHE-313). One line for
          the visitor who would rather never open this page again. */}
      <p className="mt-3 w-full max-w-xl text-center font-mono text-[13px] leading-6 text-fg-faint">
        Prefer your coding agent?{" "}
        <Link href={CONNECT_GUIDE_PATH} className="text-accent transition-colors hover:underline">
          Connect it →
        </Link>
      </p>
      {/* Owner decision, 2026-09-05: every anonymous check is public. Say so
          where the link is pasted, and make it the reason to sign in. */}
      <p className="mt-3 w-full max-w-xl text-center font-mono text-[13px] leading-6 text-fg-faint">
        Anonymous checks are public and listed in{" "}
        <Link href="/checks/today" className="text-accent transition-colors hover:underline">
          today&apos;s checks
        </Link>
        .{" "}
        <TrackedLink
          event="sign_in_clicked"
          props={{ from: "home" }}
          href="/sign-in"
          className="text-accent transition-colors hover:underline"
        >
          Sign in
        </TrackedLink>{" "}
        to keep yours unlisted and get ${PLAN_LIMITS.free.creditUsd} of free checks.
      </p>
    </main>
  );
}
