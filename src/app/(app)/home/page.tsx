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
import { setIntegrationEndpoints } from "@/app/dashboard/actions";
import { ConnectAgent } from "@/components/connect-agent";
import { AppPostHogProject } from "@/components/app-posthog-project";
import { teamProjects } from "@/lib/posthog/choices";
import { teamBalance, watchTrialState } from "@/lib/plans";
import { appCanRun } from "@/lib/plan-status";
import type { UserPlan } from "@/lib/enums";
import { teamOwned } from "@/lib/tenant-db";
import { extensionCheckFor } from "@/lib/viewer-flags";
import { integrationNotice } from "@/lib/integration-notice";
import { BALANCE_PATH } from "@/lib/balance-links";
import { appPath } from "@/lib/app-shell";

// Today (CHE-351). Until direction C's Today lands (CHE-361) this is what the
// old /dashboard was, inside the shell: the agent panel and the team's apps.
// The balance moved to Billing, the analytics connection to Integrations and
// the API keys to Agent and API keys — each one item in the sidebar.
export default async function HomePage({
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
    select: { lastUsedAt: true },
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

  // CHE-327: per watched app, whether its next tick can run (the scheduler's
  // own gate) — the balance itself is on Billing.
  const plan = team.plan as UserPlan;
  const balance = await teamBalance(db, { id: team.id, plan });
  const canRun = new Map(
    await Promise.all(
      apps
        .filter((a) => a.watch?.active)
        .map(async (a) => [a.id, (await appCanRun(db, { id: team.id, plan }, balance, a.appSlug)).ok] as const),
    ),
  );

  // CHE-237: the projects this team's connection can see, listed ONCE for the
  // whole page. Every app row picks from the same list — one request, however
  // many apps. Null means there is no connection, or we could not list them;
  // either way no picker is offered, because a dropdown with nothing in it is
  // an invitation to wonder what went wrong.
  const posthogProjects = await teamProjects(db, {
    teamId: team.id,
    clientId: `${(cfEnv.APP_URL ?? "https://checkmyapp.dev").replace(/\/+$/, "")}/.well-known/posthog-client.json`,
  });

  const notice = integrationNotice(integration);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      {/* CHE-351: /dashboard#balance is in old e-mails and agents' notes. The
          redirect brings it here, and the fragment — which never reaches a
          server — says where it meant: the balance, which lives on Billing. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `if(location.hash==="#balance")location.replace(${JSON.stringify(BALANCE_PATH)})`,
        }}
      />

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

      {notice && (
        <div className="card mb-6 flex items-start justify-between gap-4 p-4">
          <p className={notice.ok ? "text-sm text-status-ok" : "text-sm text-status-confusing"}>{notice.text}</p>
          <Link href="/home" className="text-xs text-fg-muted hover:text-fg" aria-label="Dismiss">
            Dismiss ✕
          </Link>
        </div>
      )}

      {/* CHE-317: the agent is the interface. Onboarding ends on this screen,
          so this is also the last thing onboarding says. */}
      <ConnectAgent keys={apiKeys.map((k) => ({ lastUsedAt: k.lastUsedAt?.toISOString() ?? null }))} />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
          <p className="mt-1 text-sm text-fg-muted">Your team&apos;s apps and their latest check.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {/* CHE-320: behind the same flag as the home page's extension option. */}
          {extensionCheck && <Link href="/onboarding?type=extension" className="text-xs text-accent hover:underline">+ Add extension</Link>}
          {/* CHE-324: the agent panel is already at the top of this page, so
              "+ Add app" here means the form — not the onboarding chooser. */}
          <Link
            href="/onboarding?path=app"
            className="rounded-md bg-accent px-4 py-2 font-mono text-[13px] font-semibold text-ink-950 transition-opacity hover:opacity-90"
          >
            + Add app
          </Link>
        </div>
      </div>

      {apps.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-fg-muted">No apps yet.</p>
          <Link href="/onboarding?path=app" className="mt-2 inline-block text-accent hover:underline">
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
                      href={appPath.page(app.id)}
                      className="break-all font-mono text-sm text-fg hover:underline"
                    >
                      {displayName}
                    </Link>
                    <Link
                      href={appPath.settings(app.id)}
                      className="text-xs text-fg-faint hover:underline"
                    >
                      Settings
                    </Link>
                  </div>
                  <p className="text-xs text-fg-faint">
                    {isExtension ? "Chrome extension · on demand" : !app.watch?.active
                      ? "paused"
                      : trial.kind === "ended" || canRun.get(app.id) === false
                        ? "paused"
                        : `watching · ${app.watch.frequency}`}
                    {labels && ` · labels: ${labels}`}
                  </p>
                  {/* CHE-327: the scheduler skips this app's ticks while the
                      balance cannot cover a check; say so, with both doors. */}
                  {app.watch?.active && trial.kind !== "ended" && canRun.get(app.id) === false && (
                    <p className="text-xs text-status-confusing">
                      paused: the balance is used —{" "}
                      <Link href="/settings/billing" className="text-accent hover:underline">
                        top up
                      </Link>{" "}
                      or{" "}
                      <Link href="/pricing" className="text-accent hover:underline">
                        upgrade
                      </Link>
                      ; it resumes on its own
                    </p>
                  )}
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
    </main>
  );
}
