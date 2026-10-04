"use client";

import { useRef, useState } from "react";
import type { PriceExplanation, PricePart } from "@/lib/check-price";

// CHE-327: a check's price is never shown alone. The price is a button, and
// pressing it opens "why did this cost $X" in one modal (CHE-411) — the same
// one from every page, where the reason used to unfold inside the row. The
// reason is in sections that follow the check: before the walk (mapping the
// app), the journeys walked, after the walk (writing the verdict). The journey
// rows are exactly the journeys the work line counts, so "Walked 5 journeys"
// over 5 rows; a journey set out on and given up before its first step has its
// own group, named for what it was. Nothing here is a cost.
//
// The modal is a native <dialog>: showModal() in the click handler, Esc and the
// backdrop close it through the element's own behaviour, no effect watches it.
// A page listing many checks hands the check's public id instead of the
// explanation and the reason is loaded on the first press (one request for the
// one check asked about).

const money = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sum = (parts: PricePart[]) => parts.reduce((s, p) => s + p.price_usd, 0);

type Source =
  | { explanation: PriceExplanation; publicId?: undefined; priceUsd?: undefined }
  | { explanation?: undefined; publicId: string; priceUsd: number };

export function CheckPrice({
  explanation,
  publicId,
  priceUsd,
  label = "This check",
  title,
  className = "",
}: Source & {
  // `label: null` is for a column that already says what the price is of:
  // the price alone, dotted, with the "why?" implied.
  label?: string | null;
  // What the reason is of — "checkmyapp.dev, check #290" — for the heading.
  title?: string;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState<PriceExplanation | null>(explanation ?? null);
  const [failed, setFailed] = useState(false);
  const price = explanation?.price_usd ?? priceUsd ?? loaded?.price_usd ?? 0;

  async function open() {
    dialog.current?.showModal();
    if (loaded || !publicId) return;
    const res = await fetch(`/api/runs/${publicId}/price`).catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as PriceExplanation | null) : null;
    if (body) setLoaded(body);
    else setFailed(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        className={
          label === null
            ? `whitespace-nowrap font-mono text-fg underline decoration-dotted underline-offset-2 hover:text-accent ${className}`
            : `inline-flex items-center gap-1 font-mono text-xs text-fg-faint hover:text-fg-muted ${className}`
        }
      >
        {label === null ? (
          money(price)
        ) : (
          <>
            {label}: <span className="text-fg-muted">{money(price)}</span>
            <span className="underline decoration-dotted underline-offset-2">why?</span>
          </>
        )}
      </button>
      <dialog
        ref={dialog}
        aria-label={`Why this check cost ${money(price)}`}
        // The dialog's own box is the backdrop's click target: a press outside
        // the panel lands on the dialog element itself, not on its content.
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        // text-left: the button often sits in a right-aligned price column,
        // and the dialog would inherit that alignment.
        className="m-auto w-[min(100vw-2rem,32rem)] rounded-xl border border-ink-700 bg-ink-850 p-0 text-left text-fg shadow-card backdrop:bg-ink-950/70"
      >
        <div className="flex flex-col gap-4 p-5 text-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-[17px] font-semibold">
                Why <span className="font-mono">{money(price)}</span>
              </h2>
              {title && <p className="mt-0.5 truncate text-[13px] text-fg-muted">{title}</p>}
            </div>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              aria-label="Close"
              className="-mr-1.5 -mt-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-ink-800 hover:text-fg"
            >
              ✕
            </button>
          </div>
          {loaded ? (
            <Breakdown e={loaded} />
          ) : (
            <p className="text-fg-muted">{failed ? "The reason could not be loaded. Close this and try again." : "Loading…"}</p>
          )}
        </div>
      </dialog>
    </>
  );
}

function Breakdown({ e }: { e: PriceExplanation }) {
  const before = e.parts.filter((p) => p.section === "before");
  const journeys = e.parts.filter((p) => p.section === "journeys");
  const walked = journeys.filter((p) => (p.steps ?? 0) > 0);
  const notWalked = journeys.filter((p) => (p.steps ?? 0) === 0);
  const after = e.parts.filter((p) => p.section === "after");
  const steps = walked.reduce((s, p) => s + (p.steps ?? 0), 0);
  return (
    <>
      <div className="flex flex-col gap-1">
        <p>{e.work}.</p>
        {e.comparison && <p className="text-fg-muted">{e.comparison}</p>}
      </div>
      {e.parts.length > 0 && (
        <div className="flex flex-col gap-3.5">
          {before.length > 0 && <Section heading="Before the walk" parts={before} />}
          {walked.length > 0 && <Section heading={`Journeys walked (${walked.length}) · ${plural(steps, "step")}`} parts={walked} />}
          {notWalked.length > 0 && <Section heading={`Started, not walked (${notWalked.length})`} parts={notWalked} note="not walked" />}
          {after.length > 0 && <Section heading="After the walk" parts={after} />}
        </div>
      )}
      <div className="flex justify-between gap-4 border-t border-ink-700 pt-3 font-medium">
        <span>Total</span>
        <span className="font-mono">{money(e.price_usd)}</span>
      </div>
    </>
  );
}

function Section({ heading, parts, note }: { heading: string; parts: PricePart[]; note?: string }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex justify-between gap-4 text-[13px] text-fg-muted">
        <span>{heading}</span>
        <span className="font-mono">{money(sum(parts))}</span>
      </div>
      <ul className="flex flex-col">
        {/* By position: a run can walk the same journey twice (#290 did), and
            two rows with one title are two parts of the price. */}
        {parts.map((p, i) => (
          <li key={i} className="flex justify-between gap-4 border-b border-ink-800 py-1.5 last:border-b-0">
            <span className="min-w-0 break-words">
              {p.label}
              {(note || (p.steps ?? 0) > 0) && <span className="whitespace-nowrap text-fg-faint"> · {note ?? plural(p.steps!, "step")}</span>}
            </span>
            <span className="shrink-0 font-mono">{money(p.price_usd)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
