import Link from "next/link";
import { appPath } from "@/lib/app-shell";
import { causeAction, causeText } from "@/lib/step-cause";
import type { CauseGroup } from "@/lib/step-cause-load";

// "Needs your attention" (CHE-443; CHE-434 puts the members' reports beside
// these): what keeps part of this app from being checked and is the team's to
// decide, not ours — a store password to add, a sign-in that ended, a rule that
// stops a check on purpose. What is only our incapacity is not here: it is a
// ticket on our own board and the admin has nothing to do about it.
export function NeedsAttention({ appId, runNumber, groups }: { appId: string; runNumber: number; groups: CauseGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <section className="card flex flex-col gap-2 p-[18px]" aria-label="Needs your attention">
      <div className="text-[15px] font-semibold">Needs your attention</div>
      <div className="text-[13px] text-fg-muted">
        Steps of check #{runNumber} that were not checked, and why.
      </div>
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
    </section>
  );
}
