// Verdict-ready notifications, provider = Resend (plain fetch — works in both
// Node and workerd). Config arrives as arguments because the agent worker has
// no process.env: bindings flow in from workflow.ts. With no apiKey the send
// degrades to a console log so local dev works offline.

import { VERDICT_META } from "@/lib/status";
import { BALANCE_PATH } from "@/lib/balance-links";

// The bottom line is model-written prose about the customer's product; it goes
// into HTML mail, so it gets escaped rather than trusted.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// CHE-226: what a stranger's mail provider sees. The first verdict mail ever
// sent to a customer outside this account (2026-09-28, a daily check) landed in
// Gmail's spam. Authentication was already aligned — SPF, DKIM and DMARC all
// pass on checkmyapp.dev — so what changes here is what a legitimate sender's
// mail carries and a phishing template does not: a complete HTML document
// rather than a fragment, a plain-text twin on every message, and one line
// saying why this address is getting it and where to stop it.
function htmlDocument(subject: string, body: string, footer: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">` +
    body +
    `<p style="margin:24px 0 0;font-size:12px;color:#888">${footer}</p>` +
    `</body></html>`
  );
}

// CHE-226: where a reply goes. The From address only sends; until 2026-09-29
// checkmyapp.dev had no MX at all, so a person answering a verdict got a bounce.
// The reply now lands in a mailbox somebody reads (Cloudflare Email Routing),
// and a reply is also the strongest sign to a recipient's provider that this
// sender is wanted.
function replyToField(replyTo?: string): { reply_to?: string } {
  return replyTo ? { reply_to: replyTo } : {};
}

// Why this address is getting the mail, in the same words in both parts. A
// recurring mail says where to stop it; a one-off says there is nothing to stop.
// Worded for every recipient the rule in recipients.ts can pick — the person
// who submitted the check, a teammate who chose this app, or a team admin — so
// it never claims "you asked" of someone who did not.
function whyThisMail(args: { appSlug: string; recurring: boolean; base: string }): {
  html: string;
  text: string;
} {
  if (args.recurring) {
    // CHE-351: "Which apps email you" on the reader's own settings — the
    // switch that stops this mail without stopping anyone else's.
    const manage = `${args.base}/settings/account`;
    // Cadence-neutral on purpose: a watch may run daily, every 6 hours, or only
    // when someone presses re-check, and all of them reach this branch.
    const sentence = `You get this because checks of ${args.appSlug} report to this address.`;
    return {
      html: `${escapeHtml(sentence)} <a href="${manage}" style="color:#888">Change or stop them</a>.`,
      text: `${sentence} Change or stop them: ${manage}`,
    };
  }
  const sentence = `You get this because a check of ${args.appSlug} was set to report to this address. This is the only mail about this check.`;
  return { html: escapeHtml(sentence), text: sentence };
}

interface VerdictReadyArgs {
  to: string;
  appSlug: string;
  publicId: string;
  partial?: boolean;
  // Verdict of the finished run — surfaced in the subject and body when known.
  verdict?: string | null;
  // The run came from a Daily Watch, so the mail is a recurring report rather
  // than the one-off result the home-page form promised.
  recurring?: boolean;
  // CHE-96: the answer itself, so the mail is worth opening on its own. The
  // bottom line is already written for exactly this job — leading with it beats
  // "your verdict is ready", which makes the reader do the work of finding out.
  bottomLine?: string | null;
  findingCounts?: { broken: number; total: number };
  // CHE-241: journeys whose measured conversion fell materially against their
  // own baseline. Rides this mail rather than becoming a second product.
  // Already rule-1 clean; composed in src/lib/metric-movement.ts.
  metricAlerts?: string[];
  apiKey?: string;
  from?: string;
  replyTo?: string;
  baseUrl?: string;
  // CHE-328: the notify step is a Workflow step, and the platform retries a step
  // that dies after the mail has gone (run #263: WorkflowInternalError after the
  // send, then a second identical mail to our first customer). Resend keeps an
  // Idempotency-Key for 24 h and answers a repeat with the original response
  // instead of sending again — so the caller passes a key that is the same on
  // every attempt for the same run and recipient.
  idempotencyKey?: string;
}

