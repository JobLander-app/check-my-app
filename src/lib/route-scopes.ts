// CHE-255 (Teams T2): every route and server action says who may call it, in
// one place, and a new one that says nothing does not ship.
//
// Before this, five different spellings of "may this person do this" were in
// use across 24 route handlers — requireUser, getOptionalUser,
// getOwnerFromRequest, canMutateOwned, and nothing at all — and one of them
// lives in a library rather than in the handler (`/api/runs/[id]/recheck`
// decides in src/lib/recheck.ts), which is how it ended up refusing the owner's
// own API key (CHE-246). Five spellings are five places to forget.
//
// The registry does not replace those decisions. It makes them declared: a
// route is either a team action (from src/lib/scopes.ts), public, or decided by
// the capability of the row itself. scripts/verify-route-scopes.ts walks the
// filesystem and fails the build when a route or server action is missing from
// this file — or when this file names one that no longer exists, because a
// stale allow is as dangerous as a missing rule and much harder to notice.

import type { TeamAction } from "./scopes";

export type RouteRule =
  // Decided by the caller's scope in their team (src/lib/scopes.ts).
  | { kind: "team"; action: TeamAction }
  // Deliberately open. `why` is a closed list: "nobody wrote a rule" and "the
  // rule is: anyone" must never look the same in a registry.
  | { kind: "public"; why: PublicReason }
  // The row's own capability decides, not the caller's scope: an anonymous run
  // is mutable by whoever holds its unguessable id, an owned one only by its
  // owner (CHE-33). `decidedIn` names the file that holds the rule, so the
  // answer is one grep away rather than one guess.
  | { kind: "row"; decidedIn: string }
  // Open to strangers AND used by people who are signed in — the public funnel.
  // A stranger is welcome; a signed-in caller is judged by `action`, using
  // their own scope. This kind exists because its absence was a real leak
  // (CHE-265): `POST /api/checks` was registered `public`, `public` means
  // "anyone", and a reader-scope API key started a check in production. A route
  // that serves both kinds of caller needs both answers, or the looser one wins
  // for everybody.
  | { kind: "funnel"; action: TeamAction; why: PublicReason };

export type PublicReason =
  | "the anonymous funnel — a stranger's first check"
  | "addressed by an unguessable id"
  | "signature-verified webhook"
  // Not a signature: the sender echoes a shared secret we gave it (Telegram's
  // X-Telegram-Bot-Api-Secret-Token). Said apart so nobody reads it as stronger.
  | "secret-token-verified webhook"
  | "public by design — today's checks are readable by anyone"
  // CHE-414: the theme switch. It writes one cookie in the caller's own
  // browser and nothing of ours, and a signed-out visitor on the public site
  // may choose too.
  | "a preference kept in the caller's own browser — writes nothing of ours";

