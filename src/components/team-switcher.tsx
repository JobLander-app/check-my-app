import { switchTeamAction } from "@/app/team/switch-actions";

// CHE-261 (Teams T8): the switcher.
//
// Invisible until it is needed. A person in exactly one team — which is
// everyone until somebody is invited — sees nothing at all, because a control
// offering one choice is furniture, not a feature.
export function TeamSwitcher({
  teams,
  activeTeamId,
}: {
  teams: { id: string; name: string; scope: string; isPersonal: boolean }[];
  activeTeamId: string;
}) {
  if (teams.length < 2) return null;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-fg-muted">Team</span>
      <div className="flex flex-wrap gap-1">
        {teams.map((t) =>
          t.id === activeTeamId ? (
            <span
              key={t.id}
              className="rounded border border-accent/40 bg-accent/10 px-2 py-1 text-xs"
              aria-current="true"
            >
              {t.name}
              {t.isPersonal && <span className="text-fg-muted"> · yours</span>}
              <span className="text-fg-muted"> · {t.scope}</span>
            </span>
          ) : (
            <form key={t.id} action={switchTeamAction.bind(null, t.id, undefined)}>
              <button type="submit" className="rounded border border-ink-600 px-2 py-1 text-xs hover:border-accent">
                {t.name}
                {t.isPersonal && <span className="text-fg-muted"> · yours</span>}
              </button>
            </form>
          ),
        )}
      </div>
    </div>
  );
}