// Returns the provider's own id for the accepted message, or null when there is
// no provider configured (local dev). CHE-224: the id is stored on the run, so
// "we sent it" can be taken to the provider and checked against what it did with
// it — a 200 from Resend is acceptance, not delivery, and the two were
// indistinguishable while nothing recorded either.
export async function sendVerdictReady({
  to,
  appSlug,
  publicId,
  partial,
  verdict,
  recurring,
  bottomLine,
  findingCounts,
  metricAlerts,
  apiKey,
  from,
  replyTo,
  baseUrl,
  idempotencyKey,
}: VerdictReadyArgs): Promise<string | null> {
  const base = baseUrl ?? "http://localhost:3000";
  const url = `${base}/verdict/${publicId}`;
  const label = verdict ? (VERDICT_META[verdict]?.label ?? verdict) : null;
  const subject = partial
    ? `We got partway through ${appSlug} — here's what we found`
    : recurring
      ? `Daily check: ${appSlug}${label ? ` — ${label}` : ""}`
      : `Your verdict for ${appSlug} is ready`;

  if (!apiKey || !from) {

    console.log(`[email:dev] to=${to} subject="${subject}" url=${url}`);
    return null;
  }

  const why = whyThisMail({ appSlug, recurring: Boolean(recurring), base });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      ...replyToField(replyTo),
      html: htmlDocument(
        subject,
        `<p style="margin:0 0 4px"><strong>${escapeHtml(appSlug)}</strong>${label ? ` — ${escapeHtml(label)}` : ""}</p>` +
          (bottomLine ? `<p style="margin:0 0 16px">${escapeHtml(bottomLine)}</p>` : "") +
          (findingCounts && findingCounts.total > 0
            ? `<p style="margin:0 0 16px;color:#666">${findingCounts.total} finding${findingCounts.total === 1 ? "" : "s"}` +
              `${findingCounts.broken > 0 ? `, ${findingCounts.broken} of them blocking` : ""}.</p>`
            : "") +
          // CHE-241. Deliberately placed AFTER the verdict and before the link:
          // "the app works" and "fewer people finish it" are both true at once,
          // and the second must not be smoothed into the first or hidden under
          // it. A green verdict with a fallen conversion is not a contradiction.
          (metricAlerts?.length
            ? `<p style="margin:0 0 16px">${metricAlerts.map((s) => escapeHtml(s)).join("<br>")}</p>`
            : "") +
          `<p><a href="${url}">See the evidence →</a></p><p style="color:#666">— CheckMyApp</p>`,
        why.html,
      ),
      text:
        `${appSlug}${label ? ` — ${label}` : ""}\n\n` +
        (bottomLine ? `${bottomLine}\n\n` : "") +
        (metricAlerts?.length ? `${metricAlerts.join("\n")}\n\n` : "") +
        `See the evidence: ${url}\n\n— CheckMyApp\n\n${why.text}`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    // Same key, different body: the first attempt's mail went out, and the row
    // changed between attempts. Sending again is exactly what the key prevents,
    // so this counts as sent — without an id, because the provider gave none.
    if (res.status === 409 && idempotencyKey && detail.includes("invalid_idempotent_request")) return null;
    throw new Error(`Resend send failed: ${res.status} ${detail}`);
  }
  // The provider's id for the accepted message. Best-effort: an unreadable body
  // must not turn a delivered mail into a failure.
  try {
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}

// CHE-328: one verdict mail per run and recipient, however many times the step
// that sends it runs. Stable across attempts, distinct per recipient.
export function verdictIdempotencyKey(publicId: string, to: string): string {
  // The address itself never goes into the header, only its digest: a header
  // value must be a ByteString, so an internationalized address would make
  // fetch throw and the verdict would not be sent at all; a raw address could
  // also run past Resend's 256-character cap, where cutting it would let two
  // recipients share a key (Codex, #199). The run id is an ASCII cuid.
  const key = `verdict-ready/${publicId}/${fnv1a64(to.toLowerCase())}`;
  return key.length <= 256 ? key : `verdict-ready/${fnv1a64(`${publicId}/${to.toLowerCase()}`)}`;
}

// The scheduler's notices (CHE-413): a watch's trial-paused and balance-used-up
// mails go to every recipient of the app, and a tick that failed on one address
// sends again on the next. The same rule as the verdict's key: one mail per
// notice and recipient, however many ticks try. `scope` names the notice and
// what makes it one notice (the watch, or the team and the window).
export function noticeIdempotencyKey(scope: string, to: string): string {
  const key = `${scope}/${fnv1a64(to.toLowerCase())}`;
  return key.length <= 256 ? key : `notice/${fnv1a64(`${scope}/${to.toLowerCase()}`)}`;
}

