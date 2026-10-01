// Telegram → D1: every message the owner writes to @checkmyapp_bot is stored
// as a `TelegramMessage` row (CHE-375). See src/lib/telegram.ts for why the
// chat is a production record.
//
// Inert until TELEGRAM_WEBHOOK_SECRET is set and setWebhook points here with
// that secret_token — returns 503 until then. Public route (verified by the
// shared secret Telegram echoes in a header, not by a session).
//
// Telegram retries a delivery until it gets a 2xx, so the row is keyed by
// update_id and a repeat is a no-op. A database failure is allowed to fail the
// request: the retry is what keeps the message from being lost.
//
// The message text is never logged.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db";
import {
  TELEGRAM_SECRET_HEADER,
  allowedChatIds,
  getTelegramEnv,
  incomingRow,
  isUniqueViolation,
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
  const existing = await db.telegramMessage.findUnique({ where: { updateId: row.updateId! }, select: { id: true } });
  if (!existing) {
    try {
      await db.telegramMessage.create({ data: row });
    } catch (err) {
      // Two deliveries of one update raced past the lookup; the unique key
      // kept one row, which is the outcome we wanted.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return new Response("ok", { status: 200 });
}
