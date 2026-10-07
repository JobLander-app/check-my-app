// CHE-375 verification: the owner's Telegram chat with @checkmyapp_bot is a
// production record — every message he writes is stored in D1 once, only
// Telegram (holding the shared secret) can write there, his text never reaches
// a log, and what we send is recorded without ever being sent twice.
//
// The real route handler and the real middleware are bundled with esbuild and
// called with real Requests. Only the boundaries are replaced: the Cloudflare
// context (the env), the database client (an in-memory table that enforces the
// unique key, and refuses an invalid date the way Prisma does — with the row
// in its message), and Clerk's middleware wrapper. The generated Prisma client
// is the workerd build and cannot load in plain Node, and this file must pass
// with no arguments and no environment (AGENTS.md).
//
// The real scripts/tg-send.ts is run as a child process with fetch replaced
// (scripts/fixtures/tg-send-fetch.mjs), so its exit codes are under test, not
// just the library under it.
//
// Every check here was written against a mutation that the first version of
// this guard let through (cross-review of #221): M1–M11 in the names below.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-telegram-webhook.ts

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { NextRequest } from "next/server";
import { createRouteMatcher } from "@clerk/nextjs/server";
import { ROUTE_RULES } from "@/lib/route-scopes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = process.cwd();
const ROUTE_FILE = "src/app/api/webhooks/telegram/route.ts";
const ROUTE_KEY = "POST /api/webhooks/telegram";
const WEBHOOK_PATH = "/api/webhooks/telegram";
const SECRET = "fixture-secret-0123456789abcdef0123456789";
const OWNER_CHAT = 101333337;
const OTHER_CHAT = 555;
// A marker that must never appear in anything logged.
const PRIVATE = "PRIVATE_OWNER_WORDS";
const DATE = 1_790_000_000;

type Row = Record<string, unknown>;

function message(updateId: number | undefined, chatId: number, extra: Row = {}, kind = "message"): Row {
  return {
    ...(updateId === undefined ? {} : { update_id: updateId }),
    [kind]: {
      message_id: (updateId ?? 0) + 1000,
      date: DATE,
      chat: { id: chatId, type: kind === "channel_post" ? "channel" : "private" },
      from: { id: chatId, is_bot: false, first_name: "Vladislav", last_name: "Sorokin", username: "sorokinvj" },
      text: `hello ${PRIVATE}`,
      ...extra,
    },
  };
}

// ─── Boundaries ──────────────────────────────────────────────────────────────

const fixture = {
  env: {} as Record<string, unknown>,
  rows: [] as Row[],
  hideExistingOnce: false, // a retry racing the first delivery past findUnique
  down: false as false | "read" | "write", // D1 unreachable for this kind of call
  db: {} as unknown,
  bodyReads: 0,
  digests: 0,
};

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed on the fields: (`updateId`)"), { code: "P2002" });
}

fixture.db = {
  telegramMessage: {
    findUnique: async ({ where }: { where: Row }) => {
      if (fixture.down === "read") throw Object.assign(new Error(`D1_ERROR: network connection lost while reading ${JSON.stringify(where)}`), { code: "D1_ERROR" });
      if (fixture.hideExistingOnce) {
        fixture.hideExistingOnce = false;
        return null;
      }
      return fixture.rows.find((r) => r.updateId != null && r.updateId === where.updateId) ?? null;
    },
    create: async ({ data }: { data: Row }) => {
      // Prisma's own wording carries the whole row — that is the leak to stop.
      if (fixture.down === "write") throw Object.assign(new Error(`D1_ERROR: could not write ${JSON.stringify(data)}`), { code: "D1_ERROR" });
      if (!(data.sentAt instanceof Date) || Number.isNaN(data.sentAt.getTime())) {
        throw Object.assign(new Error(`Invalid value for argument \`sentAt\`: Provided Date object is invalid. ${JSON.stringify(data)}`), {
          name: "PrismaClientValidationError",
        });
      }
      if (data.updateId != null && fixture.rows.some((r) => r.updateId === data.updateId)) throw uniqueViolation();
      const row = { id: `row-${fixture.rows.length + 1}`, createdAt: new Date(), ...data };
      fixture.rows.push(row);
      return row;
    },
  },
};

// Everything logged while the route runs.
const logged: string[] = [];
let capturing = false;
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (!capturing) return original(...args);
    logged.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(" "));
  };
}

// Every SHA-256 the process computes — secretMatches must hash, not compare text.
const subtle = globalThis.crypto.subtle;
const realDigest = subtle.digest.bind(subtle);
(subtle as { digest: typeof subtle.digest }).digest = ((...args: Parameters<typeof subtle.digest>) => {
  fixture.digests++;
  return realDigest(...args);
}) as typeof subtle.digest;

async function bundle<T>(entry: string, mocks: Record<string, string>): Promise<T> {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [{
      name: "boundaries",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => (mocks[args.path] ? { path: args.path, namespace: "fixture" } : undefined));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
      },
    }],
  });
  const mod = { exports: {} as T };
  new Function("module", "exports", "fixture", "require", out.outputFiles[0].text)(mod, mod.exports, fixture, require);
  return mod.exports;
}

