"use client";

import { useId, useState, type MouseEvent } from "react";
import { ISSUE_MARKS, markLabel, type IssueMark } from "@/lib/issues-page";
import { useIssueMark } from "@/components/issue-marks";

// The owner's answer on an Issues row (CHE-413): the answer given so far as
// text, and one "Actions" button whose menu holds the four answers. Choosing
// the current one again withdraws it. The write is the one the problem's own
// page makes (useIssueMark — PATCH /api/findings/{id} on the finding of the
// latest sighting, then a refresh).
//
// The menu is positioned from the button's own box at the moment it opens and
// drawn fixed, so a row near the bottom of the table opens it over whatever is
// below rather than inside the card. A full-screen transparent backdrop behind
// it closes it on a click anywhere else; Escape and a wheel turn close it too.
// State only — no effect watches anything.
export function IssueActions({ findingId, mark: initial }: { findingId: string; mark: string }) {
  const { mark, busy, failed, set } = useIssueMark(findingId, initial);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const menuId = useId();
  const open = at !== null;
  const close = () => setAt(null);

  function toggle(e: MouseEvent<HTMLButtonElement>) {
    if (open) return close();
    const box = e.currentTarget.getBoundingClientRect();
    setAt({ top: box.bottom + 4, right: Math.max(8, window.innerWidth - box.right) });
  }

  function choose(next: IssueMark) {
    close();
    void set(next);
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className={`text-xs ${mark === "none" ? "text-fg-faint" : "text-fg"}`}>{markLabel(mark) ?? "—"}</span>
      <button
        type="button"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-600 px-2.5 text-xs text-fg-muted transition-colors hover:border-fg-faint hover:text-fg disabled:opacity-50"
      >
        Actions
        <span aria-hidden="true" className="text-[10px]">▾</span>
      </button>
      {open && (
        <>
          <button type="button" tabIndex={-1} aria-label="Close menu" onClick={close} onWheel={close} className="fixed inset-0 z-20 cursor-default bg-transparent" />
          <div
            id={menuId}
            role="menu"
            aria-label="Your answer"
            style={{ top: at.top, right: at.right }}
            onKeyDown={(e) => e.key === "Escape" && close()}
            className="fixed z-30 w-44 rounded-lg border border-ink-600 bg-ink-900 p-1 shadow-card"
          >
            {ISSUE_MARKS.map((m) => {
              const given = mark === m.mark;
              return (
                <button
                  key={m.mark}
                  type="button"
                  role="menuitemradio"
                  aria-checked={given}
                  onClick={() => choose(given ? "none" : m.mark)}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-ink-800 ${given ? "text-fg" : "text-fg-muted hover:text-fg"}`}
                >
                  {m.label}
                  {given && <span aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
      {failed && <span className="text-xs text-status-broken">Not saved — try again.</span>}
    </span>
  );
}
