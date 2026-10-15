// How a tracker is named to a person (CHE-438). Pure, so the pages and modules
// that only need the name do not pull in the trackers themselves.

/** "Linear" or "Jira", from TrackerIntegration.type. */
export function trackerName(type: string | null | undefined): string {
  return type === "jira" ? "Jira" : "Linear";
}
