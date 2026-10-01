// Send a message to a Telegram chat through @checkmyapp_bot and record it in D1
// as `direction = 'out'` (CHE-375), so both sides of the owner's conversation
// with CheckMyApp are in the database — the webhook stores his side.
//
//   npm run tg:send -- <chat_id> "<text>"
//
// Needs, from the environment or .env:
//   TELEGRAM_BOT_TOKEN     the bot's token (GCP Secret Manager
//                          `checkmyapp-telegram-bot-token`)
//   CLOUDFLARE_API_TOKEN   to write the row through the D1 HTTP API
//   CLOUDFLARE_ACCOUNT_ID  optional; looked up from the token when absent
//
// The row is written with bound parameters, never by splicing the text into
// SQL. A message that was sent but could not be recorded exits non-zero and
// says so: the owner has read it, and the database must be made to agree.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { outgoingRow } from "../src/lib/telegram";

const D1_DATABASE = "checkmyapp";

function databaseId(): string {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const id = /"database_name"\s*:\s*"checkmyapp"[\s\S]*?"database_id"\s*:\s*"([0-9a-f-]+)"/.exec(config)?.[1];
  if (!id) throw new Error(`wrangler.jsonc names no database_id for ${D1_DATABASE}`);
  return id;
}

async function accountId(token: string): Promise<string> {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const res = await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json()) as { success: boolean; result?: { id: string }[] };
  const accounts = body.result ?? [];
  if (!body.success || accounts.length !== 1) {
    throw new Error(`cannot tell which Cloudflare account to use (${accounts.length} visible) — set CLOUDFLARE_ACCOUNT_ID`);
  }
  return accounts[0].id;
}

// The text form Prisma's D1 adapter writes ("2026-10-01T17:38:44.011+00:00"),
// so rows from here and from the webhook sort together on createdAt.
function d1Time(d: Date): string {
  return d.toISOString().replace(/Z$/, "+00:00");
}

// cuid-shaped enough for a primary key: unique, sortable by time.
function rowId(): string {
  return `tg${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function main() {
  const [chatId, ...words] = process.argv.slice(2);
  const text = words.join(" ");
  if (!chatId || !/^-?\d+$/.test(chatId) || !text) {
    console.error('usage: npm run tg:send -- <chat_id> "<text>"');
    process.exit(2);
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (!cfToken) throw new Error("CLOUDFLARE_API_TOKEN is not set — the message would be sent and not recorded");
  // Resolved before sending, so a message is never sent that cannot be recorded
  // for a reason we could have known first.
  const account = await accountId(cfToken);
  const database = databaseId();

  const sent = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const sentBody = (await sent.json()) as { ok: boolean; description?: string; result?: Parameters<typeof outgoingRow>[0] };
  if (!sentBody.ok || !sentBody.result) throw new Error(`Telegram refused the message: ${sentBody.description ?? sent.status}`);

  const row = outgoingRow(sentBody.result, chatId);
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sql:
        'INSERT INTO "TelegramMessage" ("id", "updateId", "messageId", "chatId", "direction", "fromName", "text", "replyToText", "edited", "sentAt", "createdAt") ' +
        "VALUES (?, NULL, ?, ?, 'out', ?, ?, ?, 0, ?, ?)",
      params: [rowId(), row.messageId, row.chatId, row.fromName, row.text, row.replyToText, d1Time(row.sentAt), d1Time(new Date())],
    }),
  });
  const body = (await res.json()) as { success: boolean; errors?: unknown };
  if (!res.ok || !body.success) {
    throw new Error(`sent (message ${row.messageId}) but NOT recorded in D1: ${JSON.stringify(body.errors ?? res.status)}`);
  }
  console.log(`tg:send: sent message ${row.messageId} to ${row.chatId} (${row.text.length} chars) and recorded it as 'out'`);
}

main().catch((err) => {
  console.error(`tg:send: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
