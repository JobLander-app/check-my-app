// Telegram → D1: every message the owner writes to @checkmyapp_bot is stored
// as a `TelegramMessage` row (CHE-375). See src/lib/telegram.ts for why the
// chat is a production record.
//
// Inert until TELEGRAM_WEBHOOK_SECRET is set and setWebhook points here with
// that secret_token — returns 503 until then. Public route (verified by the
// shared secret Telegram echoes in a header, not by a session).
//
// Telegram retries a delivery until it gets a 2xx, so the row is keyed by
// update_id and a repeat is a no-op. A database failure answers 500: the retry
// is what keeps the message from being lost.
//
// The message text is never logged — not by us, and not by the framework,
// which is why no database error is rethrown from here.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db";
import {
  TELEGRAM_SECRET_HEADER,
  allowedChatIds,
  errorLabel,
  getTelegramEnv,
  incomingRow,
  isUniqueViolation,
  keepTelegramFile,
  secretMatches,
} from "@/lib/telegram";

export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const tg = getTelegramEnv(env as Record<string, unknown>);
  if (!tg.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("telegram webhook not configured", { status: 503 });
  }
  if (!(await secretMatches(req.headers.get(TELEGRAM_SECRET_HEADER), tg.TELEGRAM_WEBHOOK_SECRET))) {
    return new Response("invalid secret token", { status: 401 });
  }

  let update: unknown;
  try {
    update = await req.json();
  } catch {
    // Verified but unreadable: a retry would be just as unreadable.
    return new Response("ok", { status: 200 });
  }

  const row = incomingRow(update);
  if (!row || !allowedChatIds(tg).has(row.chatId)) return new Response("ok", { status: 200 });

  const db = getDb(env as unknown as { DB: D1Database });
  try {
    const existing = await db.telegramMessage.findUnique({ where: { updateId: row.updateId! }, select: { id: true } });
    if (!existing) {
      // CHE-427: a file is kept before the row is written, so the row says
      // where. A copy that cannot be made never costs the message: the row is
      // stored with Telegram's file id, and the reason is logged by label.
      if (row.fileId) {
        const bucket = (env as unknown as { EVIDENCE?: R2Bucket }).EVIDENCE;
        const kept =
          tg.TELEGRAM_BOT_TOKEN && bucket
            ? await keepTelegramFile(
                {
                  token: tg.TELEGRAM_BOT_TOKEN,
                  fetch,
                  put: (key, body, contentType) => bucket.put(key, body, contentType ? { httpMetadata: { contentType } } : undefined),
                },
                row,
              )
            : { error: tg.TELEGRAM_BOT_TOKEN ? "no bucket" : "no bot token" };
        if ("key" in kept) row.fileKey = kept.key;
        else console.warn(`telegram webhook: update ${row.updateId} file not kept (${kept.error})`);
      }
      await db.telegramMessage.create({ data: row });
    }
  } catch (err) {
    // Two deliveries of one update raced past the lookup; the unique key kept
    // one row, which is the outcome we wanted.
    if (isUniqueViolation(err)) return new Response("ok", { status: 200 });
    // Anything else: 500, so Telegram delivers it again. Handled here rather
    // than rethrown, because the framework would log the error's message, and
    // a Prisma error's message prints the row it refused — the owner's text.
    console.error(`telegram webhook: update ${row.updateId} not stored (${errorLabel(err)})`);
    return new Response("not stored", { status: 500 });
  }
  return new Response("ok", { status: 200 });
}
