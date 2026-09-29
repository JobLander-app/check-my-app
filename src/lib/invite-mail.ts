// CHE-341: how a web route sends a team invitation.
//
// The web worker holds no mail key. It asks the agent worker's Mailer
// (src/agent/mailer.ts) over the MAILER service binding, so there is one key,
// one sender and one place that decides what our mail looks like.
//
// Before this, all three call sites passed the web worker's own EMAIL_API_KEY /
// EMAIL_FROM — which production never had — to sendTeamInvite, which reads a
// missing key as local dev and only logs. Every invitation would have been
// created, answered 201, and never sent. So a missing binding in production is
// an error here, not a log line; local `next dev` (no bindings at all) keeps
// the dev log so the flow still works offline.

import { sendTeamInvite, type TeamInviteMail } from "@/lib/email";

interface MailerBinding {
  sendTeamInvite(mail: TeamInviteMail): Promise<string | null>;
}

export async function sendInviteMail(
  env: Record<string, unknown>,
  mail: TeamInviteMail,
): Promise<string | null> {
  const mailer = env.MAILER as MailerBinding | undefined;
  if (mailer) return mailer.sendTeamInvite(mail);
  if (process.env.NODE_ENV === "production") {
    throw new Error("The invitation was saved but not sent: the MAILER binding is missing.");
  }
  return sendTeamInvite({
    ...mail,
    apiKey: env.EMAIL_API_KEY as string | undefined,
    from: env.EMAIL_FROM as string | undefined,
  });
}
