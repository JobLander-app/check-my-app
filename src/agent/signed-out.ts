// A check that runs inside a signed-in session, on a day the sign-in has ended
// (CHE-389).
//
// Some apps are checked in a browser a person signed in to (session-browser.ts)
// — the Shopify admin's sign-in has a captcha, which we never solve. Sign-ins
// end: the product expires them, or asks again. From then on the app's address
// leads to the product's sign-in page, and a run that went on would map and
// walk that page and report on it as if it were the app — the closed door of
// CHE-390 (closed-door.ts) in another coat: a claim about the customer's
// product resting on our not getting in (rule 8).
//
// So it is decided where it is first met — by the surface scan, in code, before
// a model sees anything — and the run ends there: Not verified, nothing spent,
// nothing charged, no finding possible. Unlike a closed door this is not a gap
// in what we can do: it is access, the one thing we may ask for (rule 2). The
// person who signs in is told once per ended sign-in, not once per run.
//
// What counts: the app's address, opened in the session, ended on an origin
// that is neither the app's nor one the owner allowed for it. An address that
// stays on the app and shows something unexpected is the app answering, and
// the walk reads it as it always did.
//
// No Playwright and no `cloudflare:workers` here, so
// scripts/verify-signed-out.ts drives these exact functions.

import { AlreadySentError, NotSentError, sendRecorded, type SendDeps } from "@/lib/telegram-send";
import { noticeIdempotencyKey, sendSignInEnded } from "@/lib/email";
import { describeRecipients, recipientsForApp, type RecipientResolution } from "@/lib/recipients";
import type { PrismaClient } from "@/generated/prisma/client";
import type { AgentBindings, AgentEnv } from "./env";

/** Where the app's address led when it did not lead to the app; null = it led to the app. */
export function landedOutside(landedUrl: string, targetUrl: string, allowedOrigins: readonly string[]): string | null {
  let landed: URL;
  let target: URL;
  try {
    landed = new URL(landedUrl);
    target = new URL(targetUrl);
  } catch {
    return null;
  }
  // An error page or a blank tab is not "somewhere else": that is a load that
  // failed, and it fails the way it always did.
  if (landed.protocol !== "https:" && landed.protocol !== "http:") return null;
  const origin = landed.origin.toLowerCase();
  if (origin === target.origin.toLowerCase()) return null;
  if (allowedOrigins.some((allowed) => allowed.toLowerCase() === origin)) return null;
  return landed.host.toLowerCase();
}

// ── where the address settled ──
//
// One look at the address is not enough, in either direction. A product may
// send a signed-out visitor to its sign-in from a script, after the first
// document has loaded — so "it loaded on the app" is not yet "it is the app".
// And a sign-in that is perfectly alive may leave the app for a moment — a
// single-sign-on or token-refresh bounce through the identity host — and come
// straight back; the first outside address is then not where it ended, and
// calling it "signed out" would end a good run and tell a person to sign in
// who is signed in (Codex on #253). So the address is watched until it has
// stayed put: on the app for the whole watch → the app; away, and still away
// after a while without coming back → the sign-in has ended.
export const SIGN_IN_WATCH_MS = 5_000;
export const SIGN_IN_AWAY_MS = 4_000;
export const SIGN_IN_LIMIT_MS = 20_000;
const SIGN_IN_LOOK_MS = 250;

/** → the host the address settled on when that is not the app; null when it settled on the app. */
export async function whereItSettled(
  address: () => string,
  outside: (url: string) => string | null,
  wait: (ms: number) => Promise<unknown>,
  now: () => number = Date.now,
): Promise<string | null> {
  const started = now();
  let awaySince: number | null = null;
  let onAppSince: number | null = null;
  for (;;) {
    const at = now();
    if (outside(address()) !== null) {
      onAppSince = null;
      awaySince ??= at;
      if (at - awaySince >= SIGN_IN_AWAY_MS) break;
    } else {
      // Counted from when it last came to the app, not from the start: an
      // address that was just away has to stay before it is believed.
      awaySince = null;
      onAppSince ??= at;
      if (at - onAppSince >= SIGN_IN_WATCH_MS) break;
    }
    // An address that keeps moving is judged where it stands when time is up.
    if (at - started >= SIGN_IN_LIMIT_MS) break;
    await wait(SIGN_IN_LOOK_MS);
  }
  return outside(address());
}

