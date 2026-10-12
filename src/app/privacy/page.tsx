import Link from "next/link";
import { pageMetadata } from "@/lib/site-metadata";
import {
  CONTACT_EMAIL,
  CONTACT_LINES,
  KEPT,
  NOT_SOLD,
  PRIVACY_DESCRIPTION,
  PRIVACY_HEADING,
  REMOVAL,
  SECTION_TITLES,
  processorsSentence,
} from "@/lib/privacy-copy";

export const metadata = pageMetadata({
  title: "Privacy",
  description: PRIVACY_DESCRIPTION,
  path: "/privacy",
});

// CHE-438: an Atlassian app can be shared with other accounts only with a
// privacy policy URL. Every word lives in src/lib/privacy-copy.ts, where
// scripts/verify-privacy-copy.ts holds each claim to the code.
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <div className="space-y-3">
        <p className="section-label">{SECTION_TITLES.label}</p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight">
          {PRIVACY_HEADING.before}
          <span className="text-accent">{PRIVACY_HEADING.accent}</span>
          {PRIVACY_HEADING.after}
        </h1>
      </div>

      <div className="mt-10 space-y-10 text-[15px] leading-7 text-fg-muted">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-fg">{SECTION_TITLES.kept}</h2>
          <ul className="list-disc space-y-2 pl-5">
            {KEPT.map((k) => (
              <li key={k.lead}>
                <span className="text-fg">{k.lead}</span> {k.text}
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-fg">{SECTION_TITLES.processors}</h2>
          <p>
            {processorsSentence()} {NOT_SOLD}
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-fg">{SECTION_TITLES.removal}</h2>
          <p>{REMOVAL.join(" ")}</p>
        </section>
      </div>

      <div className="card mt-10 space-y-2 p-5 font-mono text-[13px] text-fg-muted">
        <p className="section-label mb-3">{SECTION_TITLES.contact}</p>
        <p>{CONTACT_LINES.operator}</p>
        <p>
          {CONTACT_LINES.contact}{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent hover:underline">
            {CONTACT_EMAIL}
          </a>
        </p>
        <p>{CONTACT_LINES.updated}</p>
      </div>

      <p className="mt-10 font-mono text-[13px] text-fg-faint">
        <Link href="/about" className="text-accent hover:underline">
          {CONTACT_LINES.about}
        </Link>
      </p>
    </main>
  );
}
