"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ISSUE_MARKS, type IssueMark } from "@/lib/issues-page";
import { markFinding } from "@/app/(app)/health/issues/actions";

// The owner's answer to a problem (CHE-360). The same four marks the check's
// own page sets, written to the finding of the problem's latest sighting — so
// a mark set here is the one the next check and the tracker rules read
// (Finding.mark). The write is a server action in a transition (R5): the
// control is live from the first HTML. The state and the write live in one
// hook shared by the two places that answer: the four links on a problem's
// own page (IssueMarks below) and the Actions menu on an Issues row
// (src/components/issue-actions.tsx, CHE-413).
export function useIssueMark(findingId: string, initial: string) {
  const router = useRouter();
  const [mark, setMark] = useState<IssueMark>(initial as IssueMark);
  const [busy, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  function set(next: IssueMark) {
    setFailed(false);
    const prev = mark;
    setMark(next);
    startTransition(async () => {
      const result = await markFinding(findingId, next).catch(() => null);
      if (result && "ok" in result) {
        // The row's state is computed on the server from the marks: ask for it again.
        router.refresh();
      } else {
        setMark(prev);
        setFailed(true);
      }
    });
  }

  return { mark, busy, failed, set };
}

export function IssueMarks({ findingId, mark: initial }: { findingId: string; mark: string }) {
  const { mark, busy, failed, set } = useIssueMark(findingId, initial);

  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {ISSUE_MARKS.map((m) => (
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
