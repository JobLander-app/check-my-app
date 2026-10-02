import Link from "next/link";
import { ExtensionSettings } from "@/components/extension-fields";
import { RunSavedApp } from "@/components/run-saved-app";
import { readExtensionOptions, extensionDisplayName } from "@/lib/extension-target";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { setIntegrationEndpoints, updateAppSettings } from "@/app/dashboard/actions";
import { DeleteAppSection } from "@/components/delete-app";
import { appPriceRange, usd } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { memberOfRows, teamOwned } from "@/lib/tenant-db";
import { setAppNotifiers } from "@/app/dashboard/actions";
import { switchTeamAction } from "@/app/team/switch-actions";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { AnalyticsProject } from "@/components/analytics-project";
import { projectChoicesFor } from "@/lib/posthog/choices";
import { listTestAccounts } from "@/lib/app-settings";
import { MAX_EXTRA_ACCOUNTS } from "@/lib/test-accounts";
import { appPath } from "@/lib/app-shell";

// Per-app settings (CHE-64, redesigned CHE-81). Three meaning-first sections —
// the page will keep growing, so hierarchy comes from sections, not from a pile
// of identical cards:
//   1. What we check   — the agent's brief: priority concerns (the owner's
//                        voice, most prominent), test login, scope & notes.
//   2. Schedule & alerts — when it runs, who hears about it.
//   3. Where results go  — integrations: tracker (with its ticket contract),
//                        code host, webhooks.
// One form ("app-settings") spans sections 1–2 and the ticket-contract fields
// nested inside the Linear card (via the HTML form= attribute — forms can't
// nest); integrations keep their own actions.
export default async function AppSettingsPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  const { user, db, team } = await requireUser();

  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId },
    include: { watch: true, policy: true, tracker: true, repo: true, runs: { orderBy: { createdAt: "desc" }, take: 1, select: { extensionEvidence: true } } },
  });
  // CHE-261: not in the team you are acting as — but possibly in another of
  // your teams. Offer the switch; never switch silently (a page that changes
  // which team you are acting as, because of a link you followed, is how a
  // check gets started against the wrong budget), and never 404 a row this
  // person is entitled to see.
  if (!app) {
    const elsewhere = await db.app.findFirst({
      where: { ...memberOfRows(user.id), id: appId },
      select: { id: true, appSlug: true, teamId: true, team: { select: { name: true } } },
    });
    if (!elsewhere?.teamId) notFound();
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-16">
        <section className="card p-6">
          <h1 className="break-words text-xl font-semibold">{elsewhere.appSlug} belongs to {elsewhere.team?.name}</h1>
          <p className="mt-2 text-sm text-fg-muted">
            You are on that team, but you are currently acting as {team.name}. Switching changes which
            team&apos;s plan pays for anything you start.
          </p>
          <form action={switchTeamAction.bind(null, elsewhere.teamId, appPath.settings(appId))}>
            <Button type="submit" className="mt-6">Switch to {elsewhere.team?.name}</Button>
          </form>
        </section>
      </main>
    );
  }

  // CHE-262: who on the team is told about this app. No chosen recipients means
  // the team's admins, which is what the copy below says rather than leaving the
  // reader to infer it from an empty list.
  const teamMembers = await db.membership.findMany({
    where: { teamId: team.id },
    select: { userId: true, scope: true, user: { select: { email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const chosen = new Set(
    (await db.appNotifier.findMany({ where: { appId }, select: { userId: true } })).map((n) => n.userId),
  );

  const pickupLabels = (JSON.parse(app.policy?.pickupLabels ?? "[]") as string[]).join(", ");
  const repoLabel = app.policy?.repoLabel ?? "";
  const urgentJourneys = (() => {
    try {
      const rule = JSON.parse(app.policy?.priorityRule ?? "{}") as { urgent?: string[] };
      return (rule.urgent ?? []).join(", ");
    } catch {
      return "";
    }
  })();
  const isExtension = app.targetKind === "extension";
  const frequency = app.watch?.frequency ?? "daily";
  // CHE-322: label and email only — the password never reaches the page.
  const testAccounts = await listTestAccounts(db, team.id, app.id);

  // CHE-327: every check spends the team's balance, so where the owner decides
  // how often the app is checked, they see what a check of it usually costs.
  const usual = await appPriceRange(db, { id: team.id, plan: team.plan as UserPlan }, app.appSlug);
  const priceLine = usual
    ? `A check of this app usually costs ${usd(usual.low)}–${usd(usual.high)}; one that finds nothing changed, a few cents.`
    : "Each check spends your team's balance; one that finds nothing changed costs a few cents.";

  // Tracker token health (CHE-68/72): a pre-refresh-flow connection has no
  // refresh token, so its 24h access token dies and only a reconnect heals it.
  const tracker = app.tracker;
  const trackerHealth = !tracker
    ? null
    : tracker.refreshTokenEnc
      ? { tone: "ok" as const, text: "connected · token auto-renews" }
      : tracker.tokenExpiresAt && tracker.tokenExpiresAt <= new Date()
        ? { tone: "bad" as const, text: "token expired — reconnect to restore ticket filing" }
        : { tone: "warn" as const, text: "reconnect to enable token auto-renew" };

  // CHE-237: the projects this team's PostHog connection can see, ranked for
  // this app. Costs nothing when no connection exists, which is the common case
  // — and an app without one is not broken, it just keeps our own estimate.
  const projectChoices = await projectChoicesFor(db, {
    teamId: team.id,
    appUrl: app.targetUrl,
    clientId: `${((getCloudflareContext().env as Record<string, string | undefined>).APP_URL ?? "https://checkmyapp.dev").replace(/\/+$/, "")}/.well-known/posthog-client.json`,
  });

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <div className="mb-10">
        <Link href={appPath.page(app.id)} className="text-xs text-fg-faint hover:underline">
          ← {app.appSlug}
        </Link>
        <p className="section-label mt-3">{isExtension ? "extension settings" : "app settings"}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{isExtension ? extensionDisplayName(app.targetUrl, app.runs[0]?.extensionEvidence) : app.appSlug}</h1>
        <p className="break-all text-sm text-fg-muted">{app.targetUrl}</p>
        {isExtension && <div className="mt-4"><RunSavedApp appId={app.id} /></div>}
      </div>

      <form id="app-settings" action={updateAppSettings.bind(null, app.id)} className="space-y-12">
        {isExtension && <ExtensionSettings initialValue={readExtensionOptions(app.extensionConfig)} />}
        {/* ── 1 · What we check ────────────────────────────────────────── */}
        <section className="space-y-4">
          <div>
            <p className="section-label">1 · What we check</p>
            <p className="mt-1 text-sm text-fg-muted">
              The agent&apos;s brief: what you care about, how it signs in, where it may not go.
            </p>
          </div>

          {/* The owner's voice — visually the loudest thing on the page. */}
          <div className="rounded-xl border border-accent/40 bg-accent/5 p-5">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-fg">What worries you most?</span>
              <span className="block text-xs text-fg-muted">
                In your own words. The agent verifies each concern on every run and reports the
                outcome — working or not — in the verdict&apos;s bottom line.
              </span>
              <Textarea
                name="focusAreas"
                rows={3}
                placeholder={
                  "e.g. All YouTube links and embeds must actually play.\nCheckout must never break."
                }
                defaultValue={app.focusAreas ?? ""}
              />
            </label>
          </div>

          <div className="card space-y-3 p-5">
            <div>
              <p className="text-sm font-medium text-fg">Test login</p>
              <p className="text-xs text-fg-faint">
                Unlocks the signed-in half of your app. Encrypted at rest, never logged, never in
                evidence. Password is write-only — blank keeps the current one. Google-OAuth logins
                aren&apos;t auto-walkable yet; use an email/password test user.
              </p>
            </div>
            <Input
              name="testEmail"
              type="email"
              placeholder="test@your-app.com"
              defaultValue={app.testEmail ?? ""}
              autoComplete="off"
            />
            <Input
              name="testPassword"
              type="password"
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>

          {/* CHE-322: named accounts — one row each, saved with the rest of the
              form. Passwords are write-only here exactly as above. */}
          {!isExtension && (
            <div className="card space-y-3 p-5">
              <div>
                <p className="text-sm font-medium text-fg">More test accounts</p>
                <p className="text-xs text-fg-faint">
                  A different kind of user — &ldquo;admin&rdquo;, &ldquo;free user&rdquo;. Name one in
                  a concern above (&ldquo;As admin: refunds go through&rdquo;) and that concern is
                  checked signed in as it; everything else uses the login above. Same encryption,
                  same rule: a blank password keeps the current one.
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

          <div className="card space-y-3 p-5">
            <div>
              <p className="text-sm font-medium text-fg">May we create test records?</p>
              <p className="text-xs text-fg-faint">
                We check the full lifecycle — create, see it appear, edit, delete — signed in as
                the test account above and inside its own space only. Everything we create is
                named &ldquo;CheckMyApp test&rdquo; and removed again. Never invites, publishing,
                messages or payments. Requires the test login; without it we stay read-only.
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
              <p className="text-xs text-fg-faint">
                Hard limits and context. The agent follows these to the letter.
              </p>
            </div>
            <Input
              name="scopeHints"
              placeholder="Don't touch /admin"
              defaultValue={app.scopeHints ?? ""}
            />
            <Input
              name="userNotes"
              placeholder="Don't delete the test account. OK to create sessions."
              defaultValue={app.userNotes ?? ""}
            />
          </div>
        </section>

        {/* ── 2 · Schedule & alerts ───────────────────────────────────── */}
        {!isExtension && <section className="space-y-4">
          <div>
            <p className="section-label">2 · Schedule &amp; alerts</p>
            <p className="mt-1 text-sm text-fg-muted">When we check, and who hears about it.</p>
          </div>
          <div className="card grid gap-4 p-5 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">Frequency</span>
              <select
                name="frequency"
                defaultValue={frequency}
                className="w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5 font-mono text-sm text-fg outline-none"
              >
                <option value="daily">Daily</option>
                <option value="every_6h">Every 6 hours</option>
                <option value="manual">Manual only</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">Escalation email</span>
              <Input
                name="notifyEmail"
                type="email"
                placeholder="you@email.com"
                defaultValue={app.watch?.notifyEmail ?? ""}
              />
            </label>
            <p className="text-xs text-fg-faint sm:col-span-2">
              {priceLine}
            </p>
          </div>
        </section>}
      </form>

      {/* ── Who hears about it (CHE-262) ──────────────────────────────── */}
      <section className="mt-12 space-y-4">
        <div>
          <h2 className="text-lg font-medium">Who hears about it</h2>
          <p className="mt-1 text-sm text-fg-muted">
            {chosen.size === 0
              ? "Nobody chosen yet, so verdicts go to the team's admins. Pick people and they go to them instead."
              : "Verdicts for this app go to the people ticked here."}
          </p>
        </div>
        <form action={setAppNotifiers.bind(null, appId)} className="card space-y-3 p-4">
          {teamMembers.map((m) => (
            <label key={m.userId} className="flex items-center gap-3 text-sm">
              <input type="checkbox" name="notifier" value={m.userId} defaultChecked={chosen.has(m.userId)} />
              <span>
                {m.user.name?.trim() || m.user.email}
                <span className="text-fg-muted"> · {m.scope}</span>
                {m.userId === user.id && <span className="text-fg-muted"> · you</span>}
              </span>
            </label>
          ))}
          <Button type="submit" variant="outline">Save who hears about it</Button>
        </form>
      </section>

      {/* ── Which PostHog project holds this app's data (CHE-237) ──────── */}
      <AnalyticsProject
        appId={appId}
        chosen={app.posthogProjectId ? { id: app.posthogProjectId, name: app.posthogProjectName } : null}
        choices={projectChoices}
      />

      {/* ── 3 · Where results go ──────────────────────────────────────── */}
      <section className="mt-12 space-y-4">
        <div>
          <p className="section-label">3 · Where results go</p>
          <p className="mt-1 text-sm text-fg-muted">
            Verdicts stay on your dashboard either way; these push regressions into your own
            tools.
          </p>
        </div>

        {/* Linear + its ticket contract (they are one concern). */}
        <div className="card space-y-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-fg">
                Linear <span className="font-normal text-xs text-fg-faint">· issue tracker</span>
              </p>
              {trackerHealth ? (
                <p
                  className={`text-xs ${
                    trackerHealth.tone === "ok"
                      ? "text-status-ok"
                      : trackerHealth.tone === "warn"
                        ? "text-status-confusing"
                        : "text-status-broken"
                  }`}
                >
                  {trackerHealth.tone === "ok" ? "✓" : "⚠"} {trackerHealth.text}
                  {tracker?.externalOrg && ` · team: ${tracker.externalOrg}`}
                </p>
              ) : (
                <p className="text-xs text-fg-faint">
                  Not connected — regressions stay on the verdict page instead of becoming
                  tickets.
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

          {/* Ticket contract fields — part of the main settings form via the
              form= attribute (forms can't nest inside the webhook form below). */}
          <div className="space-y-3 border-t border-ink-700 pt-4">
            <p className="text-xs text-fg-faint">
              The ticket contract: these labels are what makes <em>your</em> automation pick up a
              filed ticket. We never guess them.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs text-fg-muted">Pickup labels (comma-separated)</span>
                <Input
                  name="pickupLabels"
                  form="app-settings"
                  placeholder="monitor"
                  defaultValue={pickupLabels}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-fg-muted">Repo label</span>
                <Input
                  name="repoLabel"
                  form="app-settings"
                  placeholder="repo: your-app"
                  defaultValue={repoLabel}
                />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">
                Critical journeys → ticket priority Urgent (comma-separated)
              </span>
              <Input
                name="urgentJourneys"
                form="app-settings"
                placeholder="login, dashboard, checkout"
                defaultValue={urgentJourneys}
              />
            </label>
          </div>
        </div>

        {/* GitHub — spec export target */}
        <div className="card flex items-start justify-between gap-4 p-5">
          <div className="space-y-1">
            <p className="text-sm font-medium text-fg">
              GitHub <span className="font-normal text-xs text-fg-faint">· e2e spec export</span>
            </p>
            {app.repo ? (
              <p className="text-xs text-status-ok">
                ✓ {app.repo.repoFullName} · base branch {app.repo.defaultBranch}
              </p>
            ) : (
              <p className="text-xs text-fg-faint">
                Not connected — use &ldquo;Export to GitHub&rdquo; on any verdict page to link a
                repo with a fine-grained PAT.
              </p>
            )}
          </div>
        </div>

        {/* Outbound webhooks + Slack (CHE-53) — separate form on purpose. */}
        <details className="card p-5">
          <summary className="cursor-pointer text-sm font-medium text-fg">
            Webhooks{" "}
            <span
              className={`text-xs font-normal ${app.webhookUrl || app.slackWebhookUrl ? "text-status-ok" : "text-fg-faint"}`}
            >
              {app.webhookUrl || app.slackWebhookUrl
                ? "· ✓ configured"
                : "· plug run results into your monitoring"}
            </span>
          </summary>
          <form
            action={setIntegrationEndpoints.bind(null, app.id)}
            className="mt-4 max-w-md space-y-2"
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
      </section>

      {/* CHE-95: found by our own check — an app could be added and never
          removed, which also pinned a free plan at its one-watch trial. */}
      <DeleteAppSection appId={app.id} appSlug={app.appSlug} isExtension={app.targetKind === "extension"} />

      {/* One Save for sections 1–2 + the ticket contract (form= association). */}
      <div className="sticky bottom-0 mt-10 border-t border-ink-700 bg-ink-950/90 py-4 backdrop-blur">
        <Button type="submit" form="app-settings" className="w-full py-3.5 text-[15px]">
          Save settings
        </Button>
        <p className="mt-2 text-center text-xs text-fg-faint">
          Saves sections 1–2 and the ticket contract. Integrations apply instantly on their own.
        </p>
      </div>
    </main>
  );
}