// Customer-facing. What happened at their address, that it is not a verdict,
// that it cost nothing, and the one thing rule 2 lets us ask for — access.
// Nothing about how we check.
export function signedOutBottomLine(host: string): string {
  return (
    `We could not check your app this run: its address led to ${host} instead of the app, because the ` +
    "sign-in this check uses has ended. Nothing was checked, so this is not a verdict on your app, " +
    "and this check was not charged. Once the sign-in is renewed, the next check runs as usual."
  );
}

export function signedOutObserved(host: string): string {
  return `The app's address led to ${host} instead of the app: the sign-in this check uses has ended. Nothing behind it was checked this run.`;
}

export const SIGNED_OUT_JOURNEY_TITLE = "Open the app while signed in";
export const SIGNED_OUT_STEP_LABEL = "Open the app's first page";
export const SIGNED_OUT_FEED = "The app asked for a sign-in before anything loaded — nothing to check this run";

/**
 * End the run at the sign-in page: one journey with one skipped step that says
 * access is missing, verdict Not verified, cost 0 (so priceRun prices it 0).
 * Idempotent for a retried Workflow step, write by write: the journey is
 * written once and so is its step — a retry after the journey was written and
 * the step was not finds the journey and still owes the step (a journey with
 * no step would publish Not verified with nothing saying why; Codex on #253).
 */
export async function completeSignedOut(
  env: Pick<AgentEnv, "db">,
  run: { id: string; targetUrl: string },
  host: string,
): Promise<"unverified"> {
  const journey =
    (await env.db.journey.findFirst({ where: { runId: run.id, title: SIGNED_OUT_JOURNEY_TITLE }, select: { id: true } })) ??
    (await env.db.journey.create({
      data: { runId: run.id, order: 0, title: SIGNED_OUT_JOURNEY_TITLE, status: "skipped", summary: signedOutObserved(host) },
      select: { id: true },
    }));
  const step = await env.db.step.findFirst({ where: { journeyId: journey.id }, select: { id: true } });
  if (!step) {
    await env.db.step.create({
      data: {
        journeyId: journey.id,
        order: 0,
        label: SIGNED_OUT_STEP_LABEL,
        status: "skipped",
        attempted: `Opened ${run.targetUrl}`,
        observed: signedOutObserved(host),
        unverifiedReason: "missing_access",
      },
    });
  }
  await env.db.run.update({
    where: { id: run.id },
    data: {
      status: "partial",
      verdict: "unverified",
      bottomLine: signedOutBottomLine(host),
      errorMessage: null,
      currentAction: null,
      completedAt: new Date(),
      costUsd: 0,
    },
  });
  return "unverified";
}

// ─── Telling the person who signs in ─────────────────────────────────────────
//
// One message per ended sign-in. Every run of the app meets the same sign-in
// page until someone signs in again — a daily check would otherwise write every
// day, and the rule for this chat is "do not repeat yourself". So the message's
// identity is the sign-in that ended: the app, and when a check last reached
// it. Until a check reaches the app again, every later run produces the same
// id, and sendRecorded (CHE-375) refuses an id it has already sent.
//
// "Reached" is written by the surface scan itself (noteSessionReached, on the
// app's own row), the moment the address turned out to lead to the app — not
// worked out afterwards from how runs ended. A run that got in and then failed
// in discovery is still a sign-in that worked; counted by finished runs, the
// next ended sign-in looked like the previous one and its message was
// swallowed (Codex on #253).

/** The scan of a session run reached the app: this sign-in works as of now. */
export async function noteSessionReached(env: Pick<AgentEnv, "db">, run: { appId: string | null }, at: Date = new Date()): Promise<void> {
  if (!run.appId) return;
  await env.db.app.update({ where: { id: run.appId }, data: { sessionReachedAt: at } });
}

