import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Prisma } from "@/generated/prisma/client";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/scopes";
import type { TeamScope } from "@/lib/scopes";
import { teamOwned } from "@/lib/tenant-db";
import { appPath, checkHref } from "@/lib/app-shell";
import { VERDICT_META } from "@/lib/status";
import { appPriceRange, usd } from "@/lib/plans";
import { appGitHub, mappingErrorText } from "@/lib/github-mapping";
import { AppGitHubRepo } from "@/components/app-github-repo";
import type { UserPlan } from "@/lib/enums";
import { LIVE_RUN_STATUSES } from "@/lib/enums";
import { outcome } from "@/lib/checks-page";
import {
  JIRA_NO_PROJECT,
  jiraAccountLine,
  jiraBlockedLine,
  sectionsFor,
  settingsSection,
  trackerHealth,
  trackerIdleLine,
  trackerSummary,
  type TrackerHealth,
} from "@/lib/app-settings-sections";
import { listTestAccounts } from "@/lib/app-settings";
import { MAX_EXTRA_ACCOUNTS } from "@/lib/test-accounts";
import { readExtensionOptions } from "@/lib/extension-target";
import { projectChoicesFor } from "@/lib/posthog/choices";
import { fetchTeams } from "@/lib/tracker/linear-oauth";
import { freshLinearToken } from "@/lib/tracker/token";
import { appRunsTheAction } from "@/lib/release-action";
import { integrationNotice } from "@/lib/integration-notice";
import { setAppNotifiers, setIntegrationEndpoints, updateAppSettings } from "@/app/dashboard/actions";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ExtensionSettings } from "@/components/extension-fields";
import { WatchSettings } from "@/components/watch-settings";
import { AnalyticsProject } from "@/components/analytics-project";
import { GitHubCard } from "@/components/github-card";
import { TeamSelect } from "@/components/team-select";
import { JiraProjectSelect } from "@/components/jira-project-select";
import { jiraChoices, jiraProjectBlockers } from "@/lib/tracker/jira-connect";
import { trackerName } from "@/lib/tracker/name";
import { DeleteAppSection } from "@/components/delete-app";
import { ScenarioList } from "@/components/scenario-list";
import { listScenarios, mayEditScenarios } from "@/lib/scenarios";
import { hasFeature, teamFeatures } from "@/lib/team-features";
import { APP_NAME_MAX } from "@/lib/app-label";
import { connectedShopifyAppOf, storesOf } from "@/lib/shopify-stores";
import { STORES_COPY } from "@/lib/sign-in-copy";

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
  // What a save bounces back: that it was saved, or the sentence it was refused
  // with. What the Linear flow bounces back: its outcome (src/lib/integration-notice.ts).
  searchParams: Promise<{ saved?: string; error?: string; integration?: string; github_error?: string }>;
}) {
  const { appId, section: raw } = await params;
  const { saved, error, integration, github_error } = await searchParams;
  const section = settingsSection(raw);
  if (!section) notFound();
  const notice = integrationNotice(integration);

  const { user, db, team, scope } = await requireUser();
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId },
    include: { watch: { include: { runs: { orderBy: { startedAt: "desc" }, take: 10 } } }, policy: true, tracker: true },
  });
  // Another team of yours, or nobody's: the settings address says which (CHE-261).
  if (!app) redirect(appPath.settings(appId));
  // A section this app does not have (an extension has no schedule).
  if (!sectionsFor(app).some((s) => s.key === section)) redirect(appPath.section(app.id, "scope"));
  const isExtension = app.targetKind === "extension";
  // This app's own name for the section: a Shopify app's accounts are its test
  // stores (CHE-468).
  const meta = sectionsFor(app).find((s) => s.key === section)!;
  const save = updateAppSettings.bind(null, app.id, section);
  // CHE-435: the scenario list, behind `shopify` like the rest of the pilot.
  const features = await teamFeatures(db, team.id);
  const scenarios = section === "scope" && hasFeature(features, "shopify") ? await listScenarios(db, team.id, app.id) : null;

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
      {notice && (
        <p
          role={notice.ok ? "status" : "alert"}
          className={
            notice.ok
              ? "rounded-lg border border-status-ok/40 bg-status-ok/5 px-4 py-2.5 text-sm text-status-ok"
              : "rounded-lg border border-status-confusing/40 bg-status-confusing/10 px-4 py-2.5 text-sm text-status-confusing"
          }
        >
          {notice.text}
        </p>
      )}

      {section === "scope" && scenarios && (
        <ScenarioList appId={app.id} scenarios={scenarios} mayEdit={mayEditScenarios({ scope, features })} />
      )}

      {section === "scope" && (
        <form action={save} className="flex flex-col gap-4">
          {/* CHE-457: what the team calls the app — shown everywhere instead of its address. */}
          <label className="card block space-y-2 p-5">
            <span className="text-sm font-medium text-fg">Name</span>
            <span className="block text-xs text-fg-faint">
              Shown everywhere instead of {app.appSlug}. The address and the app&apos;s history stay as they are.
            </span>
            <Input name="name" maxLength={APP_NAME_MAX} placeholder={app.appSlug} defaultValue={app.name ?? ""} />
          </label>
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

          {/* CHE-468 (Codex on #342): a Shopify app has no test login to create
              records as, so its checks read the store and never write to it;
              offering the choice would only be overruled at run time (the
              workflow's hasTestAccount gate). CHE-442 is the per-app opt-in. */}
          {app.targetKind === "session" ? (
            <div className="card space-y-1 p-5">
              <p className="text-sm font-medium text-fg">{STORES_COPY.readOnlyTitle}</p>
              <p className="text-xs text-fg-faint">{STORES_COPY.readOnly}</p>
            </div>
          ) : (
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
          )}

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

      {/* A login is an admin's to set (app.credentials.write, src/lib/scopes.ts;
          CHE-417). A member is told so instead of being shown a form that
          would refuse them on save. */}
      {section === "accounts" && app.targetKind === "session" && (
        <ShopifyStores app={app} teamId={team.id} mayWrite={can(scope, "app.credentials.write")} hasStorePassword={Boolean(app.storePasswordEnc)} save={save} />
      )}
      {section === "accounts" && app.targetKind !== "session" &&
        (can(scope, "app.credentials.write") ? (
          <Accounts appId={app.id} teamId={team.id} testEmail={app.testEmail} hasStorePassword={Boolean(app.storePasswordEnc)} isExtension={isExtension} save={save} />
        ) : (
          <p className="card p-5 text-sm text-fg-muted">
            {app.testEmail ? `Signs in as ${app.testEmail}. ` : "No test login yet. "}
            Test logins are set by an admin of the team.
          </p>
        ))}

      {section === "schedule" && <Schedule app={app} plan={team.plan as UserPlan} teamId={team.id} />}

      {section === "notifications" && <Notifications appId={app.id} teamId={team.id} userId={user.id} />}

      {section === "integrations" && <Integrations app={app} teamId={team.id} plan={team.plan as UserPlan} scope={scope} githubError={github_error} save={save} />}

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

// CHE-468: a Shopify app's "test accounts" are the dev stores it is checked
// on — the team's rows of the same app handle (CHE-451) — each with its own
// page and its own sign-in. A check signs in through the team's signed-in
// browser, never with a stored login, so no login form is shown; the one
// credential a store can have is the password of its storefront's password
// page (CHE-372), kept here. The form carries that field alone, and the save
// leaves every field it does not carry as it was.
async function ShopifyStores({
  app,
  teamId,
  mayWrite,
  hasStorePassword,
  save,
}: {
  app: { id: string; appSlug: string; targetUrl: string; targetKind: string };
  teamId: string;
  mayWrite: boolean;
  hasStorePassword: boolean;
  save: Save;
}) {
  const { db, user } = await requireUser();
  const shopify = connectedShopifyAppOf(app);
  const stores = shopify ? await storesOf(db, teamId, shopify.handle) : [];
  // Every sentence is STORES_COPY's (src/lib/sign-in-copy.ts), under the
  // language guards in scripts/verify-live-view.ts.
  return (
    <div className="flex flex-col gap-4">
      <div className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">{STORES_COPY.heading}</p>
        {/* CHE-482: how stores work, where they are connected. */}
        <p className="text-xs text-fg-muted">{STORES_COPY.how}</p>
        {stores.length === 0 ? (
          // Codex on #342: a store still waiting for its app to be chosen is
          // chosen on its own sign-in page — linked, not only named.
          <p className="text-sm text-fg-muted">
            {STORES_COPY.none}{" "}
            <Link href={appPath.signIn(app.id)} className="text-accent hover:underline">
              {STORES_COPY.signIn}
            </Link>
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-ink-800">
            {stores.map((s) => (
              <li key={s.appId} className="flex items-center justify-between gap-4 py-2 text-sm">
                <span className="flex flex-col">
                  {s.appId === app.id ? (
                    <span className="font-mono">
                      {s.store} <span className="font-sans text-xs text-fg-faint">· {STORES_COPY.thisPage}</span>
                    </span>
                  ) : (
                    <Link href={appPath.page(s.appId)} className="font-mono text-accent hover:underline">
                      {s.store}
                    </Link>
                  )}
                  <span className="text-xs text-fg-faint">{STORES_COPY.signedInAs({ mine: s.ownerId === user.id, email: s.ownerEmail })}</span>
                </span>
                {/* Only the store's own connector signs in for it (storeSignIn). */}
                {s.ownerId === user.id && (
                  <Link href={appPath.signIn(s.appId)} className="text-xs text-fg-muted hover:text-accent">
                    {STORES_COPY.signIn}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-fg-faint">
          {STORES_COPY.addBefore}{" "}
          <Link href="/connect/shopify" className="text-accent hover:underline">
            {STORES_COPY.addLink}
          </Link>
          {STORES_COPY.addAfter}
        </p>
      </div>

      {mayWrite ? (
        <form action={save} className="flex flex-col gap-4">
          <div className="card space-y-3 p-5">
            <div>
              <p className="text-sm font-medium text-fg">{STORES_COPY.passwordTitle}</p>
              <p className="text-xs text-fg-faint">
                {STORES_COPY.passwordWhat} {hasStorePassword ? `${STORES_COPY.passwordSet} ` : ""}
                {STORES_COPY.passwordRule}
              </p>
            </div>
            <Input name="storePassword" type="password" placeholder="••••••••" aria-label={STORES_COPY.passwordTitle} autoComplete="new-password" />
            {hasStorePassword && (
              <label className="flex items-center gap-1.5 text-xs text-fg-muted">
                <input type="checkbox" name="storePasswordRemove" value="1" className="h-4 w-4 rounded border-ink-600 bg-ink-900" />
                {STORES_COPY.passwordRemove}
              </label>
            )}
          </div>
          <SaveRow label={STORES_COPY.passwordSave} />
        </form>
      ) : (
        <p className="card p-5 text-sm text-fg-muted">
          {hasStorePassword ? STORES_COPY.passwordIsSet : STORES_COPY.passwordNone} {STORES_COPY.passwordByAdmin}
        </p>
      )}
    </div>
  );
}

// How a check signs in: the default login, and — for a website — named accounts
// besides it (CHE-322). Passwords are write-only: a blank box keeps the current one.
async function Accounts({
  appId,
  teamId,
  testEmail,
  hasStorePassword,
  isExtension,
  save,
}: {
  appId: string;
  teamId: string;
  testEmail: string | null;
  hasStorePassword: boolean;
  isExtension: boolean;
  save: Save;
}) {
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

      {/* CHE-443: the card's "Add the store password" lands here. Until now the
          password could only be set through MCP (CHE-372), so the link led to a
          page with nowhere to put it. */}
      {!isExtension && (
        <div className="card space-y-3 p-5">
          <div>
            <p className="text-sm font-medium text-fg">Store password</p>
            <p className="text-xs text-fg-faint">
              For a store that shows a password page before anything else. {hasStorePassword ? "One is set. " : ""}Same
              encryption, same rule: a blank box keeps the current one.
            </p>
          </div>
          <Input name="storePassword" type="password" placeholder="••••••••" aria-label="Store password" autoComplete="new-password" />
          {hasStorePassword && (
            <label className="flex items-center gap-1.5 text-xs text-fg-muted">
              <input type="checkbox" name="storePasswordRemove" value="1" className="h-4 w-4 rounded border-ink-600 bg-ink-900" />
              Remove the store password
            </label>
          )}
        </div>
      )}

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

// Who is told (CHE-262): the people on the team, one form with its own action.
// Every verdict of the app goes to them — there is no second, outside address
// (CHE-413): one list, so nobody wonders which of two it went to.
async function Notifications({ appId, teamId, userId }: { appId: string; teamId: string; userId: string }) {
  const { db } = await requireUser();
  const [teamMembers, notifiers] = await Promise.all([
    db.membership.findMany({ where: { teamId }, select: { userId: true, scope: true, user: { select: { email: true, name: true } } }, orderBy: { createdAt: "asc" } }),
    db.appNotifier.findMany({ where: { appId }, select: { userId: true } }),
  ]);
  const chosen = new Set(notifiers.map((n) => n.userId));
  return (
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
      <p className="text-xs text-fg-faint">
        Someone who should hear about it but is not on the team?{" "}
        <Link href="/settings/team" className="text-accent hover:underline">
          Invite them
        </Link>
        .
      </p>
      <Button type="submit" variant="outline">
        Save who hears about it
      </Button>
    </form>
  );
}

type AppWithIntegrations = Prisma.AppGetPayload<{ include: { policy: true; tracker: true } }>;

// One tracker's row in the Issue tracker card: its name, its state, what it
// files into, and its own Connect. Linear and Jira share the frame, so neither
// can quietly grow a different card again.
function TrackerRow({ name, href, health, detail, idle, children }: { name: string; href: string; health: TrackerHealth | null; detail: string; idle: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-ink-700 pt-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-fg">{name}</p>
        {health ? (
          <p className={`text-xs ${health.tone === "ok" ? "text-status-ok" : health.tone === "warn" ? "text-status-confusing" : "text-status-broken"}`}>
            {health.tone === "ok" ? "✓" : "⚠"} {health.text}
            {detail}
          </p>
        ) : (
          <p className="text-xs text-fg-faint">{idle}</p>
        )}
        {children}
      </div>
      <a
        href={href}
        className="shrink-0 rounded-lg border border-ink-600 px-3 py-1.5 font-mono text-xs text-fg-muted transition-colors hover:border-fg-faint hover:text-fg"
      >
        {health ? "Reconnect →" : "Connect →"}
      </a>
    </div>
  );
}

// Where problems go besides this page, and where checks come from: one card
// per integration, each with its state and its own action.
async function Integrations({ app, teamId, plan, scope, githubError, save }: { app: AppWithIntegrations; teamId: string; plan: UserPlan; scope: TeamScope; githubError: string | undefined; save: Save }) {
  const { db } = await requireUser();
  // CHE-438: an app files into one tracker — Linear or Jira. Each card reads
  // only its own kind; connecting one replaces the other.
  const jira = app.tracker?.type === "jira" ? app.tracker : null;
  const tracker = app.tracker && app.tracker.type !== "jira" ? app.tracker : null;
  const health = trackerHealth(tracker, new Date());
  const jiraHealth = trackerHealth(jira, new Date());
  const env = getCloudflareContext().env as Record<string, string | undefined>;
  // Which of the workspace's teams the tickets land in. Best-effort — a
  // transient Linear error hides the picker and shows the stored name.
  const linearTeams = tracker
    ? await freshLinearToken(db, tracker, { clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET })
        .then(fetchTeams)
        .catch(() => [] as { id: string; name: string }[])
    : [];
  // CHE-438: every project on every site the Jira grant reaches. Best-effort,
  // like the Linear teams: an Atlassian error hides the picker.
  const jiraProjects = jira
    ? await jiraChoices(db, jira, { clientId: env.JIRA_CLIENT_ID, clientSecret: env.JIRA_CLIENT_SECRET }).catch(
        () => [] as { value: string; label: string }[],
      )
    : [];
  // Required fields of the chosen project that a ticket of ours cannot fill.
  const jiraBlockers = jira
    ? await jiraProjectBlockers(db, jira, { clientId: env.JIRA_CLIENT_ID, clientSecret: env.JIRA_CLIENT_SECRET }).catch(() => [] as string[])
    : [];
  // CHE-237: the projects this team's PostHog connection can see, ranked for
  // this app. Costs nothing when no connection exists.
  const [projectChoices, fromAction, github] = await Promise.all([
    projectChoicesFor(db, {
      teamId,
      appUrl: app.targetUrl,
      clientId: `${(env.APP_URL ?? "https://checkmyapp.dev").replace(/\/+$/, "")}/.well-known/posthog-client.json`,
    }),
    appRunsTheAction(db, teamId, app.id),
    // A deploy is checked as a website; an extension has no repository here.
    app.targetKind === "website" ? appGitHub(db, { id: teamId, plan }, app.id) : Promise.resolve(null),
  ]);
  const githubErrorText = mappingErrorText(githubError);

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
      {/* The issue tracker and its ticket contract — one concern, one card. An
          app files into Linear or Jira, one at a time, and both file with the
          same contract (src/lib/tracker/file.ts draftForFinding), so the two
          rows share one frame and the contract sits under both (CHE-438). */}
      <div className="card space-y-4 p-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-fg">
            Issue tracker <span className="text-xs font-normal text-fg-faint">· Linear or Jira, one at a time</span>
          </p>
          {/* The words are src/lib/app-settings-sections.ts's, every one of
              them checked against the customer-language gate. */}
          <p className="text-xs text-fg-faint">{trackerSummary(app.tracker, jira ? jiraHealth : health, jiraBlockers)}</p>
        </div>

        <TrackerRow
          name="Linear"
          href={`/api/integrations/linear/start?appId=${app.id}`}
          health={health}
          detail={linearTeams.length === 0 && tracker?.externalOrg ? ` · team: ${tracker.externalOrg}` : ""}
          idle={trackerIdleLine("Linear", jira ? "Jira" : null)}
        >
          {tracker && linearTeams.length > 0 && (
            <p className="flex items-center gap-2 text-xs text-fg-muted">
              Tickets go to team
              <TeamSelect appId={app.id} teams={linearTeams} current={tracker.teamId} />
            </p>
          )}
        </TrackerRow>

        <TrackerRow
          name="Jira"
          href={`/api/integrations/jira/start?appId=${app.id}`}
          health={jiraHealth}
          detail={
            jira && jiraProjects.length === 0
              ? `${jira.teamId ? ` · project ${jira.teamId}` : ""}${jira.externalUrl ? ` on ${jira.externalUrl.replace(/^https?:\/\//, "")}` : ""}`
              : ""
          }
          idle={trackerIdleLine("Jira", tracker ? trackerName(tracker.type) : null)}
        >
          {/* Before Connect and Reconnect alike: both start the same consent. */}
          <p className="text-xs text-fg-faint">{jiraAccountLine(jira !== null)}</p>
          {jira && !jira.teamId && <p className="text-xs text-status-confusing">{JIRA_NO_PROJECT}</p>}
          {jira?.teamId && jiraBlockers.length > 0 && <p className="text-xs text-status-broken">{jiraBlockedLine(jira.teamId, jiraBlockers)}</p>}
          {jira && jiraProjects.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              Tickets go to project
              <JiraProjectSelect
                appId={app.id}
                choices={jiraProjects}
                current={jira.externalOrg && jira.teamId ? `${jira.externalOrg}/${jira.teamId}` : null}
              />
            </p>
          )}
        </TrackerRow>

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
                {/* A Jira label holds no spaces (src/lib/tracker/jira.ts jiraLabel). */}
                <Input name="repoLabel" placeholder={jira ? "repo-your-app" : "repo: your-app"} defaultValue={app.policy.repoLabel ?? ""} />
              </label>
            </div>
            <label className="block space-y-1">
              {/* Priority 1 on the draft: Linear calls it Urgent, Jira Highest. */}
              <span className="text-xs text-fg-muted">Critical journeys → ticket priority {jira ? "Highest" : "Urgent"} (comma-separated)</span>
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

      {/* GitHub — where a release is checked from (CHE-413). The repository this app
          deploys from is set here, on the app's Integrations section (CHE-369, B). */}
      {/* The refusal arrives as a code and is shown only as our own sentence. */}
      {githubErrorText && (
        <p role="alert" className="rounded-lg border border-status-broken/40 bg-status-broken/10 px-4 py-2.5 text-sm text-status-broken">
          Not saved: {githubErrorText}
        </p>
      )}
      {github && <AppGitHubRepo appId={app.id} appSlug={app.appSlug} github={github} canConnect={can(scope, "integration.connect")} />}
      <GitHubCard connected={fromAction} />

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
