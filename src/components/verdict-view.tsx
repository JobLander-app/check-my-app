import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getDbFromContext } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { normalizeAnatomy } from "@/lib/anatomy";
import { VERDICT_META } from "@/lib/status";
import { AppLensSection } from "@/components/app-lens";
import { JourneyStrips } from "@/components/journey-strip";
import { numbersForJourneys } from "@/lib/journey-numbers-load";
import { AppAnatomySection } from "@/components/app-anatomy";
import { FindingsList } from "@/components/findings-list";
import { EnableWatchButton, FullRecheckButton, RecheckButton } from "@/components/verdict-actions";
import { ExportSpecs } from "@/components/export-specs";
import { TrackOnView, TrackedLink } from "@/components/track";
import { canMutateOwned, getOptionalUser, optionalTeamContext } from "@/lib/auth";
import { viewerCapabilities } from "@/lib/viewer-capabilities";
import { FINDING_PUBLIC_SELECT } from "@/lib/finding-fields";
import { explainPrice } from "@/lib/check-price";
import { CheckPrice } from "@/components/check-price";
import type { UserPlan } from "@/lib/enums";
import type { AppLens, RunEvent } from "@/lib/types";
import { extensionDisplayName, extensionReportPublished } from "@/lib/extension-target";
import { alreadyScoped, publicRow } from "@/lib/tenant-db";

// CHE-334: the journey statuses that put a problem on the page — what the
// empty findings section must not contradict.
const FLAGGED_JOURNEY = new Set(["confusing", "risky", "broken", "exposed"]);

