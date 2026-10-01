import { VERDICT_META } from "@/lib/status";

// An app's last checks as a strip: one bar per check, oldest on the left, the
// colour of its verdict (CHE-357). Always `slots` wide, so two apps' strips line
// up check for check; an app with fewer checks starts with empty slots.
export function VerdictStrip({
  verdicts,
  slots = 21,
  className = "h-[30px]",
}: {
  verdicts: { runNumber: number; verdict: string }[];
  slots?: number;
  className?: string;
}) {
  const shown = verdicts.slice(-slots);
  const empty = Math.max(0, slots - shown.length);
  return (
    <div
      role="img"
      aria-label={
        shown.length === 0
          ? "No checks yet"
          : `Last ${shown.length} check${shown.length === 1 ? "" : "s"}, oldest first: ${shown
              .map((v) => VERDICT_META[v.verdict]?.label ?? v.verdict)
              .join(", ")}`
      }
      className={`flex gap-[3px] ${className}`}
    >
      {Array.from({ length: empty }, (_, i) => (
        <span key={`e${i}`} className="h-full min-w-0 flex-1 rounded-[3px] bg-ink-800" />
      ))}
      {shown.map((v) => (
        <span
          key={v.runNumber}
          title={`#${v.runNumber} · ${VERDICT_META[v.verdict]?.label ?? v.verdict}`}
          className={`h-full min-w-0 flex-1 rounded-[3px] ${VERDICT_META[v.verdict]?.dotClassName ?? "bg-ink-600"}`}
        />
      ))}
    </div>
  );
}
