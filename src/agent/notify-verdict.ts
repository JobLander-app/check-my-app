// The verdict-ready email, and the two gates in front of it (CHE-156).
//
// Lifted out of workflow.ts unchanged except for the first gate. workflow.ts
// imports `cloudflare:workers`, so nothing in it can be driven on plain Node;
// the silence rule is the one thing in this file that must be provable without
// a Workers runtime, and scripts/verify-self-check-silence.ts drives the real
// `notifyVerdictReady` below rather than a copy of it.
//
// ─── Why the silence gate reads the TARGET and not the account ───────────────
//
// CLAUDE.md §6 promises a self-check is silent. Until CHE-156 that promise was
// keyed on `User.isTestAccount`, and the app the rule was written for —
// checkmyapp.dev — belongs to the owner's ordinary account (isTestAccount = 0).
// The key never matched the object. On 2026-09-07 run #156 published verdict
// `broken` about a sign-in page our own checker had broken (CHE-212) and mailed
// the owner about it; 29 of the 30 checkmyapp.dev runs in production carried a
// notifyEmail, so that was the rule, not the exception.
//
// The marker is a property of the target, and the mechanism that answers "is
// this ours" already exists: isSelfUrl (self-hosts.ts, CHE-193), the same list
// the browser context, the click gate and the read-only guard consult, extended
// by the SELF_CHECK_HOSTS binding so a preview host is covered without a
// deploy. One fact, one source.
//
// The test-account gate stays beside it rather than being replaced. It answers
// a different question — the placeholder apps the self-check registers
// (example.com, test-app-*) are not on our hosts and are swept by the janitor —
// and dropping it would put those back in the owner's inbox.
//
// What is silenced is OUR run of our app, not every run of it. Two conditions,
// answering two different questions: the target is one of our hosts (is this
// app ours?) and the run is ours — it has an owner, or it belongs to a watch
// (is this run ours?). An anonymous visitor's free public check of
// checkmyapp.dev is an ordinary run and gets its mail: pointing the checker at
// the checker will be one of the most common first runs anyone ever does, and
// silence there reads as "the form is broken", which costs exactly the trust §6
// was written to protect. The account is not back in the definition of "our
// app" — that is still the host. It answers "whose run is this", which is the
// question it actually knows the answer to.

import { sendVerdictReady, verdictIdempotencyKey } from "@/lib/email";
import { describeRecipients, recipientsForApp } from "@/lib/recipients";
import type { Verdict } from "@/lib/enums";
import { metricAlertsForRun } from "./metric-alerts";
import { isSelfUrl } from "./self-hosts";
import type { AgentBindings, AgentEnv } from "./env";

export interface NotifiableRun {
  publicId: string;
  appSlug: string;
  targetUrl: string;
  notifyEmail: string | null;
  ownerId: string | null;
  teamId?: string | null;
  appId?: string | null;
  watchId: string | null;
  baselineRunId: string | null;
}

// Why this run stays quiet, in the words the log line uses.
// null = the mail goes out.
export type SilenceReason = "our own product, checked by us" | "a self-check account";

// The whole rule, as a pure function, so it can be asserted directly and so the
// log line and the decision cannot drift apart.
export function silenceReason(input: {
  targetUrl: string;
  // The run is ours rather than a visitor's: it has an owner, or a watch of
  // ours scheduled it.
  ownRun: boolean;
  ownedByTestAccount: boolean;
  selfCheckHosts?: string;
}): SilenceReason | null {
  if (isSelfUrl(input.targetUrl, input.selfCheckHosts)) {
    // Our host. Two answers live here, and they are different answers:
    if (input.ownRun) return "our own product, checked by us";
    // — our host, somebody else's run. A visitor pointed the public checker at
    // the checker. Ordinary run, ordinary mail.
    return null;
  }
  if (input.ownedByTestAccount) return "a self-check account";
  return null;
}

// A run belongs to us when someone signed in started it, a team owns it, or a
// watch scheduled it. An ownerless, teamless run came off the public home-page form
// form.
//
// CHE-253 added teamId, and it is read here on purpose rather than left to
// ownerId alone. Every owned run still carries its actor in ownerId, so this
// clause changes no answer today — it means that a future run written with only
// a team cannot silently stop being ours. When this predicate is wrong we do
// not get a 500: we mail a customer a verdict about a page our own checker
// broke, which is what CHE-156 cost (30 runs, 66 findings, 29 mailed out).
export function isOwnRun(run: {
  ownerId: string | null;
  teamId?: string | null;
  watchId: string | null;
}): boolean {
  return run.ownerId !== null || (run.teamId ?? null) !== null || run.watchId !== null;
}

