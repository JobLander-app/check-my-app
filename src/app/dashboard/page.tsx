import Link from "next/link";
import { RunSavedApp } from "@/components/run-saved-app";
import { extensionDisplayName } from "@/lib/extension-target";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { fetchTeams } from "@/lib/tracker/linear-oauth";
import { freshLinearToken } from "@/lib/tracker/token";
import { TeamSelect } from "@/components/team-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { setIntegrationEndpoints } from "./actions";
import { ApiKeys } from "@/components/api-keys";
import { AnalyticsConnection } from "@/components/analytics-connection";
import { AppPostHogProject } from "@/components/app-posthog-project";
import { teamProjects } from "@/lib/posthog/choices";
import { isStranded } from "@/lib/posthog/token";
import { missingScopes } from "@/lib/posthog/oauth";
import { watchTrialState } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { teamOwned } from "@/lib/tenant-db";
import { teamsOf } from "@/lib/teams";
import { TeamSwitcher } from "@/components/team-switcher";
import { extensionCheckFor } from "@/lib/viewer-flags";

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

// Owner home (protected). Lists the apps this owner has under daily QA.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ integration?: string; added?: string; extensionAdded?: string }>;
}) {
  const { integration, added, extensionAdded } = await searchParams;
  const { user, db, team } = await requireUser();
  // CHE-261: the TEAM's apps. Filtering by ownerId here would show each member
  // a different dashboard of the same team — the exact thing teams remove.
  const apps = await db.app.findMany({
    where: { ...teamOwned(team.id) },
    include: {
      watch: true,
      policy: true,
      tracker: true,
      runs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });
  const apiKeys = await db.apiKey.findMany({
    where: { ...teamOwned(team.id) },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, lastUsedAt: true, createdAt: true },
  });
  const extensionCheck = await extensionCheckFor(user);

  // For connected apps, pull the workspace teams so the owner can pick which one
  // tickets land in (best-effort — a transient Linear error just hides the picker).
  const teamsByApp: Record<string, { id: string; name: string }[]> = {};
  const cfEnv = getCloudflareContext().env as Record<string, string | undefined>;
  const oauthCreds = { clientId: cfEnv.LINEAR_CLIENT_ID, clientSecret: cfEnv.LINEAR_CLIENT_SECRET };
  await Promise.all(
    apps.map(async (app) => {
      if (!app.tracker) return;
      try {
        teamsByApp[app.id] = await fetchTeams(await freshLinearToken(db, app.tracker, oauthCreds));
      } catch {
        teamsByApp[app.id] = [];
      }
    }),
  );

  const posthog = await analyticsConnection(db, team.id);
  // CHE-237: the projects this team's connection can see, listed ONCE for the
  // whole page. Every app row picks from the same list — one request, however
  // many apps. Null means there is no connection, or we could not list them;
  // either way no picker is offered, because a dropdown with nothing in it is
  // an invitation to wonder what went wrong.
  const posthogProjects = await teamProjects(db, {
    teamId: team.id,
    clientId: `${((getCloudflareContext().env as Record<string, string | undefined>).APP_URL ?? "https://checkmyapp.dev").replace(/\/+$/, "")}/.well-known/posthog-client.json`,
  });

  // CHE-67: the Connect Linear flow bounces back here with a hint when the
  // integration isn't set up yet or the OAuth handshake failed — surface it as
  // a small inline notice instead of the old raw JSON error page. CHE-236 adds
  // the PostHog outcomes: every branch either route can take ends on one of
  // these sentences, because a person who pressed Connect and was told nothing
  // will press it again.
  const integrationNotice =
    integration === "linear_unconfigured"
      ? "Linear isn't connected yet — the integration is being set up."
      : integration === "linear_failed"
        ? "Couldn't connect Linear — please try again."
        : integration === "posthog_connected"
          ? "PostHog is connected — we can read your funnels, and only read them."
          : integration === "posthog_declined"
            ? "PostHog wasn't connected — the request was declined on PostHog's screen."
            : integration === "posthog_unavailable"
              ? "PostHog couldn't be reached just now — please try again in a minute."
              : integration === "posthog_scopes"
                ? "PostHog changed what it offers — we've stopped rather than ask for the wrong access."
                : integration === "posthog_unreadable"
                  ? "PostHog connected but returned no readable account — nothing was saved. Please try again."
                  : integration === "posthog_failed"
                    ? "Couldn't connect PostHog — please try again."
                    : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      {/* CHE-92: a successful onboarding used to land here with no word about
          what happened — the agent (and any first-time owner) could not tell a
          silent success from a silent failure. */}
      {added && (
        <div className="card mb-6 border-status-ok/40 bg-status-ok/5 p-4">
          <p className="text-sm text-status-ok">
            ✓ {added} is added and its first check is on the way — you&apos;ll get an email when
            the verdict is ready.
          </p>
        </div>
      )}

      {extensionAdded && <div className="card mb-6 border-status-ok/40 bg-status-ok/5 p-4"><p className="text-sm text-status-ok">✓ Extension added. Start its first check below.</p></div>}

      {integrationNotice && (
        <div className="card mb-6 flex items-start justify-between gap-4 p-4">
          <div>
            <p className="section-label">integration</p>
            <p
            className={
              integration === "posthog_connected"
                ? "text-sm text-status-ok"
                : "text-sm text-status-confusing"
            }
          >
            {integrationNotice}
          </p>
          </div>
          <Link href="/dashboard" className="text-xs text-fg-muted hover:text-fg" aria-label="Dismiss">
            Dismiss ✕
          </Link>
        </div>
      )}

      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="section-label">your apps</p>
          <TeamSwitcher teams={await teamsOf(db, user.id)} activeTeamId={team.id} />
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {/* CHE-99: our own error rate lives one click from the apps it is
              about, not in a private spreadsheet. */}
          <Link href="/dashboard/accuracy" className="text-xs text-fg-muted hover:text-fg">
            Accuracy
          </Link>
          {/* CHE-320: behind the same flag as the home page's extension option. */}
          {extensionCheck && <Link href="/onboarding?type=extension" className="text-xs text-accent hover:underline">+ Add extension</Link>}
          <Link
            href="/onboarding"
            className="rounded-md bg-accent px-4 py-2 font-mono text-[13px] font-semibold text-ink-950 transition-opacity hover:opacity-90"
          >
            + Add app
          </Link>
        </div>
      </div>

      {apps.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-fg-muted">No apps yet.</p>
          <Link href="/onboarding" className="mt-2 inline-block text-accent hover:underline">
            Add your first app →
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {apps.map((app) => {
            const latest = app.runs[0];
            const isExtension = app.targetKind === "extension";
            const displayName = isExtension ? extensionDisplayName(app.targetUrl, latest?.extensionEvidence) : app.appSlug;
            const labels = (JSON.parse(app.policy?.pickupLabels ?? "[]") as string[]).join(", ");
            // CHE-54: a free-plan watch runs on a 7-day trial. The scheduler
            // stops running an expired one, so the card must not keep claiming
            // it's watching.
            const trial = watchTrialState(app.watch, team.plan as UserPlan);
            return (
              <li key={app.id} className="card flex flex-wrap items-start justify-between gap-4 p-5">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/${app.id}`}
                      className="break-all font-mono text-sm text-fg hover:underline"
                    >
                      {displayName}
                    </Link>
                    <Link
                      href={`/dashboard/${app.id}`}
                      className="text-xs text-fg-faint hover:underline"
                    >
                      Settings
                    </Link>
                  </div>
                  <p className="text-xs text-fg-faint">
                    {isExtension ? "Chrome extension · on demand" : !app.watch?.active
                      ? "paused"
                      : trial.kind === "ended"
                        ? "paused"
                        : `watching · ${app.watch.frequency}`}
                    {labels && ` · labels: ${labels}`}
                  </p>
                  {trial.kind === "ended" ? (
                    <p className="text-xs text-status-confusing">
                      trial ended — daily watch paused ·{" "}
                      <Link href="/pricing" className="text-accent hover:underline">
                        Upgrade to resume →
                      </Link>
                    </p>
                  ) : trial.kind === "active" ? (
                    <p className="text-xs text-fg-faint">
                      free trial · {trial.daysLeft} day{trial.daysLeft === 1 ? "" : "s"} left ·{" "}
                      <Link href="/pricing" className="text-accent hover:underline">
                        Upgrade
                      </Link>
                    </p>
                  ) : null}
                  {app.tracker ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-status-ok">✓ Linear · team:</span>
                      {teamsByApp[app.id]?.length ? (
                        <TeamSelect
                          appId={app.id}
                          teams={teamsByApp[app.id]}
                          current={app.tracker.teamId}
                        />
                      ) : (
                        <span className="text-xs text-fg-faint">
                          {app.tracker.externalOrg ?? "—"}
                        </span>
                      )}
                    </div>
                  ) : (
                    <a
                      href={`/api/integrations/linear/start?appId=${app.id}`}
                      className="text-xs text-accent hover:underline"
                    >
                      Connect Linear →
                    </a>
                  )}
                  {/* CHE-237: which PostHog project feeds THIS app. The
                      connection is the team's; the project is the app's, and
                      until this row existed there was no way to tell which fed
                      which. A setting nobody can find is a setting nobody sets. */}
                  {posthogProjects !== null && (
                    <AppPostHogProject
                      appId={app.id}
                      chosen={
                        app.posthogProjectId
                          ? { id: app.posthogProjectId, name: app.posthogProjectName }
                          : null
                      }
                      projects={posthogProjects}
                    />
                  )}
                  {/* Outbound webhooks (CHE-53): generic endpoint + Slack preset,
                      POSTed after every completed watch run. */}
                  <details className="pt-1">
                    <summary className="cursor-pointer text-xs text-fg-faint hover:text-fg-muted">
                      {app.webhookUrl || app.slackWebhookUrl ? "✓ Webhooks" : "Webhooks"} — plug
                      into your monitoring
                    </summary>
                    <form
                      action={setIntegrationEndpoints.bind(null, app.id)}
                      className="mt-2 max-w-md space-y-2"
                    >
                      <label className="block space-y-1">
                        <span className="text-xs text-fg-muted">Webhook URL</span>
                        <Input
                          name="webhookUrl"
                          type="url"
                          placeholder="https://your-stack.example.com/hooks/checkmyapp"
                          defaultValue={app.webhookUrl ?? ""}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-xs text-fg-muted">
                          Signing secret (optional, write-only — blank keeps the current one)
                        </span>
                        <Input
                          name="webhookSecret"
                          type="password"
                          placeholder="••••••••"
                          autoComplete="new-password"
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-xs text-fg-muted">Slack incoming webhook URL</span>
                        <Input
                          name="slackWebhookUrl"
                          type="url"
                          placeholder="https://hooks.slack.com/services/…"
                          defaultValue={app.slackWebhookUrl ?? ""}
                        />
                      </label>
                      <Button type="submit" variant="outline" className="px-3 py-1.5 text-xs">
                        Save webhooks
                      </Button>
                    </form>
                  </details>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-3">
                {isExtension && <RunSavedApp appId={app.id} />}
                {latest ? (
                  <Link
                    href={`/${latest.status === "completed" ? "verdict" : "run"}/${latest.publicId}`}
                    className="font-mono text-[13px] text-accent hover:underline"
                  >
                    latest run →
                  </Link>
                ) : (
                  <span className="font-mono text-[13px] text-fg-faint">no runs yet</span>
                )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AnalyticsConnection connection={posthog} />

      <ApiKeys
        keys={apiKeys.map((k) => ({
          id: k.id,
          name: k.name,
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          createdAt: k.createdAt.toISOString(),
        }))}
      />
    </main>
  );
}
