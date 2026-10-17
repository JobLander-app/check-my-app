import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { teamOwned } from "@/lib/tenant-db";
import { isStranded } from "@/lib/posthog/token";
import { missingScopes } from "@/lib/posthog/oauth";
import { AnalyticsConnection } from "@/components/analytics-connection";
import { TeamTrackers, type TeamTrackersProps } from "@/components/team-trackers";
import { TRACKER_KINDS, connectionApps, teamConnections } from "@/lib/tracker/connection";
import { trackerName } from "@/lib/tracker/name";
import { trackerHealth, trackerUnanswered } from "@/lib/app-settings-sections";
import { trackerAnswers } from "@/lib/tracker/answers";
import { trackerCreds } from "@/lib/tracker/factory";
import { integrationNotice } from "@/lib/integration-notice";
import { appPath } from "@/lib/app-shell";
import { appKind, appLabel } from "@/lib/app-label";
import { AppName } from "@/components/app-mark";
import { integrationsLabel } from "@/lib/app-page";
import { appsRunningTheAction, teamRunsTheAction } from "@/lib/release-action";
import { GitHubCard } from "@/components/github-card";
import { GitHubAppPanel } from "@/components/github-app-panel";
import { getGitHubAppEnv } from "@/lib/github-app";
import { teamGitHub } from "@/lib/github-mapping";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { can } from "@/lib/scopes";

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

/**
 * The team's issue trackers as the screen needs them (CHE-469): which are
 * connected, whether the tracker still answers the grant, and which apps file
 * into each. Tokens never leave this function.
 */
async function teamTrackers(db: Awaited<ReturnType<typeof requireUser>>["db"], teamId: string): Promise<TeamTrackersProps["trackers"]> {
  const connections = await teamConnections(db, teamId);
  const creds = trackerCreds(getCloudflareContext().env as unknown as Record<string, unknown>);
  const now = new Date();
  const loaded = await Promise.all(
    TRACKER_KINDS.map(async (kind) => {
      const connection = connections[kind];
      if (!connection) return null;
      const [apps, answers] = await Promise.all([connectionApps(db, teamId, kind), trackerAnswers(db, kind, connection, creds)]);
      // The stored health, unless the tracker gave nothing for the grant: one
      // revoked on its side still has a refresh token here (Codex on #347).
      const stored = trackerHealth(connection, now);
      const health = !answers && stored?.tone === "ok" ? trackerUnanswered(trackerName(kind)) : stored;
      // Only an app with somewhere to file files into it (Codex on #347); one
      // still waiting for its project or team is named as waiting.
      const routed = (a: (typeof apps)[number]) => Boolean(a.teamId && (kind !== "jira" || a.externalOrg));
      return {
        kind,
        name: trackerName(kind),
        health,
        // A new consent replaces the team's grant; it starts from one of the
        // apps that use it, which the connect flow needs to come back to.
        reconnect: health?.tone !== "ok" && apps[0] ? `/api/integrations/${kind}/start?appId=${apps[0].appId}` : null,
        apps: apps.filter(routed).map(({ app }) => appLabel(app)),
        waiting: apps.filter((a) => !routed(a)).map(({ app }) => appLabel(app)),
      };
    }),
  );
  return loaded.filter((t) => t !== null);
}

// Integrations (CHE-351 shell, CHE-356): the connections the whole team
// shares — the analytics connection, the issue trackers (CHE-469), and GitHub,
// where a release's check comes from (CHE-413). The PostHog flow comes back
// here with ?integration=…. What is set per app — where its tickets go, the
// analytics project, webhooks — is on that app's Integrations section, and
// every app is one click away from here, connected or not.
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ integration?: string; installation_id?: string; setup_action?: string; state?: string }>;
}) {
  const { integration, installation_id, setup_action, state } = await searchParams;
  // CHE-369: this page is the GitHub App's setup URL — where GitHub sends the
  // person after installing it. The binding happens in the callback route;
  // this only carries GitHub's parameters there.
  if (installation_id) {
    const q = new URLSearchParams({ installation_id, ...(setup_action ? { setup_action } : {}), ...(state ? { state } : {}) });
    redirect(`/api/integrations/github/app/callback?${q}`);
  }
  const { db, team, scope } = await requireUser();
  const { env } = getCloudflareContext();
  const installable = Boolean(getGitHubAppEnv(env as Record<string, unknown>).GITHUB_APP_SLUG);
  // GitHub twice: once for the team's card, and per app for the list — the
  // same fact the app's own card states.
  const [posthog, trackers, apps, fromAction, actionApps, github] = await Promise.all([
    analyticsConnection(db, team.id),
    teamTrackers(db, team.id),
    db.app.findMany({
      where: { ...teamOwned(team.id) },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, appSlug: true, targetKind: true, targetUrl: true, posthogProjectName: true, webhookUrl: true, slackWebhookUrl: true,
        tracker: { select: { type: true } },
      },
    }),
    teamRunsTheAction(db, team.id),
    appsRunningTheAction(db, team.id),
    teamGitHub(db, { id: team.id }),
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

      <TeamTrackers trackers={trackers} canDisconnect={can(scope, "integration.connect")} />

      <div className="mt-6">
        <GitHubAppPanel github={github} canConnect={can(scope, "integration.connect")} installable={installable} />
      </div>

      <div className="mt-6">
        <GitHubCard connected={fromAction} scope="team" />
      </div>

      {apps.length > 0 && (
        <section className="card mt-6 p-5">
          <h2 className="text-lg font-medium">Per app</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Where an app&apos;s tickets go, its analytics project and its webhooks are set on the app. Open an app to
            choose or change them.
          </p>
          <ul className="mt-3 divide-y divide-ink-700">
            {apps.map((app) => (
              <li key={app.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <AppName name={appLabel(app)} kind={appKind(app)} className="font-mono text-sm" />
                <span className="flex items-center gap-3">
                  {/* The app page's own words for the same facts (src/lib/app-page.ts). */}
                  <span className="text-xs text-fg-muted">
                    {integrationsLabel({
                      tracker: app.tracker?.type ?? null,
                      analyticsProject: app.posthogProjectName,
                      github: actionApps.has(app.id),
                      webhook: Boolean(app.webhookUrl),
                      slack: Boolean(app.slackWebhookUrl),
                    })}
                  </span>
                  <Link href={appPath.section(app.id, "integrations")} className="whitespace-nowrap text-xs text-accent hover:underline">
                    {/* CHE-469: with the team's tracker connected, an app only chooses where. */}
                    {app.tracker ? "Open →" : trackers.length > 0 ? "Choose →" : "Connect →"}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
