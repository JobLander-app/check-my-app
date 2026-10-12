"use client";

import { useState, useTransition } from "react";
import { setJiraProject } from "@/app/dashboard/actions";

// Which Jira project an app's tickets land in (CHE-438), across every site the
// grant reaches. The same shape as TeamSelect for Linear.
export function JiraProjectSelect({
  appId,
  choices,
  current,
}: {
  appId: string;
  choices: { value: string; label: string }[];
  current: string | null;
}) {
  const [value, setValue] = useState(current ?? "");
  const [pending, startTransition] = useTransition();

  return (
    <select
      value={value}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value;
        if (!choices.some((c) => c.value === next)) return;
        setValue(next);
        startTransition(() => setJiraProject(appId, next));
      }}
      className="max-w-full rounded border border-ink-700 bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-fg-muted outline-none"
    >
      {choices.map((c) => (
        <option key={c.value} value={c.value} className="bg-ink-950">
          {c.label}
        </option>
      ))}
    </select>
  );
}