// ─── What happened to the mail, as a value (CHE-224) ─────────────────────────
//
// Until now this function returned void and swallowed a provider failure into a
// console.warn. In production that meant: 30 watch runs between 2026-08-29 and
// 2026-09-08 reached the send with every gate passed — the Workflow step history
// shows `notify-1` ran for runs #146, #156 and #158 — and not one of them
// arrived. Every message the owner did receive was addressed to
// hello@joblander.app; every silent one to sorokinvj@gmail.com. Nothing in the
// database, the run feed or our own board said so, and by the time anyone
// looked the Worker log had expired.
//
// So the decision is now a value: every run that carries an address ends with
// one of these recorded on the row, and a failure additionally lands in the run
// feed and on our own board. "We could not tell whether the customer got their
// verdict" is our defect (CLAUDE.md rules 2 and 8), and it may not be silent.
export type NotifyOutcome =
  | { kind: "sent"; providerMessageId: string | null }
  // Deliberately not sent, and why — in words stable enough to group by.
  | { kind: "skipped"; reason: string }
  // The provider refused it, or the request never completed.
  | { kind: "failed"; error: string };

// The stored form of an outcome (Run.notifyOutcome). Prefix-coded so one query
// reconciles a month: `LIKE 'failed:%'` is every refused send, `LIKE 'skipped:%'`
// every deliberate silence with its reason, and NULL on a terminal run that had
// an address is a run that never reached the decision at all.
export function notifyOutcomeCode(outcome: NotifyOutcome): string {
  switch (outcome.kind) {
    case "sent":
      return outcome.providerMessageId ? `sent:${outcome.providerMessageId}` : "sent";
    case "skipped":
      return `skipped: ${outcome.reason}`;
    case "failed":
      return `failed: ${outcome.error}`.slice(0, 500);
  }
}

// The reasons a send is deliberately not made, as constants, so the feed line,
// the stored code and any query over them cannot drift apart.
export const SKIP_NO_ADDRESS = "no address on the run";
export const SKIP_UNCHANGED = "the verdict has not changed since the last check";

// Write the outcome onto the run. Separate from the decision so a path that
// never reaches the send can still record why.
export async function recordNotifyOutcome(
  env: AgentEnv,
  publicId: string,
  outcome: NotifyOutcome,
): Promise<void> {
  await env.db.run.update({
    where: { publicId },
    data: { notifyOutcome: notifyOutcomeCode(outcome) },
  });
}

