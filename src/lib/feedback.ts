// CHE-434: where CheckMyApp got it wrong, said by the team whose app it checked.
// The pilot (CHE-432) exists to make the checker right on Shopify apps with the
// Securify team's eyes, so every report is a signal about OUR mistake — not
// checked, wrong, the wrong scenario — and becomes a ticket on our board. It is
// not a chat about the team's app: there is no free "comment", and nothing is
// said about an app as a whole (the check makes no claim about it to be wrong
// about; a part it does not see is a missing scenario).
//
// One module for the page and for MCP, so neither door can do what the other
// refuses. Every target is looked up inside the caller's team: an id from
// another team is "not found", never "forbidden". The run's own words are
// never rewritten — a report sits beside them. Filing onto our board is the
// scheduler tick's job (src/agent/feedback-filing.ts).

import type { PrismaClient } from "@/generated/prisma/client";
import { can, type TeamScope } from "@/lib/scopes";
import { hasFeature, type TeamFeature } from "@/lib/team-features";
import { teamOwned } from "@/lib/tenant-db";

export const FEEDBACK_REASONS = ["not_checked", "wrong", "scenario_wrong", "other"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
// "app" is a place to READ every report about an app; nothing is reported on it.
export type FeedbackKind = "app" | "run" | "finding" | "step" | "scenario";
export type ReportKind = Exclude<FeedbackKind, "app">;

export const REASON_LABEL: Record<FeedbackReason, string> = {
  not_checked: "It was not really checked",
  wrong: "The check got it wrong",
  scenario_wrong: "It is really a different scenario",
  other: "The check got something else wrong",
};

// What the check can have got wrong at each place. A finding was either wrong
// or wrong in another way; only a scenario can be the wrong scenario.
export const REASONS_FOR: Record<ReportKind, readonly FeedbackReason[]> = {
  run: ["not_checked", "wrong", "other"],
  finding: ["wrong", "other"],
  step: ["not_checked", "wrong", "other"],
  scenario: ["scenario_wrong", "not_checked", "wrong", "other"],
};

export const FEEDBACK_TEXT_MAX = 4000;

// What a comment is about, as the outside names it: an app id, a scenario id
// (AppJourney.id), or a run id with — optionally — a finding number, or a
// journey position and step position (1-based, as the review lists them).
export type FeedbackTarget =
  | { app_id: string }
  | { scenario_id: string }
  | { run_id: string; finding?: number; journey?: number; step?: number };

export type ResolvedTarget = {
  kind: FeedbackKind;
  appId: string;
  runId: string | null;
  findingId: string | null;
  stepId: string | null;
  appJourneyId: string | null;
};

export type FeedbackActor = { userId: string; teamId: string; scope: TeamScope; features: readonly TeamFeature[] };

export type FeedbackRefusal = { ok: false; code: "forbidden" | "not_found" | "invalid_input"; error: string };

export const NOT_OPEN = "Reporting the check's mistakes is not open for this team yet.";

export function mayComment(actor: Pick<FeedbackActor, "scope" | "features">): boolean {
  return hasFeature(actor.features, "shopify") && can(actor.scope, "feedback.write");
}

export async function resolveTarget(db: PrismaClient, teamId: string, t: FeedbackTarget): Promise<ResolvedTarget | null> {
  const none = { runId: null, findingId: null, stepId: null, appJourneyId: null };
  if ("app_id" in t) {
    const app = await db.app.findFirst({ where: { ...teamOwned(teamId), id: t.app_id }, select: { id: true } });
    return app ? { kind: "app", appId: app.id, ...none } : null;
  }
  if ("scenario_id" in t) {
    const sc = await db.appJourney.findFirst({ where: { id: t.scenario_id, app: { ...teamOwned(teamId) } }, select: { id: true, appId: true } });
    return sc ? { kind: "scenario", appId: sc.appId, ...none, appJourneyId: sc.id } : null;
  }
  const run = await db.run.findFirst({ where: { ...teamOwned(teamId), publicId: t.run_id }, select: { id: true, appId: true } });
  // A run that belongs to no saved app (a one-off check of a URL) has nowhere
  // for a comment to live; the team saves the app first.
  if (!run?.appId) return null;
  const base = { appId: run.appId, runId: run.id, findingId: null, stepId: null, appJourneyId: null };
  if (t.finding !== undefined) {
    const f = await db.finding.findFirst({ where: { runId: run.id, number: t.finding }, select: { id: true } });
    return f ? { ...base, kind: "finding", findingId: f.id } : null;
  }
  if (t.journey !== undefined) {
    const journeys = await db.journey.findMany({ where: { runId: run.id }, orderBy: { order: "asc" }, select: { id: true, appJourneyId: true } });
    const j = journeys[t.journey - 1];
    if (!j) return null;
    if (t.step === undefined) {
      return j.appJourneyId ? { ...base, kind: "scenario", appJourneyId: j.appJourneyId } : { ...base, kind: "run" };
    }
    const steps = await db.step.findMany({ where: { journeyId: j.id }, orderBy: { order: "asc" }, select: { id: true } });
    const s = steps[t.step - 1];
    return s ? { ...base, kind: "step", stepId: s.id, appJourneyId: j.appJourneyId } : null;
  }
  if (t.step !== undefined) return null;
  return { ...base, kind: "run" };
}

export type GiveFeedbackInput = { target: FeedbackTarget; reason: string; text: string };

export async function giveFeedback(
  db: PrismaClient,
  actor: FeedbackActor,
  input: GiveFeedbackInput,
): Promise<{ ok: true; id: string; kind: ReportKind } | FeedbackRefusal> {
  if (!hasFeature(actor.features, "shopify")) return { ok: false, code: "forbidden", error: NOT_OPEN };
  if (!can(actor.scope, "feedback.write")) {
    return { ok: false, code: "forbidden", error: "Your access to this team is read-only. An admin or a member can report the check's mistakes." };
  }
  if ("app_id" in input.target) {
    return { ok: false, code: "invalid_input", error: "Report a mistake on a check, a finding, a step or a scenario — a check makes no claim about the app as a whole." };
  }
  const text = input.text.trim();
  if (!text) return { ok: false, code: "invalid_input", error: "Say what really happened, or what the check should have done." };
  if (text.length > FEEDBACK_TEXT_MAX) return { ok: false, code: "invalid_input", error: `Keep it under ${FEEDBACK_TEXT_MAX} characters.` };
  const target = await resolveTarget(db, actor.teamId, input.target);
  if (!target || target.kind === "app") return { ok: false, code: "not_found", error: "Not found in this team." };
  const kind = target.kind;
  const reason = input.reason as FeedbackReason;
  if (!REASONS_FOR[kind].includes(reason)) {
    return { ok: false, code: "invalid_input", error: `On a ${kind} the mistake is one of: ${REASONS_FOR[kind].join(", ")}.` };
  }
  const row = await db.feedback.create({
    data: { ...teamOwned(actor.teamId), ...target, reason, text, authorId: actor.userId },
    select: { id: true },
  });
  return { ok: true, id: row.id, kind };
}

export type FeedbackItem = {
  id: string;
  kind: FeedbackKind;
  reason: FeedbackReason;
  text: string;
  author: string;
  at: string;
  status: string;
  findingNumber: number | null;
  stepId: string | null;
  stepLabel: string | null;
};

// Everything said about a target. For an app: every comment on the app and on
// anything in it. For a scenario: on the scenario and its steps in any run. For
// a run: on the run, its findings and its steps.
export async function listFeedback(db: PrismaClient, teamId: string, t: FeedbackTarget): Promise<FeedbackItem[] | null> {
  const target = await resolveTarget(db, teamId, "run_id" in t ? { run_id: t.run_id } : t);
  if (!target) return null;
  const where =
    target.kind === "app"
      ? { appId: target.appId }
      : target.kind === "scenario"
        ? { appJourneyId: target.appJourneyId }
        : { runId: target.runId };
  const rows = await db.feedback.findMany({
    where: { ...teamOwned(teamId), ...where },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { id: true, kind: true, reason: true, text: true, authorId: true, status: true, createdAt: true, findingId: true, stepId: true },
  });
  return describe(db, rows);
}

// The items of one run, grouped where the verdict page shows them.
export async function feedbackForRun(db: PrismaClient, teamId: string, runId: string) {
  const rows = await db.feedback.findMany({
    where: { ...teamOwned(teamId), runId },
    orderBy: { createdAt: "asc" },
    take: 500,
    select: { id: true, kind: true, reason: true, text: true, authorId: true, status: true, createdAt: true, findingId: true, stepId: true, appJourneyId: true },
  });
  const items = await describe(db, rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const run: FeedbackItem[] = [];
  const byFinding: Record<number, FeedbackItem[]> = {};
  const byScenario: Record<string, FeedbackItem[]> = {};
  for (const item of items) {
    const row = byId.get(item.id)!;
    if (item.kind === "finding" && item.findingNumber !== null) (byFinding[item.findingNumber] ??= []).push(item);
    else if ((item.kind === "scenario" || item.kind === "step") && row.appJourneyId) (byScenario[row.appJourneyId] ??= []).push(item);
    else run.push(item);
  }
  return { run, byFinding, byScenario };
}

async function describe(
  db: PrismaClient,
  rows: { id: string; kind: string; reason: string; text: string; authorId: string; status: string; createdAt: Date; findingId: string | null; stepId: string | null }[],
): Promise<FeedbackItem[]> {
  const ids = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
  // D1 caps the parameters one statement may bind; a long thread must not be
  // the thing that finds out how many.
  const chunked = async <T,>(list: string[], q: (part: string[]) => Promise<T[]>) => {
    const out: T[] = [];
    for (let i = 0; i < list.length; i += 50) out.push(...(await q(list.slice(i, i + 50))));
    return out;
  };
  const [users, findings, steps] = await Promise.all([
    chunked(ids(rows.map((r) => r.authorId)), (part) => db.user.findMany({ where: { id: { in: part } }, select: { id: true, email: true, name: true } })),
    chunked(ids(rows.map((r) => r.findingId)), (part) => db.finding.findMany({ where: { id: { in: part } }, select: { id: true, number: true } })),
    chunked(ids(rows.map((r) => r.stepId)), (part) => db.step.findMany({ where: { id: { in: part } }, select: { id: true, label: true } })),
  ]);
  const who = new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));
  const num = new Map(findings.map((f) => [f.id, f.number]));
  const label = new Map(steps.map((s) => [s.id, s.label]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as FeedbackKind,
    reason: r.reason as FeedbackReason,
    text: r.text,
    author: who.get(r.authorId) ?? "a former member",
    at: r.createdAt.toISOString(),
    status: r.status,
    findingNumber: r.findingId ? (num.get(r.findingId) ?? null) : null,
    stepId: r.stepId,
    stepLabel: r.stepId ? (label.get(r.stepId) ?? null) : null,
  }));
}

// How a row's status reads to the team. "filed" means it reached the people
// who build the checker, not that anything is fixed yet.
export const STATUS_LABEL: Record<string, string> = {
  open: "received",
  filed: "with the CheckMyApp team",
  linked: "being fixed",
  fixed: "fixed",
  wont_fix: "not a mistake of the check",
};
