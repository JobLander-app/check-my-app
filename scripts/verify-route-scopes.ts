// CHE-255 (Teams T2) verification: a route or server action that says nothing
// about who may call it does not ship.
//
// The check walks the filesystem — every `src/app/api/**/route.ts` and every
// exported server action — and compares it with the registry in
// src/lib/route-scopes.ts. Both directions matter:
//
//   - a handler with no entry fails, because forgetting is silent and looks
//     exactly like a route that is deliberately public;
//   - an entry naming a handler that no longer exists fails, because a stale
//     allow is as dangerous as a missing rule and far harder to notice.
//
// This is a registry check rather than a behaviour check on purpose. A guard
// that watched for unguarded responses would only ever see the routes somebody
// remembered to exercise; this one sees the route the moment it exists
// (CHE-217/218/220 were three symptom-watching guards missing the first case in
// one morning).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-route-scopes.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { ACTION_RULES, ROUTE_RULES, type RouteRule } from "@/lib/route-scopes";
import { TEAM_ACTIONS } from "@/lib/scopes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const API = join(ROOT, "src/app/api");
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

// ─── What exists on disk ─────────────────────────────────────────────────────

const found: string[] = [];
for (const file of walk(API)) {
  const text = readFileSync(file, "utf8");
  const urlPath = "/" + relative(join(ROOT, "src/app"), file).replace(/\/route\.ts$/, "");
  for (const method of METHODS) {
    const exported =
      new RegExp(String.raw`export\s+async\s+function\s+${method}\b`).test(text) ||
      new RegExp(String.raw`export\s+const\s+${method}\s*=`).test(text);
    if (exported) found.push(`${method} ${urlPath}`);
  }
}
found.sort();
check("found route handlers on disk", found.length > 0, `${found.length} handlers`);

// Server actions: a file marked "use server" exports functions that are POST
// endpoints in everything but name, and are reachable from any page that
// imports them.
// Discovered, not listed: a hardcoded list of action files is the same hole
// this whole script exists to close — a new one would simply not be looked at.
function walkAll(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkAll(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}
const ACTION_FILES = walkAll(join(ROOT, "src/app"))
  .filter((f) => /"use server"|'use server'/.test(readFileSync(f, "utf8")))
  .map((f) => relative(ROOT, f))
  .sort();
check("found server action files", ACTION_FILES.length > 0, ACTION_FILES.join(", "));

const foundActions: string[] = [];
for (const rel of ACTION_FILES) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  for (const m of text.matchAll(/export\s+async\s+function\s+(\w+)/g)) foundActions.push(`${rel}#${m[1]}`);
}
foundActions.sort();
check("found server actions on disk", foundActions.length > 0, `${foundActions.length} actions`);

// ─── Registered, both ways ───────────────────────────────────────────────────

const unregistered = found.filter((r) => !(r in ROUTE_RULES));
check(
  "every route handler is registered",
  unregistered.length === 0,
  unregistered.length ? `\n${unregistered.map((r) => `        ${r}`).join("\n")}` : `${found.length} handlers`,
);

const stale = Object.keys(ROUTE_RULES).filter((r) => !found.includes(r));
check(
  "the registry names no route that has gone",
  stale.length === 0,
  stale.join(", ") || "clean",
);

const unregisteredActions = foundActions.filter((a) => !(a in ACTION_RULES));
check(
  "every server action is registered",
  unregisteredActions.length === 0,
  unregisteredActions.length ? `\n${unregisteredActions.map((a) => `        ${a}`).join("\n")}` : `${foundActions.length} actions`,
);

const staleActions = Object.keys(ACTION_RULES).filter((a) => !foundActions.includes(a));
check(
  "the registry names no server action that has gone",
  staleActions.length === 0,
  staleActions.join(", ") || "clean",
);

// ─── The rules themselves ────────────────────────────────────────────────────

const all: [string, RouteRule][] = [...Object.entries(ROUTE_RULES), ...Object.entries(ACTION_RULES)];

const badAction = all.filter(([, r]) => r.kind === "team" && !TEAM_ACTIONS.includes(r.action));
check(
  "every team rule names an action the scope table knows",
  badAction.length === 0,
  badAction.map(([k]) => k).join(", ") || `${all.filter(([, r]) => r.kind === "team").length} team rules`,
);

// A `row` rule points at the file that decides. If that file is gone, the rule
// is a sentence with nothing behind it.
const rowRules = all.filter(([, r]) => r.kind === "row") as [string, Extract<RouteRule, { kind: "row" }>][];
const brokenPointer = rowRules.filter(([, r]) => {
  const path = r.decidedIn.split(" ")[0];
  try {
    statSync(join(ROOT, path));
    return false;
  } catch {
    return true;
  }
});
check(
  "every row rule points at a file that exists",
  brokenPointer.length === 0,
  brokenPointer.map(([k, r]) => `${k} → ${r.decidedIn}`).join(", ") || `${rowRules.length} row rules`,
);

