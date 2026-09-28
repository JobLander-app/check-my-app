import Link from "next/link";
import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/site-metadata";
import { ANON_RUNS_PER_DAY, ANON_RUNS_PER_DAY_SITE, PLAN_LIMITS, TOPUP_AMOUNTS_USD, usd } from "@/lib/plans";

export const metadata = pageMetadata({
  title: "FAQ",
  description:
    "What CheckMyApp does with your app, what it never touches, what happens to your test credentials, and what lands on your verdict page.",
  path: "/faq",
});

// Public FAQ · /faq (CHE-63). Answers must stay accurate — no overpromising.
// API keys and MCP come with every plan (CHE-316); trackers are Linear-only today.
type Faq = {
  q: string;
  a: ReactNode;
};

// Inline monospace token for code / commands inside answers.
function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[13px] text-fg">
      {children}
    </code>
  );
}

const FAQS: Faq[] = [
  {
    q: "Can my coding agent or CI run checks automatically?",
    a: (
      <>
        Yes, on every plan, Free included. Create an API key on your dashboard and{" "}
        <Code>POST</Code> to <Code>/api/checks</Code> with{" "}
        <Code>Authorization: Bearer cma_…</Code>. Agents that speak MCP can add apps, run
        checks and read results directly — see{" "}
        <Link href="/guides/connect-your-agent" className="text-accent hover:underline">
          Connect your coding agent
        </Link>
        . A check started with a key spends your balance exactly like one started from the
        site.
      </>
    ),
  },
  {
    q: "Do you look at my source code?",
    a: (
      <>
        No. The agent uses your running app in a real browser like a first-time user; it
        never reads your repo.
      </>
    ),
  },
  {
    q: "What happens to the test-login credentials I provide?",
    a: (
      <>
        Encrypted at rest, never logged, never shown in evidence. Used only so the agent can
        walk signed-in journeys.{" "}
        <Link href="/guides/login-and-test-accounts" className="text-accent hover:underline">
          More on test accounts
        </Link>
        .
      </>
    ),
  },
  {
    q: "Will it create real accounts or delete my data?",
    a: (
      <>
        No. Signup is walked up to the final submit but not completed unless you allow it;
        destructive actions (delete, cancel) are off-limits unless you explicitly permit them.
      </>
    ),
  },
  {
    q: "What do I actually get?",
    a: (
      <>
        A verdict page with journey-level findings, screenshots, network evidence, and
        downloadable Playwright specs. Daily Watch re-checks and files one ticket per new
        regression into your tracker.
      </>
    ),
  },
  {
    // CHE-327: every number here is read from src/lib/plans.ts, never typed.
    q: "What does a check cost?",
    a: (
      <>
        Every plan is a balance: {usd(PLAN_LIMITS.starter.creditUsd ?? 0)} of checks a month on
        Starter, {usd(PLAN_LIMITS.growth.creditUsd ?? 0)} on Growth. Each check has its own
        price, shown on its verdict next to the work it did — a check that walks every journey
        of a big app costs more than one that re-walks what changed after a deploy, and one
        that finds nothing changed costs a few cents. When the balance runs out you can top it
        up from ${TOPUP_AMOUNTS_USD[0]} or upgrade; nothing is lost in between.
      </>
    ),
  },
  {
    q: "What is the difference between a re-check and a full re-check?",
    a: (
      <>
        A re-check re-walks what changed since the last check and is what to press after a
        deploy. A full re-check walks every journey of your app from scratch, as if for the
        first time — so it costs more.
      </>
    ),
  },
  {
    q: "How is the free tier limited?",
    a: (
      <>
        The site runs {ANON_RUNS_PER_DAY_SITE} free checks a day in total. Without an account
        that is {ANON_RUNS_PER_DAY} check per visitor every 24 hours; a free account gets{" "}
        {usd(PLAN_LIMITS.free.creditUsd ?? 0)} of checks. Once the day&apos;s free checks are
        used up, a check costs $1; a plan or a top-up lifts the caps.
      </>
    ),
  },
  {
    // Owner decision, 2026-09-05: anonymous checks are public. Owned verdicts
    // are "unlisted" — reachable by their link, listed nowhere — not "private".
    q: "Are my checks public?",
    a: (
      <>
        Checks run without an account are public: they appear in{" "}
        <Link href="/checks/today" className="text-accent hover:underline">
          today&apos;s checks
        </Link>
        , and the next visitor who pastes the same app on{" "}
        <Link href="/" className="text-accent hover:underline">
          the home page
        </Link>{" "}
        may be shown its previous verdict. With a free account your verdicts are unlisted —
        they open only by their link — you get 3 checks, and they stay in your dashboard with
        their history.
      </>
    ),
  },
  {
    q: "Which trackers are supported?",
    a: <>Linear today (GitHub next), on Growth and above.</>,
  },
];

export default function FaqPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <div className="stagger space-y-10">
        <div className="space-y-3">
          <p className="section-label">faq</p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight">
            Questions, <span className="text-accent">answered honestly</span>.
          </h1>
          <p className="max-w-xl text-sm text-fg-muted">
            What the agent does, what it never touches, and what lands on your verdict page.
          </p>
        </div>

        <div className="space-y-4">
          {FAQS.map((faq) => (
            <div key={faq.q} className="card p-5">
              <h2 className="text-[15px] font-semibold tracking-tight text-fg">{faq.q}</h2>
              <p className="mt-2 text-sm leading-6 text-fg-muted">{faq.a}</p>
            </div>
          ))}
        </div>

        <p className="font-mono text-[13px] text-fg-faint">
          <Link href="/" className="text-accent hover:underline">
            Check your app →
          </Link>{" "}
          · first run is free, no signup.
        </p>
      </div>
    </main>
  );
}
