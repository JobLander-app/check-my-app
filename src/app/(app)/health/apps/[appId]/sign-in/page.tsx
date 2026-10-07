import { notFound } from "next/navigation";
import Link from "next/link";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { memberOfRows, teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";
import { OtherTeamApp } from "@/components/other-team-app";
import { LiveSignIn } from "@/components/live-sign-in";
import { VIEW_HOST, appHandleOfAdminUrl, mintViewToken, shopifySlug, storeOfAdminUrl } from "@/lib/session-view";
import { SIGN_IN_COPY } from "@/lib/sign-in-copy";
import { claimSlot } from "@/lib/session-slots";

// CHE-419: a person signs in to the Shopify store their app lives in, here,
// on our page — a live view of the browser the checks of this app run in.
// No VNC console: what they type and paste goes in as text, and the page
// tells them when the admin has opened.
//
// Only for an app checked inside a signed-in session, only for a member of the
// team that owns it; the view token is minted per visit and lives 30 minutes.
export default async function SignInPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  const { user, db, team } = await requireUser();
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId },
    select: { id: true, appSlug: true, targetUrl: true, targetKind: true },
  });
  if (!app) {
    const elsewhere = await db.app.findFirst({
      where: { ...memberOfRows(user.id), id: appId },
      select: { appSlug: true, targetUrl: true, targetKind: true, teamId: true, team: { select: { name: true } } },
    });
    if (!elsewhere?.teamId) notFound();
    return <OtherTeamApp app={{ ...elsewhere, teamId: elsewhere.teamId }} acting={team.name} to={appPath.signIn(appId)} />;
  }
  const store = app.targetKind === "session" ? storeOfAdminUrl(app.targetUrl) : null;
  if (!store) notFound();

  const { env } = getCloudflareContext();
  const secret = (env as unknown as { SESSION_VIEW_SECRET?: string }).SESSION_VIEW_SECRET;
  // CHE-426: the team's own browser on the host — the token can open no other.
  // Claimed here too, not only on connect: a team that connected before slots
  // existed has its app but no slot yet.
  const slot = await claimSlot(db, team.id);
  const token = secret && slot ? await mintViewToken(secret, { slot, store }) : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href={appPath.page(app.id)} className="text-[13px] text-fg-muted hover:text-accent">← {app.appSlug}</Link>
      <h1 className="mt-3 text-2xl font-semibold">{SIGN_IN_COPY.title(store)}</h1>
      <p className="mt-2 max-w-2xl text-sm text-fg-muted">{SIGN_IN_COPY.intro}</p>
      {token ? (
        <LiveSignIn
          url={`${VIEW_HOST}?token=${encodeURIComponent(token)}`}
          store={store}
          appHref={appPath.page(app.id)}
          appId={app.id}
          // A store connected but its app not chosen yet (connect/shopify);
          // the app the person linked to is picked as soon as they are in.
          choose={app.appSlug === shopifySlug(store)}
          handle={appHandleOfAdminUrl(app.targetUrl)}
        />
      ) : (
        <p className="mt-6 text-sm">{SIGN_IN_COPY.unavailable}</p>
      )}
    </div>
  );
}
