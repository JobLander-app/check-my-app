// CHE-434: every comment a team leaves on an app, a scenario or a run becomes
// one "[Pilot feedback] …" ticket on OUR board, on the scheduler tick. The web
// only writes the row; this files it, so a page never waits on Linear and a
// filing that fails is simply tried again next tick.
//
// The row is claimed (open → filing) before the ticket is made, so two ticks
// cannot file it twice; a failure puts it back to open.

import { ourBoard, type GapBoard } from "./capability-gaps";
import { REASON_LABEL, type FeedbackReason } from "@/lib/feedback";
import { systemWide } from "@/lib/tenant-db";
import type { AgentEnv } from "./env";

const PER_TICK = 10;

export async function fileOpenFeedback(env: AgentEnv, opts: { board?: GapBoard | null } = {}): Promise<{ filed: string[]; failed: number }> {
  const open = await env.db.feedback.findMany({
    where: { ...systemWide("scheduler"), status: "open" },
    orderBy: { createdAt: "asc" },
    take: PER_TICK,
  });
  if (open.length === 0) return { filed: [], failed: 0 };
  const board = opts.board !== undefined ? opts.board : await ourBoard(env);
  if (!board) {
    console.warn(`[feedback] ${open.length} comment(s) wait: our board has no tracker connected`);
    return { filed: [], failed: open.length };
  }
  const filed: string[] = [];
  let failed = 0;
  for (const row of open) {
    const claimed = await env.db.feedback.updateMany({ where: { id: row.id, status: "open" }, data: { status: "filing" } });
    if (claimed.count !== 1) continue;
    try {
      const draft = await draftFor(env, board, row);
      const issue = await board.tracker.createIssue(draft);
      await env.db.feedback.update({ where: { id: row.id }, data: { status: "filed", issueIdentifier: issue.identifier } });
      filed.push(issue.identifier);
    } catch (err) {
      failed++;
      await env.db.feedback.update({ where: { id: row.id }, data: { status: "open" } }).catch(() => {});
      console.warn(`[feedback] could not file ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { filed, failed };
}

type Row = {
  id: string;
  teamId: string;
  appId: string;
  runId: string | null;
  findingId: string | null;
  stepId: string | null;
  appJourneyId: string | null;
  kind: string;
  reason: string;
  text: string;
  authorId: string;
};

async function draftFor(env: AgentEnv, board: GapBoard, row: Row) {
  const [author, team, app, run, finding, step, scenario] = await Promise.all([
    env.db.user.findUnique({ where: { id: row.authorId }, select: { email: true } }),
    env.db.team.findUnique({ where: { id: row.teamId }, select: { name: true } }),
    env.db.app.findUnique({ where: { id: row.appId, ...systemWide("scheduler") }, select: { appSlug: true } }),
    row.runId ? env.db.run.findUnique({ where: { id: row.runId, ...systemWide("scheduler") }, select: { publicId: true, runNumber: true } }) : null,
    row.findingId ? env.db.finding.findUnique({ where: { id: row.findingId }, select: { number: true, title: true } }) : null,
    row.stepId ? env.db.step.findUnique({ where: { id: row.stepId }, select: { label: true, unverifiedReason: true } }) : null,
    row.appJourneyId ? env.db.appJourney.findUnique({ where: { id: row.appJourneyId }, select: { title: true } }) : null,
  ]);
  const what =
    finding ? `finding #${String(finding.number).padStart(3, "0")} “${finding.title}”`
    : step ? `step “${step.label}”${scenario ? ` of “${scenario.title}”` : ""}`
    : scenario ? `scenario “${scenario.title}”`
    : run ? `check #${run.runNumber}`
    : "the app";
  const reason = REASON_LABEL[row.reason as FeedbackReason] ?? row.reason;
  const firstWords = row.text.replace(/\s+/g, " ").slice(0, 70);
  const lines = [
    `**${author?.email ?? "a team member"}** (${team?.name ?? row.teamId}) on ${app?.appSlug ?? row.appId}, about ${what}.`,
    `Reason: ${reason}.`,
    "",
    "> " + row.text.split("\n").join("\n> "),
    "",
    run ? `Verdict: ${board.baseUrl}/verdict/${run.publicId}` : null,
    step?.unverifiedReason ? `The step was recorded as unverified: ${step.unverifiedReason}.` : null,
    `Feedback row: ${row.id}`,
  ].filter((l): l is string => l !== null);
  return {
    title: `[Pilot feedback] ${app?.appSlug ?? "app"} · ${what}: ${firstWords}`.slice(0, 200),
    description: lines.join("\n"),
    labelNames: ["pilot-feedback"],
    stateName: "Backlog",
    priority: row.reason === "wrong" || row.reason === "not_checked" ? 2 : 3,
  };
}
