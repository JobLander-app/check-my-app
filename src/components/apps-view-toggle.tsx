"use client";

import Link from "next/link";
import { APPS_VIEW_COOKIE, type AppsView } from "@/lib/all-apps";

// Cards / List on Health → All apps (CHE-357). The view is in the address, so
// the server renders it; the click also leaves the choice in a cookie, so the
// page opens the same way next time. Written where the choice is made — in the
// click — not by an effect watching the address.
const YEAR_S = 365 * 24 * 60 * 60;

export function AppsViewToggle({ view, hrefs }: { view: AppsView; hrefs: Record<AppsView, string> }) {
  return (
    <div role="group" aria-label="View" className="flex gap-0.5 rounded-lg border border-ink-700 bg-ink-900 p-[3px]">
      {(["cards", "list"] as const).map((v) => (
        <Link
          key={v}
          href={hrefs[v]}
          aria-current={view === v ? "true" : undefined}
          onClick={() => {
            document.cookie = `${APPS_VIEW_COOKIE}=${v}; path=/; max-age=${YEAR_S}; samesite=lax`;
          }}
          className={`inline-flex h-[30px] items-center rounded-md px-3 text-[13px] ${
            view === v ? "bg-ink-700 text-fg" : "text-fg-muted hover:text-fg"
          }`}
        >
          {v === "cards" ? "Cards" : "List"}
        </Link>
      ))}
    </div>
  );
}
