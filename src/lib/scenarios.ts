// CHE-435 / CHE-434 B: the team edits what its app's checks look at.
//
// A scenario is an AppJourney. The check discovers most of them; a team writes
// its own (source "team"): a title and, in its own words, what a user does and
// what should happen. A daily team scenario goes into every check's focus —
// Run.focusAreas, which discovery must cover, the walk takes first and the
// verdict reports on (src/agent/instructions.ts focusBlock) — so "check this
// every day" needs nothing from the walk planner. A once-scenario goes into
// the focus of the check that names it.
//
// One module for the page and for MCP. Every scenario is looked up inside the
// caller's team: another team's id is "not found", never "forbidden".

import type { PrismaClient } from "@/generated/prisma/client";
import { journeyKey } from "@/lib/journey-key";
import { can, type TeamScope } from "@/lib/scopes";
import { hasFeature, type TeamFeature } from "@/lib/team-features";
import { teamOwned } from "@/lib/tenant-db";

export type ScenarioActor = { userId: string; teamId: string; scope: TeamScope; features: readonly TeamFeature[] };
export type ScenarioRefusal = { ok: false; code: "forbidden" | "not_found" | "invalid_input"; error: string };

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 1000;

export function mayEditScenarios(actor: Pick<ScenarioActor, "scope" | "features">): boolean {
  return hasFeature(actor.features, "shopify") && can(actor.scope, "scenario.write");
}

function gate(actor: ScenarioActor): ScenarioRefusal | null {
  if (!hasFeature(actor.features, "shopify")) return { ok: false, code: "forbidden", error: "Editing scenarios is not open for this team yet." };
  if (!can(actor.scope, "scenario.write")) {
    return { ok: false, code: "forbidden", error: "Your access to this team is read-only. An admin or a member can change the scenarios." };
  }
  return null;
}

function clean(title: string | undefined, description: string | undefined): ScenarioRefusal | { title?: string; description?: string | null } {
  const out: { title?: string; description?: string | null } = {};
  if (title !== undefined) {
    const t = title.replace(/\s+/g, " ").trim();
    if (t.length < 3) return { ok: false, code: "invalid_input", error: "Give the scenario a title a person would recognise." };
    if (t.length > TITLE_MAX) return { ok: false, code: "invalid_input", error: `Keep the title under ${TITLE_MAX} characters.` };
    out.title = t;
  }
  if (description !== undefined) {
    const d = description.trim();
    if (d.length > DESCRIPTION_MAX) return { ok: false, code: "invalid_input", error: `Keep the description under ${DESCRIPTION_MAX} characters.` };
    out.description = d || null;
  }
  return out;
}

export type ScenarioView = {
  id: string;
  title: string;
  description: string | null;
  source: "discovered" | "team";
  daily: boolean;
  status: string | null;
  lastWalkedAt: string | null;
};

// The app's live scenarios, team ones first. Null when the app is not the team's.
export async function listScenarios(db: PrismaClient, teamId: string, appId: string): Promise<ScenarioView[] | null> {
  const app = await db.app.findFirst({ where: { ...teamOwned(teamId), id: appId }, select: { id: true } });
  if (!app) return null;
  const rows = await db.appJourney.findMany({
    where: { appId: app.id, retiredAt: null },
    select: { id: true, title: true, description: true, source: true, daily: true, status: true, lastWalkedAt: true, createdAt: true },
  });
  return rows
    .sort((a, b) => (a.source === b.source ? a.createdAt.getTime() - b.createdAt.getTime() : a.source === "team" ? -1 : 1))
    .map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      source: r.source === "team" ? "team" : "discovered",
      daily: r.daily,
      status: r.status,
      lastWalkedAt: r.lastWalkedAt?.toISOString() ?? null,
    }));
}

async function ownScenario(db: PrismaClient, teamId: string, id: string) {
  return db.appJourney.findFirst({
    where: { id, retiredAt: null, app: { ...teamOwned(teamId) } },
    select: { id: true, appId: true, source: true, title: true },
  });
}

