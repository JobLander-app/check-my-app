import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Prisma } from "@/generated/prisma/client";
import { requireUser } from "@/lib/auth";
import { teamOwned } from "@/lib/tenant-db";
import { appPath, checkHref } from "@/lib/app-shell";
import { VERDICT_META } from "@/lib/status";
import { appPriceRange, usd } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { LIVE_RUN_STATUSES } from "@/lib/enums";
import { outcome } from "@/lib/checks-page";
import { SETTINGS_SECTIONS, sectionsFor, settingsSection, trackerHealth } from "@/lib/app-settings-sections";
import { listTestAccounts } from "@/lib/app-settings";
import { MAX_EXTRA_ACCOUNTS } from "@/lib/test-accounts";
import { readExtensionOptions } from "@/lib/extension-target";
import { projectChoicesFor } from "@/lib/posthog/choices";
import { fetchTeams } from "@/lib/tracker/linear-oauth";
import { freshLinearToken } from "@/lib/tracker/token";
import { setAppNotifiers, setIntegrationEndpoints, updateAppSettings } from "@/app/dashboard/actions";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ExtensionSettings } from "@/components/extension-fields";
import { WatchSettings } from "@/components/watch-settings";
import { AnalyticsProject } from "@/components/analytics-project";
import { TeamSelect } from "@/components/team-select";
import { DeleteAppSection } from "@/components/delete-app";

export const dynamic = "force-dynamic";

const DATE_FMT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

// One section of an app's settings (CHE-359): /health/apps/{appId}/settings/
// {section}. Each section is its own form with its own action — nothing here
// is nested in another form, and saving one section writes that section alone
// (updateAppSettings is bound to the section by this page). The frame around
// it — whose settings, the sections — is the layout's.
export default async function AppSettingsSection({
  params,
  searchParams,
}: {
  params: Promise<{ appId: string; section: string }>;
  // What a save bounces back: that it was saved, or the sentence it was refused with.
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { appId, section: raw } = await params;
  const { saved, error } = await searchParams;
  const section = settingsSection(raw);
  if (!section) notFound();

  const { user, db, team } = await requireUser();
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId },
    include: { watch: { include: { runs: { orderBy: { startedAt: "desc" }, take: 10 } } }, policy: true, tracker: true, repo: true },
  });
  // Another team of yours, or nobody's: the settings address says which (CHE-261).
  if (!app) redirect(appPath.settings(appId));
  // A section this app does not have (an extension has no schedule).
  if (!sectionsFor(app).some((s) => s.key === section)) redirect(appPath.section(app.id, "scope"));
  const isExtension = app.targetKind === "extension";
  const meta = SETTINGS_SECTIONS.find((s) => s.key === section)!;
  const save = updateAppSettings.bind(null, app.id, section);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-medium">{meta.label}</h2>
        <p className="mt-1 text-sm text-fg-muted">{meta.what}</p>
      </div>
      {saved && !error && (
        <p role="status" className="rounded-lg border border-status-ok/40 bg-status-ok/5 px-4 py-2.5 text-sm text-status-ok">
          ✓ Saved.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-status-broken/40 bg-status-broken/10 px-4 py-2.5 text-sm text-status-broken">
          Not saved: {error}
        </p>
      )}

      {section === "scope" && (
        <form action={save} className="flex flex-col gap-4">
          {isExtension && <ExtensionSettings initialValue={readExtensionOptions(app.extensionConfig)} />}
          {/* The owner's voice — visually the loudest thing in the settings. */}
          <div className="rounded-xl border border-accent/40 bg-accent/5 p-5">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-fg">What worries you most?</span>
              <span className="block text-xs text-fg-muted">
                In your own words. Each concern is verified on every check, and the verdict&apos;s bottom line says how it
                came out — working or not.
              </span>
              <Textarea
                name="focusAreas"
                rows={3}
                placeholder={"e.g. All YouTube links and embeds must actually play.\nCheckout must never break."}
                defaultValue={app.focusAreas ?? ""}
              />
            </label>
          </div>

          <div className="card space-y-3 p-5">
            <div>
              <p className="text-sm font-medium text-fg">May we create test records?</p>
              <p className="text-xs text-fg-faint">
                We check the full lifecycle — create, see it appear, edit, delete — signed in as the test account and
                inside its own space only. Everything we create is named &ldquo;CheckMyApp test&rdquo; and removed
                again. Never invites, publishing, messages or payments. Requires a{" "}
                <Link href={appPath.section(app.id, "accounts")} className="text-accent hover:underline">
                  test login
                </Link>
                ; without it we stay read-only.
              </p>
            </div>
            <label className="flex items-start gap-2.5 text-sm text-fg">
              <input
                type="checkbox"
                name="writeMode"
                value="create_cleanup"
                defaultChecked={app.writeMode === "create_cleanup"}
                className="mt-0.5 h-4 w-4 rounded border-ink-600 bg-ink-900"
              />
              <span>Yes — create and clean up test records as my test account</span>
            </label>
          </div>

          <div className="card space-y-3 p-5">
            <div>
              <p className="text-sm font-medium text-fg">Scope &amp; notes</p>
              <p className="text-xs text-fg-faint">Hard limits and context. A check follows these to the letter.</p>
            </div>
            <Input name="scopeHints" placeholder="Don't touch /admin" defaultValue={app.scopeHints ?? ""} />
            <Input name="userNotes" placeholder="Don't delete the test account. OK to create sessions." defaultValue={app.userNotes ?? ""} />
          </div>
          <SaveRow label="Save what we check" />
        </form>
      )}

      {section === "accounts" && <Accounts appId={app.id} teamId={team.id} testEmail={app.testEmail} isExtension={isExtension} save={save} />}

      {section === "schedule" && <Schedule app={app} plan={team.plan as UserPlan} teamId={team.id} />}

      {section === "notifications" && <Notifications appId={app.id} teamId={team.id} userId={user.id} notifyEmail={app.watch ? (app.watch.notifyEmail ?? "") : null} save={save} />}

      {section === "integrations" && <Integrations app={app} teamId={team.id} save={save} />}

      {section === "remove" && <DeleteAppSection appId={app.id} appSlug={app.appSlug} isExtension={isExtension} />}
    </div>
  );
}

