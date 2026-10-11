// CHE-254 (Teams, T1): what an admin, a member and a reader may do — decided
// here and nowhere else.
//
// The shape is deliberately the one src/lib/viewer-capabilities.ts already
// proved: a pure table, mirrored exactly by the server, exercised for every
// combination without a database (scripts/verify-team-scopes.ts). A route that
// re-derives "may this person do this" from a membership row is how a page and
// a server drift apart — a control that fails on click is the defect this
// product flags on other people's apps (CHE-108).
//
// Three properties hold, and the verify script proves each rather than trusting
// this comment:
//   - the ladder is monotonic: anything a reader may do, a member may do, and
//     anything a member may do, an admin may do;
//   - a reader never spends the team's money — every action that starts agent
//     work is denied, whatever else the table says;
//   - every action is classified exactly once, so adding one forces a decision
//     instead of inheriting a default.

export type TeamScope = "admin" | "member" | "reader";

export const TEAM_SCOPES: TeamScope[] = ["admin", "member", "reader"];

// Everything a member of a team can ask the product to do. One name per
// decision, not per route: several routes may share an action (re-check and
// full re-check differ because their cost differs, not because they are
// different endpoints).
export type TeamAction =
  // Reading: dashboards, verdict pages, findings, evidence, journey history.
  | "read"
  // Spends the team's agent budget.
  | "run.start"
  | "run.recheck"
  | "run.full_recheck"
  | "watch.configure"
  // Operational writes that cost nothing but change what the team sees.
  | "finding.mark"
  // CHE-434: commenting on / correcting an app, a scenario or a run.
  | "feedback.write"
  // CHE-435: adding, editing and removing the app's scenarios.
  | "scenario.write"
  | "ticket.create"
  | "specs.export"
  | "app.settings.write"
  // Trusted writes: credentials, outbound integrations, destructive acts.
  | "app.credentials.write"
  | "integration.connect"
  | "app.delete"
  // The team itself.
  | "member.invite"
  | "member.remove"
  | "member.scope.change"
  | "apikey.manage"
  | "billing.manage"
  | "team.delete";

export const TEAM_ACTIONS: TeamAction[] = [
  "read",
  "run.start",
  "run.recheck",
  "run.full_recheck",
  "watch.configure",
  "finding.mark",
  "feedback.write",
  "scenario.write",
  "ticket.create",
  "specs.export",
  "app.settings.write",
  "app.credentials.write",
  "integration.connect",
  "app.delete",
  "member.invite",
  "member.remove",
  "member.scope.change",
  "apikey.manage",
  "billing.manage",
  "team.delete",
];

// Actions that start agent work and therefore spend the team's daily budget
// (src/agent/scheduler.ts) or its plan's monthly allowance (src/lib/plans.ts).
// A reader is denied every one of them — that is what "read-only" has to mean
// for a product whose every action costs real money.
export const SPENDS_MONEY: TeamAction[] = [
  "run.start",
  "run.recheck",
  "run.full_recheck",
  "watch.configure",
];

// Actions only an admin may take: they move money, hand out access, expose a
// credential, or destroy something that cannot be recovered.
export const ADMIN_ONLY: TeamAction[] = [
  "app.credentials.write",
  "integration.connect",
  "app.delete",
  "member.invite",
  "member.remove",
  "member.scope.change",
  "apikey.manage",
  "billing.manage",
  "team.delete",
];

// The table. Written out per scope rather than derived from the two lists
// above, so the lists stay an independent statement to check it against — a
// table that computes its own oracle proves nothing.
const CAN: Record<TeamScope, Record<TeamAction, boolean>> = {
  admin: {
    read: true,
    "run.start": true,
    "run.recheck": true,
    "run.full_recheck": true,
    "watch.configure": true,
    "finding.mark": true,
    "feedback.write": true,
    "scenario.write": true,
    "ticket.create": true,
    "specs.export": true,
    "app.settings.write": true,
    "app.credentials.write": true,
    "integration.connect": true,
    "app.delete": true,
    "member.invite": true,
    "member.remove": true,
    "member.scope.change": true,
    "apikey.manage": true,
    "billing.manage": true,
    "team.delete": true,
  },
  member: {
    read: true,
    "run.start": true,
    "run.recheck": true,
    "run.full_recheck": true,
    "watch.configure": true,
    "finding.mark": true,
    "feedback.write": true,
    "scenario.write": true,
    "ticket.create": true,
    "specs.export": true,
    "app.settings.write": true,
    "app.credentials.write": false,
    "integration.connect": false,
    "app.delete": false,
    "member.invite": false,
    "member.remove": false,
    "member.scope.change": false,
    "apikey.manage": false,
    "billing.manage": false,
    "team.delete": false,
  },
  reader: {
    read: true,
    "run.start": false,
    "run.recheck": false,
    "run.full_recheck": false,
    "watch.configure": false,
    "finding.mark": false,
    "feedback.write": false,
    "scenario.write": false,
    "ticket.create": false,
    "specs.export": false,
    "app.settings.write": false,
    "app.credentials.write": false,
    "integration.connect": false,
    "app.delete": false,
    "member.invite": false,
    "member.remove": false,
    "member.scope.change": false,
    "apikey.manage": false,
    "billing.manage": false,
    "team.delete": false,
  },
};

export function can(scope: TeamScope, action: TeamAction): boolean {
  return CAN[scope][action] === true;
}

// Everything this scope may do — for a page deciding which controls to render,
// and for the verify script's ladder property.
export function allowedActions(scope: TeamScope): TeamAction[] {
  return TEAM_ACTIONS.filter((a) => can(scope, a));
}

// What a person is told when the answer is no. Never an error, never our
// machinery: it names who on their team can do this instead, because the
// person reading it is a colleague of that admin and one message away from it.
// Returns null when the action is allowed — the caller has nothing to say.
export function refusal(scope: TeamScope, action: TeamAction): string | null {
  if (can(scope, action)) return null;
  if (scope === "reader" && SPENDS_MONEY.includes(action)) {
    return "Your access to this team is read-only. Starting a check spends the team's plan, so an admin or a member has to start this one.";
  }
  if (scope === "reader") {
    return "Your access to this team is read-only. An admin or a member of the team can make this change.";
  }
  return "Only an admin of this team can do that.";
}

// CHE-263: what scope a key may be minted with.
//
// Never above the scope of the person minting it — otherwise "admin" is one
// API call away for any member, and the scope table becomes a suggestion. The
// ladder is already monotonic (reader ⊆ member ⊆ admin), so "not above" is an
// index comparison rather than a special case per pair.
const LADDER: TeamScope[] = ["reader", "member", "admin"];

export function canMintKey(minter: TeamScope, keyScope: TeamScope): boolean {
  return LADDER.indexOf(keyScope) <= LADDER.indexOf(minter);
}

export function mintRefusal(minter: TeamScope, keyScope: TeamScope): string | null {
  if (canMintKey(minter, keyScope)) return null;
  return `You can't create a ${keyScope} key — a key can't do more than the person who made it.`;
}

// CHE-265: a route open to strangers, reached by somebody who is signed in.
//
// `null` means nobody is signed in — the public funnel applies and the caller
// is welcome. A scope means they ARE signed in, and their own scope decides:
// being a reader on a team is not a way to gain the capabilities of a stranger.
// The leak this closes is the reverse of the one people expect — authentication
// made the caller LESS restricted, because "public" had only one meaning.
export function funnelAllows(scope: TeamScope | null, action: TeamAction): boolean {
  return scope === null ? true : can(scope, action);
}
