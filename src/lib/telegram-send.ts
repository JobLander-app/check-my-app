// Sending to the owner's chat and recording it in D1 (CHE-375), as one flow the
// script (scripts/tg-send.ts) runs and the guard (scripts/verify-telegram-webhook.ts)
// exercises with fakes.

import { outgoingRow } from "./telegram";

export interface SendDeps {
  // One SQL statement with bound parameters against the checkmyapp D1.
  d1(sql: string, params: unknown[]): Promise<void>;
  // Bot API sendMessage; returns its JSON body.
  sendMessage(chatId: string, text: string): Promise<{ ok: boolean; description?: string; result?: Parameters<typeof outgoingRow>[0] }>;
  newId(): string;
  now(): Date;
}

// The text form Prisma's D1 adapter writes ("2026-10-01T17:38:44.011+00:00"),
// so rows from here and from the webhook sort together on createdAt.
export function d1Time(d: Date): string {
  return d.toISOString().replace(/Z$/, "+00:00");
}

// A sent message cannot be unsent, so the record must not hang on a database
// call made after the send (Codex review of #221). The row is written first;
// a send Telegram refuses takes it back; a send that succeeds fills in
// Telegram's message id. Whenever the message may have been delivered — the
// last write failed, or the send's outcome is unknown — it stays on record and
// this returns a warning rather than throws: an error would invite a re-run,
// and a re-run sends the owner the same message twice.
export async function sendRecorded(
  deps: SendDeps,
  chatId: string,
  text: string,
): Promise<{ id: string; messageId: string | null; warning?: string }> {
  const id = deps.newId();
  const now = d1Time(deps.now());
  await deps.d1(
    'INSERT INTO "TelegramMessage" ("id", "updateId", "messageId", "chatId", "direction", "fromName", "text", "replyToText", "edited", "sentAt", "createdAt") ' +
      "VALUES (?, NULL, NULL, ?, 'out', NULL, ?, NULL, 0, ?, ?)",
    [id, chatId, text, now, now],
  );

  let sent: Awaited<ReturnType<SendDeps["sendMessage"]>>;
  try {
    sent = await deps.sendMessage(chatId, text);
  } catch (err) {
    // A network failure leaves it unknown whether Telegram delivered: keep the
    // row (no message id marks it unconfirmed) rather than erase a message
    // the owner may be reading — and warn rather than throw, for the same
    // reason as below: a retry could deliver it twice (Codex review of #221).
    return {
      id,
      messageId: null,
      warning: `send outcome unknown (${err instanceof Error ? err.message : String(err)}); kept without a message id — look at the chat before sending again`,
    };
  }
  if (!sent.ok || !sent.result) {
    await deps.d1('DELETE FROM "TelegramMessage" WHERE "id" = ?', [id]);
    throw new Error(`Telegram refused the message: ${sent.description ?? "no result"}`);
  }

  const row = outgoingRow(sent.result, chatId);
  try {
    await deps.d1(
      'UPDATE "TelegramMessage" SET "messageId" = ?, "chatId" = ?, "fromName" = ?, "text" = ?, "replyToText" = ?, "sentAt" = ? WHERE "id" = ?',
      [row.messageId, row.chatId, row.fromName, row.text, row.replyToText, d1Time(row.sentAt), id],
    );
  } catch (err) {
    return { id, messageId: row.messageId, warning: `sent and recorded, but Telegram's message id was not stored: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { id, messageId: row.messageId };
}
