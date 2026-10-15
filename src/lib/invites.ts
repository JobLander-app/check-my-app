// CHE-257 (Teams T4): the state machine of an invitation, and the token that
// carries it.
//
// Everything here is pure except the two crypto helpers, so every branch — an
// expired invite, a revoked one, one already used, one for a team you are
// already on — can be asserted without a database or a clock
// (scripts/verify-invites.ts).
//
// Two decisions worth stating, because both look like details and are not:
//
// 1. Acceptance matches on the TOKEN, never on the email address. A colleague
//    types the address they know; the person signs in with the Google account
//    they actually use. Matching on the address would refuse exactly the people
//    the invitation was meant for, and refusing them would look like a broken
//    link rather than a rule.
// 2. An invite is never deleted. Revoking and resending mark it; the row stays,
//    because "who invited whom, and what happened to it" is what T11's audit
//    log reads, and a row that vanishes takes its own history with it.

import type { TeamScope } from "./scopes";

export const INVITE_TTL_DAYS = 7;

// Long enough that guessing is hopeless, short enough to survive an email
// client's line wrapping. Same shape as an API key (`cma_` + 32 hex), so the
// two read as what they are: bearer secrets.
export const INVITE_TOKEN_RE = /^inv_[0-9a-f]{32}$/;

export function generateInviteToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `inv_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function hashInviteToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function inviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export type InviteRow = {
  teamId: string;
  scope: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
};

export type InviteState = "pending" | "accepted" | "revoked" | "resent" | "expired";

// Order matters and is the rule: a revoked invite is revoked even after its
// expiry, and an accepted one stays accepted. Expiry is only the answer when
// nothing else has happened to it.
export function inviteState(invite: InviteRow, now: Date = new Date()): InviteState {
  if (invite.acceptedAt) return "accepted";
  if (invite.revokedAt) return invite.revokedReason === "resent" ? "resent" : "revoked";
  if (invite.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

export type AcceptDecision =
  | { kind: "ok"; teamId: string; scope: TeamScope }
  // Already on the team: not an error. The link did its job earlier, or somebody
  // invited a colleague twice; either way the answer is "you are in", not a
  // refusal that makes the product look broken.
  | { kind: "already_member"; teamId: string }
  | { kind: "refused"; reason: string };

// The whole decision, as a function of the row, who is holding it, and when.
// `alreadyMember` is the caller's answer to "is this person already on that
// team" — a database question, kept out of here so the rule stays testable.
export function decideAccept(
  invite: InviteRow | null,
  alreadyMember: boolean,
  now: Date = new Date(),
): AcceptDecision {
  if (!invite) {
    return {
      kind: "refused",
      reason: "That invitation link isn't valid. Ask whoever invited you to send a new one.",
    };
  }
  const state = inviteState(invite, now);
  if (alreadyMember) return { kind: "already_member", teamId: invite.teamId };
  switch (state) {
    case "pending":
      return { kind: "ok", teamId: invite.teamId, scope: invite.scope as TeamScope };
    case "accepted":
      return {
        kind: "refused",
        reason: "That invitation has already been used. Ask for a new one if you still need access.",
      };
    case "revoked":
      return {
        kind: "refused",
        reason: "That invitation was cancelled. Ask whoever invited you to send a new one.",
      };
    case "resent":
      return {
        kind: "refused",
        reason: "A newer invitation replaced this one — use the most recent email you received.",
      };
    case "expired":
      return {
        kind: "refused",
        reason: `That invitation expired after ${INVITE_TTL_DAYS} days. Ask whoever invited you to send a new one.`,
      };
  }
}

// Where a signed-out visitor to an invitation goes, and the way back. Joining
// needs an identity, but the identity is a step on the way to the team, not the
// destination: the link has to survive it. Before this the page sent people to a
// bare /sign-in, they came out on /home inside a fresh team of their own, and
// the invitation sat pending — to them it read as "this made me a new account"
// (connect@otp.plus, 2026-10-14).
//
// Most people holding an invitation have never been here, so the default is
// sign-up; someone whose invited address already has an account goes to
// sign-in. Either page links to the other with the way back intact, so a wrong
// guess costs one click, never the invitation.
export function inviteAuthPath(token: string, hasAccount: boolean): string {
  // The token is encoded on its own first, so whatever was typed into the path
  // stays inside the one segment and the way back cannot lead anywhere else.
  const back = encodeURIComponent(`/invite/${encodeURIComponent(token)}`);
  return `${hasAccount ? "/sign-in" : "/sign-up"}?redirect_url=${back}`;
}

export type InviteRequest = { email: string; scope: string };
export type InviteCheck = { ok: true; email: string; scope: TeamScope } | { ok: false; reason: string };

const SCOPES: TeamScope[] = ["admin", "member", "reader"];

// What an admin is allowed to send. Deliberately strict about the address: an
// invitation to a typo is an invitation nobody receives, and the admin finds
// out days later when their colleague says they never got it.
export function checkInviteRequest(req: InviteRequest): InviteCheck {
  const email = req.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { ok: false, reason: "That doesn't look like an email address." };
  }
  if (!SCOPES.includes(req.scope as TeamScope)) {
    return { ok: false, reason: "Pick admin, member or reader." };
  }
  return { ok: true, email, scope: req.scope as TeamScope };
}
