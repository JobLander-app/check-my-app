// Telling the team's admin, once per cause, why part of an app was not checked
// (CHE-443).
//
// What a run could not check is one of two kinds of news, and they go to
// different people. Ours (`our_capability`) becomes a "[Checker gap]" ticket and
// goes to Mender — capability-gaps.ts. Everything else is the team's to decide:
// a store password to add, a sign-in to renew, a rule that stops a check on
// purpose. Those go to the team's admin, in two places: the app page's "Needs
// your attention" card (always there, as long as the cause stands) and one mail
// — here — the first time the cause shows on that app. Never one per run: the
// same cause on the next run sends nothing.
//
// The memory of "told" is the CauseNotice row, unique per app and cause. It is
// written BEFORE the mail goes out, so two runs of one app finishing together
// cannot both send, and stamped after, so a mail that did not go is tried again
// on the next run (the provider's idempotency key makes a retry after a send
// that did go a no-op rather than a second mail).
//
// Only teams that have been given `shopify` (src/lib/team-features.ts): the
// pilot's admin, not every account.

import { noticeIdempotencyKey, sendCauseNotice } from "@/lib/email";
import { causeAction, causeText, isMailedToAdmin, type StepCause } from "@/lib/step-cause";
import { causesOfRun } from "@/lib/step-cause-load";
import { teamHasFeature } from "@/lib/team-features";
import { appPath } from "@/lib/app-shell";
import { systemWide, teamOwned } from "@/lib/tenant-db";
import type { AgentBindings, AgentEnv } from "./env";

export type CauseSend = typeof sendCauseNotice;

export interface CauseNoticeOutcome {
  cause: StepCause;
  /** told: a mail went to this many admins. already: it had gone before. none: nobody to tell — tried again next run. failed: no admin could be reached. */
  result: "told" | "already" | "none" | "failed";
  admins: number;
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return e?.code === "P2002" || /unique constraint/i.test(e?.message ?? "");
}

/**
 * Mail the team's admins about each cause this run met for the first time on
 * its app. Never throws: housekeeping must not cost a run its verdict.
 * `send` is for the guard; the worker sends through Resend with its bindings.
 */
export async function noticeNewCauses(
  env: Pick<AgentEnv, "db"> & { bindings: Pick<AgentBindings, "EMAIL_API_KEY" | "EMAIL_FROM" | "EMAIL_REPLY_TO" | "APP_URL"> },
  runId: string,
  send: CauseSend = sendCauseNotice,
): Promise<CauseNoticeOutcome[]> {
  try {
    return await noticeNewCausesOrThrow(env, runId, send);
  } catch (error) {
    console.warn(`[cause-notice] run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function noticeNewCausesOrThrow(
  env: Pick<AgentEnv, "db"> & { bindings: Pick<AgentBindings, "EMAIL_API_KEY" | "EMAIL_FROM" | "EMAIL_REPLY_TO" | "APP_URL"> },
  runId: string,
  send: CauseSend,
): Promise<CauseNoticeOutcome[]> {
  const run = await env.db.run.findUnique({ ...systemWide("agent workflow"),
    where: { id: runId },
    select: { appId: true, teamId: true, appSlug: true, ephemeral: true },
  });
  if (!run?.appId || !run.teamId || run.ephemeral) return [];
  if (!(await teamHasFeature(env.db, run.teamId, "shopify"))) return [];

  const { groups } = await causesOfRun(env.db, run.teamId, runId, { walkedOnly: true });
  const mailed = groups.filter((g) => isMailedToAdmin(g.cause));
  if (mailed.length === 0) return [];

  const admins = [
    ...new Set(
      (await env.db.membership.findMany({ where: { ...teamOwned(run.teamId), scope: "admin" }, select: { user: { select: { email: true } } } }))
        .map((m) => m.user.email.trim().toLowerCase())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)),
    ),
  ];

  const base = (env.bindings.APP_URL ?? "https://checkmyapp.dev").replace(/\/+$/, "");
  const out: CauseNoticeOutcome[] = [];
  for (const group of mailed) {
    const { cause } = group;
    // CauseNotice has no team column: its app is the run's, read above.
    const known = await env.db.causeNotice.findUnique({ ...systemWide("agent workflow"), where: { appId_cause: { appId: run.appId, cause } } });
    if (known?.sentAt) {
      out.push({ cause, result: "already", admins: 0 });
      continue;
    }
    if (!known) {
      try {
        await env.db.causeNotice.create({ ...systemWide("agent workflow"), data: { appId: run.appId, cause, firstRunId: runId } });
      } catch (error) {
        // Another run of this app claimed it between our read and our write: it sends.
        if (isUniqueViolation(error)) {
          out.push({ cause, result: "already", admins: 0 });
          continue;
        }
        throw error;
      }
    }
    if (admins.length === 0) {
      // The claim stays unsent: the first admin the team has hears it next run.
      out.push({ cause, result: "none", admins: 0 });
      continue;
    }

    const action = causeAction(cause);
    const actionUrl = action?.to ? `${base}${action.to === "sign_in" ? appPath.signIn(run.appId) : appPath.section(run.appId, "accounts")}` : undefined;
    let told = 0;
    for (const to of admins) {
      try {
        await send({
          to,
          appSlug: run.appSlug,
          causeSentence: causeText(cause),
          actionText: action?.text,
          actionUrl,
          stepLabels: group.labels,
          appUrl: `${base}${appPath.page(run.appId)}`,
          apiKey: env.bindings.EMAIL_API_KEY,
          from: env.bindings.EMAIL_FROM,
          replyTo: env.bindings.EMAIL_REPLY_TO,
          idempotencyKey: noticeIdempotencyKey(`cause/${run.appId}/${cause}`, to),
        });
        told++;
      } catch (error) {
        console.warn(`[cause-notice] ${cause} for ${run.appSlug} not sent to one admin: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Sent means every admin was reached: stamping it after one success would
    // stop the next run retrying the admin whose send failed. The retry cannot
    // double-mail the others — each recipient has its own idempotency key.
    const everyone = told === admins.length;
    if (everyone) await env.db.causeNotice.update({ ...systemWide("agent workflow"), where: { appId_cause: { appId: run.appId, cause } }, data: { sentAt: new Date() } });
    out.push({ cause, result: everyone ? "told" : "failed", admins: told });
  }
  return out;
}
