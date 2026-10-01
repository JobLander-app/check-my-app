// Sending to the owner's chat and recording it in D1 (CHE-375). The flow and
// the command line live here; scripts/tg-send.ts only calls cli(), and
// scripts/verify-telegram-webhook.ts runs both against fakes.
//
// A sent message cannot be unsent, and the owner's rule for this chat is "do
// not repeat yourself". So every send has a sendId — by default a hash of chat
// and text — and a row whose status says how far it got:
//
//   pending  written, send not attempted yet   → a re-run may send it
//   unknown  send attempted, outcome not known → a re-run refuses
//   sent     Telegram confirmed it             → a re-run refuses
//   failed   Telegram refused it               → a re-run may send it
//
// The row moves pending → unknown in a conditional UPDATE before the send, so
// two runs racing on one sendId cannot both send. Whenever the message may
// have been delivered (a timeout, a lost response, a lost final write) the
// result is a warning, not an error: an error invites a retry, and a retry is
// exactly the duplicate this exists to prevent (Codex and cross-review of #221).

import { outgoingRow } from "./telegram";

export type SendStatus = "pending" | "unknown" | "sent" | "failed";

export interface D1Result {
  results: Record<string, unknown>[];
  changes: number;
}

export interface SendDeps {
  // One SQL statement with bound parameters against the checkmyapp D1.
  d1(sql: string, params: unknown[]): Promise<D1Result>;
  // Bot API sendMessage; returns its JSON body. Must give up on its own
  // (a timeout) rather than hang: a run killed mid-send learns nothing.
  sendMessage(chatId: string, text: string): Promise<{ ok: boolean; description?: string; result?: Parameters<typeof outgoingRow>[0] }>;
  newId(): string;
  now(): Date;
}

// Nothing was sent; running again is safe.
export class NotSentError extends Error {}
// A send with this sendId already happened or may have; nothing was sent now.
export class AlreadySentError extends Error {}

export interface SendResult {
  id: string;
  sendId: string;
  status: "sent" | "unknown";
  messageId: string | null;
  warning?: string;
}

// The text form Prisma's D1 adapter writes ("2026-10-01T17:38:44.011+00:00"),
// so rows from here and from the webhook sort together on createdAt.
export function d1Time(d: Date): string {
  return d.toISOString().replace(/Z$/, "+00:00");
}

