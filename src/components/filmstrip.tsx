import { STEP_STATUS_META } from "@/lib/status";
import { THUMB_WIDTH } from "@/lib/storage";
import { frameLabel } from "@/lib/journeys-page";
import type { JourneyFrame } from "@/lib/journeys-load";

// A journey as the screens of one walk (CHE-362): numbered frames in step
// order, each with its status and its step's own words underneath. Drawn on the
// server and without script — a frame is a link to its full-size screenshot,
// and the strip scrolls sideways with snap where it does not fit.
//
// The picture is the small copy (src/lib/thumbnail.ts): ~6 KB against ~420 KB.
// Same cell discipline as the verdict's strip (journey-strip.tsx): equal cells,
// caption in a fixed-height box, so a long label never makes the row ragged.
export function Filmstrip({ frames }: { frames: JourneyFrame[] }) {
  return (
    <ol className="strip-scroll flex snap-x snap-mandatory items-start gap-2 overflow-x-auto pb-2 pt-1">
      {frames.map((frame, i) => {
        const s = STEP_STATUS_META[frame.status] ?? STEP_STATUS_META.skipped;
        const failed = frame.status === "broken" || frame.status === "exposed";
        const name = frameLabel(i, frames.length, frame.label);
        return (
          <li key={frame.id} className={`w-40 shrink-0 snap-start ${frame.status === "skipped" ? "opacity-60" : ""}`}>
            {frame.shot ? (
              <a
                href={frame.shot.full}
                target="_blank"
                rel="noreferrer"
                aria-label={`${name} — open the full-size screenshot`}
                className={`relative block aspect-[16/10] overflow-hidden rounded border bg-ink-950 ${
                  failed ? "border-status-broken ring-1 ring-status-broken" : "border-ink-700 hover:border-ink-600"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={frame.shot.thumb}
                  alt={name}
                  width={THUMB_WIDTH}
                  height={(THUMB_WIDTH * 10) / 16}
                  loading="lazy"
                  decoding="async"
                  className={`h-full w-full object-cover object-top ${frame.status === "skipped" ? "grayscale" : ""}`}
                />
                <Marks index={i} status={frame.status} />
              </a>
            ) : (
              // A step with no picture of its own: its status in a dashed frame,
              // never an empty photo box that reads as a broken image.
              <div
                className={`relative flex aspect-[16/10] items-center justify-center gap-1.5 rounded border border-dashed bg-ink-900 ${
                  failed ? "border-status-broken/60" : "border-ink-600"
                }`}
              >
                <span className={`text-base ${s.className}`}>{s.emoji}</span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">{s.label}</span>
                <Marks index={i} status={null} />
              </div>
            )}
            <p className="mt-1.5 line-clamp-2 h-8 text-[11px] leading-4 text-fg-muted">{frame.label}</p>
          </li>
        );
      })}
    </ol>
  );
}

// The frame's number, and — over a picture — the step's status mark.
function Marks({ index, status }: { index: number; status: string | null }) {
  const s = status ? STEP_STATUS_META[status] ?? STEP_STATUS_META.skipped : null;
  return (
    <>
      <span className="absolute left-1 top-1 flex h-4 min-w-4 items-center justify-center rounded bg-ink-950/80 px-1 font-mono text-[10px] text-fg-muted">
        {index + 1}
      </span>
      {s && (
        <span
          className={`absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-ink-950 ${s.dotClassName}`}
        >
          {s.emoji}
        </span>
      )}
    </>
  );
}
