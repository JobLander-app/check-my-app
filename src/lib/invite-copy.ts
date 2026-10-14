// CHE-481: every sentence the invitation page shows (src/app/invite/[token]),
// in one pure module, so scripts/verify-invites.ts runs each through the
// language guards (R18). The refusals themselves are decideAccept's
// (src/lib/invites.ts) and are guarded by the same script.

import type { TeamScope } from "./scopes";

export const INVITE_COPY = {
  alreadyTitle: (team: string) => `You are already on ${team}`,
  alreadyBody: "Nothing to accept — the team is in your dashboard.",
  openTeam: (team: string) => `Open ${team}`,
  refusedTitle: "This invitation can't be used",
  toDashboard: "Go to your dashboard",
  joinTitle: (team: string) => `Join ${team}`,
  scope: {
    admin: "As an admin you will be able to run checks, change settings, and manage the team and its billing.",
    member: "As a member you will be able to run checks, change an app's settings, and act on what we find.",
    reader: "As a reader you will be able to see everything the team's checks find. Running a check is left to the others.",
  } satisfies Record<TeamScope, string>,
  signedInAs: (email: string, sentTo: string) =>
    `Signed in as ${email}. The invitation was sent to ${sentTo} — joining with this account is fine.`,
  joinButton: (team: string) => `Join ${team}`,
  worksUntil: (day: string) => `This link works until ${day}.`,
} as const;

// Every sentence above, for the guard.
export function allInviteSentences(team = "Securify", email = "a@b.test"): string[] {
  return [
    INVITE_COPY.alreadyTitle(team),
    INVITE_COPY.alreadyBody,
    INVITE_COPY.openTeam(team),
    INVITE_COPY.refusedTitle,
    INVITE_COPY.toDashboard,
    INVITE_COPY.joinTitle(team),
    ...Object.values(INVITE_COPY.scope),
    INVITE_COPY.signedInAs(email, email),
    INVITE_COPY.joinButton(team),
    INVITE_COPY.worksUntil("2026-10-20"),
  ];
}
