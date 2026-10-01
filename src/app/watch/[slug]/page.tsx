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
  const here = await db.app.findFirst({ where: { ...teamOwned(team.id), appSlug: slug }, select: { id: true } });
  if (here) redirect(appPath.schedule(here.id));
  // In another team of yours: the settings page offers the switch (CHE-261).
  const elsewhere = await db.app.findFirst({ where: { ...memberOfRows(user.id), appSlug: slug }, select: { id: true } });
  if (elsewhere) redirect(appPath.settings(elsewhere.id));
  notFound();
}
