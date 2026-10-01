// The owner's Telegram chat with @checkmyapp_bot, as a production record
// (CHE-375). Owner, 2026-10-01: «сообщения в тг должны сохраняться в базу
// checkmyapp и являться прод составляющей». The conversation used to live only
// in Telegram and be polled from a laptop; now both directions are rows in D1
// (`TelegramMessage`), readable by any agent and surviving any session.
//
// The bot is dedicated to CheckMyApp, so it can use a webhook. The shared
// JobLander Alerts bot could not: a webhook there would stop getUpdates for
// every other reader.
//
// Shared by the web route (src/app/api/webhooks/telegram/route.ts) and
// scripts/tg-send.ts, so nothing here imports anything Next-only.

export interface TelegramEnv {
  // The `secret_token` given to setWebhook; Telegram echoes it in
  // X-Telegram-Bot-Api-Secret-Token on every delivery. Unset → the route is
  // inert (503), the way the Stripe and Clerk webhooks are before their keys.
  TELEGRAM_WEBHOOK_SECRET?: string;
  // Comma-separated chat ids whose messages are stored. Unset → none are: an
  // open bot must not let a stranger write into our database.
  TELEGRAM_ALLOWED_CHAT_IDS?: string;
  // For sending (scripts/tg-send.ts). The route does not need it.
  TELEGRAM_BOT_TOKEN?: string;
}

export function getTelegramEnv(env: Record<string, unknown>): TelegramEnv {
  return {
    TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET as string | undefined,
    TELEGRAM_ALLOWED_CHAT_IDS: env.TELEGRAM_ALLOWED_CHAT_IDS as string | undefined,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN as string | undefined,
  };
}

export const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

export function allowedChatIds(env: TelegramEnv): Set<string> {
  return new Set(
    (env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

// Compares digests rather than the strings, so the time taken depends on
// neither the length of the guess nor how many leading characters it got right.
export async function secretMatches(given: string | null, expected: string): Promise<boolean> {
  if (!given) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Reply context is kept short: it is there to say which message was answered,
// not to store the conversation twice.
export const REPLY_TO_MAX_CHARS = 200;

interface TgUser {
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TgMessage {
  message_id?: number;
  date?: number;
  edit_date?: number;
  chat?: { id?: number | string };
  from?: TgUser;
  text?: string;
  caption?: string;
  reply_to_message?: { text?: string; caption?: string };
}

export interface StoredTelegramMessage {
  // Telegram's ids are kept as text: they may outgrow 32 bits, which is what
  // Prisma's Int is, and nothing does arithmetic on them.
  updateId: string | null;
  messageId: string | null;
  chatId: string;
  direction: "in" | "out";
  fromName: string | null;
  text: string;
  replyToText: string | null;
  edited: boolean;
  sentAt: Date;
}

function nameOf(user: TgUser | undefined): string | null {
  if (!user) return null;
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return full || (user.username ? `@${user.username}` : null);
}

// A message without text is a photo, a voice note, a sticker…: the record says
// that something was sent, and keeps the caption when there is one.
export function messageText(m: { text?: string; caption?: string }): string {
  if (typeof m.text === "string" && m.text.length > 0) return m.text;
  return typeof m.caption === "string" && m.caption.length > 0 ? `<media> ${m.caption}` : "<media>";
}

// The row an incoming update becomes, or null when it is not a message we
// record (callback queries, channel posts, member updates, anything else).
export function incomingRow(update: unknown): StoredTelegramMessage | null {
  if (typeof update !== "object" || update === null) return null;
  const u = update as { update_id?: unknown; message?: TgMessage; edited_message?: TgMessage };
  if (typeof u.update_id !== "number" && typeof u.update_id !== "string") return null;
  const edited = !u.message && Boolean(u.edited_message);
  const m = u.message ?? u.edited_message;
  if (!m || m.chat?.id === undefined || m.chat.id === null) return null;
  const reply = m.reply_to_message;
  const seconds = (edited ? m.edit_date : undefined) ?? m.date;
  return {
    updateId: String(u.update_id),
    messageId: m.message_id !== undefined ? String(m.message_id) : null,
    chatId: String(m.chat.id),
    direction: "in",
    fromName: nameOf(m.from),
    text: messageText(m),
    replyToText: reply ? messageText(reply).slice(0, REPLY_TO_MAX_CHARS) : null,
    edited,
    sentAt: typeof seconds === "number" ? new Date(seconds * 1000) : new Date(),
  };
}

// The row a message we sent becomes, from Bot API sendMessage's `result`.
export function outgoingRow(result: TgMessage, chatId: string): StoredTelegramMessage {
  return {
    updateId: null,
    messageId: result.message_id !== undefined ? String(result.message_id) : null,
    chatId: String(result.chat?.id ?? chatId),
    direction: "out",
    fromName: nameOf(result.from),
    text: messageText(result),
    replyToText: result.reply_to_message ? messageText(result.reply_to_message).slice(0, REPLY_TO_MAX_CHARS) : null,
    edited: false,
    sentAt: typeof result.date === "number" ? new Date(result.date * 1000) : new Date(),
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}