// 64-bit FNV-1a as hex: synchronous, the same in workerd and Node, and ample
// for telling a handful of addresses on one run apart.
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(s)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

interface WatchTrialPausedArgs {
  to: string;
  appSlug: string;
  apiKey?: string;
  from?: string;
  replyTo?: string;
  baseUrl?: string;
  idempotencyKey?: string;
}

// A 409 on a repeated key: the first attempt's mail went out. Sending again
// is exactly what the key prevents, so the repeat counts as sent.
async function refuseUnlessRepeat(res: Response, idempotencyKey: string | undefined): Promise<void> {
  if (res.ok) return;
  const detail = await res.text();
  if (res.status === 409 && idempotencyKey && detail.includes("invalid_idempotent_request")) return;
  throw new Error(`Resend send failed: ${res.status} ${detail}`);
}

// Sent once, by the scheduler, the first time it declines to run a watch whose
// free trial has run out (CHE-54), to the people who hear about the app's
// checks. Nothing is deleted and no setting changed — subscribing is all it
// takes for the next cron tick to pick the watch back up, so the mail says
// exactly that.
export async function sendWatchTrialPaused({
  to,
  appSlug,
  apiKey,
  from,
  replyTo,
  baseUrl,
  idempotencyKey,
}: WatchTrialPausedArgs): Promise<void> {
  const base = baseUrl ?? "http://localhost:3000";
  const url = `${base}/pricing`;
  const subject = `Your daily watch on ${appSlug} is paused`;

  if (!apiKey || !from) {

    console.log(`[email:dev] to=${to} subject="${subject}" url=${url}`);
    return;
  }

  const why = `You get this because you hear about the checks of ${appSlug}. Nothing else will follow unless the daily watch is turned back on.`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      ...replyToField(replyTo),
      html: htmlDocument(
        subject,
        `<p>Your free trial of Daily Watch on <strong>${escapeHtml(appSlug)}</strong> has ended, ` +
          `so we've paused the daily check.</p>` +
          `<p>Your app, its history and its settings are all still here — upgrade and ` +
          `the next check runs on schedule.</p>` +
          `<p><a href="${url}">Keep the daily watch running</a></p><p>— CheckMyApp</p>`,
        escapeHtml(why),
      ),
      // CHE-226: every message carries a plain-text twin; this one had none.
      text:
        `Your free trial of Daily Watch on ${appSlug} has ended, so we've paused the daily check.\n\n` +
        `Your app, its history and its settings are all still here — upgrade and the next check runs on schedule.\n\n` +
        `Keep the daily watch running: ${url}\n\n— CheckMyApp\n\n${why}`,
    }),
  });
  await refuseUnlessRepeat(res, idempotencyKey);
}

interface BalanceUsedUpArgs {
  to: string;
  appSlug: string;
  // balanceTooLowReason (src/lib/plans.ts): the balance, and both ways out.
  reason: string;
  apiKey?: string;
  from?: string;
  replyTo?: string;
  baseUrl?: string;
  idempotencyKey?: string;
}

// CHE-327: sent by the scheduler the first time in a window it declines to run
// a watch because the team's balance is used. Nothing is paused by a setting:
// a top-up, an upgrade, or the plan's next credit is all it takes for the next
// tick to run it, and the mail says exactly that.
export async function sendBalanceUsedUp({ to, appSlug, reason, apiKey, from, replyTo, baseUrl, idempotencyKey }: BalanceUsedUpArgs): Promise<void> {
  const base = baseUrl ?? "http://localhost:3000";
  const url = `${base}${BALANCE_PATH}`;
  const subject = `Recurring checks of ${appSlug} are paused`;

  if (!apiKey || !from) {
    console.log(`[email:dev] to=${to} subject="${subject}" url=${url}`);
    return;
  }

  const why = whyThisMail({ appSlug, recurring: true, base });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      ...replyToField(replyTo),
      html: htmlDocument(
        subject,
        `<p>${escapeHtml(reason)}</p>` +
          `<p>Until then the recurring checks of <strong>${escapeHtml(appSlug)}</strong> are paused. ` +
          `Nothing is lost — they pick up on their own as soon as the balance allows.</p>` +
          `<p><a href="${url}">Top up or upgrade</a></p><p>— CheckMyApp</p>`,
        why.html,
      ),
      text:
        `${reason}\n\nUntil then the recurring checks of ${appSlug} are paused. Nothing is lost — ` +
        `they pick up on their own as soon as the balance allows.\n\nTop up or upgrade: ${url}\n\n— CheckMyApp\n\n${why.text}`,
    }),
  });
  await refuseUnlessRepeat(res, idempotencyKey);
}

