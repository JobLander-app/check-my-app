// CHE-375 verification: the owner's Telegram chat with @checkmyapp_bot is a
// production record — every message he writes is stored in D1 once, and only
// Telegram (holding the shared secret) can write there.
//
// The real route handler is bundled with esbuild and called with plain
// Requests. Two boundaries are replaced, nothing else: the Cloudflare context
// (which carries the env) and the database client (an in-memory table that
// enforces the unique key on updateId the way D1 does, by throwing P2002). The
// generated Prisma client is the workerd build and cannot load in plain Node,
// and this file must pass with no arguments and no environment (AGENTS.md).
//
// What must hold:
//   - no TELEGRAM_WEBHOOK_SECRET configured → 503, nothing stored;
//   - a missing or wrong X-Telegram-Bot-Api-Secret-Token → 401, nothing stored;
//   - a message from an allowed chat → exactly one row, direction 'in';
//   - Telegram retrying the same update → still one row (also when the retry
//     races the first delivery past the existence check);
//   - another chat, or no allowlist at all → 200, nothing stored;
//   - an edit, a captioned photo and a long reply are stored the way the
//     ticket says ("<media>" + caption, reply text cut to 200 chars);
//   - the message text never reaches the log;
//   - the route is registered in src/lib/route-scopes.ts as a public webhook,
//     for a reason the route-scopes guard accepts for a mutating route.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-telegram-webhook.ts

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { ROUTE_RULES } from "@/lib/route-scopes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROUTE_FILE = "src/app/api/webhooks/telegram/route.ts";
const ROUTE_KEY = "POST /api/webhooks/telegram";
const SECRET = "fixture-secret-0123456789abcdef0123456789";
const OWNER_CHAT = 101333337;
const OTHER_CHAT = 555;
// A marker that must never appear in anything the route logs.
const PRIVATE = "PRIVATE_OWNER_WORDS";

type Row = Record<string, unknown>;

// ─── The fake table ──────────────────────────────────────────────────────────

const fixture = {
  env: {} as Record<string, unknown>,
  rows: [] as Row[],
  // Simulates a duplicate delivery racing the first one past findUnique.
  hideExistingOnce: false,
  db: {} as unknown,
};

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed on the fields: (`updateId`)"), { code: "P2002" });
}

fixture.db = {
  telegramMessage: {
    findUnique: async ({ where }: { where: Row }) => {
      if (fixture.hideExistingOnce) {
        fixture.hideExistingOnce = false;
        return null;
      }
      return fixture.rows.find((r) => r.updateId != null && r.updateId === where.updateId) ?? null;
    },
    findFirst: async ({ where }: { where: Row }) =>
      fixture.rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (data.updateId != null && fixture.rows.some((r) => r.updateId === data.updateId)) throw uniqueViolation();
      const row = { id: `row-${fixture.rows.length + 1}`, createdAt: new Date(), ...data };
      fixture.rows.push(row);
      return row;
    },
  },
};

// ─── The real handler ────────────────────────────────────────────────────────

const DATE = 1_790_000_000;
function message(updateId: number, chatId: number, extra: Row = {}, kind = "message"): Row {
  return {
    update_id: updateId,
    [kind]: {
      message_id: updateId + 1000,
      date: DATE,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false, first_name: "Vladislav", last_name: "Sorokin", username: "sorokinvj" },
      text: `hello ${PRIVATE}`,
      ...extra,
    },
  };
}

async function main() {
if (!existsSync(ROUTE_FILE)) {
  check("the webhook route exists", false, `${ROUTE_FILE} is missing`);
  check(`${ROUTE_KEY} is registered`, false, JSON.stringify(ROUTE_RULES[ROUTE_KEY]));
  return;
}

const mocks: Record<string, string> = {
  "@opennextjs/cloudflare": "export const getCloudflareContext = () => ({ env: fixture.env });",
  "@/lib/db": "export const getDb = () => fixture.db; export const getDbFromContext = async () => fixture.db;",
};
const bundle = await build({
  entryPoints: [ROUTE_FILE],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [{
    name: "telegram-boundaries",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => (mocks[args.path] ? { path: args.path, namespace: "fixture" } : undefined));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
    },
  }],
});
const mod = { exports: {} as { POST(req: Request): Promise<Response> } };
new Function("module", "exports", "fixture", "require", bundle.outputFiles[0].text)(mod, mod.exports, fixture, require);

