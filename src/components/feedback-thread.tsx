"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { giveFeedbackAction } from "@/app/feedback/actions";
import { REASON_LABEL, STATUS_LABEL, type FeedbackItem, type FeedbackReason, type FeedbackTarget } from "@/lib/feedback";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

// CHE-434: where the check got this check, finding, step or scenario wrong —
// what the team already reported and the box to report it. It asks only for
// the check's mistake: the reports are how the checker gets better, not a chat.
// Collapsed to one line until there is something to read, so a verdict with
// twenty findings does not become twenty forms.
export function FeedbackThread({
  target,
  back,
  items,
  mayWrite,
  reasons,
  label,
  open = false,
}: {
  target: FeedbackTarget;
  back: string;
  items: FeedbackItem[];
  mayWrite: boolean;
  reasons: readonly FeedbackReason[];
  label: string;
  open?: boolean;
}) {
  const [state, formAction] = useActionState(giveFeedbackAction.bind(null, target, back), null);
  if (!mayWrite && items.length === 0) return null;

  return (
    <details className="group rounded-lg border border-ink-700 bg-ink-850/40 px-3 py-2" open={open || items.length > 0}>
      <summary className="cursor-pointer list-none text-sm text-fg-muted hover:text-fg">
        {label}
        {items.length > 0 && <span className="text-fg-faint"> · {items.length} reported</span>}
      </summary>
      {items.length > 0 && (
        <ul className="mt-2 space-y-2">
          {items.map((c) => (
            <li key={c.id} className="text-sm">
              <p className="text-xs text-fg-faint">
                {REASON_LABEL[c.reason] ?? c.reason}
                {c.findingNumber !== null && <> · finding #{String(c.findingNumber).padStart(3, "0")}</>}
                {c.stepLabel && <> · step “{c.stepLabel}”</>}
                {" · "}
                {c.author} · {c.at.slice(0, 16).replace("T", " ")} UTC · {STATUS_LABEL[c.status] ?? c.status}
              </p>
              <p className="whitespace-pre-wrap text-fg">{c.text}</p>
            </li>
          ))}
        </ul>
      )}
      {mayWrite && (
        <form action={formAction} className="mt-3 flex flex-col gap-2">
          <Select name="reason" required defaultValue="" className="py-1.5 text-sm" aria-label="What did the check get wrong?">
            <option value="" disabled>
              What did the check get wrong?
            </option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {REASON_LABEL[r]}
              </option>
            ))}
          </Select>
          <Textarea
            name="text"
            required
            rows={2}
            maxLength={4000}
            placeholder="What really happened, or what the check should have done"
            className="text-sm"
          />
          <div className="flex items-center gap-3">
            <SendButton />
            {state?.error && <span className="text-sm text-status-broken">{state.error}</span>}
            {state?.sent && <span className="text-sm text-fg-muted">Sent to the CheckMyApp team. Its status shows here.</span>}
          </div>
        </form>
      )}
    </details>
  );
}

function SendButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" className="py-1.5" disabled={pending}>
      {pending ? "Sending…" : "Report"}
    </Button>
  );
}