function formatDuration(start: Date, end: Date | null): string | null {
  if (!end) return null;
  const mins = Math.round((end.getTime() - start.getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// The verdict itself — the main artifact — rendered by two routes (CHE-371):
// the public permalink `/verdict/{id}` (src/app/verdict/[id]/page.tsx), which
// is what people share, and the check inside the signed-in app
// (src/app/(app)/health/apps/[appId]/checks/[runNumber]/page.tsx), which keeps
// the sidebar. One body, so the two can never say different things about the
// same check; who may see and press what is decided here, per viewer, exactly
// as before — the in-app route adds nothing to it.
//
// Order is deliberate: Findings first (the owner opens a verdict to learn what's
// wrong — 2026-08-23) → Lens (mirror) → Journeys (centerpiece) → Anatomy →
// Daily Watch footer.
export async function VerdictView({
  id,
  watchError,
  recheck,
  balance,
  inApp,
}: {
  id: string;
  // CHE-75/94: the verdict actions bounce their outcomes back as text —
  // a refusal the visitor can read beats a button that quietly does nothing.
  watchError?: string;
  recheck?: string;
  balance?: string;
  // Inside the app: where another check of this app opens (the "newer run"
  // notice), so the reader stays in the workspace. Absent on the public page.
  // `back` is this check's own address there: the actions bounce a refusal to
  // it, so it is read where the button was pressed.
  inApp?: { checkHref: (run: { publicId: string; runNumber: number }) => string; back: string };
}) {
  const balanceRefused = balance === "1" && typeof recheck === "string";
  const recheckNotice =
    recheck === "reused"
      ? "This is the current verdict for this app — it was checked recently, so we're showing that result instead of spending a new check."
      : recheck === "notfound"
        ? "That run no longer exists."
        : (recheck ?? null);
  const prisma = await getDbFromContext();
  const run = await prisma.run.findUnique({ ...publicRow(),
    where: { publicId: id },
    include: {
      journeys: { include: { steps: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
      // CHE-215: an explicit projection, not `include`. This array is a prop of
      // a client component, so every column on it ships to the browser in the
      // RSC payload whether or not it is rendered — and `anchor` is our own
      // record of what the finding was allowed to rest on (rule 1).
      // src/lib/finding-fields.ts classifies every column and a verify case
      // fails when a new one is added without a decision.
      findings: {
        select: { ...FINDING_PUBLIC_SELECT, evidence: true },
        orderBy: { number: "asc" },
      },
      watch: { select: { active: true } },
      llmUsage: true,
    },
  });
  if (!run) notFound();
  // CHE-329: includes every failed run — a check that didn't finish has no
  // verdict to show, and its page is the run page, which says so in one line.
  if (!extensionReportPublished(run)) redirect(`/run/${run.publicId}`);

  const verdictMeta = run.verdict ? VERDICT_META[run.verdict] : null;
  const duration = formatDuration(run.startedAt, run.completedAt);
  // Tokens-model-money — the primary metric. Ledger rows when present (new
  // runs), Run.costUsd alone for runs that predate the LlmUsage table.
  const totalTokens = run.llmUsage.reduce(
    (s, u) => s + u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens + u.outputTokens,
    0,
  );
  const byModel = [...new Set(run.llmUsage.map((u) => u.model))].map((model) => ({
    model: model.replace(/^claude-/, "").replace(/-[\d-]+$/, ""),
    costUsd: run.llmUsage.filter((u) => u.model === model).reduce((s, u) => s + u.costUsd, 0),
  }));
  const fmtTok = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;
  const generatedTests = await prisma.generatedTest.findMany({
    where: { appSlug: run.appSlug },
    orderBy: [{ title: "asc" }, { version: "desc" }],
    distinct: ["title"],
  });
  // If the signed-in viewer owns this target, surface their GitHub connection
  // so "Export to GitHub" renders in its connected state. Anonymous viewers get
  // the connect path (the export API redirects them to sign-in).
  const viewer = await getOptionalUser(prisma);
  // CHE-253: the allowance shown to a signed-in viewer is their team's.
  const viewerTeam = await optionalTeamContext(prisma, viewer);
  // CHE-202: an ephemeral run has no App and gets none — the lookup is skipped
  // rather than tolerated, so a preview hostname that happens to match an
  // onboarded app's slug never borrows that app's repo connection.
  const viewerApp =
    viewer && !run.ephemeral
      ? await prisma.app.findUnique({ ...alreadyScoped("the unique key names the owner"),
        where: { ownerId_appSlug: { ownerId: viewer.id, appSlug: run.appSlug } },
        include: { repo: { select: { repoFullName: true } }, watch: { select: { active: true } } },
      })
    : null;
  // Watched: this check was started by a watch, or the viewer's app of this
  // address has one. The second half matters for every check the owner started
  // by hand — it carries no watch of its own, and the page offered "Enable
  // Daily Watch" on an app already checked daily (checkmyapp.dev #294, seen on
  // the CHE-371 stand).
  const hasWatch = Boolean(run.watch?.active || viewerApp?.watch?.active);
  // CHE-108: a verdict link is public, and the owner's controls used to render
  // for whoever opened it — the server refused the click, which is a button
  // that does nothing, on our own page. Each control now appears only when the
  // server would honour it, computed with the same helpers the routes use
  // (rules in src/lib/viewer-capabilities.ts).
  const caps = viewerCapabilities({
    run: { ownerId: run.ownerId, hasWatch, ephemeral: run.ephemeral, targetKind: run.targetKind },
    viewer,
    viewerApp,
    canMutate: await canMutateOwned(prisma, run.ownerId),
  });
  // CHE-327: what this check was priced at, and why — only to the team whose
  // balance paid for it. A shared verdict link is public; the team's spending
  // is not.
  const priceExplanation =
    viewerTeam && run.teamId && viewerTeam.team.id === run.teamId
      ? await explainPrice(prisma, run, viewerTeam.team.plan as UserPlan)
      : null;
  // CHE-108: what a run cost us, which models produced it and which deploy it
  // ran against are OUR operating figures, and they belong to nobody outside
  // this business — not a stranger who opened a shared link, and not the
  // customer either. Owner rule, 2026-09-02: "зачем нашу кухню показывать
  // вообще кому либо кроме админам?" A customer paying $29 reading that their
  // check cost us $0.47 on opus is rule §1 in its purest form — our machinery,
  // arguing with their invoice on the next tab.
  const isAdmin = viewer?.role === "admin";
  // A replay-first smoke pass (CHE-51) finishes inside the "replay" phase and
  // never walks a journey — so the run's last event is a replay one. Any run
  // that fell through to the full check has later phases after it.
  const events = parseJson<RunEvent[]>(run.events) ?? [];
  const smokePass =
    run.journeys.length === 0 && events[events.length - 1]?.phase === "replay";
  // Carried journeys (CHE-57) name the run that actually walked them by id; the
  // chip shows its number. One query for the handful of distinct source runs —
  // a few at most, since each carried journey names the run that last walked it.
  const carriedRunIds = [
    ...new Set(run.journeys.map((j) => j.carriedFromRunId).filter((id): id is string => Boolean(id))),
  ];
  // CHE-240: the two numbers for each journey — what we judged by walking it,
  // and what the customer's own analytics counted. Read here, labelled here,
  // and never blended: a reader who cannot tell an estimate from a measurement
  // will act on the wrong one.
  const journeyNumbers = await numbersForJourneys(
    prisma,
    run.journeys.map((j) => ({ id: j.id, appJourneyId: j.appJourneyId, status: j.status })),
  );
  const carriedRuns = carriedRunIds.length
    ? await prisma.run.findMany({ ...publicRow(),
        where: { id: { in: carriedRunIds } },
        select: { id: true, runNumber: true, completedAt: true },
      })
    : [];
  const carriedRunNumbers = Object.fromEntries(carriedRuns.map((r) => [r.id, r.runNumber]));
  // CHE-331: a carried journey says WHEN it was last walked, not only by which
  // run — since every check now lists the app's known journeys, a carried card
  // can be days old, and its status pill is a statement about that day. UTC.
  const carriedRunDays = Object.fromEntries(
    carriedRuns
      .filter((r) => r.completedAt)
      .map((r) => [
        r.id,
        (r.completedAt as Date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      ]),
  );
  const newerRun = await prisma.run.findFirst({ ...publicRow(),
    where: { baselineRunId: run.id, status: { in: ["completed", "partial"] } },
    orderBy: { createdAt: "desc" },
    select: { publicId: true, runNumber: true, completedAt: true },
  });

  return (
    <>
      <TrackOnView
        event="verdict_viewed"
        props={{
          appSlug: run.appSlug,
          verdict: run.verdict ?? "none",
          isOwner: viewer !== null && viewer.id === run.ownerId,
        }}
      />
      {run.status === "partial" && (
        <p className="mb-4 rounded-lg border border-status-confusing/40 bg-status-confusing/10 px-4 py-2.5 text-sm text-status-confusing">
          {run.targetKind === "extension" ? "Some parts of this extension remain unverified. The results below show what was confirmed." : "The agent got partway through and paused — this is a partial verdict."}
        </p>
      )}
      {/* Owner decision, 2026-09-05: an anonymous verdict is public and listed.
          Say it on the page itself, and make signing in the way out of it. */}
      {run.ownerId === null && (
        <p className="mb-4 rounded-lg border border-ink-600 bg-ink-800/60 px-4 py-2.5 text-sm text-fg-muted">
          This check was run without an account, so this verdict is public and listed in{" "}
          <Link href="/checks/today" className="text-accent underline-offset-2 hover:underline">
            today&apos;s checks
          </Link>
          .{" "}
          <TrackedLink
            event="sign_in_clicked"
            props={{ from: "verdict" }}
            href="/sign-in"
            className="text-accent underline-offset-2 hover:underline"
          >
            Sign in
          </TrackedLink>{" "}
          before your next check to keep it unlisted.
        </p>
      )}
      {run.ephemeral && run.expiresAt && (
        <p className="mb-4 rounded-lg border border-ink-600 bg-ink-800/60 px-4 py-2.5 text-sm text-fg-muted">
          This is a check of a temporary preview. It is not listed anywhere and is removed on{" "}
          {run.expiresAt.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" })}.
        </p>
      )}
      {newerRun && (
        <p className="mb-4 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2.5 text-sm text-accent">
          A newer run of this app exists —{" "}
          <Link href={inApp ? inApp.checkHref(newerRun) : `/verdict/${newerRun.publicId}`} className="underline underline-offset-2">
            view the latest verdict
          </Link>
        </p>
      )}

      <div className="stagger space-y-6">
        <header className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="mono text-xl text-fg">{run.targetKind === "extension" ? extensionDisplayName(run.targetUrl, run.extensionEvidence) : run.appSlug}</h1>
              <p className="mt-1 font-mono text-xs text-fg-faint">
                Checked{" "}
                {run.completedAt?.toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }) ?? "—"}
                {duration && ` · ${duration}`} · Run #{run.runNumber}
                {/* CHE-108: what a run cost us, which models produced it and
                    which deploy it ran against are OUR machinery — rule §1, and
                    the worst of it is the model names arguing with $29 on the
                    next tab. The language gate only ever saw the verdict's text,
                    so the page chrome walked straight past it. Owner only. */}
                {isAdmin && run.costUsd != null && ` · $${run.costUsd.toFixed(2)}`}
                {isAdmin && run.deploySha &&
                  ` · deploy ${run.deploySha.slice(0, 7)}${run.deployEnv ? ` (${run.deployEnv})` : ""}`}
              </p>
              {priceExplanation && <CheckPrice explanation={priceExplanation} />}
              {isAdmin && totalTokens > 0 && (
                <p className="mt-0.5 font-mono text-xs text-fg-faint">
                  {fmtTok(totalTokens)} tokens
                  {byModel.map((m) => ` · ${m.model} $${m.costUsd.toFixed(2)}`).join("")}
                </p>
              )}
            </div>
            {(caps.recheck || caps.fullRecheck || caps.enableWatch || caps.watchSettings) && (
              <div className="flex flex-wrap items-center gap-2.5 sm:shrink-0">
                {caps.recheck && <RecheckButton runId={run.publicId} appSlug={run.appSlug} back={inApp?.back} />}
                {caps.fullRecheck && <FullRecheckButton runId={run.publicId} appSlug={run.appSlug} back={inApp?.back} />}
                {(caps.enableWatch || caps.watchSettings) && (
                  <EnableWatchButton
                    runId={run.publicId}
                    hasWatch={hasWatch}
                    appSlug={run.appSlug}
                    variant="outline"
                    back={inApp?.back}
                  />
                )}
              </div>
            )}
          </div>

          {recheckNotice && (
            <p className="rounded-md border border-ink-600 bg-ink-800/60 px-3 py-2 text-sm text-fg-muted">
              {recheckNotice}
              {/* CHE-327: an empty balance is never met without its two doors. */}
              {balanceRefused && (
                <>
                  {" "}
                  <Link href="/settings/billing" className="text-accent hover:underline">
                    Top up
                  </Link>{" "}
                  ·{" "}
                  <Link href="/pricing" className="text-accent hover:underline">
                    Upgrade
                  </Link>
                </>
              )}
            </p>
          )}

          {watchError && (
            <p className="rounded-md border border-status-broken/40 bg-status-broken/10 px-3 py-2 text-sm text-status-broken">
              Couldn&apos;t enable Daily Watch: {watchError}
            </p>
          )}

          {/* The verdict and its reason are ONE unit: pill first, and the
              bottom line hangs off it as the labeled explanation (same visual
              language as the journey "why" callout). An unlabeled grey
              paragraph floating above the pill read as "о чем это описание?"
              — owner, 2026-08-23. */}
          {(verdictMeta || run.bottomLine) && (
            <div>
              {verdictMeta && (
                <span
                  className={`inline-block rounded-full border px-3 py-1.5 font-mono text-sm font-medium ${verdictMeta.pillClassName}`}
                >
                  {verdictMeta.emoji} {verdictMeta.label}
                </span>
              )}
              {run.bottomLine && (
                <p
                  className={`mt-2.5 rounded-r-md border-l-2 bg-ink-800/40 py-2 pl-3 pr-3 text-sm ${verdictMeta?.textClassName ?? "text-fg-muted"}`}
                  style={{ borderColor: "color-mix(in srgb, currentColor 50%, transparent)" }}
                >
                  <span className="font-medium">Bottom line:</span>{" "}
                  <span className="text-fg-muted">{run.bottomLine}</span>
                </p>
              )}
              {run.targetKind === "extension" && run.verdict === "unverified" && viewerApp && (
                <Link href={`/health/apps/${viewerApp.id}/settings`} className="mt-3 inline-flex text-sm text-accent hover:underline">
                  Extension settings →
                </Link>
              )}
            </div>
          )}
        </header>

        <FindingsList
          findings={run.findings}
          canMark={caps.markFindings}
          canCreateTicket={caps.createTicket}
          finished={run.status === "completed" || run.status === "partial"}
          journeysFlagged={run.journeys.some((j) => FLAGGED_JOURNEY.has(j.status))}
        />
        <AppLensSection
          runId={run.publicId}
          appSlug={run.appSlug}
          lens={parseJson<AppLens>(run.appLens)}
          feedback={run.lensFeedback}
        />
        <JourneyStrips
          journeys={run.journeys}
          numbers={journeyNumbers}
          carriedRunNumbers={carriedRunNumbers}
          carriedRunDays={carriedRunDays}
          emptyNote={
            smokePass
              ? // The price explanation's own words for this kind of check
                // ("Quick check — nothing had changed"); "smoke check" was our
                // name for it, on a page the customer reads (CLAUDE.md §1).
                "Quick check — your known pages still load and nothing had changed, so the journeys were not walked " +
                "again and the previous verdict stands. The next full check walks them."
              : undefined
          }
        />
        <AppAnatomySection anatomy={normalizeAnatomy(parseJson<unknown>(run.anatomy))} />

        {(caps.enableWatch || caps.watchSettings) && (
          <footer className="card flex flex-wrap items-center justify-between gap-4 p-6">
            <div>
              <p className="font-medium text-fg">
                Want us to keep watching {run.appSlug}?
              </p>
              <p className="mt-0.5 text-sm text-fg-muted">
                Daily Watch — we re-run this every 24h, alert on regressions.
              </p>
            </div>
            <EnableWatchButton runId={run.publicId} hasWatch={hasWatch} appSlug={run.appSlug} back={inApp?.back} />
          </footer>
        )}

        {(generatedTests.length > 0 || run.transcriptUrl) && (
          <section className="card p-6">
            <h2 className="section-label">Run artifacts</h2>
            <p className="mt-1 text-sm text-fg-muted">
              The agent formalized this check as executable tests — take them into your own CI.
            </p>
            {/* Dozens of specs accumulate across runs; a flat list of them was
                the longest thing on the page (70+ rows on joblander.app by run
                #50) — collapsed by default, the count tells the story. */}
            {generatedTests.length > 0 && (
            <details className="mt-3">
              <summary className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-fg">
                <span className="chevron inline-block text-fg-faint">›</span>
                {generatedTests.length} Playwright spec{generatedTests.length === 1 ? "" : "s"}
              </summary>
            <ul className="mt-3 space-y-2">
              {generatedTests.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <span
                    className={`font-mono text-xs ${
                      t.lastRunStatus === "passed"
                        ? "text-status-ok"
                        : t.lastRunStatus === "failed"
                          ? "text-status-broken"
                          : "text-fg-faint"
                    }`}
                  >
                    {t.lastRunStatus === "passed" ? "✓" : t.lastRunStatus === "failed" ? "✕" : "—"}{" "}
                    {t.lastRunStatus.replace("_", " ")}
                  </span>
                  <a
                    href={`/api/tests/${t.id}`}
                    className="font-mono text-xs text-accent underline-offset-2 hover:underline"
                  >
                    {t.title} · v{t.version} (.spec.ts)
                  </a>
                  <span className="font-mono text-[10px] text-fg-faint">
                    sha256 {t.sha256.slice(0, 12)}…
                  </span>
                </li>
              ))}
            </ul>
            </details>
            )}
            {run.transcriptUrl && (
              <p className="mt-3 text-sm">
                <a
                  href={run.transcriptUrl}
                  className="font-mono text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  📋 agent transcript (audit log, .json)
                </a>
              </p>
            )}
            {generatedTests.length > 0 && caps.exportSpecs && (
              <ExportSpecs
                runId={run.publicId}
                connectedRepo={viewerApp?.repo?.repoFullName ?? null}
              />
            )}
          </section>
        )}

        <p className="text-center font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint">
          {/* CHE-108: "private" was false on every verdict — the route is not
              login-gated, anonymous verdicts are public by owner decision, and
              an owned one loads for anyone holding the link. Say which. */}
          run #{run.runNumber} · permalink · privacy:{" "}
          {run.ownerId ? "unlisted link" : "public"}
          {/* CHE-202: a preview run is deleted on this date, evidence included —
              say so where the permalink is described, since the link dies too. */}
          {run.ephemeral && run.expiresAt && (
            <>
              {" "}· ephemeral · expires{" "}
              {run.expiresAt.toLocaleDateString([], { month: "short", day: "numeric" })}
            </>
          )}
        </p>
      </div>
    </>
  );
}
