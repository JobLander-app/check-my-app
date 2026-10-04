import Link from "next/link";
import { switchTeamAction } from "@/app/team/switch-actions";
import { extensionDisplayName } from "@/lib/extension-target";
import { Button } from "@/components/ui/button";

// An app of another team of yours, opened while acting as a different team
// (CHE-261; a page of its own since CHE-412). It is an ordinary page of the
// app: the breadcrumb back to All apps, the app's name as the title, and one
// card in the work area that says whose it is and offers the switch — never a
// silent switch (a page that changes which team you are acting as, because
// of a link you followed, is how a check gets started against the wrong
// budget), and never a 404 of a row this person is entitled to see. `to` is
// where the switch lands: the page that was asked for, in the right team.
export function OtherTeamApp({
  app,
  acting,
  to,
}: {
  app: { appSlug: string; targetUrl: string; targetKind: string; teamId: string; team: { name: string } | null };
  acting: string;
  to: string;
}) {
  const name = app.targetKind === "extension" ? extensionDisplayName(app.targetUrl) : app.appSlug;
  const team = app.team?.name ?? "another team of yours";
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-2.5">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-[13px] text-fg-muted">
          <Link href="/health/apps" className="hover:text-fg">
            Health
          </Link>
          <span aria-hidden className="text-fg-faint">/</span>
          <Link href="/health/apps" className="hover:text-fg">
            All apps
          </Link>
        </nav>
        <h1 className="break-words font-mono text-[30px] font-semibold leading-tight tracking-tight">{name}</h1>
        <p className="break-all text-sm text-fg-muted">{app.targetUrl}</p>
      </div>
      <section className="card mx-auto w-full max-w-xl p-6">
        <h2 className="text-lg font-semibold">
          {name} belongs to {team}
        </h2>
        <p className="mt-2 text-sm text-fg-muted">
          You are on that team, but you are currently acting as {acting}. Switching changes which team&apos;s plan pays
          for anything you start.
        </p>
        <form action={switchTeamAction.bind(null, app.teamId, to)}>
          <Button type="submit" className="mt-6">
            Switch to {team}
          </Button>
        </form>
      </section>
    </main>
  );
}
