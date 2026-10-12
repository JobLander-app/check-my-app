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
  const inRename = (callee: string) => calls(actions).some((c) => c.callee === callee && insideFunction(c.node, "renameTeamAction"));
  check(
    "the server action asks for team.rename before it writes",
    calls(actions).some((c) => c.callee === "requireActionScope" && c.args[0] === '"team.rename"' && insideFunction(c.node, "renameTeamAction")) &&
      inRename("renameTeam"),
  );
  check("…and logs the change for the team", inRename("recordTeamEvent"));
  eq("the action registry says the same", ACTION_RULES["src/app/team/actions.ts#renameTeamAction"], { kind: "team", action: "team.rename" });

  // 4. The page and the readers.
  const page = source("src/app/(app)/settings/team/page.tsx");
  check("the page offers the form only to who the server honours", jsx(page).some((e) => e.tag === "TeamNameForm" && e.guard === 'can(scope, "team.rename")'));
  check("an invitation names the team from its row", properties(actions, "teamName").includes("team.name"));
  check("the switcher's list reads the row's name", properties(source("src/lib/teams.ts"), "name").includes("m.team.name"));
  check("…and so do the MCP instructions", properties(source("src/lib/mcp/handler.ts"), "name").some((v) => /team\.name$/.test(v)));

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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
