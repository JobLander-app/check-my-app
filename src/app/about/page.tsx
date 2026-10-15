import Link from "next/link";
import { pageMetadata } from "@/lib/site-metadata";

export const metadata = pageMetadata({
  title: "About",
  description:
    "CheckMyApp is built and run by one independent developer, and it checks its own product the same way it checks yours. Who is behind it and how to reach them.",
  path: "/about",
});

// About / imprint (owner request 2026-08-22): an independent-developer project,
// with the legal details a paying customer or tax authority would look for.
export default function AboutPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <div className="space-y-3">
        <p className="section-label">about</p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight">
          An independent project, <span className="text-accent">watched daily</span> by itself.
        </h1>
      </div>

      <div className="mt-8 space-y-5 text-[15px] leading-7 text-fg-muted">
        <p>
          CheckMyApp is built and run by <span className="text-fg">Vladislav Sorokin</span>, an
          independent software developer. No team page, no venture story — one person and an
          agent fleet, shipping in the open.
        </p>
        <p>
          The product does exactly what it says: paste a link, and an AI agent explores your app
          the way a first-time user would — then keeps re-checking it every day and alerts you
          the moment something breaks. CheckMyApp watches its own production the same way, with
          the same public verdicts.
        </p>
      </div>

      <div className="card mt-10 space-y-2 p-5 font-mono text-[13px] text-fg-muted">
        <p className="section-label mb-3">legal &amp; contact</p>
        <p>
          Operator: <span className="text-fg">Vladislav Sorokin</span> (independent developer)
        </p>
        <p>
          VAT: <span className="text-fg">PT300084099</span>
        </p>
        <p>
          Contact:{" "}
          <a href="mailto:sorokinvj@gmail.com" className="text-accent hover:underline">
            sorokinvj@gmail.com
          </a>
        </p>
        <p>
          <Link href="/privacy" className="text-accent hover:underline">
            Privacy policy
          </Link>
        </p>
      </div>

      <p className="mt-10 font-mono text-[13px] text-fg-faint">
        <Link href="/" className="text-accent hover:underline">
          Check your app →
        </Link>{" "}
        · first run is free, no signup.
      </p>
    </main>
  );
}