// Everything the route writes to the console, to prove the text stays out.
const logged: string[] = [];
let inRoute = false;
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (!inRoute) return original(...args);
    logged.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(" "));
  };
}

async function post(update: unknown, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  inRoute = true;
  try {
    return await mod.exports.POST(new Request("https://checkmyapp.dev/api/webhooks/telegram", {
      method: "POST",
      headers,
      body: JSON.stringify(update),
    }));
  } finally {
    inRoute = false;
  }
}

// 1 — unconfigured: 503, nothing stored.
fixture.env = { TELEGRAM_ALLOWED_CHAT_IDS: String(OWNER_CHAT) };
{
  const res = await post(message(1, OWNER_CHAT));
  check("no secret configured → 503", res.status === 503, `got ${res.status}`);
  check("no secret configured → nothing stored", fixture.rows.length === 0, `${fixture.rows.length} rows`);
}

// 2 — configured: the header decides.
fixture.env = { TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_ALLOWED_CHAT_IDS: ` ${OTHER_CHAT + 1}, ${OWNER_CHAT} ` };
for (const [label, secret] of [
  ["missing header", null],
  ["empty header", ""],
  ["wrong header", "not-the-secret"],
  ["same length, one char off", SECRET.slice(0, -1) + "X"],
  ["a prefix of the secret", SECRET.slice(0, 10)],
  ["the secret plus a suffix", SECRET + "x"],
] as const) {
  const res = await post(message(2, OWNER_CHAT), secret);
  check(`${label} → 401`, res.status === 401, `got ${res.status}`);
}
check("a refused request stores nothing", fixture.rows.length === 0, `${fixture.rows.length} rows`);

// 3 — a valid message from the owner's chat: one row.
{
  const res = await post(message(10, OWNER_CHAT));
  check("valid update from an allowed chat → 200", res.status === 200, `got ${res.status}`);
  check("valid update → exactly one row", fixture.rows.length === 1, `${fixture.rows.length} rows`);
  const row = fixture.rows[0] ?? {};
  check("row: direction 'in'", row.direction === "in", String(row.direction));
  check("row: chatId is the chat's id as text", row.chatId === String(OWNER_CHAT), String(row.chatId));
  check("row: updateId is the update's id", String(row.updateId) === "10", String(row.updateId));
  check("row: text is the message text", row.text === `hello ${PRIVATE}`, String(row.text));
  check("row: fromName names the sender", typeof row.fromName === "string" && /Vladislav/.test(row.fromName), String(row.fromName));
  check("row: sentAt is Telegram's date", row.sentAt instanceof Date && row.sentAt.getTime() === DATE * 1000,
    row.sentAt instanceof Date ? row.sentAt.toISOString() : String(row.sentAt));
  check("row: no reply → replyToText null", row.replyToText == null, String(row.replyToText));
}

// 4 — Telegram retries: still one row.
{
  const res = await post(message(10, OWNER_CHAT));
  check("same update again → 200", res.status === 200, `got ${res.status}`);
  check("same update again → still one row", fixture.rows.length === 1, `${fixture.rows.length} rows`);
  fixture.hideExistingOnce = true;
  const raced = await post(message(10, OWNER_CHAT));
  check("a retry racing past the existence check → 200 (unique key settles it)", raced.status === 200, `got ${raced.status}`);
  check("a racing retry → still one row", fixture.rows.length === 1, `${fixture.rows.length} rows`);
}

