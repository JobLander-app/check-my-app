import Link from "next/link";
import { GUIDES, GUIDES_PATH, guidePath } from "@/lib/guides";
import { pageMetadata } from "@/lib/site-metadata";

export const metadata = pageMetadata({
  title: "Guides",
  description:
    "How to check the signed-in part of your app, write your own scenarios, test several accounts, and run CheckMyApp from your coding agent.",
  path: GUIDES_PATH,
});

// /guides (CHE-318): the questions the first outside developer asked, answered
// once, on the site. The list itself lives in src/lib/guides.ts.
export default function GuidesPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <div className="stagger space-y-10">
        <div className="space-y-3">
          <p className="section-label">guides</p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight">
            Set it up once, <span className="text-accent">then let your agent drive</span>.
          </h1>
          <p className="max-w-xl text-sm text-fg-muted">
            Logins, scenarios, several accounts, and connecting CheckMyApp to the coding agent you
            already work with. Each takes a few minutes.
          </p>
        </div>

        <ol className="space-y-4">
          {GUIDES.map((g, i) => (
            <li key={g.slug}>
              <Link
                href={guidePath(g.slug)}
                className="card group block p-5 transition-colors hover:border-ink-600"
              >
                <p className="font-mono text-[11px] text-fg-faint">{String(i + 1).padStart(2, "0")}</p>
                <h2 className="mt-1 text-[15px] font-semibold tracking-tight text-fg group-hover:text-accent">
                  {g.title} →
                </h2>
                <p className="mt-2 text-sm leading-6 text-fg-muted">{g.description}</p>
              </Link>
            </li>
          ))}
        </ol>

        <p className="font-mono text-[13px] text-fg-faint">
          Something missing?{" "}
          <Link href="/faq" className="text-accent hover:underline">
            The FAQ
          </Link>{" "}
          answers the rest.
        </p>
      </div>
    </main>
  );
}
