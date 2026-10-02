import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";
import { extensionDisplayName } from "@/lib/extension-target";
import { sectionsFor } from "@/lib/app-settings-sections";
import { SettingsNav } from "@/components/app-settings/settings-nav";
import { RunSavedApp } from "@/components/run-saved-app";

// The frame of an app's settings (CHE-359): whose settings these are, and the
// sections. Each section is a page of its own under it.
export default async function AppSettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  const { db, team } = await requireUser();
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId },
    select: {
      id: true, appSlug: true, targetUrl: true, targetKind: true,
      runs: { orderBy: { createdAt: "desc" }, take: 1, select: { extensionEvidence: true } },
    },
  });
  // Not in the team you are acting as: the page under this frame says which
  // team it belongs to and offers the switch (CHE-261) — no frame around that.
  if (!app) return <>{children}</>;
  const isExtension = app.targetKind === "extension";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-4">
        <div>
          <Link href={appPath.page(app.id)} className="text-xs text-fg-faint hover:underline">
            ← {isExtension ? extensionDisplayName(app.targetUrl, app.runs[0]?.extensionEvidence) : app.appSlug}
          </Link>
          <p className="section-label mt-3">{isExtension ? "extension settings" : "app settings"}</p>
          <h1 className="text-3xl font-semibold tracking-tight">{isExtension ? extensionDisplayName(app.targetUrl, app.runs[0]?.extensionEvidence) : app.appSlug}</h1>
          <p className="break-all text-sm text-fg-muted">{app.targetUrl}</p>
          {isExtension && (
            <div className="mt-4">
              <RunSavedApp appId={app.id} />
            </div>
          )}
        </div>
        <SettingsNav base={appPath.settings(app.id)} sections={sectionsFor(app).map((s) => ({ key: s.key, label: s.label }))} />
      </header>
      {children}
    </main>
  );
}