// 5 — another chat, or no allowlist: acknowledged, not stored.
{
  const res = await post(message(11, OTHER_CHAT));
  check("another chat → 200", res.status === 200, `got ${res.status}`);
  check("another chat → not stored", fixture.rows.length === 1, `${fixture.rows.length} rows`);
  const saved = fixture.env;
  fixture.env = { TELEGRAM_WEBHOOK_SECRET: SECRET };
  const open = await post(message(12, OWNER_CHAT));
  check("no allowlist configured → 200, and no chat is allowed", open.status === 200 && fixture.rows.length === 1,
    `${open.status}, ${fixture.rows.length} rows`);
  fixture.env = saved;
}

// 6 — only message / edited_message are records.
{
  const res = await post({ update_id: 13, callback_query: { id: "x", from: { id: OWNER_CHAT }, data: PRIVATE } });
  check("a non-message update → 200, not stored", res.status === 200 && fixture.rows.length === 1,
    `${res.status}, ${fixture.rows.length} rows`);
  const garbage = await post("not an update");
  check("a verified body that is not an update → 200, not stored", garbage.status === 200 && fixture.rows.length === 1,
    `${garbage.status}, ${fixture.rows.length} rows`);
}

// 7 — the shapes the ticket names.
{
  const edit = await post(message(20, OWNER_CHAT, { text: `edited ${PRIVATE}`, edit_date: DATE + 60 }, "edited_message"));
  const row = fixture.rows.find((r) => String(r.updateId) === "20") ?? {};
  check("edited_message → stored", edit.status === 200 && row.text === `edited ${PRIVATE}`, `${edit.status} ${String(row.text)}`);

  const photo = message(21, OWNER_CHAT, { text: undefined, photo: [{ file_id: "f" }], caption: `look ${PRIVATE}` });
  await post(photo);
  const photoRow = fixture.rows.find((r) => String(r.updateId) === "21") ?? {};
  check("media with a caption → \"<media>\" + caption", photoRow.text === `<media> look ${PRIVATE}`, String(photoRow.text));

  await post(message(22, OWNER_CHAT, { text: undefined, sticker: { file_id: "s" } }));
  const stickerRow = fixture.rows.find((r) => String(r.updateId) === "22") ?? {};
  check("media without a caption → \"<media>\"", stickerRow.text === "<media>", String(stickerRow.text));

  const long = "y".repeat(300);
  await post(message(23, OWNER_CHAT, { reply_to_message: { message_id: 1, date: DATE, chat: { id: OWNER_CHAT }, text: long } }));
  const replyRow = fixture.rows.find((r) => String(r.updateId) === "23") ?? {};
  check("reply_to text is kept, cut to 200 chars",
    typeof replyRow.replyToText === "string" && replyRow.replyToText.length <= 200 && replyRow.replyToText.startsWith("y".repeat(150)),
    `${String(replyRow.replyToText).length} chars`);
}

check("every stored row is direction 'in'", fixture.rows.every((r) => r.direction === "in"));
check("the message text never reaches the log", !logged.some((l) => l.includes(PRIVATE)),
  logged.filter((l) => l.includes(PRIVATE)).slice(0, 2).join(" | ") || `${logged.length} lines, clean`);