interface CauseNoticeArgs {
  to: string;
  appSlug: string;
  // The sentence the step shows (causeText) — the mail says the same thing.
  causeSentence: string;
  // What the admin does about it, and where; both absent when the cause asks nothing.
  actionText?: string;
  actionUrl?: string;
  // A few of the steps it kept unchecked, by name.
  stepLabels: string[];
  appUrl: string;
  apiKey?: string;
  from?: string;
  replyTo?: string;
  idempotencyKey?: string;
}

// CHE-443: sent to a team's admin the first time a cause keeps a step of an app
// from being checked — a store password that is missing, a rule that stops a
// check on purpose. One mail per cause and app, never one per run: the same
// cause on the next run sends nothing (CauseNotice is the memory of that, and
// the idempotency key the second belt). It describes the customer's product
// only and asks for access, never for verification work (CLAUDE.md §1, §2).
export async function sendCauseNotice({
  to,
  appSlug,
  causeSentence,
  actionText,
  actionUrl,
  stepLabels,
  appUrl,
  apiKey,
  from,
  replyTo,
  idempotencyKey,
}: CauseNoticeArgs): Promise<void> {
  const subject = `Part of ${appSlug} was not checked`;

  if (!apiKey || !from) {
    console.log(`[email:dev] to=${to} subject="${subject}" url=${actionUrl ?? appUrl}`);
    return;
  }

  const steps = stepLabels.slice(0, 3);
  const why = `You get this because you are an admin of the team that owns ${appSlug}. This is the only mail about this cause; the app's page keeps showing it for as long as it stands.`;
  const action =
    actionText && actionUrl
      ? `<p><a href="${escapeHtml(actionUrl)}">${escapeHtml(actionText)}</a></p>`
      : actionText
        ? `<p>${escapeHtml(actionText)}.</p>`
        : "";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      ...replyToField(replyTo),
      html: htmlDocument(
        subject,
        `<p>${escapeHtml(causeSentence)}</p>` +
          (steps.length ? `<p>Steps it kept unchecked: ${steps.map((l) => escapeHtml(l)).join("; ")}.</p>` : "") +
          action +
          `<p><a href="${escapeHtml(appUrl)}">Open ${escapeHtml(appSlug)}</a></p><p>— CheckMyApp</p>`,
        escapeHtml(why),
      ),
      text:
        `${causeSentence}\n\n` +
        (steps.length ? `Steps it kept unchecked: ${steps.join("; ")}.\n\n` : "") +
        (actionText ? `${actionText}${actionUrl ? `: ${actionUrl}` : "."}\n\n` : "") +
        `Open ${appSlug}: ${appUrl}\n\n— CheckMyApp\n\n${why}`,
    }),
  });
  await refuseUnlessRepeat(res, idempotencyKey);
}

interface TeamInviteArgs {
  to: string;
  teamName: string;
  // Who is asking. A name if we have one, their email otherwise — an invitation
  // from nobody in particular is the one that gets deleted unread.
  invitedBy: string;
  scope: string;
  acceptUrl: string;
  apiKey?: string;
  from?: string;
  replyTo?: string;
}

// CHE-341: what the web worker hands the agent's Mailer — the invitation
// without the key, sender and reply address, which only the agent worker holds.
export type TeamInviteMail = Omit<TeamInviteArgs, "apiKey" | "from" | "replyTo">;

