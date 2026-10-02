// Preloaded into the real scripts/tg-send.ts by the CHE-375 guard
// (`node --import tsx --import <this> scripts/tg-send.ts …`). It replaces
// global fetch, so the script runs end to end — argv, env, exit code — with no
// network: the D1 HTTP API is answered from an in-memory TelegramMessage table
// and the Bot API by the scenario in TG_FAKE.
//
//   TG_FAKE              ok | throw | hang | refused | insert-reply-lost
//   TG_FAKE_SEED         JSON rows to put in the table first
//   TG_FAKE_REPORT_FILE  where to write { telegram, rows } on exit
//                        (a file, because a pipe written at exit is lost on macOS)

import { writeFileSync } from "node:fs";
import { telegramTable } from "./telegram-table.mjs";

const scenario = process.env.TG_FAKE ?? "ok";
const table = await telegramTable();
for (const row of JSON.parse(process.env.TG_FAKE_SEED ?? "[]")) {
  const cols = Object.keys(row);
  table.run(
    `INSERT INTO "TelegramMessage" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    Object.values(row),
  );
}
let telegram = 0;

process.on("exit", () => {
  if (process.env.TG_FAKE_REPORT_FILE) {
    writeFileSync(process.env.TG_FAKE_REPORT_FILE, JSON.stringify({ telegram, rows: table.all() }));
  }
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/d1\/database\/[^/]+\/query$/.test(url)) {
    const { sql, params } = JSON.parse(init.body);
    let out;
    try {
      out = table.run(sql, params);
    } catch (err) {
      return json({ success: false, errors: [{ message: err.message }] }, 400);
    }
    if (scenario === "insert-reply-lost" && /^INSERT/.test(sql)) throw new TypeError("fetch failed (reply lost)");
    return json({ success: true, result: [{ results: out.results, meta: { changes: out.changes } }] });
  }
  if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/.test(url)) {
    telegram++;
    const { chat_id, text } = JSON.parse(init.body);
    if (scenario === "throw") throw new TypeError("fetch failed");
    if (scenario === "hang") {
      // A real hung request holds the process open through its socket; this
      // timer stands in for it (AbortSignal.timeout's own timer does not).
      return new Promise((_, reject) => {
        const socket = setTimeout(() => {}, 10 * 60 * 1000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(socket);
          reject(init.signal.reason);
        });
      });
    }
    if (scenario === "refused") return json({ ok: false, description: "Bad Request: chat not found" }, 400);
    return json({ ok: true, result: { message_id: 777, date: 1_790_000_000, chat: { id: Number(chat_id) }, from: { first_name: "CheckMyApp" }, text } });
  }
  throw new Error(`tg-send-fetch: no network in the guard (${url})`);
};
