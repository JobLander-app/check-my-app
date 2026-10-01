import type { PriceExplanation } from "@/lib/check-price";

// CHE-327: a check's price is never shown alone. The price is the summary of a
// native <details> — no script, no extra request — and opening it answers
// "why did this cost $X": the work it did, how that compares with this app's
// usual, and, where the ledger recorded it, each part's share (prices that add
// up to the check's price). Server-rendered; nothing here is a cost.

const money = (n: number) => `$${n.toFixed(2)}`;

// `label: null` is for a table column that already says what the price is of.
export function CheckPrice({ explanation, label = "This check" }: { explanation: PriceExplanation; label?: string | null }) {
  const e = explanation;
  return (
    <details className="group mt-1 font-mono text-xs text-fg-faint">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 hover:text-fg-muted">
        {label !== null && `${label}: `}
        <span className="text-fg-muted">{money(e.price_usd)}</span>
        <span className="underline decoration-dotted underline-offset-2">why?</span>
      </summary>
      <div className="mt-2 min-w-64 max-w-md space-y-2 rounded-md border border-ink-700 bg-ink-850 p-3 text-left font-sans text-xs leading-5 text-fg-muted">
        <p className="text-fg">{e.work}.</p>
        {e.comparison && <p>{e.comparison}</p>}
        {e.parts.length > 0 && (
          <ul className="space-y-0.5">
            {e.parts.map((p) => (
              <li key={p.label} className="flex justify-between gap-4">
                <span className="min-w-0 truncate">
                  {p.label}
                  {p.steps !== undefined && <span className="text-fg-faint"> · {p.steps} step{p.steps === 1 ? "" : "s"}</span>}
                </span>
                <span className="font-mono">{money(p.price_usd)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
