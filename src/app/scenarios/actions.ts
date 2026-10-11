"use server";

// CHE-435: the app's scenarios from the page — the same src/lib/scenarios.ts the
// MCP tools call, so the two doors cannot disagree.

import { revalidatePath } from "next/cache";
import { requireActionScope } from "@/lib/team-auth";
import { refuseSelfCheck } from "@/lib/self-check-action";
import { appPath } from "@/lib/app-shell";
import { addScenario, removeScenario, replaceScenario, updateScenario } from "@/lib/scenarios";
import { teamFeatures } from "@/lib/team-features";

export type ScenarioFormState = { error?: string; saved?: boolean } | null;

async function actor() {
  const { user, db, team, scope } = await requireActionScope("scenario.write");
  return { db, actor: { userId: user.id, teamId: team.id, scope, features: await teamFeatures(db, team.id) } };
}

const text = (fd: FormData, name: string) => String(fd.get(name) ?? "");
const daily = (fd: FormData) => fd.get("daily") === "on";

export async function addScenarioAction(appId: string, _prev: ScenarioFormState, fd: FormData): Promise<ScenarioFormState> {
  await refuseSelfCheck(appPath.section(appId, "scope"));
  const { db, actor: a } = await actor();
  const r = await addScenario(db, a, { appId, title: text(fd, "title"), description: text(fd, "description"), daily: daily(fd) });
  if (!r.ok) return { error: r.error };
  revalidatePath(appPath.section(appId, "scope"));
  return { saved: true };
}

export async function updateScenarioAction(appId: string, id: string, _prev: ScenarioFormState, fd: FormData): Promise<ScenarioFormState> {
  await refuseSelfCheck(appPath.section(appId, "scope"));
  const { db, actor: a } = await actor();
  const title = fd.has("title") ? text(fd, "title") : undefined;
  const r = await updateScenario(db, a, id, { title, description: text(fd, "description"), daily: daily(fd) });
  if (!r.ok) return { error: r.error };
  revalidatePath(appPath.section(appId, "scope"));
  return { saved: true };
}

export async function replaceScenarioAction(appId: string, id: string, _prev: ScenarioFormState, fd: FormData): Promise<ScenarioFormState> {
  await refuseSelfCheck(appPath.section(appId, "scope"));
  const { db, actor: a } = await actor();
  const r = await replaceScenario(db, a, id, { title: text(fd, "title"), description: text(fd, "description"), daily: daily(fd) });
  if (!r.ok) return { error: r.error };
  revalidatePath(appPath.section(appId, "scope"));
  return { saved: true };
}

export async function removeScenarioAction(appId: string, id: string): Promise<void> {
  await refuseSelfCheck(appPath.section(appId, "scope"));
  const { db, actor: a } = await actor();
  const r = await removeScenario(db, a, id);
  if (!r.ok) throw new Error(r.error);
  revalidatePath(appPath.section(appId, "scope"));
}
