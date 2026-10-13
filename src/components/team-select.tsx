"use client";

import { useState, useTransition } from "react";
import { setTrackerTeam } from "@/app/dashboard/actions";

// Dropdown to choose which Linear team an app's tickets land in, from the
// team's Linear connection (CHE-469).
export function TeamSelect({
  appId,
  teams,
  current,
}: {
  appId: string;
  teams: { id: string; name: string }[];
  current: string | null;
}) {
  const [value, setValue] = useState(current ?? "");
  const [pending, startTransition] = useTransition();

  return (
    <select
      value={value}
      disabled={pending}
      onChange={(e) => {
        const team = teams.find((t) => t.id === e.target.value);
        if (!team) return;
        setValue(team.id);
        startTransition(() => setTrackerTeam(appId, team.id, team.name));
      }}
      className="rounded border border-ink-700 bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-fg-muted outline-none"
    >
      {/* CHE-469: an app of a team with Linear connected may not file into it
          yet; without this the first team would show as chosen and could not
          be picked. */}
      {!current && (
        <option value="" disabled className="bg-ink-950">
          Choose a team
        </option>
      )}
      {teams.map((t) => (
        <option key={t.id} value={t.id} className="bg-ink-950">
          {t.name}
        </option>
      ))}
    </select>
  );
}