// 8 — the schema and its migration exist together.
{
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  check("schema declares model TelegramMessage", /\bmodel\s+TelegramMessage\s*\{/.test(schema));
  const migration = readdirSync("prisma/migrations").find((f) => {
    const sql = readFileSync(`prisma/migrations/${f}`, "utf8");
    return /CREATE TABLE "TelegramMessage"/.test(sql) && /CREATE UNIQUE INDEX "TelegramMessage_updateId_key"/.test(sql);
  });
  check("a migration creates TelegramMessage with a unique updateId", Boolean(migration), migration ?? "none");
}

// 9 — our side of the conversation (scripts/tg-send.ts). A message Telegram
// has delivered cannot be unsent, so the record must not depend on a database
// call made after it (Codex review of #221): the row exists before the send,
// and a send that fails takes it back. Run against the real migration in
// SQLite, so the statements themselves are under test too.
{
  const { sendRecorded } = await import("@/lib/telegram-send");
  const migrationFile = readdirSync("prisma/migrations").find((f) => /CREATE TABLE "TelegramMessage"/.test(readFileSync(`prisma/migrations/${f}`, "utf8")));
  // node:sqlite exists from Node 22.5; package.json allows Node 20 (Codex
  // review of #221). There the statements are read by a small interpreter of
  // the three shapes the flow uses, so the flow is still under test.
  let sqliteModule: typeof import("node:sqlite") | null = null;
  try {
    sqliteModule = await import("node:sqlite");
  } catch {
    console.log("NOTE  node:sqlite is not available on this Node; tg-send statements are read by the fallback interpreter");
  }

  type Table = { run(sql: string, params: unknown[]): void; all(): Row[] };
  function realTable(): Table {
    const sqlite = new sqliteModule!.DatabaseSync(":memory:");
    sqlite.exec(readFileSync(`prisma/migrations/${migrationFile}`, "utf8"));
    return {
      run: (sql, params) => void sqlite.prepare(sql).run(...(params as (string | number | null)[])),
      all: () => sqlite.prepare(`SELECT * FROM "TelegramMessage"`).all() as Row[],
    };
  }
  function interpretedTable(): Table {
    const rows: Row[] = [];
    const cols = (list: string) => list.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    return {
      run(sql, params) {
        const queue = [...params];
        const value = (token: string) => {
          const t = token.trim();
          if (t === "?") return queue.shift() ?? null;
          if (t === "NULL") return null;
          if (/^'.*'$/.test(t)) return t.slice(1, -1);
          return Number(t);
        };
        let m: RegExpExecArray | null;
        if ((m = /^INSERT INTO "TelegramMessage" \(([^)]*)\) VALUES \(([^)]*)\)$/.exec(sql.trim()))) {
          const names = cols(m[1]);
          const values = m[2].split(",").map(value);
          if (names.length !== values.length) throw new Error("column/value count mismatch");
          rows.push(Object.fromEntries(names.map((n, i) => [n, values[i]])));
        } else if ((m = /^UPDATE "TelegramMessage" SET (.*) WHERE "id" = \?$/.exec(sql.trim()))) {
          const sets = m[1].split(",").map((s) => [s.split("=")[0].trim().replace(/^"|"$/g, ""), value(s.split("=")[1])] as const);
          const id = queue.shift();
          for (const r of rows.filter((x) => x.id === id)) for (const [k, v] of sets) r[k] = v;
        } else if (/^DELETE FROM "TelegramMessage" WHERE "id" = \?$/.test(sql.trim())) {
          const id = queue.shift();
          rows.splice(0, rows.length, ...rows.filter((x) => x.id !== id));
        } else {
          throw new Error(`fallback interpreter does not know this statement: ${sql.slice(0, 60)}`);
        }
      },
      all: () => rows,
    };
  }

  function harness(opts: { telegramOk?: boolean; telegramThrows?: boolean; d1DownAfterSend?: boolean; d1Down?: boolean } = {}) {
    const table = sqliteModule ? realTable() : interpretedTable();
    const state = { sentCalls: 0 };
    let n = 0;
    const deps = {
      d1: async (sql: string, params: unknown[]) => {
        if (opts.d1Down || (opts.d1DownAfterSend && state.sentCalls > 0)) throw new Error("D1 unavailable");
        table.run(sql, params);
      },
      sendMessage: async (chatId: string, text: string) => {
        state.sentCalls++;
        if (opts.telegramThrows) throw new Error("socket hang up");
        if (opts.telegramOk === false) return { ok: false, description: "Bad Request: chat not found" };
        return { ok: true, result: { message_id: 777, date: DATE, chat: { id: Number(chatId) }, from: { first_name: "CheckMyApp" }, text } };
      },
      newId: () => `out-${++n}`,
      now: () => new Date(DATE * 1000 + 5000),
    };
    return { deps, state, rows: () => table.all() };
  }
  const tricky = `it's; DROP TABLE "TelegramMessage"; -- ${PRIVATE}`;

  const ok = harness();
  await sendRecorded(ok.deps, String(OWNER_CHAT), tricky);
  const okRows = ok.rows();
  check("tg-send: a sent message is one row, direction 'out', text verbatim",
    okRows.length === 1 && okRows[0].direction === "out" && okRows[0].text === tricky && okRows[0].chatId === String(OWNER_CHAT),
    JSON.stringify(okRows.map((r) => ({ d: r.direction, t: String(r.text).length }))));
  check("tg-send: the row carries Telegram's message id and send time",
    okRows[0]?.messageId === "777" && okRows[0]?.sentAt === "2026-09-21T14:13:20.000+00:00" && okRows[0]?.updateId === null,
    `${String(okRows[0]?.messageId)} ${String(okRows[0]?.sentAt)}`);

  const lateD1 = harness({ d1DownAfterSend: true });
  let lateError = "";
  await sendRecorded(lateD1.deps, String(OWNER_CHAT), tricky).catch((e: Error) => { lateError = e.message; });
  const lateRows = lateD1.rows();
  check("tg-send: Telegram accepted, then D1 failed → the message is still recorded",
    lateD1.state.sentCalls === 1 && lateRows.length === 1 && lateRows[0].text === tricky && lateRows[0].direction === "out",
    `${lateRows.length} rows${lateError ? `, threw: ${lateError}` : ""}`);
  check("tg-send: …and it does not throw, so nobody re-runs it and sends the owner the same message twice",
    lateError === "", lateError || "resolved");

  const refused = harness({ telegramOk: false });
  let refusedError = "";
  await sendRecorded(refused.deps, String(OWNER_CHAT), tricky).catch((e: Error) => { refusedError = e.message; });
  check("tg-send: Telegram refused → error, and no 'out' row claims it was sent",
    refusedError.length > 0 && refused.rows().length === 0, `${refused.rows().length} rows, ${refusedError || "no error"}`);

  const lost = harness({ telegramThrows: true });
  let lostError = "";
  await sendRecorded(lost.deps, String(OWNER_CHAT), tricky).catch((e: Error) => { lostError = e.message; });
  const lostRows = lost.rows();
  check("tg-send: the send's outcome is unknown → error, and the row is kept, marked by no message id",
    lostError.length > 0 && lostRows.length === 1 && lostRows[0].messageId === null,
    `${lostRows.length} rows, ${lostError || "no error"}`);

  const down = harness({ d1Down: true });
  let downError = "";
  await sendRecorded(down.deps, String(OWNER_CHAT), tricky).catch((e: Error) => { downError = e.message; });
  check("tg-send: D1 unreachable → nothing is sent", downError.length > 0 && down.state.sentCalls === 0,
    `${down.state.sentCalls} sends, ${downError || "no error"}`);
}

// 10 — the registry.
{
  const rule = ROUTE_RULES[ROUTE_KEY];
  check(`${ROUTE_KEY} is registered public`, rule?.kind === "public", JSON.stringify(rule));
  // verify-route-scopes refuses a public mutating route whose reason only
  // justifies reading; the reason must be one it lets through.
  const scopesGuard = readFileSync("scripts/verify-route-scopes.ts", "utf8");
  const openToWrites = /const OPEN_TO_WRITES = new Set\(\[([\s\S]*?)\]\)/.exec(scopesGuard)?.[1] ?? "";
  check("its reason is one the route-scopes guard accepts for a write",
    rule?.kind === "public" && openToWrites.includes(JSON.stringify(rule.why)), rule?.kind === "public" ? rule.why : "");
}
}

main()
  .catch((err) => check("the guard ran to the end", false, err instanceof Error ? err.message : String(err)))
  .finally(() => {
    console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
