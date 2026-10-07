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
  photo?: TgFile[];
  document?: TgFile;
  video?: TgFile;
  animation?: TgFile;
  voice?: TgFile;
  audio?: TgFile;
  video_note?: TgFile;
  sticker?: TgFile;
}

interface TgFile {
  file_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

// CHE-427: which file an incoming message carries. A photo arrives as several
// sizes; the largest is the one worth keeping (the owner's screenshot of an
// error is read, not glanced at). The first field present wins, in the order a
// person is likely to send them.
const FILE_FIELDS = ["photo", "document", "video", "animation", "voice", "audio", "video_note", "sticker"] as const;
export type TelegramFileKind = (typeof FILE_FIELDS)[number];

export function attachmentOf(m: TgMessage): { fileId: string; fileKind: TelegramFileKind } | null {
  for (const kind of FILE_FIELDS) {
    if (kind === "photo") {
      const sizes = (Array.isArray(m.photo) ? m.photo : []).filter((p) => typeof p?.file_id === "string" && p.file_id);
      if (!sizes.length) continue;
      // One unit for every size (Codex on #295): pixels, when every size
      // has them; otherwise Telegram's own order, which is smallest first.
      const sized = sizes.every((p) => typeof p.width === "number" && typeof p.height === "number");
      const largest = sized
        ? sizes.reduce((a, b) => (b.width! * b.height! >= a.width! * a.height! ? b : a))
        : sizes[sizes.length - 1];
      return { fileId: largest.file_id!, fileKind: "photo" };
    }
    const file = m[kind];
    if (file && typeof file.file_id === "string" && file.file_id) return { fileId: file.file_id, fileKind: kind };
  }
  return null;
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
  // Incoming only (CHE-427).
  fileId?: string | null;
  fileKind?: TelegramFileKind | null;
  fileKey?: string | null;
}

function nameOf(user: TgUser | undefined): string | null {
  if (!user) return null;
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return full || (user.username ? `@${user.username}` : null);
}

// Telegram's unix-seconds date, accepted only when it is a plausible one.
// `new Date(1e17 * 1000)` is an Invalid Date, and Prisma refuses it with an
// error whose message prints the whole row — the text included — into the
// log (cross-review of #221). Anything implausible is stamped with now.
const EARLIEST_SECONDS = Date.UTC(2013, 0, 1) / 1000; // before Telegram's Bot API
const LATEST_SECONDS = Date.UTC(2100, 0, 1) / 1000;
export function telegramTime(seconds: unknown): Date {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= EARLIEST_SECONDS && seconds < LATEST_SECONDS
    ? new Date(seconds * 1000)
    : new Date();
}

// What may be logged about a failure: its class and code. Never its message —
// a database error's message can carry the row it refused.
export function errorLabel(err: unknown): string {
  if (typeof err !== "object" || err === null) return typeof err;
  const name = "name" in err && typeof err.name === "string" ? err.name : "Error";
  const code = "code" in err && (typeof err.code === "string" || typeof err.code === "number") ? ` ${err.code}` : "";
  return `${name}${code}`;
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
  const seconds = edited && m.edit_date !== undefined ? m.edit_date : m.date;
  const file = attachmentOf(m);
  return {
    ...(file ? { fileId: file.fileId, fileKind: file.fileKind } : {}),
    updateId: String(u.update_id),
    messageId: m.message_id !== undefined ? String(m.message_id) : null,
    chatId: String(m.chat.id),
    direction: "in",
    fromName: nameOf(m.from),
    text: messageText(m),
    replyToText: reply ? messageText(reply).slice(0, REPLY_TO_MAX_CHARS) : null,
    edited,
    sentAt: telegramTime(seconds),
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
    sentAt: telegramTime(result.date),
  };
}

// CHE-427: the copy of an incoming file, kept where an agent can open it. Bot
// API getFile names the file's path, then the file is downloaded once (Bot API
// files are at most 20 MB) and put under private/ in R2, which /api/evidence
// never serves. Neither URL is ever logged or returned: both carry the bot
// token. Returns the R2 key, or a label of why there is none.
export const TELEGRAM_FILE_MAX_BYTES = 20 * 1024 * 1024;

const FILE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  txt: "text/plain",
};

export function telegramFileKey(row: { chatId: string; updateId: string | null; fileKind?: string | null }, filePath: string): string {
  const name = (filePath.split("/").pop() || "file").replace(/[^A-Za-z0-9._-]/g, "_");
  return `private/telegram/${row.chatId}/${row.updateId ?? "none"}/${row.fileKind ?? "file"}-${name}`;
}

export async function keepTelegramFile(
  deps: {
    token: string;
    fetch: typeof fetch;
    put: (key: string, body: ArrayBuffer, contentType: string | undefined) => Promise<unknown>;
  },
  row: { chatId: string; updateId: string | null; fileId?: string | null; fileKind?: string | null },
): Promise<{ key: string } | { error: string }> {
  if (!row.fileId) return { error: "no file" };
  const api = `https://api.telegram.org/bot${deps.token}`;
  let filePath: string;
  try {
    const answer = await deps.fetch(`${api}/getFile?file_id=${encodeURIComponent(row.fileId)}`);
    const body = (await answer.json().catch(() => null)) as { ok?: boolean; result?: { file_path?: string; file_size?: number } } | null;
    if (!answer.ok || !body?.ok || typeof body.result?.file_path !== "string") return { error: `getFile HTTP ${answer.status}` };
    if ((body.result.file_size ?? 0) > TELEGRAM_FILE_MAX_BYTES) return { error: "file too large" };
    filePath = body.result.file_path;
  } catch (err) {
    return { error: `getFile ${errorLabel(err)}` };
  }
  try {
    const file = await deps.fetch(`https://api.telegram.org/file/bot${deps.token}/${filePath}`);
    if (!file.ok) return { error: `download HTTP ${file.status}` };
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > TELEGRAM_FILE_MAX_BYTES) return { error: "file too large" };
    const key = telegramFileKey(row, filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    await deps.put(key, bytes, FILE_TYPES[ext]);
    return { key };
  } catch (err) {
    return { error: `download ${errorLabel(err)}` };
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}