async function main() {
  if (!existsSync(ROUTE_FILE)) {
    check("the webhook route exists", false, `${ROUTE_FILE} is missing`);
    check(`${ROUTE_KEY} is registered`, false, JSON.stringify(ROUTE_RULES[ROUTE_KEY]));
    return;
  }
  const route = await bundle<{ POST(req: Request): Promise<Response> }>(ROUTE_FILE, {
    "@opennextjs/cloudflare": "export const getCloudflareContext = () => ({ env: fixture.env });",
    "@/lib/db": "export const getDb = () => fixture.db; export const getDbFromContext = async () => fixture.db;",
  });

  // A body that counts being read, so "refused before reading" is observable.
  async function post(update: unknown, secret: string | null = SECRET, rawBody?: string): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
    const bytes = new TextEncoder().encode(rawBody ?? JSON.stringify(update));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        fixture.bodyReads++;
        controller.enqueue(bytes);
        controller.close();
      },
    }, { highWaterMark: 0 });
    capturing = true;
    try {
      return await route.POST(new Request(`https://checkmyapp.dev${WEBHOOK_PATH}`, { method: "POST", headers, body, duplex: "half" } as RequestInit));
    } catch (err) {
      // What the framework does with an error a handler throws: logs it,
      // message and all, and answers 500.
      console.error(err);
      return new Response("Internal Server Error", { status: 500 });
    } finally {
      capturing = false;
    }
  }
  const rowFor = (updateId: number) => fixture.rows.find((r) => r.updateId === String(updateId)) ?? {};

  // 1 — unconfigured.
  fixture.env = { TELEGRAM_ALLOWED_CHAT_IDS: String(OWNER_CHAT) };
  {
    const res = await post(message(1, OWNER_CHAT));
    check("no secret configured → 503", res.status === 503, `got ${res.status}`);
    check("no secret configured → nothing stored, body not read", fixture.rows.length === 0 && fixture.bodyReads === 0,
      `${fixture.rows.length} rows, ${fixture.bodyReads} body reads`);
  }

  // 2 — the header decides, before the body is touched.
  fixture.env = { TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_ALLOWED_CHAT_IDS: ` ${OTHER_CHAT + 1}, ${OWNER_CHAT} ` };
  // A guess whose SHA-256 shares its first byte with the secret's: a compare
  // that looks at one byte lets it through (M4).
  const firstByte = (s: string) => createHash("sha256").update(s).digest()[0];
  let sameFirstByte = "";
  for (let i = 0; !sameFirstByte; i++) if (firstByte(`guess-${i}`) === firstByte(SECRET)) sameFirstByte = `guess-${i}`;
  for (const [label, secret] of [
    ["missing header", null],
    ["empty header", ""],
    ["wrong header", "not-the-secret"],
    ["same length, one char off", SECRET.slice(0, -1) + "X"],
    ["a prefix of the secret", SECRET.slice(0, 10)],
    ["the secret plus a suffix", SECRET + "x"],
    ["a guess whose digest shares the first byte (M4)", sameFirstByte],
  ] as const) {
    const res = await post(message(2, OWNER_CHAT), secret);
    check(`${label} → 401`, res.status === 401, `got ${res.status}`);
  }
  {
    const res = await post(undefined, "not-the-secret", "{ not json");
    check("a wrong secret with an unreadable body → 401, not 200 (M1)", res.status === 401, `got ${res.status}`);
  }
  check("a refused request never reads the body (M1)", fixture.bodyReads === 0, `${fixture.bodyReads} reads`);
  check("a refused request stores nothing", fixture.rows.length === 0, `${fixture.rows.length} rows`);
  {
    const before = fixture.digests;
    await post(message(3, OTHER_CHAT), "not-the-secret");
    check("the secret is compared as digests, not as text (M3)", fixture.digests - before >= 2, `${fixture.digests - before} digests`);
  }

  // 3 — a valid message from the owner's chat.
  {
    const res = await post(message(10, OWNER_CHAT));
    check("valid update from an allowed chat → 200", res.status === 200, `got ${res.status}`);
    check("valid update → exactly one row", fixture.rows.length === 1, `${fixture.rows.length} rows`);
    const row = fixture.rows[0] ?? {};
    check("row: direction 'in'", row.direction === "in", String(row.direction));
    check("row: chatId is the chat's id as text", row.chatId === String(OWNER_CHAT), String(row.chatId));
    check("row: updateId is the update's id", row.updateId === "10", String(row.updateId));
    check("row: messageId is Telegram's message_id (M8)", row.messageId === "1010", String(row.messageId));
    check("row: text is the message text", row.text === `hello ${PRIVATE}`, String(row.text).length + " chars");
    check("row: fromName names the sender", row.fromName === "Vladislav Sorokin", String(row.fromName));
    check("row: sentAt is Telegram's date", row.sentAt instanceof Date && row.sentAt.getTime() === DATE * 1000,
      row.sentAt instanceof Date ? row.sentAt.toISOString() : String(row.sentAt));
    check("row: not an edit", row.edited === false, String(row.edited));
    check("row: no reply → replyToText null", row.replyToText == null, String(row.replyToText));
  }

  // 4 — Telegram retries.
  {
    const res = await post(message(10, OWNER_CHAT));
    check("same update again → 200, still one row", res.status === 200 && fixture.rows.length === 1, `${res.status}, ${fixture.rows.length} rows`);
    fixture.hideExistingOnce = true;
    const raced = await post(message(10, OWNER_CHAT));
    check("a retry racing past the lookup → 200, still one row", raced.status === 200 && fixture.rows.length === 1,
      `${raced.status}, ${fixture.rows.length} rows`);
  }

  // 5 — what is not stored.
  {
    const n = fixture.rows.length;
    const other = await post(message(11, OTHER_CHAT));
    check("another chat → 200, not stored", other.status === 200 && fixture.rows.length === n, `${other.status}, ${fixture.rows.length} rows`);
    const saved = fixture.env;
    fixture.env = { TELEGRAM_WEBHOOK_SECRET: SECRET };
    const open = await post(message(12, OWNER_CHAT));
    check("no allowlist configured → 200, no chat is allowed", open.status === 200 && fixture.rows.length === n, `${open.status}, ${fixture.rows.length} rows`);
    fixture.env = saved;
    const cb = await post({ update_id: 13, callback_query: { id: "x", from: { id: OWNER_CHAT }, data: PRIVATE } });
    check("a callback query → 200, not stored", cb.status === 200 && fixture.rows.length === n, `${cb.status}, ${fixture.rows.length} rows`);
    const channel = await post(message(14, OWNER_CHAT, {}, "channel_post"));
    check("a channel_post, even from an allowed id → 200, not stored (M6)", channel.status === 200 && fixture.rows.length === n,
      `${channel.status}, ${fixture.rows.length} rows`);
    const garbage = await post(undefined, SECRET, "not json at all");
    check("a verified body that is not JSON → 200, not stored", garbage.status === 200 && fixture.rows.length === n, `${garbage.status}`);
    await post(message(undefined, OWNER_CHAT));
    await post(message(undefined, OWNER_CHAT, { text: "second" }));
    check("updates without an update_id are not stored — they would collapse into one row (M9)", fixture.rows.length === n,
      `${fixture.rows.length - n} rows added`);
  }

  // 6 — the shapes the ticket names.
  {
    const edit = await post(message(20, OWNER_CHAT, { text: `edited ${PRIVATE}`, edit_date: DATE + 60 }, "edited_message"));
    const row = rowFor(20);
    check("edited_message → stored", edit.status === 200 && row.text === `edited ${PRIVATE}`, `${edit.status}`);
    check("edited_message → marked edited, dated by edit_date (M5)",
      row.edited === true && row.sentAt instanceof Date && row.sentAt.getTime() === (DATE + 60) * 1000,
      `edited=${String(row.edited)} sentAt=${row.sentAt instanceof Date ? row.sentAt.toISOString() : String(row.sentAt)}`);

    await post(message(21, OWNER_CHAT, { text: undefined, photo: [{ file_id: "f" }], caption: `look ${PRIVATE}` }));
    check("media with a caption → \"<media>\" + caption", rowFor(21).text === `<media> look ${PRIVATE}`, String(rowFor(21).text).length + " chars");
    await post(message(22, OWNER_CHAT, { text: undefined, sticker: { file_id: "s" } }));
    check("media without a caption → \"<media>\"", rowFor(22).text === "<media>", String(rowFor(22).text));

    await post(message(23, OWNER_CHAT, { reply_to_message: { message_id: 1, date: DATE, chat: { id: OWNER_CHAT }, text: "y".repeat(300) } }));
    const reply = rowFor(23).replyToText;
    check("reply_to text is cut to exactly 200 chars (M7)", reply === "y".repeat(200), `${String(reply).length} chars`);
  }

  // 6b — CHE-427: a file sent with a message is kept, not reduced to "<media>".
  // On 2026-10-06 the owner's screenshot of an onboarding error became a row
  // reading "<media>" with nothing to open.
  {
    const TOKEN = "fake-bot-token-SECRET";
    const puts: { key: string; bytes: number; type?: string }[] = [];
    const store = new Map<string, ArrayBuffer>();
    const bucket = {
      put: async (key: string, body: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) => {
        puts.push({ key, bytes: body.byteLength, type: opts?.httpMetadata?.contentType });
        store.set(key, body);
      },
      get: async (key: string) => (store.has(key) ? { body: store.get(key), httpMetadata: {}, httpEtag: "e" } : null),
    };
    const asked: string[] = [];
    let telegramDown = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      asked.push(url);
      if (telegramDown) return new Response('{"ok":false,"description":"Bad Request: wrong file_id"}', { status: 400 });
      if (url.includes("/getFile?")) {
        const id = new URL(url).searchParams.get("file_id");
        const path = id === "doc1" ? "documents/report.pdf" : "photos/file_7.jpg";
        return new Response(JSON.stringify({ ok: true, result: { file_id: id, file_path: path, file_size: 4096 } }), { status: 200 });
      }
      if (url.includes("/file/bot")) return new Response(new Uint8Array(4096), { status: 200 });
      return new Response("unexpected", { status: 599 });
    }) as typeof fetch;
    const saved = fixture.env;
    fixture.env = { ...saved, TELEGRAM_BOT_TOKEN: TOKEN, EVIDENCE: bucket };
    const logsBefore = logged.length;

    // Out of order, and the biggest file in bytes is not the biggest picture;
    // file_size is optional and may be missing on the one that is (Codex on #295).
    const sizes = [
      { file_id: "small", width: 90, height: 90, file_size: 2_000_000 },
      { file_id: "large", width: 1280, height: 1280 },
      { file_id: "mid", width: 320, height: 320, file_size: 30_000 },
    ];
    const photo = await post(message(50, OWNER_CHAT, { text: undefined, photo: sizes, caption: `see ${PRIVATE}` }));
    const p = rowFor(50);
    check("photo → 200, stored with the caption as before", photo.status === 200 && p.text === `<media> see ${PRIVATE}`, `${photo.status}`);
    check("photo → the largest size's file id is kept", p.fileId === "large" && p.fileKind === "photo", `${String(p.fileId)} / ${String(p.fileKind)}`);
    check("photo → getFile asked for the largest size", asked.some((u) => u.includes("getFile?file_id=large")), asked.map((u) => u.replace(TOKEN, "<t>")).join(" "));
    const key = String(p.fileKey);
    check("photo → a copy is kept under private/ in R2, and the row says where",
      key === `private/telegram/${OWNER_CHAT}/50/photo-file_7.jpg` && puts.some((x) => x.key === key && x.bytes === 4096 && x.type === "image/jpeg"),
      `${key} ${JSON.stringify(puts)}`);

    await post(message(55, OWNER_CHAT, { text: undefined, photo: [{ file_id: "first" }, { file_id: "last" }] }));
    check("photo sizes without dimensions → Telegram's order, the last one", rowFor(55).fileId === "last", String(rowFor(55).fileId));

    await post(message(51, OWNER_CHAT, { text: undefined, document: { file_id: "doc1", file_name: "report.pdf" } }));
    check("document → kept as a document, as a PDF",
      rowFor(51).fileKind === "document" && puts.some((x) => x.key === `private/telegram/${OWNER_CHAT}/51/document-report.pdf` && x.type === "application/pdf"),
      `${String(rowFor(51).fileKind)} ${String(rowFor(51).fileKey)}`);

    const before = puts.length;
    await post(message(50, OWNER_CHAT, { text: undefined, photo: sizes }));
    check("a retry of a stored update downloads nothing again", puts.length === before, `${puts.length - before} puts`);

    telegramDown = true;
    const down = await post(message(52, OWNER_CHAT, { text: undefined, photo: sizes }));
    telegramDown = false;
    check("Telegram refuses getFile → the message is still stored, with its file id and no copy",
      down.status === 200 && rowFor(52).fileId === "large" && rowFor(52).fileKey == null, `${down.status} ${String(rowFor(52).fileKey)}`);

    fixture.env = { ...saved, EVIDENCE: bucket };
    const askedBefore = asked.length;
    const noToken = await post(message(53, OWNER_CHAT, { text: undefined, photo: sizes }));
    check("no bot token → stored with its file id, Telegram never asked",
      noToken.status === 200 && rowFor(53).fileId === "large" && asked.length === askedBefore, `${noToken.status}`);

    await post(message(54, OWNER_CHAT, { text: `plain ${PRIVATE}` }));
    check("a text message carries no file", rowFor(54).fileId == null && rowFor(54).fileKey == null);

    const said = logged.slice(logsBefore);
    check("the bot token never reaches a log", !said.some((l) => l.includes(TOKEN)), said.join(" | ").slice(0, 200) || "nothing logged");
    check("a file that was not kept is logged by reason", said.some((l) => /update 52 file not kept \(getFile HTTP 400\)/.test(l)), said.join(" | ").slice(0, 200));

    // The copy is never served: /api/evidence refuses private/ keys.
    const evidence = await bundle<{ GET(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> }>(
      "src/app/api/evidence/[...path]/route.ts",
      {
        "@opennextjs/cloudflare": "export const getCloudflareContext = () => ({ env: { EVIDENCE: fixture.bucket }, ctx: { waitUntil() {} } });",
        "@/lib/storage": "export const getObject = (b, k) => b.get(k); export const contentTypeFor = () => 'application/octet-stream'; export const screenshotKeyOfThumb = () => null;",
        "@/lib/thumbnail": "export const thumbnail = async () => null;",
        "next/server": "export const NextResponse = { json: (b, i) => new Response(JSON.stringify(b), { status: (i && i.status) || 200 }) };",
      },
    );
    Object.assign(fixture, { bucket });
    const served = await evidence.GET(new Request(`https://checkmyapp.dev/api/evidence/${key}`), { params: Promise.resolve({ path: key.split("/") }) });
    check("/api/evidence does not serve the kept file", served.status === 404, `got ${served.status}`);
    const control = "screens/x.png";
    store.set(control, new ArrayBuffer(1));
    const servedControl = await evidence.GET(new Request(`https://checkmyapp.dev/api/evidence/${control}`), { params: Promise.resolve({ path: control.split("/") }) });
    check("…while it does serve an ordinary evidence key (control)", servedControl.status === 200, `got ${servedControl.status}`);

    fixture.env = saved;
    globalThis.fetch = realFetch;
  }

  // 7 — dates Telegram would never send, and a database that is down: the
  // text stays out of every log (cross-review of #221, point 5).
  {
    const before = Date.now();
    const huge = await post(message(30, OWNER_CHAT, { date: 1e17 }));
    const hugeRow = rowFor(30);
    check("a date of 1e17 → stored, stamped with now", huge.status === 200 && hugeRow.sentAt instanceof Date && hugeRow.sentAt.getTime() >= before,
      `${huge.status} ${hugeRow.sentAt instanceof Date ? hugeRow.sentAt.toISOString() : String(hugeRow.sentAt)}`);
    const hugeEdit = await post(message(31, OWNER_CHAT, { edit_date: 1e17 }, "edited_message"));
    check("an edit_date of 1e17 → stored, stamped with now", hugeEdit.status === 200 && rowFor(31).sentAt instanceof Date, `${hugeEdit.status}`);
    for (const date of [Number.NaN, -1, "2026-01-01", null]) {
      const id = 32 + [Number.NaN, -1, "2026-01-01", null].indexOf(date);
      const res = await post(message(id, OWNER_CHAT, { date }));
      check(`a date of ${JSON.stringify(date)} → stored`, res.status === 200 && rowFor(id).sentAt instanceof Date, `${res.status}`);
    }

    const n = fixture.rows.length;
    for (const kind of ["read", "write"] as const) {
      const logsBefore = logged.length;
      fixture.down = kind;
      const down = await post(message(40, OWNER_CHAT));
      fixture.down = false;
      check(`D1 ${kind} fails → 500, so Telegram delivers it again (M2)`, down.status === 500 && fixture.rows.length === n, `${down.status}`);
      const said = logged.slice(logsBefore);
      check(`D1 ${kind} fails → logged by class and code, without the message`,
        said.some((l) => /D1_ERROR/.test(l)) && !said.some((l) => l.includes(PRIVATE) || l.includes("could not write")),
        said.join(" | ").slice(0, 200) || "nothing logged");
    }
    const retry = await post(message(40, OWNER_CHAT));
    check("…and Telegram's retry is stored", retry.status === 200 && rowFor(40).text === `hello ${PRIVATE}`, `${retry.status}`);
  }

  check("every stored row is direction 'in'", fixture.rows.every((r) => r.direction === "in"));
  check("the message text never reaches the log", !logged.some((l) => l.includes(PRIVATE) || l.includes("Sorokin")),
    logged.filter((l) => l.includes(PRIVATE) || l.includes("Sorokin")).slice(0, 2).join(" | ") || `${logged.length} lines, clean`);

  // 8 — the middleware leaves the webhook public (M11). Telegram has no
  // session; a protected path would answer every delivery with a redirect.
  {
    const captured: { cb?: (auth: unknown, req: NextRequest) => Promise<void> } = {};
    Object.assign(fixture, { createRouteMatcher, captured });
    await bundle("src/middleware.ts", {
      "@clerk/nextjs/server":
        "export const createRouteMatcher = (p) => fixture.createRouteMatcher(p);" +
        "export const clerkMiddleware = (cb) => { fixture.captured.cb = cb; return () => {}; };",
    });
    const protects = async (path: string) => {
      let called = false;
      const auth = Object.assign(() => ({}), { protect: async () => { called = true; } });
      await captured.cb!(auth, new NextRequest(`https://checkmyapp.dev${path}`, { method: "POST" }));
      return called;
    };
    check("middleware: the dashboard is protected (control)", await protects("/dashboard"));
    check("middleware: the Telegram webhook is not protected (M11)", !(await protects(WEBHOOK_PATH)));
  }

  // 9 — our side: the flow, against the real migration (or the interpreter on
  // Node 20). A sent message cannot be unsent, so whenever it may have been
  // delivered the row stays and a re-run refuses (Codex + cross-review of #221).
  {
    const { sendRecorded, AlreadySentError, NotSentError } = await import("@/lib/telegram-send");
    const { telegramTable } = await import("./fixtures/telegram-table.mjs");
    type Opts = { telegram?: "ok" | "refused" | "throw"; failWhen?: (sql: string, sentCalls: number) => boolean; table?: Awaited<ReturnType<typeof telegramTable>> };
    async function harness(opts: Opts = {}) {
      const table = opts.table ?? (await telegramTable(ROOT));
      const state = { sentCalls: 0 };
      let n = 0;
      const deps = {
        d1: async (sql: string, params: unknown[]) => {
          await Promise.resolve(); // let concurrent runs interleave
          if (opts.failWhen?.(sql, state.sentCalls)) throw new Error("D1 unavailable");
          return table.run(sql, params);
        },
        sendMessage: async (chatId: string, text: string) => {
          state.sentCalls++;
          if (opts.telegram === "throw") throw new Error("The operation was aborted due to timeout");
          if (opts.telegram === "refused") return { ok: false, description: "Bad Request: chat not found" };
          return { ok: true, result: { message_id: 777, date: DATE, chat: { id: Number(chatId) }, from: { first_name: "CheckMyApp" }, text } };
        },
        newId: () => `out-${++n}-${Math.random().toString(36).slice(2, 6)}`,
        now: () => new Date(DATE * 1000 + 5000),
      };
      return { deps, state, table, rows: () => table.all() as Row[] };
    }
    const chat = String(OWNER_CHAT);
    const tricky = `it's; DROP TABLE "TelegramMessage"; -- ${PRIVATE}`;
    const outcome = (p: Promise<unknown>) =>
      p.then((v) => ({ v: v as { status?: string; warning?: string } | undefined, e: null as Error | null }), (e: Error) => ({ v: undefined, e }));

    const ok = await harness();
    const sent = await outcome(sendRecorded(ok.deps, chat, tricky, "s-ok"));
    const okRow = ok.rows()[0] ?? {};
    check(`tg-send (${ok.table.kind}): sent → one 'out' row, status 'sent', text verbatim, message id`,
      !sent.e && ok.rows().length === 1 && okRow.direction === "out" && okRow.status === "sent" && okRow.text === tricky && okRow.messageId === "777",
      sent.e?.message ?? JSON.stringify({ status: okRow.status, messageId: okRow.messageId }));
    const again = await outcome(sendRecorded(ok.deps, chat, tricky, "s-ok"));
    check("tg-send: the same sendId again → refused, nothing sent", again.e instanceof AlreadySentError && ok.state.sentCalls === 1,
      `${again.e?.constructor.name}, ${ok.state.sentCalls} sends`);

    const lost = await harness({ telegram: "throw" });
    const lostOut = await outcome(sendRecorded(lost.deps, chat, tricky, "s-lost"));
    check("tg-send: outcome unknown (timeout) → warning, row 'unknown'",
      !lostOut.e && lostOut.v?.status === "unknown" && Boolean(lostOut.v?.warning) && lost.rows()[0]?.status === "unknown",
      lostOut.e?.message ?? String(lostOut.v?.warning));
    const lostAgain = await outcome(sendRecorded(lost.deps, chat, tricky, "s-lost"));
    check("tg-send: …a re-run refuses, so it cannot arrive twice", lostAgain.e instanceof AlreadySentError && lost.state.sentCalls === 1,
      `${lostAgain.e?.constructor.name}, ${lost.state.sentCalls} sends`);

    const late = await harness({ failWhen: (sql, sends) => sends > 0 && /'sent'/.test(sql) });
    const lateOut = await outcome(sendRecorded(late.deps, chat, tricky, "s-late"));
    check("tg-send: delivered, then D1 failed → warning, row kept 'unknown' with the text",
      !lateOut.e && Boolean(lateOut.v?.warning) && late.rows()[0]?.status === "unknown" && late.rows()[0]?.text === tricky,
      lateOut.e?.message ?? String(lateOut.v?.warning));

    const refused = await harness({ telegram: "refused" });
    const refusedOut = await outcome(sendRecorded(refused.deps, chat, tricky, "s-refused"));
    check("tg-send: Telegram refused → NotSent error, row 'failed'",
      refusedOut.e instanceof NotSentError && refused.rows()[0]?.status === "failed", refusedOut.e?.message ?? "no error");
    const retryAfterFail = await harness({ table: refused.table });
    const retryOut = await outcome(sendRecorded(retryAfterFail.deps, chat, tricky, "s-refused"));
    check("tg-send: …a re-run after 'failed' sends, still one row, now 'sent'",
      !retryOut.e && refused.rows().length === 1 && refused.rows()[0]?.status === "sent", retryOut.e?.message ?? String(refused.rows()[0]?.status));

    const refusedHidden = await harness({ telegram: "refused", failWhen: (sql, sends) => sends > 0 && /'failed'/.test(sql) });
    const hiddenOut = await outcome(sendRecorded(refusedHidden.deps, chat, tricky, "s-hidden"));
    check("tg-send: refused and the row cannot be marked → the error still says why Telegram refused",
      Boolean(hiddenOut.e?.message.includes("chat not found")) && refusedHidden.rows()[0]?.status === "unknown", hiddenOut.e?.message ?? "no error");

    const down = await harness({ failWhen: () => true });
    const downOut = await outcome(sendRecorded(down.deps, chat, tricky, "s-down"));
    check("tg-send: D1 unreachable → NotSent, nothing sent", downOut.e instanceof NotSentError && down.state.sentCalls === 0,
      `${downOut.e?.constructor.name}, ${down.state.sentCalls} sends`);

    // The INSERT lands but its answer is lost: the flow asks, finds its row
    // pending, and goes on — no phantom row, no lost send.
    let insertSeen = false;
    const lostReply = await harness();
    const realRun = lostReply.deps.d1;
    lostReply.deps.d1 = async (sql, params) => {
      const out = await realRun(sql, params);
      if (/^INSERT/.test(sql) && !insertSeen) {
        insertSeen = true;
        throw new Error("fetch failed (reply lost)");
      }
      return out;
    };
    const lostReplyOut = await outcome(sendRecorded(lostReply.deps, chat, tricky, "s-reply"));
    check("tg-send: INSERT landed, reply lost → it goes on: one row, 'sent'",
      !lostReplyOut.e && lostReply.rows().length === 1 && lostReply.rows()[0]?.status === "sent", lostReplyOut.e?.message ?? "");

    const shared = await telegramTable(ROOT);
    const a = await harness({ table: shared });
    const b = await harness({ table: shared });
    const both = await Promise.all([outcome(sendRecorded(a.deps, chat, tricky, "s-race")), outcome(sendRecorded(b.deps, chat, tricky, "s-race"))]);
    check("tg-send: two runs racing on one sendId → exactly one send",
      a.state.sentCalls + b.state.sentCalls === 1 && both.filter((o) => o.e instanceof AlreadySentError).length === 1,
      `${a.state.sentCalls + b.state.sentCalls} sends, ${both.map((o) => o.e?.constructor.name ?? o.v?.status).join(" / ")}`);

    // A run that died before its claim left the row 'pending'. Two re-runs both
    // find it and both reach the claim: only the conditional UPDATE keeps it to
    // one send.
    const resumed = await telegramTable(ROOT);
    resumed.run(
      'INSERT INTO "TelegramMessage" ("id", "chatId", "direction", "text", "edited", "sendId", "status", "sentAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ["dead-run", chat, "out", tricky, 0, "s-resume", "pending", "2026-09-30T00:00:00.000+00:00"],
    );
    const c = await harness({ table: resumed });
    const d = await harness({ table: resumed });
    const resumedBoth = await Promise.all([outcome(sendRecorded(c.deps, chat, tricky, "s-resume")), outcome(sendRecorded(d.deps, chat, tricky, "s-resume"))]);
    check("tg-send: two re-runs racing on a 'pending' row → exactly one send, one row",
      c.state.sentCalls + d.state.sentCalls === 1 && resumed.all().length === 1 && resumedBoth.filter((o) => o.e instanceof AlreadySentError).length === 1,
      `${c.state.sentCalls + d.state.sentCalls} sends, ${resumed.all().length} rows, ${resumedBoth.map((o) => o.e?.constructor.name ?? o.v?.status).join(" / ")}`);
  }

  // 10 — the real script: argv, env, exit codes (M10), timeout.
  {
    const { defaultSendId } = await import("@/lib/telegram-send");
    const dir = mkdtempSync(join(tmpdir(), "tg-send-"));
    const preload = pathToFileURL(join(ROOT, "scripts/fixtures/tg-send-fetch.mjs")).href;
    let runNo = 0;
    async function run(scenario: string, args: string[], seed: Row[] = [], timeoutMs = 2000) {
      const report = join(dir, `report-${++runNo}.json`);
      const started = Date.now();
      return new Promise<{ code: number | null; stderr: string; stdout: string; ms: number; telegram: number; rows: Row[] }>((resolve) => {
        const child = spawn(process.execPath, ["--no-warnings", "--import", "tsx", "--import", preload, "scripts/tg-send.ts", ...args], {
          cwd: ROOT,
          env: {
            ...process.env,
            TELEGRAM_BOT_TOKEN: "fake-bot",
            CLOUDFLARE_API_TOKEN: "fake-cf",
            CLOUDFLARE_ACCOUNT_ID: "fake-account",
            TELEGRAM_SEND_TIMEOUT_MS: String(timeoutMs),
            TG_FAKE: scenario,
            TG_FAKE_SEED: JSON.stringify(seed),
            TG_FAKE_REPORT_FILE: report,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        child.on("exit", (code) => {
          clearTimeout(killer);
          let r = { telegram: -1, rows: [] as Row[] };
          try { r = JSON.parse(readFileSync(report, "utf8")); } catch { /* killed before writing */ }
          resolve({ code, stdout, stderr, ms: Date.now() - started, ...r });
        });
      });
    }
    const chat = String(OWNER_CHAT);
    const seedRow = (sendId: string, status: string) => ({
      id: `seed-${sendId}`, chatId: chat, direction: "out", text: "earlier", edited: 0, sendId, status, sentAt: "2026-09-30T00:00:00.000+00:00",
    });

    const ok = await run("ok", [chat, "hello", "there"]);
    check("tg:send script: sent → exit 0, one send, row 'sent'",
      ok.code === 0 && ok.telegram === 1 && ok.rows[0]?.status === "sent" && ok.rows[0]?.text === "hello there",
      `exit ${ok.code}, ${ok.telegram} sends, ${JSON.stringify(ok.rows.map((r) => r.status))} ${ok.stderr.trim().slice(0, 200)}`);

    const warned = await run("throw", [chat, "hello"]);
    check("tg:send script: outcome unknown → exit 0 with a WARNING, never a retryable failure (M10)",
      warned.code === 0 && /WARNING/.test(warned.stderr) && warned.rows[0]?.status === "unknown",
      `exit ${warned.code}, ${JSON.stringify(warned.rows.map((r) => r.status))} ${warned.stderr.trim().slice(0, 160)}`);

    const hang = await run("hang", [chat, "hello"], [], 300);
    check("tg:send script: Telegram hangs → it gives up on its own timeout, exit 0 + WARNING, row 'unknown'",
      hang.code === 0 && /WARNING/.test(hang.stderr) && hang.rows[0]?.status === "unknown" && hang.ms < 20_000,
      `exit ${hang.code} after ${hang.ms} ms, ${JSON.stringify(hang.rows.map((r) => r.status))}`);

    const repeat = await run("ok", [chat, "hello"], [seedRow(await defaultSendId(chat, "hello"), "sent")]);
    check("tg:send script: the same text to the same chat again → exit 3, nothing sent",
      repeat.code === 3 && repeat.telegram === 0, `exit ${repeat.code}, ${repeat.telegram} sends`);

    const unknownSeed = await run("ok", [chat, "hello", "--send-id", "fixed-1"], [seedRow("fixed-1", "unknown")]);
    check("tg:send script: a send left 'unknown' by a killed run → exit 3, nothing sent",
      unknownSeed.code === 3 && unknownSeed.telegram === 0, `exit ${unknownSeed.code}, ${unknownSeed.telegram} sends`);

    const deliberate = await run("ok", [chat, "hello", "--send-id", "fixed-2"], [seedRow(await defaultSendId(chat, "hello"), "sent")]);
    check("tg:send script: the same text with a new --send-id → sent (a deliberate repeat)",
      deliberate.code === 0 && deliberate.telegram === 1, `exit ${deliberate.code}, ${deliberate.telegram} sends`);

    const refused = await run("refused", [chat, "hello"]);
    check("tg:send script: Telegram refused → exit 1, row 'failed'",
      refused.code === 1 && refused.rows[0]?.status === "failed" && /chat not found/.test(refused.stderr),
      `exit ${refused.code}, ${JSON.stringify(refused.rows.map((r) => r.status))}`);

    const reply = await run("insert-reply-lost", [chat, "hello"]);
    check("tg:send script: INSERT landed, reply lost → exit 0, one row 'sent'",
      reply.code === 0 && reply.rows.length === 1 && reply.rows[0]?.status === "sent", `exit ${reply.code}, ${JSON.stringify(reply.rows.map((r) => r.status))}`);

    const usage = await run("ok", ["not-a-chat"]);
    check("tg:send script: bad arguments → exit 2, nothing sent", usage.code === 2 && usage.telegram === 0, `exit ${usage.code}`);
    rmSync(dir, { recursive: true, force: true });
  }

  // 11 — the schema and its migration exist together.
  {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    check("schema declares model TelegramMessage", /\bmodel\s+TelegramMessage\s*\{/.test(schema));
    const migration = readdirSync("prisma/migrations").find((f) => {
      const sql = readFileSync(`prisma/migrations/${f}`, "utf8");
      return /CREATE TABLE "TelegramMessage"/.test(sql) && /CREATE UNIQUE INDEX "TelegramMessage_updateId_key"/.test(sql) &&
        /CREATE UNIQUE INDEX "TelegramMessage_sendId_key"/.test(sql);
    });
    check("a migration creates TelegramMessage with unique updateId and sendId", Boolean(migration), migration ?? "none");
  }

  // 12 — the registry.
  {
    const rule = ROUTE_RULES[ROUTE_KEY];
    check(`${ROUTE_KEY} is registered public`, rule?.kind === "public", JSON.stringify(rule));
    // verify-route-scopes refuses a public mutating route whose reason only
    // justifies reading, and one that claims a webhook reason without calling
    // its verifier; the reason must be one it knows for both.
    const scopesGuard = readFileSync("scripts/verify-route-scopes.ts", "utf8");
    const openToWrites = /const OPEN_TO_WRITES = new Set\(\[([\s\S]*?)\]\)/.exec(scopesGuard)?.[1] ?? "";
    const verifiedBy = /const VERIFIED_BY[^=]*=\s*\{([\s\S]*?)\};/.exec(scopesGuard)?.[1] ?? "";
    const why = rule?.kind === "public" ? JSON.stringify(rule.why) : "<none>";
    check("its reason is one the route-scopes guard accepts for a write", openToWrites.includes(why), why);
    check("…and one whose verifier the route-scopes guard demands", verifiedBy.includes(why), why);
  }
}

main()
  .catch((err) => check("the guard ran to the end", false, err instanceof Error ? `${err.message}\n${err.stack}` : String(err)))
  .finally(() => {
    console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
