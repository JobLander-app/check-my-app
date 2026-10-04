import type { Release } from "@/lib/releases";
import { AUDIENCE_LABEL, DELTA_GROUPS, releaseDeltaLine } from "@/lib/release-page";

// What a release broke, fixed and left alone against the one before it
// (CHE-367): the line, and — opened — the problems under each heading with who
// would have hit them. Server-rendered; a native <details>, no script.
export function ReleaseDelta({ release, open = false }: { release: Release; open?: boolean }) {
  const line = releaseDeltaLine(release);
  const d = release.delta;
  const any = d !== null && DELTA_GROUPS.some((g) => d[g.key].length > 0);
  if (!d || !any) return <p className="text-sm text-fg-muted">{line}</p>;
  return (
    <details open={open} className="group text-sm">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-fg-muted hover:text-fg">
        <span className={d.broke.length > 0 ? "text-status-broken" : undefined}>{line}</span>
        <span className="text-xs text-fg-faint underline decoration-dotted underline-offset-2 group-open:hidden">what</span>
      </summary>
      <div className="mt-2.5 flex flex-col gap-3 rounded-md border border-ink-700 bg-ink-850 p-3.5">
        {DELTA_GROUPS.filter((g) => d[g.key].length > 0).map((g) => (
          <div key={g.key}>
            <p className={`text-xs font-medium ${g.className}`}>{g.label}</p>
            <ul className="mt-1 flex flex-col gap-1">
              {d[g.key].map((item) => {
                const who = AUDIENCE_LABEL[item.audience];
                return (
                  <li key={`${g.key}:${item.signature}:${item.title}`} className="text-[13px] text-fg">
                    {item.title}
                    {who && <span className="text-fg-faint"> · {who}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