// The app is named by its id, not its address: two owners' apps can share a
// slug, and an app deleted and added again is a new app — while a send id is
// unique across everyone. Keyed on the slug, the second app's first ended
// sign-in ("…:never") would look already told (Codex on #253).
export function signedOutSendId(appId: string, reachedAt: Date | null): string {
  return `session-signed-out:${appId}:${reachedAt ? reachedAt.toISOString() : "never"}`;
}

export function signedOutMessage(appSlug: string, host: string, signInUrl: string | null): string {
  return (
    `Проверки ${appSlug} остановились: вход в аккаунт закончился, адрес приложения ведёт на ${host}. ` +
    `Нужно войти заново${signInUrl ? ` — ${signInUrl}` : " в браузере сессии"}. ` +
    "Отвечать не нужно: следующая проверка пойдёт сама, как только вход будет на месте."
  );
}

export type OwnerTold =
  | { told: "sent"; sendId: string }
  // This ended sign-in was already reported; nothing was sent now.
  | { told: "already"; sendId: string }
  // The channel is not configured on this Worker; nothing was sent.
  | { told: "off" }
  // Not sent, or possibly sent — said in `detail`, never retried here.
  | { told: "failed" | "unknown"; sendId: string; detail: string };

type TellBindings = Pick<AgentBindings, "DB" | "TELEGRAM_BOT_TOKEN" | "OWNER_TELEGRAM_CHAT_ID" | "SESSION_SIGN_IN_URL" | "APP_URL">;

// CHE-419: where the person signs in again — the app's own sign-in page on
// checkmyapp.dev (a live view of the session browser, paste that works), not
// the VNC console. A run with no saved app has no such page; it keeps the
// configured address.
export function signInUrlFor(bindings: Pick<TellBindings, "SESSION_SIGN_IN_URL" | "APP_URL">, appId: string | null): string | null {
  if (appId) return `${(bindings.APP_URL ?? "https://checkmyapp.dev").replace(/\/+$/, "")}/health/apps/${appId}/sign-in`;
  return bindings.SESSION_SIGN_IN_URL?.trim() || null;
}

function sendDeps(bindings: TellBindings, token: string): SendDeps {
  return {
    d1: async (sql, params) => {
      const answer = await bindings.DB.prepare(sql).bind(...params).all();
      return { results: (answer.results ?? []) as Record<string, unknown>[], changes: answer.meta?.changes ?? 0 };
    },
    sendMessage: async (chatId, text) => {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      return response.json();
    },
    newId: () => `tg${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    now: () => new Date(),
  };
}

/**
 * Tell the person who signs in — once for this ended sign-in. Never throws: a
 * message that could not be sent must not turn a finished run into a failed
 * one. `deps` is for the guard; the Worker builds its own from its bindings.
 */
export async function tellOwnerSignedOut(
  env: { db: AgentEnv["db"]; bindings: TellBindings },
  run: { id: string; appId: string | null; appSlug: string },
  host: string,
  deps?: SendDeps,
): Promise<OwnerTold> {
  const token = env.bindings.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.bindings.OWNER_TELEGRAM_CHAT_ID?.trim();
  if (!deps && (!token || !chatId)) return { told: "off" };
  if (!chatId) return { told: "off" };

  let sendId: string;
  try {
    // When a check last reached this app names the sign-in that has now ended.
    const app = run.appId ? await env.db.app.findUnique({ where: { id: run.appId }, select: { sessionReachedAt: true } }) : null;
    const reachedAt = app?.sessionReachedAt ? new Date(app.sessionReachedAt) : null;
    // A run with no saved app has no sign-in history to name; it is its own.
    sendId = signedOutSendId(run.appId ?? `run:${run.id}`, reachedAt);
  } catch (error) {
    return { told: "failed", sendId: "", detail: `could not tell which sign-in ended: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    const sent = await sendRecorded(
      deps ?? sendDeps(env.bindings, token as string),
      chatId,
      signedOutMessage(run.appSlug, host, signInUrlFor(env.bindings, run.appId)),
      sendId,
    );
    return sent.status === "sent" ? { told: "sent", sendId } : { told: "unknown", sendId, detail: sent.warning ?? "outcome unknown" };
  } catch (error) {
    if (error instanceof AlreadySentError) return { told: "already", sendId };
    const detail = error instanceof Error ? error.message : String(error);
    return { told: error instanceof NotSentError ? "failed" : "unknown", sendId, detail };
  }
}