// The mutating side is where a missing rule costs something. A POST, PATCH,
// PUT or DELETE may not be `public` unless its reason is one of the two that
// really are open by design — the anonymous funnel and a verified webhook.
const OPEN_TO_WRITES = new Set([
  "the anonymous funnel — a stranger's first check",
  "signature-verified webhook",
  "secret-token-verified webhook",
]);
const looseWrites = Object.entries(ROUTE_RULES).filter(
  ([key, rule]) =>
    /^(POST|PATCH|PUT|DELETE) /.test(key) && rule.kind === "public" && !OPEN_TO_WRITES.has(rule.why),
);
check(
  "no mutating route is public for a reason that only justifies reading",
  looseWrites.length === 0,
  looseWrites.map(([k]) => k).join(", ") || "clean",
);

// A webhook reason opens a route to writes from anyone on the strength of a
// verification, so the verification must be in the handler: a route that
// claims it and does not call the verifier is an open write with a label
// (cross-review of #221, CHE-375).
const VERIFIED_BY: Record<string, string[]> = {
  "secret-token-verified webhook": ["secretMatches("],
  "signature-verified webhook": ["constructEventAsync(", "verifyWebhook("],
};
const unverified = Object.entries(ROUTE_RULES).filter(([key, rule]) => {
  if (rule.kind !== "public" || !(rule.why in VERIFIED_BY)) return false;
  const text = readFileSync(join(ROOT, fileFor(key)), "utf8");
  return !VERIFIED_BY[rule.why].some((call) => text.includes(call));
});
check(
  "every route that claims a verified webhook calls its verifier",
  unverified.length === 0,
  unverified.map(([k, r]) => `${k} (${r.kind === "public" ? r.why : ""})`).join(", ") ||
    `${Object.values(ROUTE_RULES).filter((r) => r.kind === "public" && r.why in VERIFIED_BY).length} webhooks`,
);

// Billing and membership are the two a wrong rule would cost money or access.
for (const [key, expected] of [
  ["POST /api/billing/checkout", "billing.manage"],
] as const) {
  const rule = ROUTE_RULES[key];
  check(
    `${key} is ${expected}`,
    rule?.kind === "team" && rule.action === expected,
    JSON.stringify(rule),
  );
}

// ─── Declared is not enforced ────────────────────────────────────────────────
//
// The lesson of an hour ago (CHE-256): 0032 added SettledSignature.teamId with
// a comment saying it belonged to the team, and nothing wrote it. A registry
// entry saying a route is `billing.manage` is worth exactly as much as that
// comment unless the handler asks. So: a route or action declared `team` must
// consult the scope table for THAT action, by name.

function fileFor(key: string): string {
  if (key.includes("#")) return key.split("#")[0];
  const path = key.split(" ")[1];
  return join("src/app", path, "route.ts");
}

// A `funnel` rule names an action for its signed-in callers, so it is enforced
// exactly like a `team` rule. Missing this was the shape of CHE-265 itself: a
// new kind that the guard did not know about was silently exempt.
const teamRules = all.filter(
  ([, r]) => r.kind === "team" || r.kind === "funnel",
) as [string, Extract<RouteRule, { kind: "team" | "funnel" }>][];
const unenforced = teamRules.filter(([key, rule]) => {
  const text = readFileSync(join(ROOT, fileFor(key)), "utf8");
  const asksByName =
    text.includes(`requireScope(`) && text.includes(`"${rule.action}"`) ||
    text.includes(`requireActionScope("${rule.action}")`) ||
    (text.includes("can(scope,") && text.includes(`"${rule.action}"`)) ||
    // CHE-265: a funnel asks the same table through funnelAllows, which answers
    // "a stranger may, this signed-in caller may not".
    (text.includes("funnelAllows(") && text.includes(`"${rule.action}"`));
  return !asksByName;
});
check(
  "every team rule is enforced in its handler, by the action it names",
  unenforced.length === 0,
  unenforced.map(([k, r]) => `${k} (${r.action})`).join(", ") || `${teamRules.length} enforced`,
);

const KNOWN_KINDS = ["team", "public", "row", "funnel"];
const unknownKind = all.filter(([, r]) => !KNOWN_KINDS.includes(r.kind));
check(
  "every rule is of a kind this guard knows — a new kind is not silently exempt",
  unknownKind.length === 0,
  unknownKind.map(([k, r]) => `${k}: ${r.kind}`).join(", ") || KNOWN_KINDS.join(", "),
);

// A funnel serves strangers AND signed-in callers, so it must name the action
// its signed-in callers are judged by. Without one it is a `public` route
// wearing a different word.
const funnels = all.filter(([, r]) => r.kind === "funnel") as [string, Extract<RouteRule, { kind: "funnel" }>][];
check(
  "every funnel names the action its signed-in callers are judged by",
  funnels.every(([, r]) => TEAM_ACTIONS.includes(r.action)),
  funnels.map(([k, r]) => `${k} → ${r.action}`).join(", ") || "none",
);

const counts = {
  team: all.filter(([, r]) => r.kind === "team").length,
  funnel: funnels.length,
  public: all.filter(([, r]) => r.kind === "public").length,
  row: all.filter(([, r]) => r.kind === "row").length,
};
console.log(
  `\n        team: ${counts.team}  ·  funnel: ${counts.funnel}  ·  public: ${counts.public}  ·  row: ${counts.row}\n`,
);

console.log(failures === 0 ? "all pass" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