export async function defaultSendId(chatId: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${chatId}\n${text}`));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const SELECT_BY_SEND_ID = 'SELECT "id", "status" FROM "TelegramMessage" WHERE "sendId" = ?';

async function findBySendId(deps: SendDeps, sendId: string): Promise<{ id: string; status: SendStatus } | null> {
  const { results } = await deps.d1(SELECT_BY_SEND_ID, [sendId]);
  const row = results[0];
  return row ? { id: String(row.id), status: row.status as SendStatus } : null;
}

export async function sendRecorded(deps: SendDeps, chatId: string, text: string, sendId: string): Promise<SendResult> {
  const now = d1Time(deps.now());

  // 1 — the row, written before anything is sent.
  let existing: Awaited<ReturnType<typeof findBySendId>>;
  try {
    existing = await findBySendId(deps, sendId);
  } catch (err) {
    throw new NotSentError(`D1 could not be read (${message(err)}); nothing was sent`);
  }
  if (existing && (existing.status === "sent" || existing.status === "unknown")) {
    throw new AlreadySentError(`send ${sendId} is already ${existing.status} (row ${existing.id}); not sending it again`);
  }
  let id: string;
  if (existing) {
    id = existing.id;
    try {
      await deps.d1(
        'UPDATE "TelegramMessage" SET "status" = \'pending\', "chatId" = ?, "text" = ?, "sentAt" = ? WHERE "id" = ? AND "status" = ?',
        [chatId, text, now, id, existing.status],
      );
    } catch (err) {
      throw new NotSentError(`D1 refused to reopen row ${id} (${message(err)}); nothing was sent`);
    }
  } else {
    id = deps.newId();
    try {
      await deps.d1(
        'INSERT INTO "TelegramMessage" ("id", "updateId", "messageId", "chatId", "direction", "fromName", "text", "replyToText", "edited", "sendId", "status", "sentAt", "createdAt") ' +
          "VALUES (?, NULL, NULL, ?, 'out', NULL, ?, NULL, 0, ?, 'pending', ?, ?)",
        [id, chatId, text, sendId, now, now],
      );
    } catch (err) {
      // The write may have landed and only its answer been lost — or another
      // run on the same sendId wrote first. Ask.
      const landed = await findBySendId(deps, sendId).catch(() => null);
      if (landed?.status === "sent" || landed?.status === "unknown") {
        throw new AlreadySentError(`send ${sendId} is already ${landed.status} (row ${landed.id}); not sending it again`);
      }
      if (landed?.status !== "pending") throw new NotSentError(`D1 refused the row (${message(err)}); nothing was sent`);
      id = landed.id;
    }
  }

  // 2 — the claim: pending → unknown, only if still pending. A second run on
  // the same sendId finds 0 rows changed and sends nothing.
  let claimed: number;
  try {
    claimed = (await deps.d1('UPDATE "TelegramMessage" SET "status" = \'unknown\' WHERE "id" = ? AND "status" = \'pending\'', [id])).changes;
  } catch (err) {
    const after = await findBySendId(deps, sendId).catch(() => null);
    if (after?.status !== "unknown") throw new NotSentError(`D1 refused the claim on row ${id} (${message(err)}); nothing was sent`);
    claimed = 1;
  }
  if (claimed !== 1) throw new AlreadySentError(`send ${sendId} was claimed by another run (row ${id}); not sending it`);

  // 3 — the send.
  let sent: Awaited<ReturnType<SendDeps["sendMessage"]>>;
  try {
    sent = await deps.sendMessage(chatId, text);
  } catch (err) {
    return {
      id, sendId, status: "unknown", messageId: null,
      warning: `send outcome unknown (${message(err)}); row ${id} stays 'unknown' — look at the chat before sending again`,
    };
  }
  if (!sent.ok || !sent.result) {
    const reason = `Telegram refused the message: ${sent.description ?? "no result"}`;
    try {
      await deps.d1('UPDATE "TelegramMessage" SET "status" = \'failed\' WHERE "id" = ?', [id]);
    } catch (err) {
      throw new Error(`${reason}; and row ${id} could not be marked 'failed' (${message(err)}), so it stays 'unknown'`);
    }
    throw new NotSentError(reason);
  }

  // 4 — confirmed.
  const row = outgoingRow(sent.result, chatId);
  try {
    await deps.d1(
      'UPDATE "TelegramMessage" SET "status" = \'sent\', "messageId" = ?, "chatId" = ?, "fromName" = ?, "text" = ?, "replyToText" = ?, "sentAt" = ? WHERE "id" = ?',
      [row.messageId, row.chatId, row.fromName, row.text, row.replyToText, d1Time(row.sentAt), id],
    );
  } catch (err) {
    return {
      id, sendId, status: "unknown", messageId: row.messageId,
      warning: `sent as message ${row.messageId}, but row ${id} could not be marked 'sent' (${message(err)}) and stays 'unknown'`,
    };
  }
  return { id, sendId, status: "sent", messageId: row.messageId };
}

// ─── The command line ────────────────────────────────────────────────────────

export const USAGE = 'usage: npm run tg:send -- <chat_id> "<text>" [--send-id <id>]';
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

// Exit codes: 0 sent, or possibly sent with a warning (never retry on those) ·
// 1 not sent, safe to retry · 2 usage · 3 refused: this send already happened
// or may have.
export async function cli(
  argv: string[],
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  io: CliIo,
  databaseId: () => string,
): Promise<number> {
  const args = [...argv];
  let sendIdArg: string | undefined;
  const flag = args.indexOf("--send-id");
  if (flag >= 0) {
    sendIdArg = args[flag + 1];
    args.splice(flag, 2);
    if (!sendIdArg) {
      io.err(USAGE);
      return 2;
    }
  }
  const [chatId, ...words] = args;
  const text = words.join(" ");
  if (!chatId || !/^-?\d+$/.test(chatId) || !text) {
    io.err(USAGE);
    return 2;
  }

  try {
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const cfToken = env.CLOUDFLARE_API_TOKEN;
    if (!botToken) throw new NotSentError("TELEGRAM_BOT_TOKEN is not set");
    if (!cfToken) throw new NotSentError("CLOUDFLARE_API_TOKEN is not set — nothing can be recorded, so nothing is sent");
    const timeoutMs = Number(env.TELEGRAM_SEND_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

    let account = env.CLOUDFLARE_ACCOUNT_ID;
    if (!account) {
      const res = await fetchImpl("https://api.cloudflare.com/client/v4/accounts", {
        headers: { Authorization: `Bearer ${cfToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json()) as { success: boolean; result?: { id: string }[] };
      const accounts = body.result ?? [];
      if (!body.success || accounts.length !== 1) {
        throw new NotSentError(`cannot tell which Cloudflare account to use (${accounts.length} visible) — set CLOUDFLARE_ACCOUNT_ID`);
      }
      account = accounts[0].id;
    }
    const queryUrl = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId()}/query`;

    const result = await sendRecorded(
      {
        d1: async (sql, params) => {
          const res = await fetchImpl(queryUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sql, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          const body = (await res.json()) as {
            success: boolean;
            errors?: unknown;
            result?: { results?: Record<string, unknown>[]; meta?: { changes?: number } }[];
          };
          if (!res.ok || !body.success) throw new Error(`D1 refused the statement: ${JSON.stringify(body.errors ?? res.status)}`);
          const first = body.result?.[0];
          return { results: first?.results ?? [], changes: first?.meta?.changes ?? 0 };
        },
        sendMessage: async (to, msg) => {
          const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: to, text: msg, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          return res.json();
        },
        newId: () => `tg${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
        now: () => new Date(),
      },
      chatId,
      text,
      sendIdArg ?? (await defaultSendId(chatId, text)),
    );
    if (result.warning) {
      io.err(`tg:send: WARNING ${result.warning} (send ${result.sendId}). Do not re-run blindly.`);
    } else {
      io.out(`tg:send: sent message ${result.messageId} to ${chatId} (${text.length} chars), row ${result.id} 'sent' (send ${result.sendId})`);
    }
    return 0;
  } catch (err) {
    io.err(`tg:send: ${message(err)}`);
    return err instanceof AlreadySentError ? 3 : 1;
  }
}
