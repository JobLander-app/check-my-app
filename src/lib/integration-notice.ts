// What happened when the owner pressed Connect (CHE-67, CHE-236).
//
// The Linear and PostHog flows bounce back with `?integration=<outcome>`. Every
// branch either route can take ends on one of these sentences, because a person
// who pressed Connect and was told nothing will press it again. Shared by the
// pages the flows return to (Today for Linear, Integrations for PostHog).
const NOTICES: Record<string, { text: string; ok: boolean }> = {
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
};

export function integrationNotice(outcome: string | undefined): { text: string; ok: boolean } | null {
  return outcome && Object.hasOwn(NOTICES, outcome) ? NOTICES[outcome] : null;
}
