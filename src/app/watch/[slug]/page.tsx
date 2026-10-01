import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { memberOfRows, teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";

// /watch/{slug} was the watch's own screen. It lives in the app's settings now
// (CHE-351 → …/settings/schedule), and the old address is in verdict e-mails
// and enable-watch redirects, so it still lands there. It names an app by its
// slug, which only a lookup can turn into the app's id — hence a page, not a
// pattern in next.config.mjs.
export default async function WatchMoved({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { user, db, team } = await requireUser();
  // The old route named one row: the caller's own app of that slug. A slug can
  // now be several apps — a teammate's in this team, one in another team of
  // yours — so the caller's own comes first, as the link meant it.
  const pickOwn = <T extends { ownerId: string }>(rows: T[]) => rows.find((a) => a.ownerId === user.id) ?? rows[0];
  const here = pickOwn(
    await db.app.findMany({ where: { ...teamOwned(team.id), appSlug: slug }, select: { id: true, ownerId: true } }),
  );
  if (here) redirect(appPath.schedule(here.id));
  // In another team of yours: the settings page offers the switch (CHE-261).
  const elsewhere = pickOwn(
    await db.app.findMany({ where: { ...memberOfRows(user.id), appSlug: slug }, select: { id: true, ownerId: true } }),
  );
  if (elsewhere) redirect(appPath.settings(elsewhere.id));
  notFound();
}
