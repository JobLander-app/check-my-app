import { switchTeamAction } from "@/app/team/switch-actions";
import { NavLink } from "@/components/shell/nav-link";
import { VERDICT_META } from "@/lib/status";
import { usd } from "@/lib/plans";
import type { ShellData } from "@/lib/shell-data";
import Link from "next/link";

// The sidebar of direction C (CHE-348, CHE-351), rendered on the server.
//
// Which lenses appear is decided by the caller from feature flags it read on
// the server; this component receives booleans and never a flag key, and the
// client half of the shell receives only the rendered result (CHE-381: the
// browser's flag client has no overrides, so a flag read there could disagree
// with the server).
//
// Group labels are sentence case at 12px. No tracked caps eyebrows: the owner
// rejected them as a fifth menu item in disguise (CHE-336).

type Team = { id: string; name: string; scope: string; isPersonal: boolean };

function initials(name: string): string {
  const words = name.replace(/@.*/, "").split(/[\s._+-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "·";
}

function TeamRow({ team, teams }: { team: { id: string; name: string }; teams: Team[] }) {
  const face = (
    <>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 font-mono text-[11px] font-semibold text-accent">
        {initials(team.name)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{team.name}</span>
    </>
  );
  const others = teams.filter((t) => t.id !== team.id);
  // One team: nothing to switch to, so nothing that looks like it opens.
  if (others.length === 0) return <div className="flex items-center gap-2.5 px-3 py-2">{face}</div>;
  return (
    <details className="group">
      <summary className="flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 hover:bg-ink-800">
        {face}
        <span className="chevron text-xs text-fg-faint">›</span>
      </summary>
      <div className="mt-1 space-y-0.5 pl-3">
        <p className="px-3 pt-1 text-xs text-fg-label">Switch to</p>
        {others.map((t) => (
          <form key={t.id} action={switchTeamAction.bind(null, t.id, "/home")}>
            <button
              type="submit"
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-ink-800 hover:text-fg"
            >
              <span className="truncate">{t.name}</span>
              <span className="shrink-0 text-xs text-fg-faint">{t.isPersonal ? "yours" : t.scope}</span>
            </button>
          </form>
        ))}
      </div>
    </details>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="px-3 pb-1 text-xs text-fg-label">{label}</p>
      {children}
    </div>
  );
}

export function Sidebar({
  team,
  teams,
  data,
  lenses,
  account,
}: {
  team: { id: string; name: string };
  teams: Team[];
  data: ShellData;
  lenses: { release: boolean; product: boolean };
  account: React.ReactNode;
}) {
  return (
    <nav className="flex min-h-full flex-col gap-5 px-2 pb-4 pt-3">
      <div className="space-y-2 pr-8 min-[900px]:pr-0">
        <TeamRow team={team} teams={teams} />
      </div>

      <div className="px-1">
        <Link
          href="/"
          className="flex w-full items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-accent-hover"
        >
          Run a check
        </Link>
      </div>

      <div className="space-y-0.5">
        <NavLink href="/home">Today</NavLink>
      </div>

      <Group label="Health">
        <NavLink href="/health/apps" exact>
          All apps
        </NavLink>
        {data.apps.map((app) => (
          <NavLink key={app.id} href={`/health/apps/${app.id}`} className="pl-6">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${app.verdict ? (VERDICT_META[app.verdict]?.dotClassName ?? "bg-ink-600") : "bg-ink-600"}`}
            />
            <span className="truncate font-mono text-xs">{app.label}</span>
          </NavLink>
        ))}
        <NavLink href="/health/issues">
          <span className="flex-1">Issues</span>
          {data.openIssues > 0 && (
            <span className="rounded-full bg-ink-700 px-1.5 font-mono text-[11px] text-fg-muted">
              {data.openIssues}
            </span>
          )}
        </NavLink>
        <NavLink href="/health/checks">Checks</NavLink>
        <NavLink href="/health/accuracy">Accuracy</NavLink>
      </Group>

      {lenses.release && (
        <Group label="Release β">
          <NavLink href="/release">Releases</NavLink>
        </Group>
      )}

      {lenses.product && (
        <Group label="Product β">
          <NavLink href="/product/journeys">Journeys</NavLink>
        </Group>
      )}

      <div className="mt-auto space-y-4">
        <div className="space-y-0.5">
          <NavLink href="/settings/api-keys">Agent and API keys</NavLink>
          <NavLink href="/settings/integrations">Integrations</NavLink>
          <NavLink href="/settings/team">Team</NavLink>
          <NavLink href="/settings/billing">Billing</NavLink>
          <NavLink href="/settings/account">Account</NavLink>
          <NavLink href="/guides">Guides</NavLink>
        </div>

        <Link
          href="/settings/billing"
          className="block rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 transition-colors hover:border-ink-600"
        >
          <span className="block text-xs text-fg-label">Your apps cost</span>
          <span className="block text-sm text-fg">
            <span className="font-mono">{usd(data.monthlyCostUsd)}</span> a month
          </span>
        </Link>

        {/* The account menu (sign out, profile). On phones it sits in the top
            bar instead, where it is reachable without opening the drawer. */}
        <div className="hidden items-center gap-2 px-3 min-[900px]:flex">{account}</div>
      </div>
    </nav>
  );
}
