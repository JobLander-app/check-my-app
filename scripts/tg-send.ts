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
// The row is written before the send and with bound parameters, never by
// splicing the text into SQL — the order and its reasons are in
// src/lib/telegram-send.ts.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { sendRecorded } from "../src/lib/telegram-send";

function databaseId(): string {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const id = /"database_name"\s*:\s*"checkmyapp"[\s\S]*?"database_id"\s*:\s*"([0-9a-f-]+)"/.exec(config)?.[1];
  if (!id) throw new Error("wrangler.jsonc names no database_id for checkmyapp");
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
  if (!cfToken) throw new Error("CLOUDFLARE_API_TOKEN is not set — nothing can be recorded, so nothing is sent");
  const queryUrl = `https://api.cloudflare.com/client/v4/accounts/${await accountId(cfToken)}/d1/database/${databaseId()}/query`;

  const result = await sendRecorded(
    {
      d1: async (sql, params) => {
        const res = await fetch(queryUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ sql, params }),
        });
        const body = (await res.json()) as { success: boolean; errors?: unknown };
        if (!res.ok || !body.success) throw new Error(`D1 refused the statement: ${JSON.stringify(body.errors ?? res.status)}`);
      },
      sendMessage: async (to, message) => {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: to, text: message, disable_web_page_preview: true }),
        });
        return res.json();
      },
      // cuid-shaped enough for a primary key: unique, sortable by time.
      newId: () => `tg${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      now: () => new Date(),
    },
    chatId,
    text,
  );
  if (result.warning) console.warn(`tg:send: ${result.warning} (row ${result.id})`);
  console.log(`tg:send: sent message ${result.messageId} to ${chatId} (${text.length} chars), recorded as 'out' (row ${result.id})`);
}

main().catch((err) => {
  console.error(`tg:send: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
