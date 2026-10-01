import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { teamOwned } from "@/lib/tenant-db";
import { isStranded } from "@/lib/posthog/token";
import { missingScopes } from "@/lib/posthog/oauth";
import { AnalyticsConnection } from "@/components/analytics-connection";
import { integrationNotice } from "@/lib/integration-notice";
import { appPath } from "@/lib/app-shell";
import { extensionDisplayName } from "@/lib/extension-target";

/**
 * The analytics connection as the screen needs it (CHE-236).
 *
 * The connection is the TEAM's, not an app's — every app the team watches reads
 * the same one. Tokens never leave this function: what the page receives is the
 * three facts it states, one of which is whether the connection is still alive.
 */
async function analyticsConnection(
  db: Awaited<ReturnType<typeof requireUser>>["db"],
  teamId: string,
) {
  const row = await db.postHogIntegration.findFirst({
    where: { ...teamOwned(teamId) },
    select: {
      organizationName: true,
      region: true,
      expiresAt: true,
      refreshTokenEnc: true,
      // CHE-286: what was actually granted, so a connection narrower than a
      // funnel query needs stops wearing an unqualified ✓.
      scope: true,
    },
  });
  if (!row) return null;
  return {
    organizationName: row.organizationName,
    region: row.region,
    stranded: isStranded(row, new Date()),
    missingScopes: missingScopes(row.scope),
  };
}

// Integrations (CHE-351 shell): the connections the whole team shares. The
// PostHog flow comes back here with ?integration=…; which tracker board an app
// files into is set on that app. CHE-356 redraws it.
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ integration?: string }>;
}) {
  const { integration } = await searchParams;
  const { db, team } = await requireUser();
  const [posthog, apps] = await Promise.all([
    analyticsConnection(db, team.id),
    db.app.findMany({
      where: { ...teamOwned(team.id) },
      orderBy: { createdAt: "desc" },
      select: { id: true, appSlug: true, targetKind: true, targetUrl: true, tracker: { select: { externalOrg: true } } },
    }),
  ]);
  const notice = integrationNotice(integration);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
      <p className="mt-1 text-sm text-fg-muted">
        Connections the whole team shares. Connect once here; which project or board an app uses is
        set on that app.
      </p>

      {notice && (
        <div className="card mt-6 flex items-start justify-between gap-4 p-4">
          <p className={notice.ok ? "text-sm text-status-ok" : "text-sm text-status-confusing"}>{notice.text}</p>
          <Link href="/settings/integrations" className="text-xs text-fg-muted hover:text-fg" aria-label="Dismiss">
            Dismiss ✕
          </Link>
        </div>
      )}

      <AnalyticsConnection connection={posthog} />

      {apps.length > 0 && (
        <section className="card mt-6 p-5">
          <h2 className="text-lg font-medium">Issue tracker, per app</h2>
          <ul className="mt-3 divide-y divide-ink-700">
            {apps.map((app) => (
              <li key={app.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <span className="min-w-0 truncate font-mono text-sm">
                  {app.targetKind === "extension" ? extensionDisplayName(app.targetUrl) : app.appSlug}
                </span>
                {app.tracker ? (
                  <span className="text-xs text-status-ok">✓ Linear · {app.tracker.externalOrg ?? "connected"}</span>
                ) : (
                  <Link href={appPath.settings(app.id)} className="text-xs text-accent hover:underline">
                    Connect on its settings →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
