"use client";

import { useEffect, useState } from "react";
import type { Journey, Step } from "@/generated/prisma/client";
import { STEP_STATUS_META } from "@/lib/status";
import { JourneyNumbersBlock, type JourneyNumbersProps } from "@/components/journey-numbers-block";

type JourneyWithSteps = Journey & { steps: Step[] };

// Verdict §3.2 — "WHAT YOUR USERS DO". The centerpiece: one horizontal strip per
// journey, each step a card with screenshot + label + status. Click a step to
// see what the agent tried, what happened, and the evidence. This is the
// screenshot people share — keep it beautiful.
export function JourneyStrips({
  journeys,
  numbers,
  emptyNote,
  carriedRunNumbers,
  carriedRunDays,
}: {
  journeys: JourneyWithSteps[];
  // CHE-240: our estimate and their measurement, keyed by journey id.
  numbers?: Record<string, JourneyNumbersProps>;
  // Why there are no strips, when the run knows. A green verdict next to a bare
  // "no journeys" reads as a contradiction — a replay-first smoke pass (CHE-51)
  // says here that it carried the verdict forward without re-walking.
  emptyNote?: string;
  // Journey.carriedFromRunId → that run's number, for the "carried · Run #N"
  // chip on a partial run's carried journeys (CHE-57).
  carriedRunNumbers?: Record<string, number>;
  // …and the day that run walked it ("Sep 23", UTC), CHE-331.
  carriedRunDays?: Record<string, string>;
}) {
  if (journeys.length === 0) {
    return (
      <section>
        <h2 className="section-label">What your users do</h2>
        <p className="mt-2 text-sm text-fg-faint">
          {emptyNote ?? "No journeys discovered yet."}
        </p>
      </section>
    );
  }
  const carried = journeys.filter((j) => j.carriedFromRunId).length;
  return (
    <section className="space-y-5">
      <div>
        <h2 className="section-label">What your users do</h2>
        <p className="mt-1 text-sm text-fg-muted">
          We discovered {journeys.length} main user journey{journeys.length > 1 ? "s" : ""}.
          Here&apos;s how each one went.
          {carried > 0 && (
            <>
              {" "}
              {journeys.length - carried} {journeys.length - carried === 1 ? "was" : "were"} walked
              again this run; {carried} {carried === 1 ? "is" : "are"} carried forward from an
              earlier run and marked as such.
            </>
          )}
        </p>
      </div>

      {journeys.map((journey, i) => (
        <JourneyCard
          key={journey.id}
          journey={journey}
          numbers={numbers?.[journey.id]}
          collapsedByDefault={i >= 2}
          carriedRunNumber={
            journey.carriedFromRunId ? carriedRunNumbers?.[journey.carriedFromRunId] : undefined
          }
          carriedDay={journey.carriedFromRunId ? carriedRunDays?.[journey.carriedFromRunId] : undefined}
        />
      ))}
    </section>
  );
}

// A step that dragged the journey's status down. "skipped" is absence of
// evidence, not a problem — the strip already dims it.
const PROBLEM_STATUSES = new Set(["risky", "confusing", "broken", "exposed"]);