// Keyed "METHOD /path" with Next's own bracket segments, so an entry can be
// compared with the filesystem rather than with somebody's memory.
export const ROUTE_RULES: Record<string, RouteRule> = {
  // Billing: the subscription belongs to the team, and only an admin may buy,
  // change or cancel one.
  "POST /api/billing/checkout": { kind: "team", action: "billing.manage" },
  "POST /api/billing/portal": { kind: "team", action: "billing.manage" },
  "POST /api/billing/topup": { kind: "team", action: "billing.manage" },
  "POST /api/billing/one-check": { kind: "public", why: "the anonymous funnel — a stranger's first check" },
  "GET /api/billing/one-check": { kind: "public", why: "the anonymous funnel — a stranger's first check" },

  // The public funnel and the pages anyone may read.
  "POST /api/checks": {
    kind: "funnel",
    action: "run.start",
    why: "the anonymous funnel — a stranger's first check",
  },
  "GET /api/checks/lookup": { kind: "public", why: "addressed by an unguessable id" },
  "GET /api/checks/today": { kind: "public", why: "public by design — today's checks are readable by anyone" },
  "GET /api/evidence/[...path]": { kind: "public", why: "addressed by an unguessable id" },
  "GET /api/runs/[id]": { kind: "public", why: "addressed by an unguessable id" },
  "GET /api/runs/[id]/verdict": { kind: "public", why: "addressed by an unguessable id" },
  "GET /api/runs/[id]/stream": { kind: "public", why: "addressed by an unguessable id" },
  "GET /api/runs/[id]/review": { kind: "public", why: "addressed by an unguessable id" },
  // CHE-411: what a check was priced at and why — the team's spending, so a
  // read of the team that paid, never public like the verdict it belongs to.
  "GET /api/runs/[id]/price": { kind: "team", action: "read" },
  "GET /api/tests/[id]": { kind: "public", why: "addressed by an unguessable id" },
  "GET /api/status/[slug]": { kind: "public", why: "addressed by an unguessable id" },

  // Signature-verified: the proof is the signature, not a session.
  "POST /api/webhooks/stripe": { kind: "public", why: "signature-verified webhook" },
  "POST /api/webhooks/clerk": { kind: "public", why: "signature-verified webhook" },
  // CHE-375: the owner's chat with @checkmyapp_bot, stored in D1. Only chats on
  // TELEGRAM_ALLOWED_CHAT_IDS are written.
  "POST /api/webhooks/telegram": { kind: "public", why: "secret-token-verified webhook" },
  // CHE-369: the GitHub App's deliveries, signed with its webhook secret; the
  // team is whoever connected the installation the delivery names.
  "POST /api/webhooks/github": { kind: "public", why: "signature-verified webhook" },

  // CHE-315: the remote MCP server. One URL, many actions: the API key names
  // the team and the scope, and each tool asks the scope table for its own
  // action (list_apps → read, start_check → run.start, enable_watch →
  // watch.configure, …) in the file named here. Connecting at all needs `read`.
  "POST /api/mcp": { kind: "row", decidedIn: "src/lib/mcp/tools.ts" },

  // Decided by the row: an anonymous run belongs to whoever holds its link.
  "POST /api/runs/[id]/recheck": { kind: "row", decidedIn: "src/lib/recheck.ts" },
  "PATCH /api/runs/[id]/lens": { kind: "row", decidedIn: "src/lib/auth.ts (canMutateOwned)" },
  "PATCH /api/findings/[id]": { kind: "row", decidedIn: "src/lib/auth.ts (canMutateOwned)" },
  "POST /api/findings/[id]/ticket": { kind: "row", decidedIn: "src/app/api/findings/[id]/ticket/route.ts" },
  "POST /api/runs/[id]/export-specs": { kind: "row", decidedIn: "src/app/api/runs/[id]/export-specs/route.ts" },

  // Inviting, cancelling and resending: `member.invite` in the scope table.
  "POST /api/team/invites": { kind: "team", action: "member.invite" },
  "POST /api/team/invites/[id]": { kind: "team", action: "member.invite" },
  "DELETE /api/team/invites/[id]": { kind: "team", action: "member.invite" },

  // The team's own settings.
  "POST /api/watch": { kind: "team", action: "watch.configure" },
  "PATCH /api/watch/[slug]": { kind: "team", action: "watch.configure" },
  "DELETE /api/watch/[slug]": { kind: "team", action: "watch.configure" },
  "POST /api/integrations/github": { kind: "team", action: "integration.connect" },
  "DELETE /api/integrations/github": { kind: "team", action: "integration.connect" },
  "GET /api/integrations/linear/start": { kind: "team", action: "integration.connect" },
  "GET /api/integrations/linear/callback": { kind: "team", action: "integration.connect" },
  // CHE-369: installing the GitHub App lets the team's deploys start checks
  // the team pays for — the same gate as a tracker.
  "GET /api/integrations/github/app/start": { kind: "team", action: "integration.connect" },
  "GET /api/integrations/github/app/callback": { kind: "team", action: "integration.connect" },
  // CHE-236: the analytics connection. Team-scoped like the tracker pair —
  // the token it stores is read by every app the team watches.
  "GET /api/integrations/posthog/start": { kind: "team", action: "integration.connect" },
  "GET /api/integrations/posthog/callback": { kind: "team", action: "integration.connect" },
};

