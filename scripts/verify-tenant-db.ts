// CHE-256 (Teams T3) verification: a query for a row a team owns cannot be
// written without saying whose rows it may see.
//
// The check is over the REGISTRY of call sites, not over observed behaviour: it
// enumerates every `db.<tenant model>.<method>(…)` in the request-serving code
// and demands that the query carries one of the five declarations from
// src/lib/tenant-db.ts. A new query with none of them fails the build the first
// time it is written — which is the point. A guard that counted unscoped
// queries, or sampled a few, would miss exactly the one nobody thought about
// (CHE-217/218/220 were three of those in one morning).
//
// src/agent is exempt as a directory, stated here rather than assumed: the
// scheduler, janitor, workflow and reconciler act for every team by definition
// and serve no request. If agent code ever answers a request, it stops being
// exempt, and this is where that has to be argued.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-tenant-db.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCANNED = ["src/app", "src/lib"];

// The models a team owns. A row of one of these can belong to somebody else,
// which is what makes an unscoped query a leak rather than a slow query.
// CHE-322: testAccount holds another team's passwords — the row a leak would
// cost the most.
const TENANT_MODELS = ["app", "run", "watch", "apiKey", "settledSignature", "testAccount"] as const;

// Files that may talk to these models without a declaration, each with its
// reason. Two, and both are about the plumbing rather than a tenant.
const EXEMPT = new Map<string, string>([
  ["src/lib/tenant-db.ts", "the declarations themselves"],
  ["src/lib/db.ts", "builds the client and assigns run numbers; owns no tenant query"],
]);

const DECLARATIONS = ["teamOwned", "memberOfRows", "alreadyScoped", "publicRow", "ownerScoped", "systemWide"] as const;
type Declaration = (typeof DECLARATIONS)[number];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

// Balance parens from the call's opening one, skipping strings, template
// literals and comments — the comments in this codebase contain apostrophes,
// and a lone quote read as a string swallows the rest of the file.
function callText(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const j = text.indexOf("\n", i);
      i = j < 0 ? text.length : j;
      continue;
    }
    if (two === "/*") {
      const j = text.indexOf("*/", i + 2);
      i = j < 0 ? text.length : j + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return text.slice(openIdx);
}

const files = SCANNED.flatMap((d) => walk(join(ROOT, d))).map((f) => relative(ROOT, f)).sort();
check(`scanned ${SCANNED.join(", ")}`, files.length > 0, `${files.length} files`);

const callPattern = new RegExp(String.raw`\b(?:db|prisma)\.(${TENANT_MODELS.join("|")})\.(\w+)\(`, "g");

type Site = { file: string; line: number; model: string; method: string; declared: Declaration | null; body: string };
const sites: Site[] = [];

for (const file of files) {
  if (EXEMPT.has(file)) continue;
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const match of text.matchAll(callPattern)) {
    const body = callText(text, match.index! + match[0].length - 1);
    sites.push({
      file,
      line: text.slice(0, match.index!).split("\n").length,
      model: match[1],
      method: match[2],
      declared: DECLARATIONS.find((d) => body.includes(`...${d}(`)) ?? null,
      body,
    });
  }
}

const undeclared = sites.filter((s) => s.declared === null);
check(
  `every tenant query declares whose rows it may see — ${sites.length} call sites`,
  undeclared.length === 0,
  undeclared.length === 0
    ? "all declared"
    : `\n${undeclared.map((s) => `        ${s.file}:${s.line}  ${s.model}.${s.method}`).join("\n")}`,
);

console.log(
  `\n        ${DECLARATIONS.map((d) => `${d}: ${sites.filter((s) => s.declared === d).length}`).join("  ·  ")}\n`,
);

// A raw statement reads tenant rows without going through `db.<model>`, so the
// registry above never sees it (Codex P1 on #236: four `$queryRaw` reads of a
// team's whole history, scoped today, unguarded tomorrow). Each one must bind
// the team in its own arguments through teamRows(…), and the Unsafe variants —
// SQL assembled as a string — have no place in request-serving code.
// Whatever the client is called at the call site (`db`, `prisma`, a helper's
// `client`): the method name is what identifies a raw statement.
const rawPattern = /\.\$(queryRaw|executeRaw)(Unsafe)?\b/g;
type RawSite = { file: string; line: number; unsafe: boolean; bound: boolean };
const rawSites: RawSite[] = [];
for (const file of files) {
  if (EXEMPT.has(file)) continue;
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const match of text.matchAll(rawPattern)) {
    // Past the type arguments, if any: `db.$queryRaw<(A & B)[]>(…)` has a
    // parenthesis in its type that is not the call's.
    let at = match.index! + match[0].length;
    if (text[at] === "<") {
      let depth = 0;
      for (; at < text.length; at++) {
        if (text[at] === "<") depth++;
        else if (text[at] === ">" && --depth === 0) break;
      }
      at++;
    }
    const open = text.indexOf("(", at);
    // A tagged template (db.$queryRaw`…`) has no parenthesis of its own: its
    // statement runs to the closing backtick.
    const tick = text.indexOf("`", at);
    const body = tick >= 0 && (open < 0 || tick < open) ? text.slice(tick, text.indexOf("`", tick + 1) + 1) : callText(text, open);
    rawSites.push({
      file,
      line: text.slice(0, match.index!).split("\n").length,
      unsafe: match[2] === "Unsafe",
      bound: body.includes("teamRows("),
    });
  }
}
const unbound = rawSites.filter((s) => !s.bound);
check(
  `every raw statement binds its team through teamRows — ${rawSites.length} raw statements`,
  unbound.length === 0,
  unbound.map((s) => `${s.file}:${s.line}`).join(", ") || "all bound",
);
check(
  "no raw statement is assembled as a string ($queryRawUnsafe / $executeRawUnsafe)",
  rawSites.every((s) => !s.unsafe),
  rawSites.filter((s) => s.unsafe).map((s) => `${s.file}:${s.line}`).join(", ") || "none",
);

