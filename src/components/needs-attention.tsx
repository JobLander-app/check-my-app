import Link from "next/link";
import { appPath } from "@/lib/app-shell";
import { causeAction, causeText } from "@/lib/step-cause";
import type { CauseGroup } from "@/lib/step-cause-load";
import { REASON_LABEL, STATUS_LABEL, type FeedbackItem, type FeedbackReason } from "@/lib/feedback";

// How many of the team's reports the card lists; the rest are a link away.
export const CARD_REPORTS = 5;

// "Needs your attention" (CHE-443, CHE-434 place 9): what keeps part of this
// app from being checked and is the team's to decide, not ours — a store
// password to add, a sign-in that ended, a rule that stops a check on purpose —
// and, beside it, what the team reported the check got wrong, each with where
// it stands. What is only our incapacity is not here: it is a ticket on our own
// board and the admin has nothing to do about it.
export function NeedsAttention({
  appId,
  runNumber,
  groups,
  reports = [],
}: {
  appId: string;
  runNumber: number | null;
  groups: CauseGroup[];
  reports?: FeedbackItem[];
}) {
  if (groups.length === 0 && reports.length === 0) return null;
  return (
    <section className="card flex flex-col gap-2 p-[18px]" aria-label="Needs your attention">
      <div className="text-[15px] font-semibold">Needs your attention</div>
      {groups.length > 0 && (
        <>
          <div className="text-[13px] text-fg-muted">Steps of check #{runNumber} that were not checked, and why.</div>
          <ul className="flex flex-col gap-3">
            {groups.map((g) => {
              const action = causeAction(g.cause);
              const href = action?.to === "sign_in" ? appPath.signIn(appId) : action?.to === "accounts" ? appPath.section(appId, "accounts") : null;
              return (
                <li key={g.cause} className="text-[13px]">
                  <span className="block">{causeText(g.cause)}</span>
                  <span className="block text-fg-muted">
                    {g.steps} {g.steps === 1 ? "step" : "steps"}: {g.labels.join("; ")}
                    {g.steps > g.labels.length ? "…" : ""}
                  </span>
                  {action &&
                    (href ? (
                      <Link href={href} className="mt-1 inline-block text-accent hover:underline">
                        {action.text}
                      </Link>
                    ) : (
                      <span className="mt-1 block text-fg-muted">{action.text}.</span>
                    ))}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {reports.length > 0 && (
        <>
          <div className={`text-[13px] text-fg-muted ${groups.length > 0 ? "mt-2 border-t border-ink-700 pt-3" : ""}`}>
            What your team reported the check got wrong.
          </div>
          <ul className="flex flex-col gap-3">
            {reports.map((r) => (
              <li key={r.id} className="text-[13px]">
                <span className="block">
                  {REASON_LABEL[r.reason as FeedbackReason] ?? r.reason}
                  {r.findingNumber !== null ? ` · finding #${String(r.findingNumber).padStart(3, "0")}` : r.stepLabel ? ` · “${r.stepLabel}”` : ""}
                </span>
                <span className="block text-fg-muted">
                  “{r.text.length > 140 ? `${r.text.slice(0, 140)}…` : r.text}” — {r.author}
                </span>
                <span className="block text-fg-muted">
                  {STATUS_LABEL[r.status] ?? r.status}
                  {r.runPublicId && (
                    <>
                      {" · "}
                      <Link href={`/verdict/${r.runPublicId}`} className="text-accent hover:underline">
                        the check
                      </Link>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
