// CHE-446 verification: a team's admin names the team.
//
//   1. the name's rule: trimmed, inner whitespace collapsed, 1–60 characters;
//   2. on a real D1 (Miniflare): a valid name is written, an invalid one leaves
//      the row as it was, the same name is not a change;
//   3. only an admin may: the scope table, and the server action asks for it
//      (read as syntax, not text), whatever the page shows;
//   4. the page offers the form to exactly who the server would honour, the
//      change is logged, and the invite names the team from the row.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-team-name.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { calls, jsx, properties, source } from "./fixtures/ts-source";
import { TEAM_NAME_MAX, checkTeamName, renameTeam } from "../src/lib/team-name";
import { ADMIN_ONLY, can } from "../src/lib/scopes";
import { ACTION_RULES } from "../src/lib/route-scopes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

async function main() {
  // 1. The rule.
  eq("trimmed, inner spaces collapsed", checkTeamName("  Securify \n  team "), { ok: true, name: "Securify team" });
  eq("empty is refused", checkTeamName("   ").ok, false);
  eq(`${TEAM_NAME_MAX} characters is fine`, checkTeamName("x".repeat(TEAM_NAME_MAX)).ok, true);
  eq(`${TEAM_NAME_MAX + 1} is refused`, checkTeamName("x".repeat(TEAM_NAME_MAX + 1)).ok, false);
  eq("a name in another script counts characters, not bytes", checkTeamName("Сек".repeat(20)).ok, true);

  // 2. The row.
  const real = await realD1();
  const { db } = real;
  try {
    await db.team.create({ data: { id: "ta", name: "Vladislav Sorokin", plan: "business" } });
    await db.team.create({ data: { id: "tb", name: "Else", plan: "business" } });
    const renamed = await renameTeam(db, "ta", "  Securify ");
    eq("a valid name is written", [renamed.ok, (await db.team.findUnique({ where: { id: "ta" } }))?.name], [true, "Securify"]);
    eq("…and says what it was", renamed.ok && renamed.previous, "Vladislav Sorokin");
    eq("another team is untouched", (await db.team.findUnique({ where: { id: "tb" } }))?.name, "Else");
    const empty = await renameTeam(db, "ta", " ");
    eq("an empty name is refused and the row keeps its name", [empty.ok, (await db.team.findUnique({ where: { id: "ta" } }))?.name], [false, "Securify"]);
    const same = await renameTeam(db, "ta", "Securify");
    eq("the same name is not a change (nothing to log)", same.ok && same.changed, false);
    eq("a team that does not exist is refused", (await renameTeam(db, "nope", "X")).ok, false);
  } finally {
    await real.dispose();
  }

  // 3. Who may.
  eq("admin may, member and reader may not", ["admin", "member", "reader"].map((s) => can(s as never, "team.rename")), [true, false, false]);
  check("renaming is on the admin-only list", ADMIN_ONLY.includes("team.rename"));
  const actions = source("src/app/team/actions.ts");
  const inFn = (fn: string) => calls(actions).filter((c) => insideFunction(c.node, fn));
  const renameCalls = inFn("renameTeamAction");
  const scopeCall = renameCalls.find((c) => c.callee === "requireActionScope" && c.args[0] === '"team.rename"');
  const writeCall = renameCalls.find((c) => c.callee === "renameTeam");
  check(
    "the server action asks for team.rename before it writes",
    Boolean(scopeCall && writeCall) && scopeCall!.node.getStart(actions) < writeCall!.node.getStart(actions),
  );
  const logCall = renameCalls.find((c) => c.callee === "recordTeamEvent");
  const logGuard = logCall && enclosingIf(logCall.node);
  check(
    "…and logs the change for the team — only when the name really changed",
    Boolean(logGuard) && logGuard!.expression.getText(actions) === "result.changed",
  );
  eq("the action registry says the same", ACTION_RULES["src/app/team/actions.ts#renameTeamAction"], { kind: "team", action: "team.rename" });

  // 4. The page and the readers, each at its own call site.
  const page = source("src/app/(app)/settings/team/page.tsx");
  const forms = jsx(page).filter((e) => e.tag === "TeamNameForm");
  check("the page offers the form only to who the server honours — every use of it", forms.length > 0 && forms.every((e) => e.guard === 'can(scope, "team.rename")'), String(forms.length));
  const inviteMail = inFn("inviteMemberAction").find((c) => c.callee === "sendInviteMail");
  check(
    "an invitation names the team from its row",
    Boolean(inviteMail) && objectProp(inviteMail!.node.arguments[1], "teamName", actions) === "team.name",
  );
  const teamsSf = source("src/lib/teams.ts");
  const mapped = calls(teamsSf).filter((c) => c.callee.endsWith(".map")).some((c) => objectProp(arrowBody(c.node.arguments[0]), "name", teamsSf) === "m.team.name");
  check("the switcher's list reads the row's name", mapped);
  const handler = source("src/lib/mcp/handler.ts");
  check(
    "…and so do the MCP instructions",
    calls(handler).some((c) => c.callee === "buildInstructions" && c.args[0] === "caller.team.name"),
  );

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

import ts from "typescript";
function insideFunction(node: ts.Node, name: string): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) return true;
  }
  return false;
}
// The nearest `if` whose then-branch holds the node.
function enclosingIf(node: ts.Node): ts.IfStatement | null {
  for (let n: ts.Node | undefined = node; n?.parent; n = n.parent) {
    if (ts.isIfStatement(n.parent) && n.parent.thenStatement === n) return n.parent;
  }
  return null;
}
// `{ key: value }` → value's source text, when the node is that object literal.
function objectProp(node: ts.Node | undefined, key: string, sf: ts.SourceFile): string | null {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  for (const p of node.properties) if (ts.isPropertyAssignment(p) && p.name.getText(sf) === key) return p.initializer.getText(sf);
  return null;
}
// `(m) => ({ … })` → the object literal it returns.
function arrowBody(node: ts.Node | undefined): ts.Node | undefined {
  if (!node || !ts.isArrowFunction(node)) return undefined;
  let body: ts.Node = node.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  return body;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
