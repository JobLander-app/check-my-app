// CHE-264 (Teams T11): who changed what, answerable without a guess.
//
// The moment more than one person can change an app, "why is the watch paused",
// "who changed this credential" and "who invited that account" become questions
// — and today they would be answered by reconstruction. Rule 8 names that class
// by its own name: **bookkeeping**, losing track of what we had done or been
// told. There is a precedent in this codebase: a paused watch came back to life
// because an agent pressed resume while exploring (CHE-89, CHE-98). With one
// owner that was traceable by memory. With five people it is not.
//
// The mechanism is that the functions which perform a change write the event,
// and scripts/verify-team-events.ts fails the build for a mutating export that
// does not. A log written by whoever remembers to call it is a log that is
// complete until the first person forgets.

import type { PrismaClient } from "@/generated/prisma/client";

// A closed list. A new kind of change has to be added here, which is a
// decision, rather than passed as a string, which is a habit.
export type TeamEventAction =
  // membership
  | "member.invited"
  | "member.invite_revoked"
  | "member.invite_resent"
  | "member.joined"
  | "member.removed"
  | "member.left"
  | "member.scope_changed"
  // billing
  | "billing.plan_changed"
  | "billing.seats_changed"
  | "billing.checkout_started"
  // the app and what we may do to it
  | "app.created"
  | "app.settings_changed"
  | "app.credentials_written"
  | "app.deleted"
  | "app.notifiers_changed"
  | "integration.connected"
  | "integration.disconnected"
  | "apikey.created"
  | "apikey.revoked"
  // the watch, which is the one with a real incident behind it
  | "watch.enabled"
  | "watch.paused"
  | "watch.resumed"
  | "watch.frequency_changed"
  | "watch.deleted";

export type TeamEventInput = {
  teamId: string;
  // Null for something our own system did — a Stripe webhook, the scheduler.
  // "system" is an answer; an empty actor that means "we did not record it" is
  // not, which is why this is explicit rather than optional.
  actorUserId: string | null;
  action: TeamEventAction;
  // What it happened to, in the team's own words: an email, an app slug, a key
  // name. Never an id — a log nobody can read is a log nobody reads.
  subject?: string | null;
  // One sentence, plain English, written for the person who will read it in
  // three weeks wondering what happened.
  summary: string;
};

// Never throws. An audit line that fails must not fail the change it describes
// — the alternative is a product where removing somebody can fail because the
// log is down, and rule 4's instinct applies: our own bookkeeping is not the
// customer's problem. It is loud in the logs instead.
export async function recordTeamEvent(db: PrismaClient, event: TeamEventInput): Promise<void> {
  try {
    await db.teamEvent.create({
      data: {
        teamId: event.teamId,
        actorUserId: event.actorUserId,
        action: event.action,
        subject: event.subject ?? null,
        summary: event.summary,
      },
    });
  } catch (err) {
    console.warn(
      `[team-event] could not record ${event.action} for ${event.teamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// The person a membership event is about, by email: TeamEvent.subject names
// people, never ids, and "changed someone's access" answers nothing the log is
// for. Never throws, for the same reason recordTeamEvent does — a failed lookup
// costs the line its name, never the change. Callers take it before they mutate.
export async function memberEmailForLog(db: PrismaClient, userId: string): Promise<string> {
  try {
    const row = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    return row?.email || "a former member";
  } catch (err) {
    console.warn(
      `[team-event] could not name member ${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "a team member";
  }
}

// How an event reads on the page. The action is a machine word; this is the
// sentence. Kept here rather than in the component so the log reads the same
// wherever it is shown — and so a new action without a sentence is visible.
export function describeEvent(event: {
  action: string;
  subject: string | null;
  summary: string;
  actorEmail?: string | null;
  createdAt: Date;
}): string {
  const who = event.actorEmail?.trim() || "CheckMyApp";
  return `${who} — ${event.summary}`;
}
