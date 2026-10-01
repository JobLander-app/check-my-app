import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { teamOwned } from "@/lib/tenant-db";
import { VERDICT_META } from "@/lib/status";
import { usd } from "@/lib/plans";
import { extensionDisplayName } from "@/lib/extension-target";
import { appPath } from "@/lib/app-shell";

// One app (CHE-351 shell): its latest checks, newest first, and the way to its
// settings. The status sentence, cost, timeline and tabs are CHE-358.
export default async function AppPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  const { db, team } = await requireUser();
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId },
    select: { id: true, appSlug: true, targetUrl: true, targetKind: true },
  });
  // Not in the team you are acting as. The settings page answers that case —
  // it offers the switch when the app is in another team of yours, and 404s
  // otherwise (CHE-261) — so it is said in one place.
  if (!app) redirect(appPath.settings(appId));

  const runs = await db.run.findMany({
    where: { ...teamOwned(team.id), appId: app.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { publicId: true, runNumber: true, status: true, verdict: true, createdAt: true, priceUsd: true },
  });
  const name = app.targetKind === "extension" ? extensionDisplayName(app.targetUrl) : app.appSlug;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-all font-mono text-2xl font-semibold tracking-tight">{name}</h1>
          <p className="break-all text-sm text-fg-muted">{app.targetUrl}</p>
        </div>
        <Link href={appPath.settings(app.id)} className="text-sm text-accent hover:underline">
          Settings →
        </Link>
      </div>

      <h2 className="mb-2 text-sm font-medium text-fg">Checks</h2>
      {runs.length === 0 ? (
        <p className="card p-6 text-sm text-fg-muted">No checks yet.</p>
      ) : (
        <ul className="card divide-y divide-ink-700">
          {runs.map((run) => {
            const meta = run.verdict ? VERDICT_META[run.verdict] : null;
            const done = run.status === "completed" || run.status === "partial";
            return (
              <li key={run.publicId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <span className="w-28 shrink-0 font-mono text-xs text-fg-faint">
                  {run.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
                <span className={`min-w-0 flex-1 text-xs ${meta?.textClassName ?? "text-fg-faint"}`}>
                  {meta ? `${meta.emoji} ${meta.label}` : run.status}
                </span>
                {run.priceUsd !== null && <span className="font-mono text-xs text-fg-muted">{usd(run.priceUsd)}</span>}
                <Link
                  href={`/${done ? "verdict" : "run"}/${run.publicId}`}
                  className="font-mono text-xs text-accent hover:underline"
                >
                  Run #{run.runNumber} →
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