type Save = (formData: FormData) => Promise<void>;

function SaveRow({ label }: { label: string }) {
  return (
    <div>
      <Button type="submit" className="px-4 py-2.5 text-sm">
        {label}
      </Button>
    </div>
  );
}

// How a check signs in: the default login, and — for a website — named accounts
// besides it (CHE-322). Passwords are write-only: a blank box keeps the current one.
async function Accounts({ appId, teamId, testEmail, isExtension, save }: { appId: string; teamId: string; testEmail: string | null; isExtension: boolean; save: Save }) {
  const { db } = await requireUser();
  // Label and email only — the password never reaches the page.
  const testAccounts = isExtension ? [] : await listTestAccounts(db, teamId, appId);
  return (
    <form action={save} className="flex flex-col gap-4">
      <div className="card space-y-3 p-5">
        <div>
          <p className="text-sm font-medium text-fg">Test login</p>
          <p className="text-xs text-fg-faint">
            Unlocks the signed-in half of your app. Encrypted at rest, never logged, never in evidence. Password is
            write-only — blank keeps the current one. Google-OAuth logins aren&apos;t auto-walkable yet; use an
            email/password test user.
          </p>
        </div>
        <Input name="testEmail" type="email" placeholder="test@your-app.com" defaultValue={testEmail ?? ""} autoComplete="off" />
        <Input name="testPassword" type="password" placeholder="••••••••" autoComplete="new-password" />
      </div>

      {!isExtension && (
        <div className="card space-y-3 p-5">
          <div>
            <p className="text-sm font-medium text-fg">More test accounts</p>
            <p className="text-xs text-fg-faint">
              A different kind of user — &ldquo;admin&rdquo;, &ldquo;free user&rdquo;. Name one in a{" "}
              <Link href={appPath.section(appId, "scope")} className="text-accent hover:underline">
                concern
              </Link>{" "}
              (&ldquo;As admin: refunds go through&rdquo;) and that concern is checked signed in as it; everything else
              uses the login above. Same encryption, same rule: a blank password keeps the current one.
            </p>
          </div>
          {testAccounts.map((account) => (
            <div key={account.id} className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-center">
              <Input name={`account:${account.id}:label`} defaultValue={account.label} aria-label="Account name" autoComplete="off" />
              <Input name={`account:${account.id}:email`} type="email" defaultValue={account.email} aria-label="Email" autoComplete="off" />
              <Input name={`account:${account.id}:password`} type="password" placeholder="•••••••• (kept)" aria-label="New password" autoComplete="new-password" />
              <label className="flex items-center gap-1.5 text-xs text-fg-muted">
                <input type="checkbox" name={`account:${account.id}:remove`} value="1" className="h-4 w-4 rounded border-ink-600 bg-ink-900" />
                Remove
              </label>
            </div>
          ))}
          {testAccounts.length < MAX_EXTRA_ACCOUNTS && (
            <div className="grid gap-2 border-t border-ink-700 pt-3 sm:grid-cols-[8rem_1fr_1fr]">
              <Input name="newAccount:label" placeholder="admin" aria-label="New account name" autoComplete="off" />
              <Input name="newAccount:email" type="email" placeholder="admin@your-app.com" aria-label="New account email" autoComplete="off" />
              <Input name="newAccount:password" type="password" placeholder="••••••••" aria-label="New account password" autoComplete="new-password" />
            </div>
          )}
        </div>
      )}
      <SaveRow label="Save test accounts" />
    </form>
  );
}

