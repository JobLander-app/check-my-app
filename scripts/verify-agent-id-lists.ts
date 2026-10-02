// CHE-403 verification: no query in src/agent sorts an id list by a column it
// does not select.
//
// Measured on a real local D1 (PR #256): a Prisma model query whose `in` list
// goes over D1's bound-parameter cap is split and merged by Prisma, and the
// merge aborts the wasm engine — `RuntimeError: unreachable`, the process dies
// — when the query has an `orderBy` on a column that is not in its `select`.
// With every ordered column selected, or with no `orderBy`, the same list is
// fine. In the agent that is a failed run, for exactly the apps with the most
// history; `planKnownJourneys` had the shape.
//
// The crash needs the real engine and a hundred ids; what can be held here, on
// every commit, is the shape: any findMany / findFirst in src/agent whose `in:`
// list is not a literal and which has an `orderBy` must select every column it
// sorts by. (A query with `include`, or with no `select`, returns every column
// of the model, so its own columns are all there.)
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-agent-id-lists.ts

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

export interface IdListQuery {
  where: string;
  lists: string[];
  sortedBy: string[];
  selected: string[] | null;
}

// The argument object of a call, from its opening brace to the matching one.
function braces(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

// The entries of an object literal at its OWN level: key → the source of its
// value. Nesting is followed, not guessed at — `include` three levels down in a
// relation's select is not the query's include, and a column named in a
// relation's select is not one the query returns (Codex on #258: the first
// reader looked for the word anywhere in the call).
export function ownEntries(objectSource: string): Map<string, string> {
  // Comments out first: "// CHE-403: …" inside a query would read as a key.
  const source = objectSource.replace(/(^|\s)\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  let depth = 0;
  let key: string | null = null;
  let valueStart = -1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0 && key !== null) out.set(key, source.slice(valueStart, i).trim());
      continue;
    }
    if (depth !== 1) continue;
    if (key === null) {
      const named = /^(\w+)\s*:/.exec(source.slice(i));
      if (named && !/\w/.test(source[i - 1] ?? "")) {
        key = named[1];
        valueStart = i + named[0].length;
        i = valueStart - 1;
      }
    } else if (ch === ",") {
      out.set(key, source.slice(valueStart, i).trim());
      key = null;
    }
  }
  return out;
}

// The columns an orderBy sorts by: the keys of its object, or of each object in
// its list — whatever way the direction is written ("asc", 'desc', a constant,
// `{ sort: "asc", nulls: "last" }`). The first reader looked for a double-quoted
// direction and saw nothing to check in `{ createdAt: 'desc' }` (Codex on #258).
// An orderBy that is not written out here (a variable, a call) cannot be read,
// and is reported as such rather than passed.
export const UNREADABLE_ORDER = "(an orderBy this guard cannot read)";
export function sortedColumns(orderSource: string): string[] {
  const order = orderSource.trim();
  if (order.startsWith("{")) return [...ownEntries(order).keys()];
  if (!order.startsWith("[")) return [UNREADABLE_ORDER];
  const columns: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 1; i < order.length - 1; i++) {
    if (order[i] === "{" && depth++ === 0) start = i;
    else if (order[i] === "}" && --depth === 0) columns.push(...ownEntries(order.slice(start, i + 1)).keys());
  }
  return columns.length ? columns : [UNREADABLE_ORDER];
}

