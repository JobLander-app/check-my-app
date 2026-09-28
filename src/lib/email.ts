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
      html:
        `<p style="margin:0 0 4px"><strong>${appSlug}</strong>${label ? ` — ${escapeHtml(label)}` : ""}</p>` +
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
      text:
        `${appSlug}${label ? ` — ${label}` : ""}\n\n` +
        (bottomLine ? `${bottomLine}\n\n` : "") +
        (metricAlerts?.length ? `${metricAlerts.join("\n")}\n\n` : "") +
        `See the evidence: ${url}\n\n— CheckMyApp`,
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
  return `verdict-ready/${publicId}/${to.toLowerCase()}`.slice(0, 256);
}

interface WatchTrialPausedArgs {
  to: string;
  appSlug: string;
  apiKey?: string;
  from?: string;
  baseUrl?: string;
}

// Sent once, by the scheduler, the first time it declines to run a watch whose
// free trial has run out (CHE-54). Nothing is deleted and no setting changed —
// subscribing is all it takes for the next cron tick to pick the watch back up,
// so the mail says exactly that.
export async function sendWatchTrialPaused({
  to,
  appSlug,
  apiKey,
  from,
  baseUrl,
}: WatchTrialPausedArgs): Promise<void> {
  const base = baseUrl ?? "http://localhost:3000";
  const url = `${base}/pricing`;
  const subject = `Your daily watch on ${appSlug} is paused`;

  if (!apiKey || !from) {
     
    console.log(`[email:dev] to=${to} subject="${subject}" url=${url}`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html:
        `<p>Your free trial of Daily Watch on <strong>${appSlug}</strong> has ended, ` +
        `so we've paused the daily check.</p>` +
        `<p>Your app, its history and its settings are all still here — upgrade and ` +
        `the next check runs on schedule.</p>` +
        `<p><a href="${url}">Keep the daily watch running</a></p><p>— CheckMyApp</p>`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

interface BalanceUsedUpArgs {
  to: string;
  appSlug: string;
  // balanceTooLowReason (src/lib/plans.ts): the balance, and both ways out.
  reason: string;
  apiKey?: string;
  from?: string;
  baseUrl?: string;
}

// CHE-327: sent by the scheduler the first time in a window it declines to run
// a watch because the team's balance is used. Nothing is paused by a setting:
// a top-up, an upgrade, or the plan's next credit is all it takes for the next
// tick to run it, and the mail says exactly that.
export async function sendBalanceUsedUp({ to, appSlug, reason, apiKey, from, baseUrl }: BalanceUsedUpArgs): Promise<void> {
  const base = baseUrl ?? "http://localhost:3000";
  const url = `${base}${BALANCE_PATH}`;
  const subject = `Recurring checks of ${appSlug} are paused`;

  if (!apiKey || !from) {
    console.log(`[email:dev] to=${to} subject="${subject}" url=${url}`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html:
        `<p>${escapeHtml(reason)}</p>` +
        `<p>Until then the recurring checks of <strong>${escapeHtml(appSlug)}</strong> are paused. ` +
        `Nothing is lost — they pick up on their own as soon as the balance allows.</p>` +
        `<p><a href="${url}">Top up or upgrade</a></p><p>— CheckMyApp</p>`,
      text:
        `${reason}\n\nUntil then the recurring checks of ${appSlug} are paused. Nothing is lost — ` +
        `they pick up on their own as soon as the balance allows.\n\nTop up or upgrade: ${url}\n\n— CheckMyApp`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
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
}

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

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html:
        `<p><strong>${escapeHtml(invitedBy)}</strong> added you to <strong>${escapeHtml(teamName)}</strong> on CheckMyApp.</p>` +
        `<p>CheckMyApp uses your team's apps the way a visitor would, every day, and tells you what broke.</p>` +
        `<p>${escapeHtml(whatTheyCanDo)}</p>` +
        `<p><a href="${acceptUrl}">Join ${escapeHtml(teamName)} →</a></p>` +
        `<p style="color:#666">The link works for 7 days.</p><p style="color:#666">— CheckMyApp</p>`,
      text:
        `${invitedBy} added you to ${teamName} on CheckMyApp.\n\n` +
        `CheckMyApp uses your team's apps the way a visitor would, every day, and tells you what broke.\n\n` +
        `${whatTheyCanDo}\n\nJoin ${teamName}: ${acceptUrl}\n\nThe link works for 7 days.\n\n— CheckMyApp`,
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
