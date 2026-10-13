// Every sentence that offers or describes the issue tracker outside its own
// card (CHE-438). An app files into Linear or Jira, so a sentence that names
// one names the other, and it says only what the code does. Pure, so
// scripts/verify-tracker-copy.ts runs each one through the customer-language
// gate (R18). The card's own sentences are src/lib/app-settings-sections.ts's.

/**
 * The app page's offer to connect one. Only a check a watch scheduled files
 * tickets and re-verifies a closed one by itself (src/agent/autofile.ts and
 * reconcile.ts return early without a watch); any check's problem can be sent
 * by hand with Create Ticket.
 */
export function trackerOffer(scheduled: boolean): string {
  return scheduled
    ? "Connect Linear or Jira and each problem a scheduled check finds becomes one ticket. Close it, and the next scheduled check confirms the fix."
    : "Connect Linear or Jira and send any problem from a check's page to it as a ticket.";
}

/**
 * The app page's card when the team has already connected a tracker (CHE-469):
 * no second connect, only where this app's tickets go. `names` are the team's
 * trackers, in the card's order.
 */
export function teamTrackerOffer(names: string[]): { text: string; action: string } {
  if (names.length === 1) {
    const where = names[0] === "Jira" ? "project" : "team";
    return { text: `Your team's ${names[0]} is connected. Choose the ${where} this app's problems go to.`, action: `Choose a ${where}` };
  }
  return { text: `Your team's ${names.join(" and ")} are connected. Choose where this app's problems go.`, action: "Choose where" };
}

// The team's trackers on Team integrations (CHE-469): connected once, used by
// every app that picks where its tickets go, ended for all of them at once.
export const TEAM_TRACKERS_NONE =
  "No issue tracker connected. Connect Linear or Jira from any app's Integrations — once, for the whole team; every other app then only picks where its tickets go.";

export function teamTrackerApps(apps: string[]): string {
  if (apps.length === 0) return "No app files into it yet — each app picks its team or project on its Integrations.";
  return `${apps.length === 1 ? "1 app files" : `${apps.length} apps file`} into it: ${apps.join(", ")}.`;
}

export const TEAM_TRACKER_DISCONNECT = "Disconnecting is for the whole team: every app that files into it stops filing tickets.";

/** "Which trackers are supported?" — from the plans' own limits, so it cannot go stale. */
export function trackerFaqAnswer(limits: Record<string, { trackerIntegration: boolean }>): string {
  const plans = Object.keys(limits);
  const withIt = plans.filter((p) => limits[p].trackerIntegration);
  const where =
    withIt.length === plans.length
      ? "on every plan"
      : withIt.length === plans.length - 1 && limits.free && !limits.free.trackerIntegration
        ? "on every paid plan"
        : `on ${withIt.map((p) => p[0].toUpperCase() + p.slice(1)).join(", ")}`;
  return `Linear or Jira, ${where}.`;
}

export const TRACKER_GUIDE_LINE =
  "Every result also stays in your dashboard. From the app's settings, new regressions can become tickets in Linear or Jira, and results can go to email, Slack or your own webhook.";

export const ONBOARDING_TRACKER_STEP =
  "After you save, connect Linear or Jira in the app's Integrations settings — we'll file tickets into the team or project you choose. The ticket parameters below take effect once that connection is live; set them now so every ticket arrives with the labels your team picks tickets up by.";

// Priority 1 on a ticket: Linear calls it Urgent, Jira Highest (src/lib/tracker/jira.ts PRIORITY_NAMES).
export const ONBOARDING_URGENT_LABEL = "Critical journeys → top priority: Urgent in Linear, Highest in Jira (comma-separated)";
