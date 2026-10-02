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
 * Idempotent for a retried Workflow step: the journey is written once.
 */
export async function completeSignedOut(
  env: Pick<AgentEnv, "db">,
  run: { id: string; targetUrl: string },
  host: string,
): Promise<"unverified"> {
  const existing = await env.db.journey.findFirst({ where: { runId: run.id, title: SIGNED_OUT_JOURNEY_TITLE }, select: { id: true } });
  if (!existing) {
    const journey = await env.db.journey.create({
      data: { runId: run.id, order: 0, title: SIGNED_OUT_JOURNEY_TITLE, status: "skipped", summary: signedOutObserved(host) },
    });
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
// identity is the sign-in that ended: the app, and the last run of it that got
// in. Until a run gets in again, every later run produces the same id, and
// sendRecorded (CHE-375) refuses an id it has already sent.

export function signedOutSendId(appSlug: string, lastRunThatGotIn: string | null): string {
  return `session-signed-out:${appSlug}:${lastRunThatGotIn ?? "never"}`;
}

export function signedOutMessage(appSlug: string, host: string, signInUrl: string | null): string {
  return (
    `Проверки ${appSlug} остановились: вход в аккаунт закончился, адрес приложения ведёт на ${host}. ` +
    `Нужно войти заново в браузере сессии${signInUrl ? ` — ${signInUrl}` : ""}. ` +
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

type TellBindings = Pick<AgentBindings, "DB" | "TELEGRAM_BOT_TOKEN" | "OWNER_TELEGRAM_CHAT_ID" | "SESSION_SIGN_IN_URL">;

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
    // The last run of this app that got past the sign-in. A run that ends here
    // (or at a closed door) spends nothing; one that went on to map and walk
    // spent something — so "got in" is "finished having spent", a fact on the
    // run's own row. Its id names the sign-in that has now ended.
    const gotIn = run.appId
      ? await env.db.run.findFirst({
          where: {
            appId: run.appId,
            targetKind: "session",
            id: { not: run.id },
            status: { in: ["completed", "partial"] },
            costUsd: { gt: 0 },
          },
          orderBy: { startedAt: "desc" },
          select: { id: true },
        })
      : null;
    sendId = signedOutSendId(run.appSlug, gotIn?.id ?? null);
  } catch (error) {
    return { told: "failed", sendId: "", detail: `could not tell which sign-in ended: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    const sent = await sendRecorded(
      deps ?? sendDeps(env.bindings, token as string),
      chatId,
      signedOutMessage(run.appSlug, host, env.bindings.SESSION_SIGN_IN_URL?.trim() || null),
      sendId,
    );
    return sent.status === "sent" ? { told: "sent", sendId } : { told: "unknown", sendId, detail: sent.warning ?? "outcome unknown" };
  } catch (error) {
    if (error instanceof AlreadySentError) return { told: "already", sendId };
    const detail = error instanceof Error ? error.message : String(error);
    return { told: error instanceof NotSentError ? "failed" : "unknown", sendId, detail };
  }
}