// CHE-257: the invitation. It says who is asking, which team, what the reader
// will be able to do, and how long the link lasts — a person deciding whether
// to click should not have to open the app to find out what they are joining.
export async function sendTeamInvite({
  to,
  teamName,
  invitedBy,
  scope,
  acceptUrl,
  apiKey,
  from,
  replyTo,
}: TeamInviteArgs): Promise<string | null> {
  const subject = `${invitedBy} added you to ${teamName} on CheckMyApp`;
  const whatTheyCanDo =
    scope === "admin"
      ? "You will be able to run checks, change settings, manage the team and its billing."
      : scope === "member"
        ? "You will be able to run checks, change an app's settings and act on what we find."
        : "You will be able to read everything the team's checks find. Running a check is left to the others.";

  if (!apiKey || !from) {
    console.log(`[email:dev] to=${to} subject="${subject}" url=${acceptUrl}`);
    return null;
  }

  // Opening the link is safe by design (a mail scanner may do it); only the
  // Join button on that page creates the membership.
  const why = `You get this because ${invitedBy} entered this address. If you weren't expecting it, ignore this mail — nothing happens unless you choose Join on the invitation page.`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      ...replyToField(replyTo),
      html: htmlDocument(
        subject,
        `<p><strong>${escapeHtml(invitedBy)}</strong> added you to <strong>${escapeHtml(teamName)}</strong> on CheckMyApp.</p>` +
          `<p>CheckMyApp uses your team's apps the way a visitor would, every day, and tells you what broke.</p>` +
          `<p>${escapeHtml(whatTheyCanDo)}</p>` +
          `<p><a href="${acceptUrl}">Join ${escapeHtml(teamName)} →</a></p>` +
          `<p style="color:#666">The link works for 7 days.</p><p style="color:#666">— CheckMyApp</p>`,
        escapeHtml(why),
      ),
      text:
        `${invitedBy} added you to ${teamName} on CheckMyApp.\n\n` +
        `CheckMyApp uses your team's apps the way a visitor would, every day, and tells you what broke.\n\n` +
        `${whatTheyCanDo}\n\nJoin ${teamName}: ${acceptUrl}\n\nThe link works for 7 days.\n\n— CheckMyApp\n\n${why}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
  try {
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}

export interface FeedbackAnswerArgs {
  to: string;
  appSlug: string;
  // The author's own words, quoted back so they know which report this is.
  theirWords: string;
  outcome: "fixed" | "wont_fix";
  // What we found, when the check was right. Required for wont_fix.
  answer?: string | null;
  // Where to look: the verdict the report was about, or the app.
  url: string;
  apiKey?: string;
  from?: string;
  replyTo?: string;
  idempotencyKey?: string;
}

// The words of a feedback answer, shared by the mail and its guard (CHE-441).
export function feedbackAnswerCopy(a: Pick<FeedbackAnswerArgs, "appSlug" | "outcome" | "answer">): { subject: string; lead: string; detail: string } {
  if (a.outcome === "fixed") {
    return {
      subject: `Fixed: what you reported on ${a.appSlug}`,
      lead: `You told us the check of ${a.appSlug} got something wrong. We fixed it.`,
      detail: "The next check of the app runs with the fix.",
    };
  }
  return {
    subject: `About what you reported on ${a.appSlug}`,
    lead: `You told us the check of ${a.appSlug} got something wrong. We looked into it, and this time the check was right.`,
    detail: a.answer ?? "",
  };
}

// CHE-441: one mail to the person who reported a mistake of the check, when it
// is settled — fixed, or the check was right and here is what we found. The
// idempotency key is the row's, so a retried tick never mails twice.
export async function sendFeedbackAnswer(args: FeedbackAnswerArgs): Promise<void> {
  const copy = feedbackAnswerCopy(args);
  if (!args.apiKey || !args.from) {
    console.log(`[email:dev] to=${args.to} subject="${copy.subject}" url=${args.url}`);
    return;
  }
  const quote = args.theirWords.replace(/\s+/g, " ").trim().slice(0, 500);
  const why = "You get this because you reported this on CheckMyApp. Nothing else will follow about it.";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
      ...(args.idempotencyKey ? { "Idempotency-Key": args.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: args.from,
      to: [args.to],
      subject: copy.subject,
      ...replyToField(args.replyTo),
      html: htmlDocument(
        copy.subject,
        `<p>${escapeHtml(copy.lead)}</p>` +
          `<blockquote style="margin:12px 0;padding-left:12px">${escapeHtml(quote)}</blockquote>` +
          (copy.detail ? `<p>${escapeHtml(copy.detail)}</p>` : "") +
          `<p><a href="${escapeHtml(args.url)}">Open it on CheckMyApp</a></p><p>— CheckMyApp</p>`,
        escapeHtml(why),
      ),
      text: `${copy.lead}\n\n> ${quote}\n\n${copy.detail ? `${copy.detail}\n\n` : ""}Open it on CheckMyApp: ${args.url}\n\n— CheckMyApp\n\n${why}`,
    }),
  });
  await refuseUnlessRepeat(res, args.idempotencyKey);
}