// Shared by the full run and the replay-first pass. Non-fatal by construction:
// a notification failure must never fail a completed run — but it is returned
// rather than swallowed, and the caller records it.
export async function notifyVerdictReady(
  env: AgentEnv,
  bindings: AgentBindings,
  run: NotifiableRun,
  verdict: Verdict | null,
): Promise<NotifyOutcome> {
  // CHE-262: who hears about this. The submitted address if there is one, the
  // people the team chose for this app, or the team's admins — resolved before
  // the silence rule so the log line can say who WOULD have been told.
  const recipients = await recipientsForApp(env.db, run.appId, run.notifyEmail);
  if (recipients.to.length === 0) return { kind: "skipped", reason: SKIP_NO_ADDRESS };
  // CHE-105/CHE-156: our own check of our own product is silent. It exists so
  // CheckMyApp can check itself; the person running the business must be able
  // to forget it exists. Its results live on the verdict page, where they can be
  // looked at deliberately — they never arrive in anyone's inbox.
  const silent = silenceReason({
    targetUrl: run.targetUrl,
    ownRun: isOwnRun(run),
    ownedByTestAccount: await ownedByTestAccount(env, run.publicId),
    selfCheckHosts: bindings.SELF_CHECK_HOSTS,
  });
  if (silent) {
    // The reason is named so the next operator reading the feed sees a decision
    // rather than a delivery that failed quietly.
    console.log(
      `[notify] run ${run.publicId} — staying silent: ${silent} (self-check, CLAUDE.md §6)`,
    );
    return { kind: "skipped", reason: silent };
  }
  // CHE-96: carry the answer into the mail. Read back rather than threaded
  // through, because both callers (smoke shortcut and full run) reach here at
  // different points, and the row is the single source of truth by now.
  const written = await env.db.run.findUnique({
    where: { publicId: run.publicId },
    select: {
      id: true,
      bottomLine: true,
      findings: { select: { category: true }, where: { mark: { not: "false_positive" } } },
    },
  });
  const findings = written?.findings ?? [];
  // CHE-241: what moved, for the mail the Watch already sends. Read once for
  // the whole recipient loop; a failure here costs the sentence, never the mail.
  //
  // Computed BEFORE the change-only gate, and handed to it. The gate used to ask
  // only whether the verdict differed from the baseline, so on a watch set to
  // "tell me when something changes" a journey that converted twenty points
  // worse was silently dropped whenever the app itself still worked — the
  // verdict was `all_good` last week and `all_good` today, so nothing was sent.
  // That is the exact sentence this epic exists to deliver, suppressed by a rule
  // about verdicts, on every watch in production (all three were change-only).
  // The ticket says it plainly: the app works AND fewer people finish, and both
  // sentences stand.
  const metricAlerts = written
    ? (await metricAlertsForRun(env, written.id)).map((a) => a.sentence)
    : [];
  if (
    run.watchId &&
    !(await watchWantsNotice(env, run.watchId, run.baselineRunId, verdict, metricAlerts))
  ) {
    return { kind: "skipped", reason: SKIP_UNCHANGED };
  }
  try {
    // One message per recipient rather than one message with several addresses:
    // a verdict is somebody's own mail, and a shared To: line is how a team
    // learns to ignore it. The provider ids are kept together so notifyOutcome
    // can be taken to the provider and checked (CHE-224).
    const ids: string[] = [];
    for (const to of recipients.to) {
    const providerMessageId = await sendVerdictReady({
      to,
      appSlug: run.appSlug,
      publicId: run.publicId,
      verdict,
      recurring: Boolean(run.watchId),
      bottomLine: written?.bottomLine ?? null,
      metricAlerts,
      findingCounts: {
        total: findings.length,
        broken: findings.filter((f) => f.category === "broken" || f.category === "exposed").length,
      },
      apiKey: bindings.EMAIL_API_KEY,
      from: bindings.EMAIL_FROM,
      replyTo: bindings.EMAIL_REPLY_TO,
      baseUrl: bindings.APP_URL,
      // CHE-328: a retried notify step must not mail the same person twice.
      idempotencyKey: verdictIdempotencyKey(run.publicId, to),
    });
      if (providerMessageId) ids.push(providerMessageId);
    }
    console.log(`[notify] run ${run.publicId} — ${describeRecipients(recipients)}`);
    return { kind: "sent", providerMessageId: ids.join(",") || null };
  } catch (err) {
    // Still non-fatal — but no longer invisible. The message carries the
    // provider's own words (`Resend send failed: 403 …`), which is the sentence
    // that was missing for ten days.
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[notify] verdict email failed: ${error}`);
    return { kind: "failed", error };
  }
}

async function ownedByTestAccount(env: AgentEnv, publicId: string): Promise<boolean> {
  const row = await env.db.run.findUnique({
    where: { publicId },
    select: { owner: { select: { isTestAccount: true } } },
  });
  return Boolean(row?.owner?.isTestAccount);
}

/**
 * Did anything the owner asked to hear about actually move?
 *
 * `notifyOnChangeOnly` means a recurring watch only writes when something
 * changed. "Something" is deliberately not just the verdict: a journey that
 * converted materially worse is a change, and it is the one this epic exists to
 * report (CHE-241). An app can work perfectly for weeks — verdict `all_good`,
 * unchanged, every day — while the flow that makes the money quietly stops
 * finishing, and a gate that reads only the verdict would swallow exactly that.
 *
 * `metricAlerts` is a required parameter rather than something fetched here, so
 * the gate cannot be evaluated without them. An optional argument would have
 * been forgotten at one of the call sites eventually, and the failure would look
 * like silence, which is indistinguishable from nothing being wrong.
 */
export function changeOnlyWantsNotice(args: {
  verdictChanged: boolean;
  metricAlerts: readonly string[];
}): boolean {
  return args.verdictChanged || args.metricAlerts.length > 0;
}

// No baseline = first run of the watch = always worth sending.
async function watchWantsNotice(
  env: AgentEnv,
  watchId: string,
  baselineRunId: string | null,
  verdict: string | null,
  metricAlerts: readonly string[],
): Promise<boolean> {
  const watch = await env.db.watch.findUnique({
    where: { id: watchId },
    select: { notifyOnChangeOnly: true },
  });
  if (!watch?.notifyOnChangeOnly) return true;
  if (!baselineRunId) return true;
  const baseline = await env.db.run.findUnique({
    where: { id: baselineRunId },
    select: { verdict: true },
  });
  return changeOnlyWantsNotice({
    verdictChanged: !baseline || baseline.verdict !== verdict,
    metricAlerts,
  });
}
