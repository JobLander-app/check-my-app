import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { memberOfRows, teamOwned } from "@/lib/tenant-db";
import { switchTeamAction } from "@/app/team/switch-actions";
import { appPath } from "@/lib/app-shell";
import { Button } from "@/components/ui/button";

// An app's settings (CHE-64, CHE-81; sections since CHE-359). The settings are
// six sections, each a page of its own under this address; this address opens
// the first. It is also where every page of an app sends a reader whose app is
// not in the team they are acting as — the one place that answers that case.
export default async function AppSettingsPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  const { user, db, team } = await requireUser();

  const app = await db.app.findFirst({ where: { ...teamOwned(team.id), id: appId }, select: { id: true } });
  if (app) redirect(appPath.section(app.id, "scope"));

  // CHE-261: not in the team you are acting as — but possibly in another of
  // your teams. Offer the switch; never switch silently (a page that changes
  // which team you are acting as, because of a link you followed, is how a
  // check gets started against the wrong budget), and never 404 a row this
  // person is entitled to see.
  const elsewhere = await db.app.findFirst({
    where: { ...memberOfRows(user.id), id: appId },
    select: { id: true, appSlug: true, teamId: true, team: { select: { name: true } } },
  });
  if (!elsewhere?.teamId) notFound();
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16">
      <section className="card p-6">
        <h1 className="break-words text-xl font-semibold">{elsewhere.appSlug} belongs to {elsewhere.team?.name}</h1>
        <p className="mt-2 text-sm text-fg-muted">
          You are on that team, but you are currently acting as {team.name}. Switching changes which
          team&apos;s plan pays for anything you start.
        </p>
        <form action={switchTeamAction.bind(null, elsewhere.teamId, appPath.settings(appId))}>
          <Button type="submit" className="mt-6">Switch to {elsewhere.team?.name}</Button>
        </form>
      </section>
    </main>
  );
}