// teamOwned is the only declaration that changes the query, and it only does so
// where it lands: in `where` it scopes, in `data` it stamps. Spread anywhere
// else it would be a label that reads like a scope and is not one.
const misplacedTeam = sites.filter(
  (s) => s.declared === "teamOwned" && !/where\s*:\s*\{[^}]*\.\.\.teamOwned\(/s.test(s.body) && !/data\s*:\s*\{[^}]*\.\.\.teamOwned\(/s.test(s.body),
);
check(
  "teamOwned is spread into `where` or `data`, never loose in the arguments",
  misplacedTeam.length === 0,
  misplacedTeam.map((s) => `${s.file}:${s.line}`).join(", ") || "clean",
);

// ownerScoped is temporary by design: it marks the rules that are still per
// person, which T7 (CHE-260) moves to the team. If it spreads beyond quota
// counting, the ticket grew — and that should be a decision, not a drift.
const OWNER_ALLOWED = new Set(["src/lib/plans.ts", "src/app/onboarding/page.tsx"]);
const strayOwner = sites.filter((s) => s.declared === "ownerScoped" && !OWNER_ALLOWED.has(s.file));
check(
  "ownerScoped appears only where a rule is genuinely per person (quota counting, until T7)",
  strayOwner.length === 0,
  strayOwner.map((s) => `${s.file}:${s.line}`).join(", ") ||
    `${sites.filter((s) => s.declared === "ownerScoped").length} sites in ${[...OWNER_ALLOWED].join(", ")}`,
);

// publicRow means "addressed by an unguessable id". A signed-in surface is not
// that, and a query there claiming it would be serving another team's rows
// behind a login.
const publicOnPrivate = sites.filter(
  (s) => s.declared === "publicRow" && /^src\/app\/(\(app\)|dashboard|onboarding|watch)\//.test(s.file),
);
check(
  "no signed-in surface claims publicRow",
  publicOnPrivate.length === 0,
  publicOnPrivate.map((s) => `${s.file}:${s.line}`).join(", ") || "clean",
);

// systemWide is for our own processes. In request-serving code the only honest
// use is a page that measures the whole product rather than showing one team
// its rows — the accuracy page. Anywhere else it is a leak wearing a label.
const ACCURACY_PAGE = "src/app/(app)/health/accuracy/page.tsx";
const SYSTEM_ALLOWED = new Set(["src/lib/ephemeral.ts", ACCURACY_PAGE]);
const straySystem = sites.filter((s) => s.declared === "systemWide" && !SYSTEM_ALLOWED.has(s.file));
check(
  "systemWide appears only in our own processes",
  straySystem.length === 0,
  straySystem.map((s) => `${s.file}:${s.line}`).join(", ") ||
    `${sites.filter((s) => s.declared === "systemWide").length} sites in ${[...SYSTEM_ALLOWED].join(", ")}`,
);

// The signed-in app is the surface where a leak would be invisible: it shows a
// signed-in person their own apps, so a missing clause shows them somebody
// else's and looks like a feature. Every query there must be team-scoped or
// pinned to a row already scoped. (CHE-351: the app lives in the (app) route
// group; the actions it posts to stay under src/app/dashboard.)
const dashboard = sites.filter((s) => /^src\/app\/(\(app\)|dashboard)\//.test(s.file) && s.file !== ACCURACY_PAGE);
// `memberOfRows` is allowed here for one job only: answering "is this row in a
// team of yours" so a deep link can offer the switch instead of 404ing a row
// the person is entitled to see (CHE-261). It grants nothing — the scope that
// decides is the one they have in that team, after they switch.
const DASHBOARD_OK = ["teamOwned", "alreadyScoped", "memberOfRows"];
check(
  "every dashboard query is teamOwned, alreadyScoped or memberOfRows",
  dashboard.every((s) => s.declared !== null && DASHBOARD_OK.includes(s.declared)),
  dashboard.filter((s) => s.declared === null || !DASHBOARD_OK.includes(s.declared)).map((s) => `${s.file}:${s.line} ${s.declared}`).join(", ") ||
    `${dashboard.length} queries`,
);

for (const [file, why] of EXEMPT) {
  check(`exempt: ${file} — ${why}`, files.includes(file));
}

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
