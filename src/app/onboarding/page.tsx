import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { OnboardingChooser } from "@/components/onboarding-chooser";
import { watchCapReason } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { ownerScoped, teamOwned } from "@/lib/tenant-db";
import { extensionCheckFor } from "@/lib/viewer-flags";

// Onboarding (protected by proxy.ts). requireUser() also lazily creates the D1
// mirror row on first visit. Prefilled with ?url= when arriving from a verdict.
//
// CHE-324: the first screen offers two ways in, the coding agent first — the
// agent is the interface (CHE-313), and the page says so before the person
// starts filling in a form. ?path=app is the form, unchanged. There is no
// "onboarded" flag anywhere: nothing sends a person back here, and the
// dashboard renders for a team with no apps, so the agent path ends on a plain
// link to /dashboard and adding the app is left to the agent.
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; type?: string; path?: string }>;
}) {
  const { user, db, team } = await requireUser();
  const { url, type, path } = await searchParams;
  // CHE-320: ?type=extension is a way into extension mode like the toggle on
  // the home page, and answers to the same flag. Without it the page is the
  // plain "add your app" form, whatever the link said.
  const extensionCheck = await extensionCheckFor(user);
  const kind = extensionCheck && type === "extension" ? "extension" : "website";

  // The extension link on the dashboard is already a choice of the form; it
  // goes straight there, as before.
  if (path !== "app" && kind !== "extension") {
    // The team's keys, as the dashboard reads them: the panel is full-size
    // until one of them has been used.
    const keys = await db.apiKey.findMany({ where: { ...teamOwned(team.id) }, select: { lastUsedAt: true } });
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-12">
        <OnboardingChooser keys={keys.map((k) => ({ lastUsedAt: k.lastUsedAt?.toISOString() ?? null }))} url={url ?? null} />
      </main>
    );
  }

  // CHE-95 (found by our own check): the plan cap used to announce itself only
  // after the owner had filled the whole form and pressed Save. Say it first.
  const activeWatches = await db.watch.count({ ...ownerScoped(), where: { ownerId: user.id, active: true } });
  const capReason = watchCapReason(team.plan as UserPlan, activeWatches);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12">
      {capReason && kind !== "extension" && (
        <div className="card mb-6 border-status-confusing/40 bg-status-confusing/5 p-4">
          <p className="text-sm text-status-confusing">{capReason}</p>
          <p className="mt-1 text-xs text-fg-muted">
            You can still fill this in, but saving will be refused until you{" "}
            <Link href="/pricing" className="text-accent hover:underline">
              upgrade
            </Link>{" "}
            or remove an app you no longer watch.
          </p>
        </div>
      )}
      <OnboardingWizard prefillUrl={url ?? ""} defaultEmail={user.email ?? ""} initialKind={kind} extensionCheck={extensionCheck} />
    </main>
  );
}
