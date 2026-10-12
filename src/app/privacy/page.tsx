import Link from "next/link";
import { pageMetadata } from "@/lib/site-metadata";

export const metadata = pageMetadata({
  title: "Privacy",
  description:
    "What CheckMyApp keeps about you and the apps you ask it to check, who processes it, and how to have it deleted.",
  path: "/privacy",
});

// CHE-438: an Atlassian app can be shared with other accounts only with a
// privacy policy URL, and checkmyapp.dev had none. Every sentence here was
// checked against the code (the Jira part against #319, which ships with it);
// when a processor or a stored field changes, this page changes with it.
const SECTIONS: { title: string; body: React.ReactNode }[] = [
  {
    title: "What we keep",
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <span className="text-fg">Your account.</span> The email and name you sign in with.
        </li>
        <li>
          <span className="text-fg">The apps you ask us to check.</span> Their addresses, what a
          check saw on their pages (screenshots, page text, errors), and the verdicts and findings
          it wrote. Test-account passwords you give us are stored encrypted and used only to sign in
          to your app during a check.
        </li>
        <li>
          <span className="text-fg">Tools you connect</span> — Jira, Linear, GitHub, PostHog. The
          access token is stored encrypted. From Jira we keep the site and project you chose and the
          keys of the issues we filed, and we read back only what became of those issues. We do not
          store Atlassian account ids, names or email addresses.
        </li>
        <li>
          <span className="text-fg">Payments.</span> Stripe takes the payment; we never see or store
          card numbers.
        </li>
        <li>
          <span className="text-fg">How the site is used.</span> Product analytics and session
          replay with form inputs masked.
        </li>
      </ul>
    ),
  },
  {
    title: "Who processes it",
    body: (
      <p>
        Cloudflare (hosting, database, file storage), Clerk (sign-in), Stripe (payments), Resend
        (email), PostHog (analytics), and the language-model providers a check runs on — Anthropic
        and models reached through OpenRouter — which receive the page content of the app being
        checked. Nothing is sold, and nothing is shared beyond what these services need to do their
        part.
      </p>
    ),
  },
  {
    title: "How long, and how to remove it",
    body: (
      <p>
        We keep your data while your account exists. You can revoke our access to a connected tool
        at any time from that tool&apos;s own settings — for Jira, under connected apps in your
        Atlassian account. Write to us and we delete your account and everything kept for it. You
        can also ask what we hold about you, or have it corrected.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <div className="space-y-3">
        <p className="section-label">privacy</p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight">
          What we keep, and <span className="text-accent">why</span>.
        </h1>
      </div>

      <div className="mt-10 space-y-10 text-[15px] leading-7 text-fg-muted">
        {SECTIONS.map((s) => (
          <section key={s.title} className="space-y-3">
            <h2 className="text-lg font-semibold text-fg">{s.title}</h2>
            {s.body}
          </section>
        ))}
      </div>

      <div className="card mt-10 space-y-2 p-5 font-mono text-[13px] text-fg-muted">
        <p className="section-label mb-3">controller &amp; contact</p>
        <p>
          Operator: <span className="text-fg">Vladislav Sorokin</span> (independent developer)
        </p>
        <p>
          Contact:{" "}
          <a href="mailto:sorokinvj@gmail.com" className="text-accent hover:underline">
            sorokinvj@gmail.com
          </a>
        </p>
        <p>Last updated: 12 October 2026</p>
      </div>

      <p className="mt-10 font-mono text-[13px] text-fg-faint">
        <Link href="/about" className="text-accent hover:underline">
          About CheckMyApp →
        </Link>
      </p>
    </main>
  );
}
