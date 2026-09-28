// An in-memory stand-in for the Prisma client, for the MCP verify scripts
// (verify-mcp-remote.ts, verify-mcp.ts — CHE-315).
//
// Why not a real database: the generated client is the workerd build (WASM
// query compiler), which plain Node cannot load, and the verify registry must
// pass with no arguments and no environment (AGENTS.md). So this implements
// the slice of the Prisma API the MCP tools reach — findUnique / findFirst /
// findMany / count / create / update / updateMany / deleteMany / upsert with `where`, `select`,
// `include`, `orderBy`, `take`, nested `create` and `increment` — over plain
// arrays of rows.
//
// It evaluates `where` for real: a query that forgets its team clause returns
// the other team's rows here exactly as it would in D1, which is the point of
// the team-scoping checks built on it.

import type { PrismaClient } from "@/generated/prisma/client";

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;

interface Relation {
  model: string;
  // own field → field on the related row
  local: string;
  foreign: string;
  many: boolean;
}

const RELATIONS: Record<string, Record<string, Relation>> = {
  apiKey: {
    owner: { model: "user", local: "ownerId", foreign: "id", many: false },
    team: { model: "team", local: "teamId", foreign: "id", many: false },
  },
  app: {
    watch: { model: "watch", local: "id", foreign: "appId", many: false },
    policy: { model: "ticketPolicy", local: "id", foreign: "appId", many: false },
    runs: { model: "run", local: "id", foreign: "appId", many: true },
    // CHE-322: named test accounts.
    testAccounts: { model: "testAccount", local: "id", foreign: "appId", many: true },
  },
  run: {
    findings: { model: "finding", local: "id", foreign: "runId", many: true },
    journeys: { model: "journey", local: "id", foreign: "runId", many: true },
    llmUsage: { model: "llmUsage", local: "id", foreign: "runId", many: true },
    // CHE-327: a run is priced on its team's plan.
    team: { model: "team", local: "teamId", foreign: "id", many: false },
  },
  journey: { steps: { model: "step", local: "id", foreign: "journeyId", many: true } },
  finding: { evidence: { model: "evidence", local: "id", foreign: "findingId", many: true } },
};

// Column defaults the schema would fill in.
const DEFAULTS: Record<string, () => Row> = {
  app: () => ({ targetKind: "website", writeMode: "read_only", extensionId: null, extensionConfig: null,
    testEmail: null, testPasswordEnc: null, scopeHints: null, userNotes: null, focusAreas: null }),
  watch: () => ({ active: true, frequency: "daily", notifyOnChangeOnly: true, nextRunAt: null, trialEndsAt: null }),
  run: () => ({ status: "queued", verdict: null, bottomLine: null, events: null, errorMessage: null, anatomy: null,
    targetKind: "website", deploySha: null, deployEnv: null, completedAt: null, costUsd: null, ephemeral: false,
    expiresAt: null, startedAt: new Date(), forceFull: false, appId: null,
    // CHE-327: unpriced until the workflow prices it.
    priceUsd: null, priceFromTopupUsd: 0, quickPagesOpened: null }),
  team: () => ({ topupUsd: 0, balanceNoticeSentAt: null }),
  teamEvent: () => ({}),
  ticketPolicy: () => ({}),
};

let seq = 0;
const nextId = (model: string) => `${model}_${(++seq).toString(36).padStart(6, "0")}`;

function matchValue(value: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
    const c = cond as Record<string, unknown>;
    if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
    if ("notIn" in c && (c.notIn as unknown[]).includes(value)) return false;
    if ("not" in c && value === c.not) return false;
    if ("equals" in c && value !== c.equals) return false;
    if ("gte" in c && !((value as Date | number) >= (c.gte as Date | number))) return false;
    if ("lte" in c && !((value as Date | number) <= (c.lte as Date | number))) return false;
    // CHE-327: a null never passes a comparison, as in SQL.
    if ("gt" in c && (value == null || !((value as Date | number) > (c.gt as Date | number)))) return false;
    if ("lt" in c && (value == null || !((value as Date | number) < (c.lt as Date | number)))) return false;
    return true;
  }
  if (value instanceof Date && cond instanceof Date) return value.getTime() === cond.getTime();
  return value === cond;
}

