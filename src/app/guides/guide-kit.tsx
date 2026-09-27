import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GUIDES, GUIDES_PATH, guideBySlug, guidePath } from "@/lib/guides";
import { pageMetadata } from "@/lib/site-metadata";

// Shared pieces of the /guides pages (CHE-318). Every word on these pages is
// customer-facing: CLAUDE.md rule 1 applies — describe the customer's product
// and what they do, never how we check, and never hand them homework.

export function guideMetadata(slug: string): Metadata {
  const g = guideBySlug(slug);
  return pageMetadata({ title: g.title, description: g.description, path: guidePath(g.slug) });
}

export function GuidePage({
  slug,
  headline,
  lead,
  children,
}: {
  slug: string;
  // The h1; may carry an accent span, so it is separate from the plain title.
  headline: ReactNode;
  lead: ReactNode;
  children: ReactNode;
}) {
  const others = GUIDES.filter((g) => g.slug !== slug);
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <div className="space-y-3">
        <p className="section-label">
          <Link href={GUIDES_PATH} className="hover:text-fg-muted">
            guides
          </Link>
        </p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight">{headline}</h1>
        <p className="max-w-xl text-[15px] leading-7 text-fg-muted">{lead}</p>
      </div>

      <article className="mt-10 space-y-10">{children}</article>

      <nav className="mt-16 border-t border-ink-800 pt-8" aria-label="Other guides">
        <p className="section-label mb-3">other guides</p>
        <ul className="space-y-2">
          {others.map((g) => (
            <li key={g.slug}>
              <Link href={guidePath(g.slug)} className="text-sm text-accent hover:underline">
                {g.title} →
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <p className="mt-10 font-mono text-[13px] text-fg-faint">
        <Link href="/" className="text-accent hover:underline">
          Check your app →
        </Link>{" "}
        · first run is free, no signup.
      </p>
    </main>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold tracking-tight text-fg">{title}</h2>
      <div className="space-y-4 text-[15px] leading-7 text-fg-muted">{children}</div>
    </section>
  );
}

// Inline monospace token, the FAQ's style.
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[13px] text-fg">
      {children}
    </code>
  );
}

export function Strong({ children }: { children: ReactNode }) {
  return <span className="font-medium text-fg">{children}</span>;
}

export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-[2px] font-mono text-accent" aria-hidden="true">
            ›
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// A quote the reader can hand to their agent or paste into a field.
export function Example({ children }: { children: ReactNode }) {
  return (
    <blockquote className="rounded-lg border-l-2 border-accent/60 bg-ink-850 px-4 py-3 text-[14px] leading-6 text-fg">
      {children}
    </blockquote>
  );
}

export function Note({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="card p-5">
      <p className="section-label mb-2">{label}</p>
      <div className="space-y-2 text-sm leading-6 text-fg-muted">{children}</div>
    </div>
  );
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-accent hover:underline">
      {children}
    </Link>
  );
}