// Server actions are routes without a URL: the same question, the same answer,
// and the same registry. Keyed "file#export".
export const ACTION_RULES: Record<string, RouteRule> = {
  "src/app/dashboard/actions.ts#setTrackerTeam": { kind: "team", action: "integration.connect" },
  "src/app/dashboard/actions.ts#setIntegrationEndpoints": { kind: "team", action: "integration.connect" },
  // CHE-369: which repository deploys an app, and whether its deploys start checks. Per app now.
  "src/app/dashboard/actions.ts#setAppGitHubRepo": { kind: "team", action: "integration.connect" },
  // CHE-236: disconnecting is the same authority as connecting — whoever may
  // grant a team's analytics access may end it.
  "src/app/dashboard/actions.ts#disconnectPostHog": { kind: "team", action: "integration.connect" },
  "src/app/dashboard/actions.ts#createApiKey": { kind: "team", action: "apikey.manage" },
  "src/app/dashboard/actions.ts#revokeApiKey": { kind: "team", action: "apikey.manage" },
  "src/app/dashboard/actions.ts#updateAppSettings": { kind: "team", action: "app.settings.write" },
  "src/app/dashboard/actions.ts#deleteApp": { kind: "team", action: "app.delete" },
  "src/app/dashboard/actions.ts#runSavedApp": { kind: "team", action: "run.start" },
  "src/app/dashboard/actions.ts#setAppNotifiers": { kind: "team", action: "app.settings.write" },
  // CHE-237: pointing an app at a PostHog project is an app setting, not an
  // integration one — the connection is already made; this says which of its
  // projects this app reports to.
  "src/app/dashboard/actions.ts#setAppPosthogProject": { kind: "team", action: "app.settings.write" },
  // Subscribing yourself is not an admin act: a reader joined to read what
  // breaks, and needing permission to be told about it would be a product that
  // makes you ask twice.
  "src/app/dashboard/actions.ts#toggleOwnNotifications": { kind: "team", action: "read" },
  "src/app/onboarding/actions.ts#createApp": { kind: "team", action: "app.settings.write" },
  // CHE-333: a Shopify app is connected by its store and then chosen after the
  // person signs in. Both save where a check of the app may act (the admin and
  // the app's own origin) — allowed origins, so credentials.write.
  "src/app/(app)/connect/shopify/actions.ts#connectShopifyStore": { kind: "team", action: "app.credentials.write" },
  "src/app/(app)/health/apps/[appId]/sign-in/actions.ts#chooseShopifyApp": { kind: "team", action: "app.credentials.write" },
  // CHE-360: the four marks on the Issues pages, the same decision as PATCH
  // /api/findings/[id] for the team the run belongs to.
  "src/app/(app)/health/issues/actions.ts#markFinding": { kind: "team", action: "finding.mark" },
  "src/app/verdict/actions.ts#recheckRunAction": { kind: "row", decidedIn: "src/lib/recheck.ts" },
  "src/app/verdict/actions.ts#fullRecheckRunAction": { kind: "row", decidedIn: "src/lib/recheck.ts" },
  // CHE-329: "Run it again" on a failed run — the same re-check, same gates.
  "src/app/verdict/actions.ts#retryFailedRunAction": { kind: "row", decidedIn: "src/lib/recheck.ts" },
  "src/app/verdict/actions.ts#enableWatchAction": { kind: "row", decidedIn: "src/lib/watch-enable.ts" },
  // Accepting is not a team action — the person is not on the team yet. The
  // token they hold is the capability, and the invitation row decides
  // (src/lib/invites.ts), which is exactly what `row` means.
  "src/app/invite/[token]/actions.ts#acceptInviteAction": { kind: "row", decidedIn: "src/lib/invites.ts" },
  "src/app/team/actions.ts#inviteMemberAction": { kind: "team", action: "member.invite" },
  "src/app/team/actions.ts#revokeInviteAction": { kind: "team", action: "member.invite" },
  "src/app/team/actions.ts#changeScopeAction": { kind: "team", action: "member.scope.change" },
  "src/app/team/actions.ts#removeMemberAction": { kind: "team", action: "member.remove" },
  // Leaving is not an admin action: everybody on the team may do it, and the
  // last-admin rule (src/lib/membership.ts) is what stops the one case where
  // it would be destructive.
  "src/app/team/actions.ts#leaveTeamAction": { kind: "team", action: "read" },
  // Switching is not an action inside a team — it chooses which team you are
  // acting as. What decides is membership in the team being switched TO, so the
  // rule lives with the switch itself rather than in the scope table.
  "src/app/team/switch-actions.ts#switchTeamAction": { kind: "row", decidedIn: "src/app/team/switch-actions.ts" },
  "src/app/(app)/settings/account/actions.ts#setThemeAction": {
    kind: "public",
    why: "a preference kept in the caller's own browser — writes nothing of ours",
  },
};
