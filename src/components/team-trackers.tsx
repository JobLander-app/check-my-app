// The team's issue trackers, as the team sees them (CHE-469).
//
// A tracker is connected once per team: from any app's Integrations, where
// the first consent happens. Here it is listed with the apps that file into
// it, and disconnected — for all of them at once, which the card says before
// the button does it. Disconnect is a form, because it changes something of
// ours; there is no Connect here, since connecting needs an app to file from.

import { Button } from "@/components/ui/button";
import { disconnectTracker } from "@/app/dashboard/actions";
import type { TrackerHealth } from "@/lib/app-settings-sections";
import { TEAM_TRACKER_DISCONNECT, TEAM_TRACKERS_NONE, teamTrackerApps, teamTrackerWaiting } from "@/lib/tracker-copy";

export interface TeamTrackersProps {
  trackers: { kind: "linear" | "jira"; name: string; health: TrackerHealth | null; apps: string[]; waiting: string[] }[];
  canDisconnect: boolean;
}

export function TeamTrackers({ trackers, canDisconnect }: TeamTrackersProps) {
  return (
    <section className="card mt-6 p-5">
      <p className="section-label">issue trackers</p>
      {trackers.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">{TEAM_TRACKERS_NONE}</p>
      ) : (
        <ul className="mt-2 divide-y divide-ink-700">
          {trackers.map((t) => (
            <li key={t.kind} className="flex flex-wrap items-start justify-between gap-4 py-3">
              <div className="min-w-0 space-y-1">
                <p className="text-sm text-fg">
                  <span className={t.health?.tone === "ok" ? "text-status-ok" : "text-status-confusing"}>{t.health?.tone === "ok" ? "✓" : "!"}</span>{" "}
                  <span className="font-medium">{t.name}</span>
                  {t.health && <span className="text-fg-muted"> · {t.health.text}</span>}
                </p>
                <p className="text-xs text-fg-faint">{teamTrackerApps(t.apps)}</p>
                {t.waiting.length > 0 && (
                  <p className="text-xs text-status-confusing">{teamTrackerWaiting(t.waiting, t.kind === "jira" ? "project" : "team")}</p>
                )}
                {canDisconnect && <p className="text-xs text-fg-faint">{TEAM_TRACKER_DISCONNECT}</p>}
              </div>
              {canDisconnect && (
                <form action={disconnectTracker.bind(null, t.kind)}>
                  <Button type="submit" variant="outline" className="px-3 py-1.5 text-xs">
                    Disconnect {t.name}
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
