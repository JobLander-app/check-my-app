// An app's settings, one section per address (CHE-359, epic CHE-348):
// /health/apps/{appId}/settings/{section}. The list is the sub-navigation, the
// set of addresses that exist, and — for the four that have a form of fields —
// the sections the settings action accepts (src/app/dashboard/actions.ts).

export type SettingsSection = "scope" | "accounts" | "schedule" | "notifications" | "integrations" | "remove";

export const SETTINGS_SECTIONS: { key: SettingsSection; label: string; what: string }[] = [
  { key: "scope", label: "What we check", what: "What you care about, and where a check may not go." },
  { key: "accounts", label: "Test accounts", what: "How a check signs in to the signed-in half of your app." },
  { key: "schedule", label: "Schedule", what: "When the app is checked by itself." },
  { key: "notifications", label: "Who hears about it", what: "Who gets the verdict when a check finishes." },
  { key: "integrations", label: "Integrations", what: "Where problems go besides this page: your tracker, your analytics, your repository, your own tools." },
  { key: "remove", label: "Remove app", what: "Stop checking this app. Its past verdicts are kept." },
];

export function settingsSection(raw: string): SettingsSection | null {
  return SETTINGS_SECTIONS.find((s) => s.key === raw)?.key ?? null;
}

/**
 * The sections an app has. An extension is checked on request only, so it has
 * no schedule to set.
 */
export function sectionsFor(app: { targetKind: string }): typeof SETTINGS_SECTIONS {
  return app.targetKind === "extension" ? SETTINGS_SECTIONS.filter((s) => s.key !== "schedule") : SETTINGS_SECTIONS;
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
