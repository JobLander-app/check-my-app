// The one place mail leaves CheckMyApp for the web app (CHE-341).
//
// The agent worker holds the mail key (EMAIL_API_KEY secret) and the sender
// (EMAIL_FROM var); the web worker has neither, and never did. Team invites are
// sent from web routes, so until this entrypoint existed every invitation was
// created, answered 201, and then only logged — `sendTeamInvite` treats a
// missing key as local dev. Nobody noticed because no invite had been sent yet.
//
// Rather than hand a second copy of the key to a second worker, the web worker
// reaches this class through a service binding (wrangler.jsonc: MAILER →
// checkmyapp-agent, entrypoint Mailer) and asks it to send. One key, one
// sender, one place that decides what our mail looks like.

import { WorkerEntrypoint } from "cloudflare:workers";
import { sendTeamInvite, type TeamInviteMail } from "@/lib/email";
import type { AgentBindings } from "./env";

export class Mailer extends WorkerEntrypoint<AgentBindings> {
  // Returns the provider's message id. Throws when the provider refuses, and —
  // unlike the local-dev path in sendTeamInvite — when this worker has no key:
  // in production a missing key is a defect to see, not a mode to log in.
  async sendTeamInvite(mail: TeamInviteMail): Promise<string | null> {
    if (!this.env.EMAIL_API_KEY || !this.env.EMAIL_FROM) {
      throw new Error("Mailer: the agent worker has no EMAIL_API_KEY or EMAIL_FROM");
    }
    return sendTeamInvite({
      ...mail,
      apiKey: this.env.EMAIL_API_KEY,
      from: this.env.EMAIL_FROM,
      replyTo: this.env.EMAIL_REPLY_TO,
    });
  }
}
