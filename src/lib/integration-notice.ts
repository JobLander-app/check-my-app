// What happened when the owner pressed Connect (CHE-67, CHE-236).
//
// The Linear and PostHog flows bounce back with `?integration=<outcome>`. Every
// branch either route can take ends on one of these sentences, because a person
// who pressed Connect and was told nothing will press it again. Shared by the
// pages the flows return to (the app's Integrations section for Linear, Today
// when the app is not known yet, Integrations for PostHog).
const NOTICES: Record<string, { text: string; ok: boolean }> = {
  linear_connected: { text: "Linear is connected — problems found on this app go to its board.", ok: true },
  linear_unconfigured: { text: "Linear isn't connected yet — the integration is being set up.", ok: false },
  linear_failed: { text: "Couldn't connect Linear — please try again.", ok: false },
  posthog_connected: { text: "PostHog is connected — we can read your funnels, and only read them.", ok: true },
  posthog_declined: { text: "PostHog wasn't connected — the request was declined on PostHog's screen.", ok: false },
  posthog_unavailable: { text: "PostHog couldn't be reached just now — please try again in a minute.", ok: false },
  posthog_scopes: {
    text: "PostHog changed what it offers — we've stopped rather than ask for the wrong access.",
    ok: false,
  },
  posthog_unreadable: {
    text: "PostHog connected but returned no readable account — nothing was saved. Please try again.",
    ok: false,
  },
  posthog_failed: { text: "Couldn't connect PostHog — please try again.", ok: false },
  // CHE-369: the GitHub App.
  github_installed: { text: "The GitHub App is installed — choose which app each repository deploys, and every successful deploy is checked.", ok: true },
  github_unconfigured: { text: "The GitHub App isn't available yet — it is being set up.", ok: false },
  github_start_here: { text: "The GitHub App was installed from GitHub's side, so it isn't connected to a team yet — press Install here, and GitHub will bring you back connected.", ok: false },
  github_failed: { text: "Couldn't connect the GitHub App — please try again.", ok: false },
  github_mapped: { text: "Saved — each repository's row says what its deploys now do.", ok: true },
};

export function integrationNotice(outcome: string | undefined): { text: string; ok: boolean } | null {
  return outcome && Object.hasOwn(NOTICES, outcome) ? NOTICES[outcome] : null;
}