export async function addScenario(
  db: PrismaClient,
  actor: ScenarioActor,
  input: { appId: string; title: string; description?: string; daily?: boolean },
): Promise<{ ok: true; id: string } | ScenarioRefusal> {
  const refused = gate(actor);
  if (refused) return refused;
  const fields = clean(input.title, input.description ?? "");
  if ("ok" in fields) return fields;
  const app = await db.app.findFirst({ where: { ...teamOwned(actor.teamId), id: input.appId }, select: { id: true } });
  if (!app) return { ok: false, code: "not_found", error: "App not found in this team." };
  const taken = await db.appJourney.findMany({ where: { appId: app.id }, select: { key: true } });
  const row = await db.appJourney.create({
    data: {
      appId: app.id,
      key: journeyKey(fields.title as string, taken.map((t) => t.key)),
      title: fields.title as string,
      description: fields.description ?? null,
      source: "team",
      daily: input.daily ?? true,
      authorId: actor.userId,
    },
    select: { id: true },
  });
  return { ok: true, id: row.id };
}

export async function updateScenario(
  db: PrismaClient,
  actor: ScenarioActor,
  id: string,
  patch: { title?: string; description?: string; daily?: boolean },
): Promise<{ ok: true } | ScenarioRefusal> {
  const refused = gate(actor);
  if (refused) return refused;
  const row = await ownScenario(db, actor.teamId, id);
  if (!row) return { ok: false, code: "not_found", error: "Scenario not found in this team." };
  // A discovered scenario's title is the check's name for what it walked; a
  // different scenario is a replacement, so the history of this one stays its own.
  if (patch.title !== undefined && row.source !== "team") {
    return { ok: false, code: "invalid_input", error: "This scenario was found by the check. If it is really a different one, replace it." };
  }
  const fields = clean(patch.title, patch.description);
  if ("ok" in fields) return fields;
  await db.appJourney.update({
    where: { id: row.id },
    data: { ...fields, ...(patch.daily !== undefined ? { daily: patch.daily } : {}) },
  });
  return { ok: true };
}

export async function removeScenario(db: PrismaClient, actor: ScenarioActor, id: string): Promise<{ ok: true } | ScenarioRefusal> {
  const refused = gate(actor);
  if (refused) return refused;
  const row = await ownScenario(db, actor.teamId, id);
  if (!row) return { ok: false, code: "not_found", error: "Scenario not found in this team." };
  if (row.source !== "team") {
    return {
      ok: false,
      code: "invalid_input",
      error: "This scenario was found by the check and comes back when it is seen again. Report it as wrong, or replace it.",
    };
  }
  // Retired, never deleted: its checks are the record of what the app did.
  await db.appJourney.update({ where: { id: row.id }, data: { retiredAt: new Date(), retiredReason: "removed by the team" } });
  return { ok: true };
}

// "It is really a different scenario": the team's version takes its place and
// the discovered one is retired with a reason that names its replacement.
export async function replaceScenario(
  db: PrismaClient,
  actor: ScenarioActor,
  id: string,
  input: { title: string; description?: string; daily?: boolean },
): Promise<{ ok: true; id: string } | ScenarioRefusal> {
  const refused = gate(actor);
  if (refused) return refused;
  const row = await ownScenario(db, actor.teamId, id);
  if (!row) return { ok: false, code: "not_found", error: "Scenario not found in this team." };
  const added = await addScenario(db, actor, { appId: row.appId, ...input });
  if (!added.ok) return added;
  await db.appJourney.update({ where: { id: row.id }, data: { retiredAt: new Date(), retiredReason: `replaced by the team's "${input.title.trim()}"` } });
  return added;
}

// What a check of this app is asked to cover, in the team's words: every daily
// team scenario, plus the ones this check names. Null when there are none.
export async function focusForRun(db: PrismaClient, appId: string, only: readonly string[] = []): Promise<string | null> {
  const rows = await db.appJourney.findMany({
    where: { appId, retiredAt: null, source: "team" },
    select: { id: true, title: true, description: true, daily: true, createdAt: true },
  });
  const due = rows.filter((r) => r.daily || only.includes(r.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (due.length === 0) return null;
  return due.map((r, i) => `${i + 1}. ${r.title}${r.description ? ` — ${r.description}` : ""}`).join("\n");
}

// The run's focus: the app's free text (what predates the list) and the list.
export function mergeFocus(appFocus: string | null | undefined, scenarios: string | null): string | null {
  const parts = [appFocus?.trim(), scenarios ? `The team's scenarios — check each:\n${scenarios}` : null].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}
