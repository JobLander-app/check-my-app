import { PROOF, PROOF_COPY } from "@/lib/home-copy";
import { EXAMPLE_VERDICT_PATH } from "@/lib/example-verdict";
import { SEVERITY_META, VERDICT_META } from "@/lib/status";
import { TrackedLink } from "@/components/track";

// The verdict is the product (CLAUDE.md §1), so the home page shows one: a
// real check of our own app, copied from the verdict it links to (CHE-421).
// The visitor sees the shape of the answer — the bottom line, one finding
// with where / what happened / why it matters, and the price of that check —
// before pasting a link of their own.
//
// Server component. The words live in src/lib/home-copy.ts and pass the leak
// gates there; here only layout. The one link carries the event the old
// "See an example verdict" line carried, so the funnel keeps its name.
export function HomeProof() {
  const verdict = VERDICT_META[PROOF.verdict];
  const severity = SEVERITY_META[PROOF.finding.severity];
  const checkedOn = new Date(`${PROOF.checkedOn}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return (
    <section aria-labelledby="home-proof" className="w-full max-w-3xl">
      <h2 id="home-proof" className="section-label mb-2 text-center">
        {PROOF_COPY.label}
      </h2>
      <p className="mb-6 text-center text-sm text-fg-muted">{PROOF_COPY.intro}</p>
      <article className="card space-y-5 p-6 sm:p-8">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className={`rounded-full border px-2.5 py-0.5 font-mono text-xs ${verdict.pillClassName}`}>{verdict.label}</span>
          <span className="font-mono text-[13px] text-fg-muted">{PROOF.app}</span>
          <span className="font-mono text-xs text-fg-faint">
            {`${PROOF_COPY.check(PROOF.runNumber)} · ${checkedOn} · $${PROOF.priceUsd.toFixed(2)}`}
          </span>
        </header>
        <p className="text-[15px] leading-7 text-fg">{PROOF.bottomLine}</p>
        <div className="space-y-3 border-t border-ink-700 pt-5">
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={`font-mono text-[11px] font-medium tracking-wider ${severity.className}`}>{severity.label}</span>
            <span className="font-semibold tracking-tight text-fg">{PROOF.finding.title}</span>
          </p>
          <dl className="grid gap-x-6 gap-y-3 text-sm leading-6 sm:grid-cols-[max-content_1fr]">
            <dt className="section-label pt-1">{PROOF_COPY.where}</dt>
            <dd className="font-mono text-[13px] leading-6 text-fg-muted">{PROOF.finding.where}</dd>
            <dt className="section-label pt-1">{PROOF_COPY.happened}</dt>
            <dd className="text-fg-muted">{PROOF.finding.happened}</dd>
            <dt className="section-label pt-1">{PROOF_COPY.matters}</dt>
            <dd className="text-fg-muted">{PROOF.finding.matters}</dd>
          </dl>
        </div>
        <TrackedLink
          event="example_verdict_clicked"
          href={EXAMPLE_VERDICT_PATH}
          className="inline-block font-mono text-[13px] text-accent transition-colors hover:underline"
        >
          {PROOF_COPY.open}
        </TrackedLink>
      </article>
    </section>
  );
}
