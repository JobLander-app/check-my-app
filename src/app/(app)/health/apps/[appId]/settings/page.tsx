import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { memberOfRows, teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";
import { OtherTeamApp } from "@/components/other-team-app";

// An app's settings (CHE-64, CHE-81; sections since CHE-359). The settings are
// six sections, each a page of its own under this address; this address opens
// the first. It is also where the settings sections send a reader whose app is
// not in the team they are acting as.
export default async function AppSettingsPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  const { user, db, team } = await requireUser();

  const app = await db.app.findFirst({ where: { ...teamOwned(team.id), id: appId }, select: { id: true } });
  if (app) redirect(appPath.section(app.id, "scope"));

  // CHE-261: not in the team you are acting as — but possibly in another of
  // your teams. The page offers the switch and nothing else; nobody's is 404.
  const elsewhere = await db.app.findFirst({
    where: { ...memberOfRows(user.id), id: appId },
    select: { id: true, appSlug: true, targetUrl: true, targetKind: true, teamId: true, team: { select: { name: true } } },
  });
  if (!elsewhere?.teamId) notFound();
  return <OtherTeamApp app={{ ...elsewhere, teamId: elsewhere.teamId }} acting={team.name} to={appPath.settings(appId)} />;
}
