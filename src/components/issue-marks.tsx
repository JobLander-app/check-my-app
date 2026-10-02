"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The owner's answer to a problem, from the Issues list (CHE-360). The same
// four marks the check's own page sets, written the same way — PATCH
// /api/findings/{id} on the finding of the problem's latest sighting — so a
// mark set here is the one the next check and the tracker rules read
// (Finding.mark; src/components/findings-list.tsx).
const MARKS = [
  { mark: "known", label: "That's fine" },
  { mark: "watch", label: "Watch it" },
  { mark: "fixed", label: "Mark as fixed" },
  { mark: "false_positive", label: "Dispute" },
] as const;

type Mark = (typeof MARKS)[number]["mark"] | "none";

export function IssueMarks({ findingId, mark: initial }: { findingId: string; mark: string }) {
  const router = useRouter();
  const [mark, setMark] = useState<Mark>(initial as Mark);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function set(next: Mark) {
    setBusy(true);
    setFailed(false);
    const prev = mark;
    setMark(next);
    const res = await fetch(`/api/findings/${findingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mark: next }),
    }).catch(() => null);
    if (res?.ok) {
      // The row's state is computed on the server from the marks: ask for it again.
      router.refresh();
    } else {
      setMark(prev);
      setFailed(true);
    }
    setBusy(false);
  }

  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {MARKS.map((m) => (
        <button
          key={m.mark}
          type="button"
          disabled={busy}
          aria-pressed={mark === m.mark}
          onClick={() => set(mark === m.mark ? "none" : m.mark)}
          className={`whitespace-nowrap text-xs underline-offset-2 hover:underline disabled:opacity-50 ${mark === m.mark ? "text-fg underline" : "text-fg-muted"}`}
        >
          {m.label}
        </button>
      ))}
      {failed && <span className="text-xs text-status-broken">Not saved — try again.</span>}
    </span>
  );
}
