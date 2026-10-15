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