function JourneyCard({
  journey,
  collapsedByDefault,
  carriedRunNumber,
  carriedDay,
  numbers,
}: {
  journey: JourneyWithSteps;
  collapsedByDefault: boolean;
  carriedRunNumber?: number;
  carriedDay?: string;
  numbers?: JourneyNumbersProps;
}) {
  const [open, setOpen] = useState(!collapsedByDefault);
  const [selected, setSelected] = useState<Step | null>(null);
  // CHE-71: full-size screenshot overlay. Holds the image URL + caption.
  const [lightbox, setLightbox] = useState<{ src: string; caption: string } | null>(null);
  const meta = STEP_STATUS_META[journey.status];
  const problems = journey.steps.filter((s) => PROBLEM_STATUSES.has(s.status));

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        // On a phone the chips go under the title instead of pushing the card
        // wider than the screen (a carried journey's two chips are ~300px).
        className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-4 text-left transition-colors hover:bg-ink-800/50 sm:flex-nowrap"
      >
        <h3 className="min-w-0 font-medium text-fg">
          <span className={`chevron mr-2 inline-block text-fg-faint ${open ? "rotate-90" : ""}`}>
            ›
          </span>
          {journey.order + 1}. {journey.title}
        </h3>
        <span className="flex flex-wrap items-center gap-2 whitespace-nowrap sm:shrink-0 sm:flex-nowrap">
          {/* CHE-57: this journey was not walked this run — it was copied
              forward from the run that did walk it. The status pill next to it
              is therefore a statement about that run, and this chip is the only
              thing on the page that says so. */}
          {journey.carriedFromRunId && (
            <span className="rounded-full border border-ink-600 px-2.5 py-1 font-mono text-xs text-fg-faint">
              carried{carriedRunNumber ? ` · Run #${carriedRunNumber}` : ""}
              {carriedDay ? ` · ${carriedDay}` : ""}
            </span>
          )}
          <span
            className={`rounded-full border px-2.5 py-1 font-mono text-xs ${meta.className}`}
            style={{
              borderColor: "color-mix(in srgb, currentColor 30%, transparent)",
              backgroundColor: "color-mix(in srgb, currentColor 10%, transparent)",
            }}
          >
            {meta.emoji} {meta.label}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-ink-700 px-5 py-4">
          {/* Answer the status pill FIRST (owner call, 2026-08-23: "when I
              click Confusing I must immediately see what is confusing").
              Deterministic — built from the steps that dragged the status
              down, each line naming the step and quoting what happened. */}
          {problems.length > 0 && (
            <div
              className={`mb-3 rounded-r-md border-l-2 bg-ink-800/40 py-2 pl-3 pr-3 ${meta.className}`}
              style={{ borderColor: "color-mix(in srgb, currentColor 50%, transparent)" }}
            >
              <p className="text-sm font-medium">
                Why this journey is “{meta.label}”:
              </p>
              <ul className="mt-1 space-y-1">
                {problems.map((p) => {
                  const s = STEP_STATUS_META[p.status];
                  return (
                    <li key={p.id} className="text-sm text-fg-muted">
                      <button
                        onClick={() => setSelected(selected?.id === p.id ? null : p)}
                        className={`font-medium underline-offset-2 hover:underline ${s.className}`}
                      >
                        {s.emoji} {p.label}
                      </button>
                      {p.observed && <> — {p.observed}</>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Storyboard discipline (NN/g, Playwright trace viewer): equal
              fixed-size cells top-aligned, caption in a fixed-height box below
              the frame, arrows on the thumbnail axis — caption length can
              never make the row ragged. Failed steps get a status ring;
              skipped ones dim. */}
          <div className="strip-scroll flex items-start gap-1 overflow-x-auto pb-2 pt-1">
            {journey.steps.map((step, i) => {
              const s = STEP_STATUS_META[step.status];
              const isSelected = selected?.id === step.id;
              const isFailed = step.status === "broken" || step.status === "exposed";
              const hasShot = Boolean(step.screenshotUrl);
              return (
                <div key={step.id} className="flex items-start">
                  {/* mt-12 ≈ card padding + half of the aspect-[16/10] thumb
                      on a w-40 cell — arrow points frame-to-frame. */}
                  {i > 0 && <span className="mx-1 mt-12 shrink-0 text-fg-faint">→</span>}
                  <button
                    onClick={() => setSelected(isSelected ? null : step)}
                    className={`group w-40 shrink-0 rounded-lg border p-2 text-left transition-all ${
                      isSelected
                        ? "border-accent bg-ink-800 shadow-glow"
                        : "border-ink-700 bg-ink-900 hover:border-ink-600 hover:bg-ink-800"
                    } ${step.status === "skipped" ? "opacity-60" : ""}`}
                  >
                    {hasShot ? (
                      <div
                        className={`relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded bg-ink-950 ${
                          isFailed ? "ring-2 ring-status-broken" : ""
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={step.screenshotUrl!}
                          alt={step.label}
                          className={`h-full w-full object-cover object-top ${
                            step.status === "skipped" ? "grayscale" : ""
                          }`}
                        />
                        <span
                          className={`absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-ink-950 ${s.dotClassName}`}
                        >
                          {s.emoji}
                        </span>
                        {/* CHE-71: zoom without toggling the step detail. A
                            span with a click handler, not a nested button —
                            buttons can't nest inside the card's button. */}
                        <span
                          role="button"
                          aria-label={`View full-size screenshot: ${step.label}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setLightbox({ src: step.screenshotUrl!, caption: step.label });
                          }}
                          className="absolute right-1 top-1 flex h-5 w-5 cursor-zoom-in items-center justify-center rounded bg-ink-950/70 text-[11px] text-fg-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                        >
                          ⤢
                        </span>
                      </div>
                    ) : (
                      // Non-visual step (an assertion / check with no meaningful
                      // screenshot): a status chip on a dashed frame, not a fake
                      // photo box that reads as a broken image.
                      <div
                        className={`flex aspect-[16/10] items-center justify-center gap-1.5 rounded border border-dashed ${
                          isFailed ? "border-status-broken/60" : "border-ink-600"
                        } bg-ink-900`}
                      >
                        <span className={`text-base ${s.className}`}>{s.emoji}</span>
                        <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                          {s.label}
                        </span>
                      </div>
                    )}
                    <p className="mt-1.5 line-clamp-2 h-8 text-[11px] leading-4 text-fg-muted">
                      {step.label}
                    </p>
                  </button>
                </div>
              );
            })}
          </div>

          {selected && <StepDetail step={selected} onZoom={setLightbox} />}

          {journey.summary && (
            /* Takeaway zone (NN/g "insights"): full-width bar with a left
               accent in the journey's worst status color — a verdict line,
               not another step caption. */
            <p
              className={`mt-3 rounded-r-md border-l-2 bg-ink-800/40 py-2 pl-3 pr-3 text-sm text-fg-muted ${meta.className}`}
              style={{ borderColor: "color-mix(in srgb, currentColor 50%, transparent)" }}
            >
              <span className="font-medium">What we found:</span>{" "}
              <span className="text-fg-muted">{journey.summary}</span>
            </p>
          )}

          {/* CHE-240: what we judged, and what their own analytics counted —
              the same kind of row each, every one naming its source, so a
              reader compares them instead of guessing which is which. */}
          {numbers && <JourneyNumbersBlock {...numbers} title={journey.title} />}

          {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}

          {journey.videoUrl && (
            <a
              href={journey.videoUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-ink-600 px-3 py-2 font-mono text-xs text-fg-muted transition-colors hover:border-ink-700 hover:text-fg"
            >
              ▶ Watch the agent go through this journey
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// Inline expansion for a clicked step-card: what we tried / what happened /
// screenshot / console / network excerpts.
function StepDetail({
  step,
  onZoom,
}: {
  step: Step;
  onZoom: (l: { src: string; caption: string }) => void;
}) {
  const s = STEP_STATUS_META[step.status];
  return (
    <div className="mt-2 animate-fade-up rounded-lg border border-ink-700 bg-ink-900 p-4">
      <p className={`font-mono text-xs ${s.className}`}>
        {s.emoji} {s.label} — {step.label}
      </p>
      {step.screenshotUrl && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={step.screenshotUrl}
          alt={step.label}
          onClick={() => onZoom({ src: step.screenshotUrl!, caption: step.label })}
          className="mt-3 max-h-80 w-auto cursor-zoom-in rounded border border-ink-700 object-contain transition-opacity hover:opacity-90"
        />
      )}
      <div className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
        {step.attempted && (
          <div>
            <p className="section-label mb-1">What we tried</p>
            <p className="text-fg-muted">{step.attempted}</p>
          </div>
        )}
        {step.observed && (
          <div>
            <p className="section-label mb-1">What happened</p>
            <p className="text-fg-muted">{step.observed}</p>
          </div>
        )}
      </div>
      {step.consoleLog && (
        <pre className="mt-3 overflow-x-auto rounded bg-ink-950 p-3 font-mono text-xs leading-5 text-fg-faint">
          {step.consoleLog}
        </pre>
      )}
      {step.networkLog && (
        <pre className="mt-2 overflow-x-auto rounded bg-ink-950 p-3 font-mono text-xs leading-5 text-fg-faint">
          {step.networkLog}
        </pre>
      )}
    </div>
  );
}

// CHE-71: full-size screenshot overlay. Click anywhere or press Escape to
// close; the image itself stops propagation so a misclick inside doesn't
// dismiss it.
function Lightbox({
  src,
  caption,
  onClose,
}: {
  src: string;
  caption: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-ink-950/90 p-6 backdrop-blur-sm"
      role="dialog"
      aria-label={`Screenshot: ${caption}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={caption}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-[95vw] rounded-lg border border-ink-600 object-contain shadow-2xl"
      />
      <p className="max-w-2xl text-center font-mono text-xs text-fg-muted">{caption}</p>
      <button
        onClick={onClose}
        className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full border border-ink-600 bg-ink-900 text-fg-muted transition-colors hover:text-fg"
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  );
}
