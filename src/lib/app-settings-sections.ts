// An app's settings, one section per address (CHE-359, epic CHE-348):
// /health/apps/{appId}/settings/{section}. The list is the sub-navigation, the
// set of addresses that exist, and — for the three that have a form of fields —
// the sections the settings action accepts (src/app/dashboard/actions.ts).

import { trackerName } from "./tracker/name";

export type SettingsSection = "scope" | "accounts" | "schedule" | "notifications" | "integrations" | "remove";

export const SETTINGS_SECTIONS: { key: SettingsSection; label: string; what: string }[] = [
  { key: "scope", label: "What we check", what: "What you care about, and where a check may not go." },
  { key: "accounts", label: "Test accounts", what: "How a check signs in to the signed-in half of your app." },
  { key: "schedule", label: "Schedule", what: "When the app is checked by itself." },
  { key: "notifications", label: "Who hears about it", what: "Who gets the verdict when a check finishes." },
  { key: "integrations", label: "Integrations", what: "Where problems go besides this page — your tracker, your analytics, your own tools — and where a release's check comes from: your CI." },
  { key: "remove", label: "Remove app", what: "Stop checking this app. Its past verdicts are kept." },
];

export function settingsSection(raw: string): SettingsSection | null {
  return SETTINGS_SECTIONS.find((s) => s.key === raw)?.key ?? null;
}

// CHE-468 (owner, 2026-10-13): "for shopify apps test accounts are test
// stores". A Shopify app is checked inside a signed-in admin, so it has no test
// login; what it has is the dev stores it is checked on.
const SHOPIFY_ACCOUNTS = {
  key: "accounts" as const,
  label: "Test stores",
  what: "The stores this app is checked on, and the password of a store that shows a password page.",
};

/**
 * The sections an app has. An extension is checked on request only, so it has
 * no schedule to set; a Shopify app's accounts are its test stores.
 */
export function sectionsFor(app: { targetKind: string }): typeof SETTINGS_SECTIONS {
  if (app.targetKind === "extension") return SETTINGS_SECTIONS.filter((s) => s.key !== "schedule");
  if (app.targetKind === "session") return SETTINGS_SECTIONS.map((s) => (s.key === "accounts" ? SHOPIFY_ACCOUNTS : s));
  return SETTINGS_SECTIONS;
}

// The tracker's token, as the Integrations row says it (CHE-68/72): a
// connection made before the refresh flow has no refresh token, so its access
// token dies and only a reconnect heals it.
export type TrackerHealth = { tone: "ok" | "warn" | "bad"; text: string };

export function trackerHealth(tracker: { refreshTokenEnc: string | null; tokenExpiresAt: Date | null } | null, now: Date): TrackerHealth | null {
  if (!tracker) return null;
  if (tracker.refreshTokenEnc) return { tone: "ok", text: "connected · token renews by itself" };
  if (tracker.tokenExpiresAt && tracker.tokenExpiresAt <= now) return { tone: "bad", text: "token expired — reconnect to restore ticket filing" };
  if (tracker.tokenExpiresAt) {
    const on = tracker.tokenExpiresAt.toISOString().slice(0, 10);
    return { tone: "warn", text: `token expires on ${on} — reconnect so it renews by itself` };
  }
  return { tone: "warn", text: "reconnect so the token renews by itself" };
}

// The Issue tracker card's sentences (CHE-438). Linear and Jira share the
// card, so they share its words; pure, so scripts/verify-app-settings-sections.ts
// can run every one of them through the customer-language gate.

/** The card's first line: where this app's problems go right now — never a promise the rows below contradict. */
export function trackerSummary(
  tracker: { type: string; teamId: string | null } | null,
  health: TrackerHealth | null,
  blockers: string[],
  // CHE-469: the team has a tracker connected, which this app may simply use.
  teamConnected = false,
): string {
  if (!tracker && teamConnected) return "Problems stay on the check's page until this app picks where its tickets go below.";
  if (!tracker) return "Not connected — problems stay on the check's page instead of becoming tickets.";
  const name = trackerName(tracker.type);
  const where = tracker.type === "jira" ? "project" : "team";
  if (!tracker.teamId) return `Problems stay on the check's page until a ${where} is chosen below.`;
  if (health?.tone === "bad") return `Problems stay on the check's page until ${name} is reconnected.`;
  if (blockers.length > 0) return `Problems stay on the check's page until another ${where} is chosen below.`;
  return `Problems found on this app become tickets in ${name}.`;
}

/** A tracker's row when the team has not connected it; `connected` names the one this app files into. */
export function trackerIdleLine(name: string, connected: string | null): string {
  return connected
    ? `Not connected. Connecting ${name} connects it for your whole team and moves this app's tickets from ${connected} to ${name}.`
    : "Not connected. Connected once, it serves every app of your team; each app picks where its tickets go.";
}

// CHE-469: a tracker is connected once per team. An app of a team that has
// one connected is never asked to connect it again — only where its tickets go.

/** A tracker the team has connected that this app does not file into (yet). */
export function trackerTeamIdleLine(name: string, where: "team" | "project", connected: string | null): string {
  return connected
    ? `Connected for your team. Choosing a ${where} below moves this app's tickets from ${connected} to ${name}.`
    : `Connected for your team. Choose a ${where} below and this app's problems become tickets in ${name}.`;
}

/**
 * The team's connection as the tracker itself answered it just now (Codex on
 * #347): a grant revoked on the provider's side still has a refresh token
 * here, so the stored health reads ok while every call fails. A tracker that
 * gave no teams or projects for it gets this line and a Reconnect.
 */
export function trackerUnanswered(name: string): TrackerHealth {
  return { tone: "warn", text: `${name} gave nothing for this connection just now — reconnect if access was revoked` };
}

/** Under a team tracker's row: whose connection it is, and what ending it does. */
export const TEAM_TRACKER_LINE = "Your team's connection: every app of the team files with it, and disconnecting it stops all of them.";

// Atlassian consents as whoever is signed in to it already, without asking,
// and an account with no Jira site ends on Atlassian's own "Access denied"
// page, which never comes back here (the owner, 2026-10-13). Reconnect starts
// the same consent, so the line stands before both.
export function jiraAccountLine(connected: boolean): string {
  return `${connected ? "Reconnect" : "Connect"} uses the Atlassian account you're signed in to — it has to be one with your team's Jira.`;
}

export const JIRA_NO_PROJECT = "⚠ No project chosen yet — nothing is filed until one is.";

/** Required fields of the chosen project that a ticket of ours cannot fill. */
export function jiraBlockedLine(project: string, blockers: string[]): string {
  return `⚠ Tickets can't be filed in ${project}: it requires ${blockers.join(", ")}, which CheckMyApp can't fill. Choose another project.`;
}