export function createStubDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  const table = (m: string) => (tables[m] ??= []);
  for (const [m, rows] of Object.entries(seed)) table(m).push(...rows.map((r) => ({ ...r })));
  const calls: string[] = [];

  function matches(model: string, row: Row, where: Args | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === "OR") {
        if (!(cond as Args[]).some((w) => matches(model, row, w))) return false;
        continue;
      }
      if (key === "AND") {
        if (!(cond as Args[]).every((w) => matches(model, row, w))) return false;
        continue;
      }
      // Compound unique, e.g. ownerId_appSlug: { ownerId, appSlug }.
      if (key.includes("_") && cond && typeof cond === "object" && !(key in row)) {
        if (!Object.entries(cond as Args).every(([k, v]) => row[k] === v)) return false;
        continue;
      }
      if (!matchValue(row[key], cond)) return false;
    }
    return true;
  }

  function order(rows: Row[], orderBy: unknown): Row[] {
    const list = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, "asc" | "desc">[];
    return [...rows].sort((a, b) => {
      for (const o of list) {
        const [field, dir] = Object.entries(o)[0];
        const av = a[field] as number | string | Date | null;
        const bv = b[field] as number | string | Date | null;
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = av < bv ? -1 : 1;
        return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  function related(model: string, row: Row, name: string, spec: unknown): unknown {
    const rel = RELATIONS[model]?.[name];
    if (!rel) throw new Error(`stub db: no relation ${model}.${name}`);
    const opts = (spec === true ? {} : spec) as Args;
    let rows = table(rel.model).filter((r) => r[rel.foreign] === row[rel.local] && row[rel.local] != null);
    if (!rel.many) return rows[0] ? project(rel.model, rows[0], opts) : null;
    rows = rows.filter((r) => matches(rel.model, r, opts.where as Args));
    rows = order(rows, opts.orderBy);
    if (typeof opts.take === "number") rows = rows.slice(0, opts.take);
    return rows.map((r) => project(rel.model, r, opts));
  }

  function project(model: string, row: Row, args: Args = {}): Row {
    const select = args.select as Args | undefined;
    const include = args.include as Args | undefined;
    if (select) {
      const out: Row = {};
      for (const [k, v] of Object.entries(select)) {
        if (!v) continue;
        if (k === "_count") {
          // { _count: { select: { steps: { where } | true } } }
          const counts: Row = {};
          for (const [rel, spec] of Object.entries(((v as Args).select ?? {}) as Args)) {
            counts[rel] = (related(model, row, rel, spec === true ? {} : { where: (spec as Args).where }) as Row[]).length;
          }
          out._count = counts;
          continue;
        }
        out[k] = RELATIONS[model]?.[k] ? related(model, row, k, v) : row[k];
      }
      return out;
    }
    const out: Row = { ...row };
    for (const [k, v] of Object.entries(include ?? {})) if (v) out[k] = related(model, row, k, v);
    return out;
  }

  function create(model: string, data: Args): Row {
    const row: Row = { id: nextId(model), createdAt: new Date(), updatedAt: new Date(), ...(DEFAULTS[model]?.() ?? {}) };
    if (model === "run") row.publicId = nextId("pub");
    const nested: [string, Args][] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const rel = RELATIONS[model]?.[k];
      if (rel) {
        if (v && typeof v === "object" && "create" in (v as Args)) nested.push([k, (v as Args).create as Args]);
        continue;
      }
      row[k] = v;
    }
    table(model).push(row);
    for (const [k, childData] of nested) {
      const rel = RELATIONS[model][k];
      create(rel.model, { ...childData, [rel.foreign]: row[rel.local] });
    }
    return row;
  }

  function applyUpdate(row: Row, data: Args) {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in (v as Args)) {
        row[k] = (row[k] as number) + ((v as Args).increment as number);
      } else if (v && typeof v === "object" && !(v instanceof Date) && "decrement" in (v as Args)) {
        row[k] = (row[k] as number) - ((v as Args).decrement as number);
      } else row[k] = v;
    }
    row.updatedAt = new Date();
  }

  function model(name: string) {
    const find = (args: Args) => table(name).filter((r) => matches(name, r, args.where as Args));
    return {
      findUnique: async (args: Args) => {
        calls.push(`${name}.findUnique`);
        const row = find(args)[0];
        return row ? project(name, row, args) : null;
      },
      findFirst: async (args: Args) => {
        calls.push(`${name}.findFirst`);
        const row = order(find(args), args.orderBy)[0];
        return row ? project(name, row, args) : null;
      },
      findMany: async (args: Args = {}) => {
        calls.push(`${name}.findMany`);
        let rows = order(find(args), args.orderBy);
        if (typeof args.take === "number") rows = rows.slice(0, args.take);
        return rows.map((r) => project(name, r, args));
      },
      count: async (args: Args = {}) => {
        calls.push(`${name}.count`);
        return find(args).length;
      },
      // CHE-327: the balance is a sum over priced runs.
      aggregate: async (args: Args) => {
        calls.push(`${name}.aggregate`);
        const rows = find(args);
        const _sum: Row = {};
        for (const f of Object.keys((args._sum ?? {}) as Args)) {
          const vals = rows.map((r) => r[f]).filter((x): x is number => typeof x === "number");
          _sum[f] = vals.length ? vals.reduce((s, x) => s + x, 0) : null;
        }
        return { _sum };
      },
      groupBy: async (args: Args) => {
        calls.push(`${name}.groupBy`);
        const by = args.by as string[];
        const groups = new Map<string, Row[]>();
        for (const r of find(args)) {
          const key = JSON.stringify(by.map((b) => r[b]));
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        return [...groups.values()].map((rows) => {
          const out: Row = {};
          for (const b of by) out[b] = rows[0][b];
          const _sum: Row = {};
          for (const f of Object.keys((args._sum ?? {}) as Args)) {
            _sum[f] = rows.reduce((s, r) => s + ((r[f] as number) ?? 0), 0);
          }
          out._sum = _sum;
          out._count = { _all: rows.length };
          return out;
        });
      },
      create: async (args: Args) => {
        calls.push(`${name}.create`);
        return project(name, create(name, args.data as Args), args);
      },
      update: async (args: Args) => {
        calls.push(`${name}.update`);
        const row = find(args)[0];
        if (!row) throw new Error(`stub db: ${name}.update found no row for ${JSON.stringify(args.where)}`);
        applyUpdate(row, args.data as Args);
        return project(name, row, args);
      },
      updateMany: async (args: Args) => {
        calls.push(`${name}.updateMany`);
        const rows = find(args);
        for (const row of rows) applyUpdate(row, args.data as Args);
        return { count: rows.length };
      },
      deleteMany: async (args: Args = {}) => {
        calls.push(`${name}.deleteMany`);
        const doomed = new Set(find(args));
        tables[name] = table(name).filter((r) => !doomed.has(r));
        return { count: doomed.size };
      },
      upsert: async (args: Args) => {
        calls.push(`${name}.upsert`);
        const row = find(args)[0];
        if (row) {
          applyUpdate(row, args.update as Args);
          return project(name, row, args);
        }
        return project(name, create(name, args.create as Args), args);
      },
    };
  }

  const db = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => model(prop),
  }) as unknown as PrismaClient;

  return { db, tables, table, calls };
}
