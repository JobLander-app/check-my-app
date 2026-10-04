// The Release lens's page (CHE-367): the words around a release. What a
// release is and what it broke or fixed is decided in src/lib/releases.ts; this
// module only says it.

import type { Audience, Release } from "@/lib/releases";

/** "4573391" — the first seven characters, as every code host shows a commit. */
export function shortSha(sha: string): string {
  return sha.trim().slice(0, 7);
}

/**
 * The commit on GitHub, when the app's repository is known and the sha is one.
 * A sha is whatever CI sent (CHE-56): only a hexadecimal one of a commit's
 * length is linked, and only to a repository named "owner/name" — never a
 * string pasted into an address.
 */
export function commitHref(repoFullName: string | null | undefined, sha: string): string | null {
  if (!repoFullName || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) return null;
  const s = sha.trim();
  return /^[0-9a-f]{7,40}$/i.test(s) ? `https://github.com/${repoFullName}/commit/${s}` : null;
}

/** The three envs the lens knows, capitalised; anything else as CI named it. */
export function envLabel(env: string): string {
  return env === "production" ? "Production" : env === "preview" ? "Preview" : env === "staging" ? "Staging" : env;
}

export type DeltaCounts = { broke: number; fixed: number; unchanged: number; notCompared: number };

export function deltaCounts(r: Pick<Release, "delta">): DeltaCounts {
  const d = r.delta;
  return { broke: d?.broke.length ?? 0, fixed: d?.fixed.length ?? 0, unchanged: d?.unchanged.length ?? 0, notCompared: d?.notCompared.length ?? 0 };
}

/**
 * The line under a release: "Broke 1, fixed 2, unchanged 3." against the
 * release before it of the same app and env.
 *   - no earlier release → "The first release we checked."
 *   - "not compared" is said when there is any: the other release did not look
 *     at that place, so neither "broke" nor "fixed" is known (CLAUDE.md §8).
 */
export function releaseDeltaLine(r: Pick<Release, "firstRelease" | "delta" | "previous">): string {
  if (r.firstRelease || !r.previous) return "The first release we checked.";
  const c = deltaCounts(r);
  const against = `against ${shortSha(r.previous.sha)}`;
  if (c.broke + c.fixed + c.unchanged + c.notCompared === 0) return `No problems before or after, ${against}.`;
  const rest = c.notCompared > 0 ? `, ${c.notCompared} not compared` : "";
  return `Broke ${c.broke}, fixed ${c.fixed}, unchanged ${c.unchanged}${rest} — ${against}.`;
}

/** Who would have hit a problem, when the walk recorded enough to say. */
export const AUDIENCE_LABEL: Record<Audience, string | null> = {
  existing_users: "signed-in users",
  new_visitors: "new visitors",
  unknown: null,
};

export const DELTA_GROUPS = [
  { key: "broke", label: "Broke", className: "text-status-broken" },
  { key: "fixed", label: "Fixed", className: "text-status-ok" },
  { key: "unchanged", label: "Unchanged", className: "text-fg-muted" },
  { key: "notCompared", label: "Not compared — the other release did not look there", className: "text-fg-faint" },
] as const;

export function releasesHref(appId?: string | null): string {
  return appId ? `/release?app=${encodeURIComponent(appId)}` : "/release";
}

/** The header's line. */
export function releasesLine(count: number, days: number): string {
  if (count === 0) return `No release was checked in the last ${days} days.`;
  return `${count} release${count === 1 ? "" : "s"} checked in the last ${days} days. Each is compared with the release before it of the same app and environment.`;
}
