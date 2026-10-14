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

// The invitation email (src/lib/email.ts sendTeamInvite). It INVITES: nobody
// is on the team until they press Join. Until 2026-10-14 it said "added you",
// and the first person who followed it signed up, landed in a team of their
// own, and read that as the product losing them (CHE-481). Someone without an
// account is told the link takes them through sign-up and back.
export const INVITE_MAIL = {
  subject: (invitedBy: string, team: string) => `${invitedBy} invited you to join ${team} on CheckMyApp`,
  lead: (invitedBy: string, team: string) => `${invitedBy} invited you to join ${team} on CheckMyApp.`,
  about: "CheckMyApp uses your team's apps the way a visitor would, every day, and tells you what broke.",
  scope: {
    admin: "You will be able to run checks, change settings, manage the team and its billing.",
    member: "You will be able to run checks, change an app's settings and act on what we find.",
    reader: "You will be able to read everything the team's checks find. Running a check is left to the others.",
  } satisfies Record<TeamScope, string>,
  join: (team: string) => `Join ${team}`,
  newHere: "No CheckMyApp account yet? You create one on the way, and the link brings you back to join.",
  lasts: "The link works for 7 days.",
  why: (invitedBy: string) =>
    `You get this because ${invitedBy} entered this address. If you weren't expecting it, ignore this mail — nothing happens unless you choose Join on the invitation page.`,
} as const;

export function inviteMailScope(scope: string): string {
  return scope === "admin" ? INVITE_MAIL.scope.admin : scope === "member" ? INVITE_MAIL.scope.member : INVITE_MAIL.scope.reader;
}

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
    INVITE_MAIL.subject(email, team),
    INVITE_MAIL.lead(email, team),
    INVITE_MAIL.about,
    ...Object.values(INVITE_MAIL.scope),
    INVITE_MAIL.join(team),
    INVITE_MAIL.newHere,
    INVITE_MAIL.lasts,
    INVITE_MAIL.why(email),
  ];
}
