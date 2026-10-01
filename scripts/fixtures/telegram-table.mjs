// A TelegramMessage table for the CHE-375 guard (scripts/verify-telegram-webhook.ts)
// and for the fake fetch it gives tg-send (scripts/fixtures/tg-send-fetch.mjs).
//
// With node:sqlite (Node >= 22.5, which CI runs) it is the real migration in a
// real SQLite, so the statements themselves are under test. package.json also
// allows Node 20, which has no node:sqlite; there a small interpreter reads the
// statement shapes src/lib/telegram-send.ts uses, unique keys included.
//
// run(sql, params) → { results, changes }   all() → every row

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function migrationSql(root) {
  const dir = join(root, "prisma/migrations");
  const file = readdirSync(dir).find((f) => /CREATE TABLE "TelegramMessage"/.test(readFileSync(join(dir, f), "utf8")));
  if (!file) throw new Error("no migration creates TelegramMessage");
  return readFileSync(join(dir, file), "utf8");
}

export async function telegramTable(root = process.cwd(), { forceInterpreter = false } = {}) {
  let sqlite = null;
  if (!forceInterpreter) {
    try {
      sqlite = await import("node:sqlite");
    } catch {
      sqlite = null;
    }
  }
  if (sqlite) {
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec(migrationSql(root));
    return {
      kind: "sqlite",
      run(sql, params = []) {
        const stmt = db.prepare(sql);
        if (/^\s*SELECT/i.test(sql)) return { results: stmt.all(...params), changes: 0 };
        const info = stmt.run(...params);
        return { results: [], changes: Number(info.changes) };
      },
      all: () => db.prepare('SELECT * FROM "TelegramMessage"').all(),
    };
  }
  return interpretedTable();
}

const UNIQUE = ["id", "updateId", "sendId"];

export function interpretedTable() {
  const rows = [];
  const unquote = (c) => c.trim().replace(/^"|"$/g, "");
  return {
    kind: "interpreter",
    run(sql, params = []) {
      const queue = [...params];
      const value = (token) => {
        const t = token.trim();
        if (t === "?") return queue.length ? queue.shift() : null;
        if (t === "NULL") return null;
        if (/^'.*'$/.test(t)) return t.slice(1, -1);
        return Number(t);
      };
      const conditions = (where) =>
        where.split(/\s+AND\s+/).map((c) => {
          const [col, val] = c.split("=");
          return [unquote(col), val];
        });
      const s = sql.trim();
      let m;
      if ((m = /^INSERT INTO "TelegramMessage" \(([^)]*)\) VALUES \(([^)]*)\)$/.exec(s))) {
        const names = m[1].split(",").map(unquote);
        const values = m[2].split(",").map(value);
        if (names.length !== values.length) throw new Error("column/value count mismatch");
        const row = Object.fromEntries(names.map((n, i) => [n, values[i]]));
        for (const key of UNIQUE) {
          if (row[key] != null && rows.some((r) => r[key] === row[key])) {
            throw new Error(`UNIQUE constraint failed: TelegramMessage.${key}`);
          }
        }
        rows.push(row);
        return { results: [], changes: 1 };
      }
      if ((m = /^SELECT (.+) FROM "TelegramMessage" WHERE (.+)$/.exec(s))) {
        const cols = m[1].split(",").map(unquote);
        const conds = conditions(m[2]).map(([c, v]) => [c, value(v)]);
        const hits = rows.filter((r) => conds.every(([c, v]) => r[c] === v));
        return { results: hits.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))), changes: 0 };
      }
      if ((m = /^UPDATE "TelegramMessage" SET (.+) WHERE (.+)$/.exec(s))) {
        const sets = m[1].split(/,\s*(?=")/).map((a) => {
          const [col, val] = a.split("=");
          return [unquote(col), value(val)];
        });
        const conds = conditions(m[2]).map(([c, v]) => [c, value(v)]);
        const hits = rows.filter((r) => conds.every(([c, v]) => r[c] === v));
        for (const r of hits) for (const [c, v] of sets) r[c] = v;
        return { results: [], changes: hits.length };
      }
      throw new Error(`the interpreter does not know this statement: ${s.slice(0, 80)}`);
    },
    all: () => rows,
  };
}
