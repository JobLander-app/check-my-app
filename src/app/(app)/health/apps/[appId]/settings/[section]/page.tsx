import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { VERDICT_META } from "@/lib/status";
import { WatchSettings } from "@/components/watch-settings";
import { teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";

export const dynamic = "force-dynamic";

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

// The app's settings, one section per address (CHE-348). CHE-359 splits the
// settings page into these; until then every section but Schedule is the one
// settings page, and Schedule is what /watch/[slug] was — that address now
// lands here.
const SECTIONS = ["scope", "accounts", "schedule", "notifications", "integrations", "remove"];

export default async function AppSettingsSection({
  params,
}: {
  params: Promise<{ appId: string; section: string }>;
}) {
  const { appId, section } = await params;
  if (!SECTIONS.includes(section)) notFound();
  if (section !== "schedule") redirect(appPath.settings(appId));

  const { db, team } = await requireUser();
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId },
    include: { watch: { include: { runs: { orderBy: { startedAt: "desc" }, take: 10 } } } },
  });
  // Another team of yours, or nobody's: the settings page says which (CHE-261).
  if (!app) redirect(appPath.settings(appId));
  const watch = app.watch;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="stagger space-y-6">
        <header>
          <Link href={appPath.settings(app.id)} className="text-xs text-fg-faint hover:underline">
            ← {app.appSlug} settings
          </Link>
          <h1 className="mt-3 text-xl font-semibold tracking-tight">
            Schedule — <span className="mono text-lg">{app.appSlug}</span>
          </h1>
          {watch && (
            <p className="mt-1.5 font-mono text-xs text-fg-faint">
              <span className={watch.active ? "text-status-ok" : "text-fg-faint"}>
                {watch.active ? "● Active" : "○ Paused"}
              </span>
              {" · "}Last checked{" "}
              {watch.lastRunAt?.toLocaleString([], DATE_FMT) ?? "never"}
              {" · "}Next {watch.nextRunAt?.toLocaleString([], DATE_FMT) ?? "—"}
            </p>
          )}
        </header>

        {!watch ? (
          <p className="card p-6 text-sm text-fg-muted">
            This app is not checked on a schedule. Choose a frequency on{" "}
            <Link href={appPath.settings(app.id)} className="text-accent hover:underline">
              its settings
            </Link>
            .
          </p>
        ) : (
          <>
            <section>
              <h2 className="mb-2.5 text-sm font-medium text-fg">Recent scheduled checks</h2>
              <ul className="card divide-y divide-ink-700 overflow-hidden">
                {watch.runs.map((run) => {
                  const meta = run.verdict ? VERDICT_META[run.verdict] : null;
                  return (
                    <li
                      key={run.id}
                      className="flex items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-ink-800/50"
                    >
                      <span className="w-16 shrink-0 font-mono text-xs text-fg-faint">
                        {run.startedAt.toLocaleDateString([], { month: "short", day: "numeric" })}
                      </span>
                      <span className="flex-1">
                        {meta ? (
                          <span className={`font-mono text-xs ${meta.textClassName}`}>
                            {meta.emoji} {meta.label}
                          </span>
                        ) : (
                          <span className="font-mono text-xs text-fg-faint">{run.status}</span>
                        )}
                      </span>
                      <Link
                        href={`/verdict/${run.publicId}`}
                        className="font-mono text-xs text-accent underline-offset-2 hover:underline"
                      >
                        view verdict
                      </Link>
                    </li>
                  );
                })}
                {watch.runs.length === 0 && (
                  <li className="px-4 py-3 text-sm text-fg-faint">No runs yet.</li>
                )}
              </ul>
            </section>

            <WatchSettings
              slug={watch.appSlug}
              initial={{
                frequency: watch.frequency as "daily" | "every_6h" | "manual",
                notifyOnChangeOnly: watch.notifyOnChangeOnly,
                active: watch.active,
              }}
            />
          </>
        )}
      </div>
    </main>
  );
}