type AppWithWatch = Prisma.AppGetPayload<{ include: { watch: { include: { runs: true } } } }>;

// When the app is checked by itself: how often, whether it is running, and the
// checks the schedule started. The controls apply at once (PATCH /api/watch).
async function Schedule({ app, plan, teamId }: { app: AppWithWatch; plan: UserPlan; teamId: string }) {
  const { db } = await requireUser();
  const watch = app.watch;
  // CHE-327: every check spends the team's balance, so where the owner decides
  // how often the app is checked, they see what a check of it usually costs.
  const usual = await appPriceRange(db, { id: teamId, plan }, app.appSlug);
  const priceLine = usual
    ? `A check of this app usually costs ${usd(usual.low)}–${usd(usual.high)}; one that finds nothing changed, a few cents.`
    : "Each check spends your team's balance; one that finds nothing changed costs a few cents.";

  if (!watch) {
    return (
      <p className="card p-6 text-sm text-fg-muted">
        This app is checked on request only. Open one of{" "}
        <Link href={appPath.page(app.id)} className="text-accent hover:underline">
          its checks
        </Link>{" "}
        and choose &ldquo;Enable Daily Watch&rdquo; to put it on a schedule. {priceLine}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <p className="font-mono text-xs text-fg-faint">
        <span className={watch.active ? "text-status-ok" : "text-fg-faint"}>{watch.active ? "● Active" : "○ Paused"}</span>
        {" · "}Last checked {watch.lastRunAt?.toLocaleString([], DATE_FMT) ?? "never"}
        {" · "}Next {watch.nextRunAt?.toLocaleString([], DATE_FMT) ?? "—"}
      </p>
      <WatchSettings
        slug={watch.appSlug}
        initial={{ frequency: watch.frequency as "daily" | "every_6h" | "manual", notifyOnChangeOnly: watch.notifyOnChangeOnly, active: watch.active }}
      />
      <p className="text-xs text-fg-faint">{priceLine}</p>
      <section>
        <h3 className="mb-2.5 text-sm font-medium text-fg">Recent scheduled checks</h3>
        <ul className="card divide-y divide-ink-700 overflow-hidden">
          {watch.runs.map((run) => {
            // One rule with Health → Checks for how a check came out: a check
            // that did not finish shows no verdict and no raw status word.
            const result = outcome(run, LIVE_RUN_STATUSES);
            const meta = result.kind === "verdict" ? VERDICT_META[result.verdict] : null;
            return (
              <li key={run.id} className="flex items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-ink-800/50">
                <span className="w-16 shrink-0 font-mono text-xs text-fg-faint">{run.startedAt.toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                <span className="flex-1">
                  {meta ? (
                    <span className={`font-mono text-xs ${meta.textClassName}`}>
                      {meta.emoji} {meta.label}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-fg-faint">{result.kind === "running" ? "Running" : "Did not finish"}</span>
                  )}
                </span>
                <Link
                  href={result.kind === "verdict" ? checkHref(run) : `/run/${run.publicId}`}
                  className="font-mono text-xs text-accent underline-offset-2 hover:underline"
                >
                  {result.kind === "verdict" ? "view verdict" : "open"}
                </Link>
              </li>
            );
          })}
          {watch.runs.length === 0 && <li className="px-4 py-3 text-sm text-fg-faint">No runs yet.</li>}
        </ul>
      </section>
    </div>
  );
}

// Who is told (CHE-262): the people on the team, and — for an app on a
// schedule — the address a regression is escalated to. Two forms: the list is
// its own action, the address is a field of the app.
async function Notifications({ appId, teamId, userId, notifyEmail, save }: { appId: string; teamId: string; userId: string; notifyEmail: string | null; save: Save }) {
  const { db } = await requireUser();
  const [teamMembers, notifiers] = await Promise.all([
    db.membership.findMany({ where: { teamId }, select: { userId: true, scope: true, user: { select: { email: true, name: true } } }, orderBy: { createdAt: "asc" } }),
    db.appNotifier.findMany({ where: { appId }, select: { userId: true } }),
  ]);
  const chosen = new Set(notifiers.map((n) => n.userId));
  return (
    <div className="flex flex-col gap-5">
      <form action={setAppNotifiers.bind(null, appId)} className="card space-y-3 p-5">
        {/* No chosen recipients means the team's admins — said, not left to be inferred from an empty list. */}
        <p className="text-sm text-fg-muted">
          {chosen.size === 0
            ? "Nobody chosen yet, so verdicts go to the team's admins. Pick people and they go to them instead."
            : "Verdicts for this app go to the people ticked here."}
        </p>
        {teamMembers.map((m) => (
          <label key={m.userId} className="flex items-center gap-3 text-sm">
            <input type="checkbox" name="notifier" value={m.userId} defaultChecked={chosen.has(m.userId)} />
            <span>
              {m.user.name?.trim() || m.user.email}
              <span className="text-fg-muted"> · {m.scope}</span>
              {m.userId === userId && <span className="text-fg-muted"> · you</span>}
            </span>
          </label>
        ))}
        <Button type="submit" variant="outline">
          Save who hears about it
        </Button>
      </form>

      {notifyEmail !== null && (
        <form action={save} className="card space-y-3 p-5">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-fg">Escalation email</span>
            <span className="block text-xs text-fg-faint">One more address that hears when a scheduled check finds a regression.</span>
            <Input name="notifyEmail" type="email" placeholder="you@email.com" defaultValue={notifyEmail} className="max-w-md" />
          </label>
          <Button type="submit" variant="outline" className="px-3 py-1.5 text-xs">
            Save escalation email
          </Button>
        </form>
      )}
    </div>
  );
}

type AppWithIntegrations = Prisma.AppGetPayload<{ include: { policy: true; tracker: true; repo: true } }>;

// Where problems go besides this page: one row per integration, each with its
// state and its own action.
async function Integrations({ app, teamId, save }: { app: AppWithIntegrations; teamId: string; save: Save }) {
  const { db } = await requireUser();
  const tracker = app.tracker;
  const health = trackerHealth(tracker, new Date());
  const env = getCloudflareContext().env as Record<string, string | undefined>;
  // Which of the workspace's teams the tickets land in. Best-effort — a
  // transient Linear error hides the picker and shows the stored name.
  const linearTeams = tracker
    ? await freshLinearToken(db, tracker, { clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET })
        .then(fetchTeams)
        .catch(() => [] as { id: string; name: string }[])
    : [];
  // CHE-237: the projects this team's PostHog connection can see, ranked for
  // this app. Costs nothing when no connection exists.
  const projectChoices = await projectChoicesFor(db, {
    teamId,
    appUrl: app.targetUrl,
    clientId: `${(env.APP_URL ?? "https://checkmyapp.dev").replace(/\/+$/, "")}/.well-known/posthog-client.json`,
  });

  const pickupLabels = (JSON.parse(app.policy?.pickupLabels ?? "[]") as string[]).join(", ");
  const urgentJourneys = (() => {
    try {
      return ((JSON.parse(app.policy?.priorityRule ?? "{}") as { urgent?: string[] }).urgent ?? []).join(", ");
    } catch {
      return "";
    }
  })();

  return (
    <div className="flex flex-col gap-5">
      {/* Linear + its ticket contract (they are one concern). */}
      <div className="card space-y-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-fg">
              Linear <span className="text-xs font-normal text-fg-faint">· issue tracker</span>
            </p>
            {health ? (
              <p className={`text-xs ${health.tone === "ok" ? "text-status-ok" : health.tone === "warn" ? "text-status-confusing" : "text-status-broken"}`}>
                {health.tone === "ok" ? "✓" : "⚠"} {health.text}
                {linearTeams.length === 0 && tracker?.externalOrg && ` · team: ${tracker.externalOrg}`}
              </p>
            ) : (
              <p className="text-xs text-fg-faint">Not connected — problems stay on the check&apos;s page instead of becoming tickets.</p>
            )}
            {tracker && linearTeams.length > 0 && (
              <p className="flex items-center gap-2 text-xs text-fg-muted">
                Tickets go to team
                <TeamSelect appId={app.id} teams={linearTeams} current={tracker.teamId} />
              </p>
            )}
          </div>
          <a
            href={`/api/integrations/linear/start?appId=${app.id}`}
            className="shrink-0 rounded-lg border border-ink-600 px-3 py-1.5 font-mono text-xs text-fg-muted transition-colors hover:border-fg-faint hover:text-fg"
          >
            {tracker ? "Reconnect →" : "Connect →"}
          </a>
        </div>

        {app.policy && (
          <form action={save} className="space-y-3 border-t border-ink-700 pt-4">
            <p className="text-xs text-fg-faint">
              The ticket contract: these labels are what makes <em>your</em> automation pick up a filed ticket. We never
              guess them.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs text-fg-muted">Pickup labels (comma-separated)</span>
                <Input name="pickupLabels" placeholder="monitor" defaultValue={pickupLabels} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-fg-muted">Repo label</span>
                <Input name="repoLabel" placeholder="repo: your-app" defaultValue={app.policy.repoLabel ?? ""} />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">Critical journeys → ticket priority Urgent (comma-separated)</span>
              <Input name="urgentJourneys" placeholder="login, dashboard, checkout" defaultValue={urgentJourneys} />
            </label>
            <Button type="submit" variant="outline" className="px-3 py-1.5 text-xs">
              Save ticket contract
            </Button>
          </form>
        )}
      </div>

      {/* PostHog — which project holds this app's data (CHE-237). */}
      <div className="[&>section]:mt-0">
        <AnalyticsProject
          appId={app.id}
          chosen={app.posthogProjectId ? { id: app.posthogProjectId, name: app.posthogProjectName } : null}
          choices={projectChoices}
        />
      </div>

      {/* GitHub — spec export target */}
      <div className="card flex items-start justify-between gap-4 p-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-fg">
            GitHub <span className="text-xs font-normal text-fg-faint">· e2e spec export</span>
          </p>
          {app.repo ? (
            <p className="text-xs text-status-ok">
              ✓ {app.repo.repoFullName} · base branch {app.repo.defaultBranch}
            </p>
          ) : (
            <p className="text-xs text-fg-faint">
              Not connected — use &ldquo;Export to GitHub&rdquo; on any check&apos;s page to link a repo with a
              fine-grained PAT.
            </p>
          )}
        </div>
      </div>

      {/* Outbound webhooks + Slack (CHE-53). */}
      <div className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">
          Webhooks{" "}
          <span className={`text-xs font-normal ${app.webhookUrl || app.slackWebhookUrl ? "text-status-ok" : "text-fg-faint"}`}>
            {app.webhookUrl || app.slackWebhookUrl ? "· ✓ configured" : "· plug check results into your own tools"}
          </span>
        </p>
        <form action={setIntegrationEndpoints.bind(null, app.id)} className="max-w-md space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">Webhook URL</span>
            <Input name="webhookUrl" type="url" placeholder="https://your-stack.example.com/hooks/checkmyapp" defaultValue={app.webhookUrl ?? ""} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">Signing secret (optional, write-only — blank keeps the current one)</span>
            <Input name="webhookSecret" type="password" placeholder="••••••••" autoComplete="new-password" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">Slack incoming webhook URL</span>
            <Input name="slackWebhookUrl" type="url" placeholder="https://hooks.slack.com/services/…" defaultValue={app.slackWebhookUrl ?? ""} />
          </label>
          <Button type="submit" variant="outline" className="px-3 py-1.5 text-xs">
            Save webhooks
          </Button>
        </form>
      </div>
    </div>
  );
}