// ─── Telling a team (CHE-428) ────────────────────────────────────────────────
//
// Since each team signs in in a browser of its own (CHE-426), the person who
// signs in is not always our owner. Slot "main" is ours: its message stays the
// Telegram one above. Any other slot is a team's, and it is told by mail — the
// people who hear the app's verdicts (src/lib/recipients.ts), the same list and
// not a new address — once per ended sign-in, with the app's sign-in page.
//
// Once: the provider's idempotency key forgets a repeat after a day, and a
// daily check meets the same ended sign-in every day. So the app's row keeps
// the ended sign-in its recipients were mailed about (App.sessionEndedTold),
// written only when every mail went out; a failure is mailed again by the next
// run, and the key keeps a same-day retry from reaching anyone twice.

export const OUR_SLOT = "main";

export type SignInMail = (to: string, mail: { appSlug: string; host: string; signInUrl: string }, idempotencyKey: string) => Promise<void>;

type MailBindings = Pick<AgentBindings, "EMAIL_API_KEY" | "EMAIL_FROM" | "EMAIL_REPLY_TO" | "APP_URL" | "SESSION_SIGN_IN_URL">;

export type TeamTold =
  | { told: "sent"; sendId: string; recipients: string }
  | { told: "already"; sendId: string }
  | { told: "off"; detail: string }
  | { told: "failed"; sendId: string; detail: string };

export async function tellTeamSignedOut(
  env: { db: AgentEnv["db"]; bindings: MailBindings },
  run: { appId: string | null; appSlug: string },
  host: string,
  deps?: { mail?: SignInMail; recipients?: (appId: string) => Promise<RecipientResolution> },
): Promise<TeamTold> {
  if (!run.appId) return { told: "off", detail: "no saved app, so no one to mail" };
  const appId = run.appId;
  const key = env.bindings.EMAIL_API_KEY;
  const from = env.bindings.EMAIL_FROM;
  const mail: SignInMail | null =
    deps?.mail ??
    (key && from
      ? (to, m, idempotencyKey) =>
          sendSignInEnded({ to, ...m, apiKey: key, from, replyTo: env.bindings.EMAIL_REPLY_TO, baseUrl: env.bindings.APP_URL, idempotencyKey })
      : null);
  if (!mail) return { told: "off", detail: "this worker has no EMAIL_API_KEY or EMAIL_FROM" };

  let sendId: string;
  try {
    const app = await env.db.app.findUnique({ where: { id: appId }, select: { sessionReachedAt: true, sessionEndedTold: true } });
    sendId = signedOutSendId(appId, app?.sessionReachedAt ? new Date(app.sessionReachedAt) : null);
    if (app?.sessionEndedTold === sendId) return { told: "already", sendId };
  } catch (error) {
    return { told: "failed", sendId: "", detail: `could not tell which sign-in ended: ${error instanceof Error ? error.message : String(error)}` };
  }

  const signInUrl = signInUrlFor(env.bindings, appId)!;
  let resolution: RecipientResolution;
  try {
    resolution = await (deps?.recipients ?? ((id) => recipientsForApp(env.db as unknown as PrismaClient, id)))(appId);
  } catch (error) {
    return { told: "failed", sendId, detail: `could not resolve recipients: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (resolution.to.length === 0) return { told: "failed", sendId, detail: describeRecipients(resolution) };

  const failed: string[] = [];
  for (const to of resolution.to) {
    try {
      await mail(to, { appSlug: run.appSlug, host, signInUrl }, noticeIdempotencyKey(sendId, to));
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failed.length) return { told: "failed", sendId, detail: `${failed.length} of ${resolution.to.length} not sent: ${failed[0]}` };
  try {
    await env.db.app.update({ where: { id: appId }, data: { sessionEndedTold: sendId } });
  } catch (error) {
    // Sent, but not recorded: the next run mails again (within a day the
    // provider's key still holds it). Said, so it is seen.
    return { told: "sent", sendId, recipients: `${describeRecipients(resolution)}; not recorded: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { told: "sent", sendId, recipients: describeRecipients(resolution) };
}
