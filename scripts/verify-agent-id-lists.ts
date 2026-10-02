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

/** Every findMany / findFirst in a source text that has both a variable `in:` list and an `orderBy`. */
export function idListQueries(text: string, where: string): IdListQuery[] {
  const found: IdListQuery[] = [];
  for (const call of text.matchAll(/\.(?:findMany|findFirst)\(\s*\{/g)) {
    const body = braces(text, call.index + call[0].length - 1);
    // `in: [...]` written out is a fixed list; anything else can be any length.
    const lists = [...body.matchAll(/(\w+):\s*\{\s*(?:not)?[iI]n:\s*(?![\s[])([^,}\n]+)/g)].map((m) => `${m[1]} in ${m[2].trim()}`);
    const order = body.match(/orderBy:\s*(\{[^}]*\}|\[[\s\S]*?\])/);
    if (lists.length === 0 || !order) continue;
    const sortedBy = [...order[1].matchAll(/(\w+):\s*"(?:asc|desc)"/g)].map((m) => m[1]);
    // The query's own select: the one at the top of the argument, not a nested relation's.
    const top = body.match(/\n {6,8}select:\s*\{([\s\S]*?)\}\s*,?\s*\n/) ?? body.match(/select:\s*\{([^{}]*)\}/);
    const selected = /\binclude:/.test(body) || !top ? null : [...top[1].matchAll(/(\w+):\s*true/g)].map((m) => m[1]);
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
