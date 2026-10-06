import type { Metadata } from "next";
import Link from "next/link";
import { SubmitForm } from "@/components/submit-form";
import { HomeProof } from "@/components/home-proof";
import { HomePains } from "@/components/home-pains";
import { TrackedLink } from "@/components/track";
import { CONNECT_GUIDE_PATH } from "@/lib/agent-connect";
import { HERO, WAYS_IN } from "@/lib/home-copy";
import { HOME_PATH, canonical } from "@/lib/site-metadata";
import { PLAN_LIMITS } from "@/lib/plans";
import { viewerExtensionCheck } from "@/lib/viewer-flags";

// The home page is the form, and since CHE-421 it is also the page that says
// what the visitor is afraid of and what they get (owner, 2026-10-06: the form
// with a slogan and eight grey caveats under it "explained our mechanics and
// asked them to try before it said anything about them"). Every sentence
// comes from src/lib/home-copy.ts, which the leak gates read.
//
// The form lived at /check from the first scaffold (2026-06-10, "no landing
// page in MVP — go straight to the submit screen") with `/` redirecting to it,
// and nothing ever needed the extra address: Search Console filed the pair as
// duplicates, every visit paid a redirect, and the brand query showed a path
// instead of the domain. Owner decision, 2026-09-17: there is no /check. Title
// and card come from the root layout; this page adds only its address, so
// `?url=` prefills and http:// resolve here instead of competing with it in a
// search index.
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
    <main className="flex flex-col items-center gap-20 px-4 pb-24 pt-16 sm:gap-24 sm:pt-24">
      {/* First screen: the fear in the visitor's words, one line of what they
          get, and the link field as the way in — not as the headline. */}
      <section className="stagger flex w-full max-w-2xl flex-col gap-8">
        <div className="space-y-4 text-center">
          <h1 className="text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-[2.75rem]">
            {/* The visitor's own sentence, crossed out, then our answer. Two
                block spans, so the strike never wraps into the answer. */}
            {HERO.struck && (
              <s className="block text-[0.7em] font-medium text-fg-muted decoration-status-broken decoration-[3px]">{HERO.struck}</s>
            )}
            <span className={HERO.struck ? "mt-2 block" : undefined}>{HERO.headline}</span>
          </h1>
          <p className="mx-auto max-w-xl text-pretty text-[15px] leading-7 text-fg-muted sm:text-base">{HERO.line}</p>
        </div>
        <div className="mx-auto w-full max-w-xl">
          <SubmitForm initialUrl={url ?? ""} extensionCheck={extensionCheck} />
        </div>
        {/* CHE-324: the coding agent is the interface (CHE-313). One line for
            the visitor who would rather never open this page again. */}
        <p className="text-center font-mono text-[13px] leading-6 text-fg-faint">
          {WAYS_IN.agent}{" "}
          <Link href={CONNECT_GUIDE_PATH} className="text-accent transition-colors hover:underline">
            {WAYS_IN.agentLink}
          </Link>
        </p>
      </section>

      {/* Proof, not promises: a real verdict, the shape of the answer. */}
      <HomeProof />

      {/* The four pains from the research, in the audience's words. */}
      <HomePains />

      {/* Owner decision, 2026-09-05: every anonymous check is public. The
          reason to sign in, once, at the end — not under the button. */}
      <p className="w-full max-w-xl text-center font-mono text-[13px] leading-6 text-fg-faint">
        <TrackedLink
          event="sign_in_clicked"
          props={{ from: "home" }}
          href="/sign-in"
          className="text-accent transition-colors hover:underline"
        >
          {WAYS_IN.signInLink}
        </TrackedLink>{" "}
        {WAYS_IN.signInRest(PLAN_LIMITS.free.creditUsd ?? 0)}
      </p>
    </main>
  );
}
