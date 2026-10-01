// Send a message to a Telegram chat through @checkmyapp_bot and record it in D1
// as `direction = 'out'` (CHE-375), so both sides of the owner's conversation
// with CheckMyApp are in the database — the webhook stores his side.
//
//   npm run tg:send -- <chat_id> "<text>" [--send-id <id>]
//
// Needs, from the environment or .env:
//   TELEGRAM_BOT_TOKEN     the bot's token (GCP Secret Manager
//                          `checkmyapp-telegram-bot-token`)
//   CLOUDFLARE_API_TOKEN   to write the row through the D1 HTTP API
//   CLOUDFLARE_ACCOUNT_ID  optional; looked up from the token when absent
//
// The same text to the same chat is one send: a re-run is refused (exit 3)
// unless the earlier one failed. To say the same thing again on purpose, give
// a new --send-id. Exit 0 with a WARNING means it may have been delivered —
// look at the chat, do not re-run. Everything else is in
// src/lib/telegram-send.ts; this file only wires it to the process.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { cli } from "../src/lib/telegram-send";

function databaseId(): string {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const id = /"database_name"\s*:\s*"checkmyapp"[\s\S]*?"database_id"\s*:\s*"([0-9a-f-]+)"/.exec(config)?.[1];
  if (!id) throw new Error("wrangler.jsonc names no database_id for checkmyapp");
  return id;
}

cli(process.argv.slice(2), process.env, fetch, { out: (l) => console.log(l), err: (l) => console.error(l) }, databaseId)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`tg:send: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
