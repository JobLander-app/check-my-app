import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";
import { extensionDisplayName } from "@/lib/extension-target";
import { recurrencesAsOf } from "@/lib/recurring";
import { checkDelta, deltaLine } from "@/lib/check-delta";
import { VerdictView } from "@/components/verdict-view";
import { releaseLensFor } from "@/lib/viewer-flags";
import { releasesByTeam } from "@/lib/releases";
import { envLabel, releasesHref, shortSha } from "@/lib/release-page";
import { ReleaseDelta } from "@/components/release-delta";

const FINISHED = ["completed", "partial"];
// The loader's window is for a feed; one release is found whenever it was.
const ALL_TIME_DAYS = 36_500;

// One check, inside the app (CHE-371, epic CHE-348 direction C): the verdict
// the public permalink shows — the same component, so the two cannot disagree —
// with the sidebar kept, the way back to its app, the checks on either side of
// it, and what it changed against the one before. The permalink stays what it
// was: the link to share, and what a signed-out reader opens.
//
// The address names the check by its number within the team, never by a row
// id: every query below is the team's, so a number from another team reads
// nothing.
export default async function CheckPage({
  params,
  searchParams,
}: {
  params: Promise<{ appId: string; runNumber: string }>;
  // What the verdict's actions bounce back as text (a refused re-check, a
  // gated watch) — read here, on the page whose button was pressed.
  searchParams: Promise<{ watch_error?: string; recheck?: string; balance?: string }>;
}) {
  const { appId, runNumber: raw } = await params;
  const { watch_error: watchError, recheck, balance } = await searchParams;
  const runNumber = /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
  if (runNumber < 1) notFound();
  const { user, db, team } = await requireUser();
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId },
    select: { id: true, appSlug: true, targetUrl: true, targetKind: true },
  });
  // Not in the team you are acting as: the app's settings page answers that
  // case in one place (it offers the switch, or 404s — CHE-261).
  if (!app) redirect(appPath.settings(appId));

  // Which checks are this app's is appHealth's rule, as on the app's page: the
  // ones attached to it, and — when it is the team's only app with this
  // address — the ones made before it was saved.
  const onlyOneWithSlug = (await db.app.count({ where: { ...teamOwned(team.id), appSlug: app.appSlug } })) === 1;
  const ofThisApp = { OR: [{ appId: app.id }, ...(onlyOneWithSlug ? [{ appId: null, appSlug: app.appSlug }] : [])] };
  const run = await db.run.findFirst({
    where: { ...teamOwned(team.id), ...ofThisApp, runNumber },
    select: { publicId: true, runNumber: true, quickPagesOpened: true, deploySha: true },
  });
  if (!run) notFound();
  // CHE-367: a check CI told us is a build is a release, and says what it
  // broke or fixed against the release before it. Read only for such a check,
  // and only for whoever has the Release lens (the layout has already asked).
  const release =
    run.deploySha && (await releaseLensFor(user))
      ? ((await releasesByTeam(db, team.id, { days: ALL_TIME_DAYS })).find((r) => r.runNumber === run.runNumber) ?? null)
      : null;

  // The checks on either side, by number: a finished check with a verdict is
  // one there is something to open (a failed one says nothing about the app —
  // CLAUDE.md §4).
  const [older, newer, asOf] = await Promise.all([
    db.run.findFirst({
      where: { ...teamOwned(team.id), ...ofThisApp, status: { in: FINISHED }, verdict: { not: null }, runNumber: { lt: runNumber } },
      orderBy: { runNumber: "desc" },
      select: { runNumber: true },
    }),
    db.run.findFirst({
      where: { ...teamOwned(team.id), ...ofThisApp, status: { in: FINISHED }, verdict: { not: null }, runNumber: { gt: runNumber } },
      orderBy: { runNumber: "asc" },
      select: { runNumber: true },
    }),
    recurrencesAsOf(db, team.id, app.id, runNumber),
  ]);
  const delta = asOf ? deltaLine(checkDelta(asOf.recurrences, asOf.checks, runNumber), run.quickPagesOpened !== null) : null;
  const name = app.targetKind === "extension" ? extensionDisplayName(app.targetUrl) : app.appSlug;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] text-fg-muted">
            <Link href="/health/apps" className="hover:text-fg">
              Health
            </Link>
            <span aria-hidden className="text-fg-faint">/</span>
            <Link href={appPath.page(app.id)} className="max-w-[16rem] truncate font-mono hover:text-fg">
              {name}
            </Link>
            <span aria-hidden className="text-fg-faint">/</span>
            <span aria-current="page" className="text-fg">
              Check #{run.runNumber}
            </span>
          </nav>
          <div className="flex items-center gap-3 font-mono text-[13px]">
            {older ? (
              <Link href={appPath.check(app.id, older.runNumber)} className="text-accent hover:underline" aria-label={`Previous check, #${older.runNumber}`}>
                ← #{older.runNumber}
              </Link>
            ) : (
              <span className="text-fg-faint">first check</span>
            )}
            {newer ? (
              <Link href={appPath.check(app.id, newer.runNumber)} className="text-accent hover:underline" aria-label={`Next check, #${newer.runNumber}`}>
                #{newer.runNumber} →
              </Link>
            ) : (
              <span className="text-fg-faint">latest check</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[13px]">
          <p className="text-fg-muted">{delta}</p>
          <Link href={`/verdict/${run.publicId}`} className="whitespace-nowrap text-accent hover:underline">
            Public link for sharing
          </Link>
        </div>
      </div>

      {release && (
        <section className="card mb-6 flex flex-col gap-2 px-5 py-4">
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
            <Link href={releasesHref(app.id)} className="text-accent hover:underline">
              Release
            </Link>
            <span className="font-mono text-fg">{shortSha(release.sha)}</span>
            <span className="inline-flex h-6 items-center rounded-full border border-ink-600 px-2.5 text-xs">{envLabel(release.env)}</span>
          </p>
          <ReleaseDelta release={release} open />
        </section>
      )}

      <VerdictView
        id={run.publicId}
        watchError={watchError}
        recheck={recheck}
        balance={balance}
        inApp={{ checkHref: (r) => appPath.check(app.id, r.runNumber), back: appPath.check(app.id, run.runNumber) }}
      />
    </main>
  );
}
