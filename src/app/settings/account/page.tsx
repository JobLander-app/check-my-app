import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { teamsOf } from "@/lib/teams";
import { TeamSwitcher } from "@/components/team-switcher";
import { Button } from "@/components/ui/button";
import { teamOwned } from "@/lib/tenant-db";
import { toggleOwnNotifications } from "@/app/dashboard/actions";

// CHE-277 — your own settings: everything whose effect stops at you
// (src/lib/settings-boundary.ts).
//
// Two things are deliberately absent. Your name, email and sign-in are managed
// by the account menu in the header, which we have not replaced: taking that
// over means owning sign-out and session listing, and the first thing to break
// there breaks silently for one person — the one person who then cannot get in
// to report it. And anything that affects a colleague is on the team's page.
export default async function AccountSettingsPage() {
  const { user, db, team } = await requireUser();

  const teams = await teamsOf(db, user.id);
  const apps = await db.app.findMany({
    where: { ...teamOwned(team.id) },
    select: { id: true, appSlug: true, notifiers: { where: { userId: user.id }, select: { id: true } } },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-wider text-fg-muted">Your settings</p>
        <h1 className="mt-1 break-words text-2xl font-semibold">{user.name?.trim() || user.email}</h1>
        <p className="mt-2 text-sm text-fg-muted">
          Only you are affected by anything on this page. What your colleagues see — people,
          billing, integrations — is on{" "}
          <Link href="/settings/team" className="text-accent hover:underline">
            the team&apos;s settings
          </Link>
          .
        </p>
      </header>

      <section className="card p-6">
        <h2 className="text-lg font-medium">Which apps email you</h2>
        <p className="mt-2 text-sm text-fg-muted">
          Ticked apps mail their verdicts to {user.email}. Untick one and the checks carry on —
          you simply stop hearing about it. An app nobody has ticked mails the team&apos;s admins,
          so nothing goes quiet by accident.
        </p>
        {apps.length === 0 ? (
          <p className="mt-4 text-sm text-fg-muted">
            This team has no apps yet.{" "}
            <Link href="/onboarding" className="text-accent hover:underline">
              Add one
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {apps.map((app) => (
              <li key={app.id} className="flex items-center justify-between gap-3">
                <span className="text-sm">{app.appSlug}</span>
                <form action={toggleOwnNotifications.bind(null, app.id)}>
                  <Button type="submit" variant="outline" className="py-1.5">
                    {app.notifiers.length > 0 ? "Stop emailing me" : "Email me"}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-lg font-medium">Which team you are acting as</h2>
        <p className="mt-2 text-sm text-fg-muted">
          {teams.length === 1
            ? `You are on one team, ${team.name}. When you join another, you can switch between them here — and whichever you are acting as is the team whose plan pays for anything you start.`
            : "Switching changes which team's plan pays for anything you start, and which apps you see. It changes nothing for your colleagues."}
        </p>
        <div className="mt-4">
          <TeamSwitcher teams={teams} activeTeamId={team.id} />
        </div>
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-lg font-medium">Your account</h2>
        <p className="mt-2 text-sm text-fg-muted">
          Your name, email address and how you sign in are managed from the account menu in the
          header. Leaving a team is on{" "}
          <Link href="/team" className="text-accent hover:underline">
            the team page
          </Link>
          {" "}— it removes your access and nothing you did: the apps, checks and tickets stay with
          the team.
        </p>
      </section>
    </main>
  );
}
