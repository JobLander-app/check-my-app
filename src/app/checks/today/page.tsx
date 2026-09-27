import Link from "next/link";
import { getDbFromContext } from "@/lib/db";
import { relativeTime, todayChecks } from "@/lib/checks-today";
import { effectiveSiteCap } from "@/lib/site-cap";
import { VERDICT_META, isTerminal } from "@/lib/status";
import { pageMetadata } from "@/lib/site-metadata";
import { TrackOnView } from "@/components/track";

// The cap in the description is the effective one (runtime env), so the
// number a search result shows is the number the page enforces.
export async function generateMetadata() {
  return pageMetadata({
    title: "Today's checks",
    description: `Every anonymous check is public. The site runs ${effectiveSiteCap()} free checks a day — read today's verdicts, or run your own.`,
    path: "/checks/today",
  });
}

// Today's checks · /checks/today (owner decision 2026-09-05). The public face
// of the site-wide daily cap: when the free checks are gone, a visitor can read
// what the day produced instead of leaving with nothing. Read from D1 on every
// request — the list changes by the minute and the counter must be true.
export const dynamic = "force-dynamic";

export default async function TodayChecksPage() {
  const db = await getDbFromContext();
  const now = new Date();
  const today = await todayChecks(db, now, effectiveSiteCap());

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <TrackOnView event="today_checks_viewed" />
      <div className="stagger space-y-10">
        <div className="space-y-3">
          <p className="section-label">today · {today.used} of {today.cap} free checks used</p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight">
            Today&apos;s <span className="text-accent">checks</span>.
          </h1>
          <p className="max-w-xl text-sm text-fg-muted">
            Anonymous checks are public. The site runs {today.cap} free checks a day (
            {today.used} used, resets at midnight UTC).
          </p>
        </div>

        {today.runs.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-fg-muted">No checks yet today — yours could be the first.</p>
            <Link
              href="/"
              className="mt-3 inline-block font-mono text-[13px] text-accent transition-colors hover:underline"
            >
              Check your app →
            </Link>
          </div>
        ) : (
          <ul className="card divide-y divide-ink-700 overflow-hidden">
            {today.runs.map((run) => {
              const inFlight = !isTerminal(run.status);
              const meta = run.verdict ? VERDICT_META[run.verdict] : null;
              const href = inFlight ? `/run/${run.publicId}` : `/verdict/${run.publicId}`;
              return (
                <li key={run.publicId} className="px-4 py-3 transition-colors hover:bg-ink-800/50">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={href} className="font-mono text-sm text-fg hover:underline">
                      {run.appSlug}
                    </Link>
                    {inFlight ? (
                      <span className="rounded-full border border-ink-600 bg-ink-800 px-2 py-0.5 font-mono text-xs text-fg-faint">
                        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse-dot rounded-full bg-accent" />
                        in progress
                      </span>
                    ) : meta ? (
                      <span
                        className={`rounded-full border px-2 py-0.5 font-mono text-xs ${meta.pillClassName}`}
                      >
                        {meta.label}
                      </span>
                    ) : null}
                    <span className="ml-auto font-mono text-xs text-fg-faint">
                      {relativeTime(run.createdAt, now)}
                    </span>
                  </div>
                  {run.bottomLine && (
                    <p className="mt-1.5 text-sm leading-6 text-fg-muted">{run.bottomLine}</p>
                  )}
                  <Link
                    href={href}
                    className="mt-1.5 inline-block font-mono text-[13px] text-accent transition-colors hover:underline"
                  >
                    {inFlight ? "Watch it run →" : "See the verdict →"}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        <p className="font-mono text-[13px] text-fg-faint">
          <Link href="/" className="text-accent hover:underline">
            Check your app →
          </Link>{" "}
          · {today.left > 0 ? `${today.left} free ${today.left === 1 ? "check" : "checks"} left today.` : "free checks open again at midnight UTC."}
        </p>
      </div>
    </main>
  );
}
