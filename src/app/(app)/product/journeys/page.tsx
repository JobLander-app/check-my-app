import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { productLensFor } from "@/lib/viewer-flags";
import { STEP_STATUS_META } from "@/lib/status";
import { appPath } from "@/lib/app-shell";
import { shellData } from "@/lib/shell-data";
import { journeysOfApp } from "@/lib/journeys-load";
import { numbersForJourneys } from "@/lib/journey-numbers-load";
import { failingLine, journeysHref, journeysLine, lastWalkedLabel, NOT_WALKED, sortJourneys, walkCountLabel } from "@/lib/journeys-page";
import { Filmstrip } from "@/components/filmstrip";
import { JourneyNumbersBlock } from "@/components/journey-numbers-block";

// Product β → Journeys (CHE-362, phase 1): every journey of one app as the
// screens of the walk that last went through it — the step screenshots a
// verdict already holds, laid out journey by journey instead of check by check.
// Beside each strip, what we judged the journey costs its user and what their
// own analytics counted, in the verdict's words (CHE-240).
//
// Behind the lens-product flag, read here on the server; with the flag off the
// address does not exist (CHE-352).
export default async function JourneysPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const { app: appParam } = await searchParams;
  const { user, db, team } = await requireUser();
  if (!(await productLensFor(user))) notFound();

  const shell = await shellData(db, team.id);
  // An app that is not the team's is no choice at all: the first one stands in.
  const app = shell.apps.find((a) => a.id === appParam) ?? shell.apps[0] ?? null;

  if (!app) {
    return (
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-10">
        <header>
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Journeys</h1>
        </header>
        <section className="card p-6 text-sm text-fg-muted">
          <p>The journeys of an app appear here after its first full check.</p>
          <Link href="/health/apps" className="mt-3 inline-block text-accent hover:underline">
            All apps →
          </Link>
        </section>
      </main>
    );
  }

  const now = new Date();
  const journeys = sortJourneys(await journeysOfApp(db, team.id, app.id));
  const walked = journeys.filter((j) => j.walk);
  const numbers = await numbersForJourneys(
    db,
    walked.map((j) => ({ id: j.walk!.journeyId, appJourneyId: j.id, status: j.walk!.status })),
  );

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-10">
      <header>
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Journeys</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-fg-muted">{journeysLine(app.label, journeys.length, walked.length)}</p>
      </header>

      {shell.apps.length > 1 && (
        <nav aria-label="Which app" className="flex flex-wrap gap-1.5">
          {shell.apps.map((a) => (
            <Link
              key={a.id}
              href={journeysHref(a.id)}
              aria-current={a.id === app.id ? "true" : undefined}
              className={`inline-flex h-7 items-center rounded-full border px-3 font-mono text-xs ${
                a.id === app.id ? "border-ink-600 bg-ink-800 text-fg" : "border-ink-700 text-fg-muted hover:text-fg"
              }`}
            >
              {a.label}
            </Link>
          ))}
        </nav>
      )}

      {journeys.map((j) => {
        const meta = j.walk ? STEP_STATUS_META[j.walk.status] ?? STEP_STATUS_META.skipped : null;
        const failing = failingLine(j.failingWalks, j.failingSince, now);
        const count = walkCountLabel(j.walkCount);
        const journeyNumbers = j.walk ? numbers[j.walk.journeyId] : undefined;
        return (
          <article key={j.id} className="card flex flex-col gap-3 px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <h2 className="min-w-0 text-[15px] font-medium text-fg">{j.title}</h2>
              {meta ? (
                <span
                  className={`inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 font-mono text-xs ${meta.className}`}
                  style={{
                    borderColor: "color-mix(in srgb, currentColor 30%, transparent)",
                    backgroundColor: "color-mix(in srgb, currentColor 10%, transparent)",
                  }}
                >
                  {meta.emoji} {meta.label}
                </span>
              ) : (
                <span className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full border border-ink-600 px-2.5 font-mono text-xs text-fg-faint">
                  {NOT_WALKED}
                </span>
              )}
            </div>

            {j.walk && (
              <>
                <p className="text-[13px] text-fg-muted">
                  {lastWalkedLabel(j.walk.at, now)} in check{" "}
                  <Link href={appPath.check(app.id, j.walk.runNumber)} className="font-mono text-accent hover:underline">
                    #{j.walk.runNumber}
                  </Link>
                  {count && <> · {count}</>}
                  {failing && <span className="text-status-broken"> · {failing}</span>}
                </p>
                {j.walk.frames.length > 0 && <Filmstrip frames={j.walk.frames} />}
                {j.walk.summary && <p className="text-sm text-fg-muted">{j.walk.summary}</p>}
                {journeyNumbers && <JourneyNumbersBlock {...journeyNumbers} title={j.title} />}
              </>
            )}
          </article>
        );
      })}
    </main>
  );
}
