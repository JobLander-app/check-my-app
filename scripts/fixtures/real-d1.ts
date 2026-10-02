// A real D1 for verify scripts (CHE-382): the generated Prisma client, the
// @prisma/adapter-d1 adapter, and a local D1 from Miniflare — the SQLite that
// `wrangler dev` runs — with every migration in prisma/migrations applied.
//
// The in-memory client (scripts/fixtures/mcp-db.ts) imitates D1; this one is
// D1. What only D1 can answer — how a DateTime stored as text compares and
// orders, what a NULL does in a range, the SQL Prisma really issues — is
// answered here. No network, no account: Miniflare runs workerd locally.
//
// The generated client imports its engine as `*.wasm?module`, which Node
// cannot load on its own; ./wasm-module-loader.mjs answers that import, and it
// must be imported before this file runs the client.
//
// Usage:
//   import "./fixtures/wasm-module-loader.mjs";
//   const d1 = await realD1();   // { db, exec, dispose }
//   …
//   await d1.dispose();

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "../../src/generated/prisma/client";

const MIGRATIONS = join(process.cwd(), "prisma/migrations");

// Statements of a migration file: split at a semicolon that ends a line,
// comments dropped. Our migrations are plain DDL/DML, one statement per
// semicolon (no triggers or bodies containing one).
function statements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

export async function realD1() {
  const mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: ["DB"] });
  const d1 = await mf.getD1Database("DB");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of statements(readFileSync(join(MIGRATIONS, file), "utf8"))) await d1.prepare(stmt).run();
  }
  const db = new PrismaClient({ adapter: new PrismaD1(d1 as never) });
  return {
    db,
    // Raw SQL, for writing a row the way a hand UPDATE did — which Prisma
    // never would.
    exec: (sql: string, ...params: unknown[]) => d1.prepare(sql).bind(...params).run(),
    dispose: async () => {
      await db.$disconnect();
      await mf.dispose();
    },
  };
}
