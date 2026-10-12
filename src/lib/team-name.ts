// CHE-446: a team's admin names the team. The owner, 2026-10-07: «нет, не
// переименовывать, но дать в ui возможность назначать имя команде» — we never
// rename a team ourselves; its admin does, here.
//
// Every place that shows the team reads Team.name (the switcher, invites, the
// MCP instructions), so the name only has to be written once, correctly.

import type { PrismaClient } from "@/generated/prisma/client";

export const TEAM_NAME_MAX = 60;

export type TeamNameCheck = { ok: true; name: string } | { ok: false; reason: string };

/** Trimmed, inner whitespace collapsed, 1–60 characters. */
export function checkTeamName(raw: string): TeamNameCheck {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, reason: "A team needs a name." };
  if ([...name].length > TEAM_NAME_MAX) return { ok: false, reason: `Keep it to ${TEAM_NAME_MAX} characters.` };
  return { ok: true, name };
}

export type RenameResult = { ok: true; name: string; previous: string; changed: boolean } | { ok: false; reason: string };

/** Writes the name if it is valid. The caller has already decided the actor may. */
export async function renameTeam(db: PrismaClient, teamId: string, raw: string): Promise<RenameResult> {
  const checked = checkTeamName(raw);
  if (!checked.ok) return checked;
  const team = await db.team.findUnique({ where: { id: teamId }, select: { name: true } });
  if (!team) return { ok: false, reason: "This team no longer exists." };
  if (team.name === checked.name) return { ok: true, name: checked.name, previous: team.name, changed: false };
  await db.team.update({ where: { id: teamId }, data: { name: checked.name } });
  return { ok: true, name: checked.name, previous: team.name, changed: true };
}