/** Every findMany / findFirst in a source text that has both a variable `in:` list and an `orderBy`. */
export function idListQueries(text: string, where: string): IdListQuery[] {
  const found: IdListQuery[] = [];
  for (const call of text.matchAll(/\.(?:findMany|findFirst)\(\s*\{/g)) {
    const top = ownEntries(braces(text, call.index + call[0].length - 1));
    // `in: [...]` written out is a fixed list; anything else can be any length.
    const lists = [...(top.get("where") ?? "").matchAll(/(\w+):\s*\{\s*(?:not)?[iI]n:\s*(?![\s[])([^,}\n]+)/g)].map((m) => `${m[1]} in ${m[2].trim()}`);
    const order = top.get("orderBy");
    if (lists.length === 0 || !order) continue;
    const sortedBy = sortedColumns(order);
    // What the query itself returns: every column of the model when it has no
    // select of its own (with or without a top-level include); otherwise the
    // columns its own select sets to true — not what a relation inside selects.
    const select = top.get("select");
    const selected = select === undefined ? null : [...ownEntries(select)].filter(([, value]) => value === "true").map(([column]) => column);
    found.push({ where: `${where}:${text.slice(0, call.index).split("\n").length}`, lists, sortedBy, selected });
  }
  return found;
}

export const unsafe = (q: IdListQuery): string[] => (q.selected === null ? [] : q.sortedBy.filter((column) => !q.selected!.includes(column)));

function main() {
  // The reader itself, on the shapes it has to tell apart.
  const was = `
    env.db.journey.findMany({
      where: { runId: { in: walkedRunIds }, appJourneyId: { in: due.map((j) => j.appJourneyId) }, carriedFromRunId: null },
      orderBy: { order: "asc" },
      select: { id: true, runId: true, appJourneyId: true },
    })`;
  const fixedList = `db.finding.findMany({ where: { mark: { in: ["known", "false_positive"] } }, orderBy: { createdAt: "desc" }, select: { title: true } })`;
  const selectsIt = `db.run.findMany({ where: { id: { in: ids } }, orderBy: { startedAt: "desc" }, select: { id: true, startedAt: true } })`;
  const wholeRow = `db.run.findMany({ where: { id: { in: ids } }, orderBy: { startedAt: "desc" } })`;
  const unsorted = `db.run.findMany({ where: { id: { in: ids } }, select: { id: true } })`;
  const twoColumns = `db.step.findFirst({ where: { journeyId: { notIn: seen } }, orderBy: [{ order: "asc" }, { createdAt: "desc" }], select: { id: true, order: true } })`;
  check("reader: the query as it was — two variable lists, sorted by a column it does not select — is the unsafe shape",
    idListQueries(was, "x").length === 1 && unsafe(idListQueries(was, "x")[0]).join() === "order", JSON.stringify(idListQueries(was, "x")));
  check("reader: a list written out in the source is fixed, not a hazard", idListQueries(fixedList, "x").length === 0);
  check("reader: sorting by a selected column is safe", unsafe(idListQueries(selectsIt, "x")[0]).length === 0);
  check("reader: a query that returns whole rows has every column it sorts by", unsafe(idListQueries(wholeRow, "x")[0]).length === 0);
  check("reader: no orderBy, nothing to merge in order", idListQueries(unsorted, "x").length === 0);
  check("reader: each sorted column is checked — one missing is enough",
    unsafe(idListQueries(twoColumns, "x")[0]).join() === "createdAt", JSON.stringify(idListQueries(twoColumns, "x")));
  // Nesting: what a relation inside the select does is not what the query returns.
  const nestedInclude = `db.journey.findMany({ where: { runId: { in: ids } }, orderBy: { order: "asc" }, select: { id: true, steps: { include: { evidence: true } } } })`;
  const nestedSelect = `db.journey.findMany({ where: { runId: { in: ids } }, orderBy: { order: "asc" }, select: { id: true, run: { select: { order: true } } } })`;
  const topInclude = `db.journey.findMany({ where: { runId: { in: ids } }, orderBy: { order: "asc" }, include: { steps: { select: { id: true } } } })`;
  const commented = `db.journey.findMany({
      where: { runId: { in: ids } },
      // order: listed here in words only, see select: below
      orderBy: { order: "asc" },
      select: { id: true /* order: true */ },
    })`;
  check("reader: an include inside a selected relation does not make the query return whole rows",
    unsafe(idListQueries(nestedInclude, "x")[0]).join() === "order", JSON.stringify(idListQueries(nestedInclude, "x")));
  check("reader: a column selected inside a relation is not a column the query returns",
    unsafe(idListQueries(nestedSelect, "x")[0]).join() === "order", JSON.stringify(idListQueries(nestedSelect, "x")));
  check("reader: an include of the query's own does return whole rows", unsafe(idListQueries(topInclude, "x")[0]).length === 0);
  check("reader: a column named only in a comment is not selected",
    unsafe(idListQueries(commented, "x")[0]).join() === "order", JSON.stringify(idListQueries(commented, "x")));
  // The direction can be written any valid way; the column is the key.
  for (const [how, order] of [
    ["single quotes", "{ createdAt: 'desc' }"],
    ["a template literal", "{ createdAt: `desc` }"],
    ["a constant", "{ createdAt: Prisma.SortOrder.desc }"],
    ["a variable", "{ createdAt: direction }"],
    ["the long form", '{ createdAt: { sort: "desc", nulls: "last" } }'],
    ["a list, single-quoted", "[{ order: 'asc' }, { createdAt: 'desc' }]"],
  ] as const) {
    const query = `db.run.findMany({ where: { id: { in: ids } }, orderBy: ${order}, select: { id: true, order: true } })`;
    check(`reader: a direction written with ${how} still names its column`, unsafe(idListQueries(query, "x")[0]).join() === "createdAt", JSON.stringify(idListQueries(query, "x")));
  }
  const variableOrder = `db.run.findMany({ where: { id: { in: ids } }, orderBy: sortFor(view), select: { id: true } })`;
  check("reader: an orderBy that is not written out cannot be read — reported, not passed",
    unsafe(idListQueries(variableOrder, "x")[0]).join() === UNREADABLE_ORDER, JSON.stringify(idListQueries(variableOrder, "x")));
  check("reader: an object's own entries, with nesting, strings and calls in the values",
    JSON.stringify([...ownEntries(`{ a: { in: f(x, { y: 1 }) }, b: "c: d, e", g: [1, 2], h: true }`)]) ===
      JSON.stringify([["a", "{ in: f(x, { y: 1 }) }"], ["b", '"c: d, e"'], ["g", "[1, 2]"], ["h", "true"]]),
    JSON.stringify([...ownEntries(`{ a: { in: f(x, { y: 1 }) }, b: "c: d, e", g: [1, 2], h: true }`)]));

  // src/agent, every file.
  const root = join(process.cwd(), "src/agent");
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => /\.ts$/.test(file));
  const queries = files.flatMap((file) => idListQueries(readFileSync(join(root, file), "utf8"), `src/agent/${file}`));
  const bad = queries.filter((q) => unsafe(q).length > 0);
  check("src/agent: no query sorts a variable id list by a column it does not select", files.length > 20 && bad.length === 0,
    bad.length ? bad.map((q) => `${q.where} sorts by ${unsafe(q).join(", ")} (${q.lists.join("; ")})`).join(" | ") : `${files.length} files, ${queries.length} queries of that kind, all safe`);
  const known = readFileSync(join(root, "partial.ts"), "utf8");
  check("planKnownJourneys: its walk-row query has no orderBy and selects the column the rows are then sorted by",
    /appJourneyId: \{ in: due\.map\(.*?\) \},[\s\S]{0,700}?select: \{ id: true, runId: true, appJourneyId: true, order: true \}/.test(known) &&
      idListQueries(known, "partial.ts").every((q) => !q.lists.some((l) => l.startsWith("appJourneyId in due"))) &&
      /\[\.\.\.sourceJourneys\]\.sort\(\(a, b\) => a\.order - b\.order\)/.test(known));

  console.log(failures === 0 ? "\nverify-agent-id-lists: all checks passed" : `\nverify-agent-id-lists: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
