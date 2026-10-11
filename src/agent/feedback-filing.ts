// CHE-434: every comment a team leaves on an app, a scenario or a run becomes
// one "[Pilot feedback] …" ticket on OUR board, on the scheduler tick. The web
// only writes the row; this files it, so a page never waits on Linear and a
// filing that fails is simply tried again next tick.
//
// The row is claimed (open → filing, with claimedAt) before the ticket is made,
// so two ticks cannot file it twice. If making the ticket fails, the row goes
// back to open. Once the ticket exists the row never goes back to open: a
// second ticket for the same report is the one outcome worse than a late one.
// A claim older than CLAIM_LEASE_MS belongs to a tick that died before it
// could say either way, and is filed again.

import { ourBoard, type GapBoard } from "./capability-gaps";
import { REASON_LABEL, type FeedbackReason } from "@/lib/feedback";
import { systemWide } from "@/lib/tenant-db";
import type { AgentEnv } from "./env";

const PER_TICK = 10;
export const CLAIM_LEASE_MS = 30 * 60 * 1000;

export async function fileOpenFeedback(
  env: AgentEnv,
  opts: { board?: GapBoard | null; now?: Date } = {},
): Promise<{ filed: string[]; failed: number }> {
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
  const due = await env.db.feedback.findMany({
    where: {
      ...systemWide("scheduler"),
      issueIdentifier: null,
      OR: [{ status: "open" }, { status: "filing", claimedAt: { lt: staleBefore } }],
    },
    orderBy: { createdAt: "asc" },
    take: PER_TICK,
  });
  if (due.length === 0) return { filed: [], failed: 0 };
  const board = opts.board !== undefined ? opts.board : await ourBoard(env);
  if (!board) {
    console.warn(`[feedback] ${due.length} report(s) wait: our board has no tracker connected`);
    return { filed: [], failed: due.length };
  }
  const filed: string[] = [];
  let failed = 0;
  for (const row of due) {
    const claimed = await env.db.feedback.updateMany({
      where: { id: row.id, status: row.status, claimedAt: row.claimedAt },
      data: { status: "filing", claimedAt: now },
    });
    if (claimed.count !== 1) continue;
    // Every write below is fenced on this tick's own claim: a tick slower than
    // the lease must not undo the claim of the tick that took the row over.
    const mine = { id: row.id, status: "filing", claimedAt: now };
    let identifier: string | null = null;
    try {
      const issue = await board.tracker.createIssue(await draftFor(env, board, row));
      identifier = issue.identifier;
    } catch (err) {
      failed++;
      await env.db.feedback.updateMany({ where: mine, data: { status: "open", claimedAt: null } }).catch(() => {});
      console.warn(`[feedback] could not file ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // The ticket exists. Record it. If even that fails twice, the row stays
    // claimed, never open; after the lease it is filed again, and this log
    // line names the first ticket so triage can fold the two together.
    let recorded: "yes" | "lost" | "failed" = "failed";
    for (let attempt = 0; attempt < 2 && recorded === "failed"; attempt++) {
      recorded = await env.db.feedback
        .updateMany({ where: mine, data: { status: "filed", issueIdentifier: identifier } })
        .then((r) => (r.count === 1 ? "yes" : "lost"), () => "failed" as const);
    }
    if (recorded === "yes") filed.push(identifier);
    else if (recorded === "lost") console.warn(`[feedback] ${row.id} was taken over by another tick after ${identifier} was made — a duplicate for triage`);
    else console.warn(`[feedback] filed ${row.id} as ${identifier} but could not record it; the row stays claimed`);
  }
  return { filed, failed };
}

type Row = {
  id: string;
  teamId: string;
  appId: string;
  runId: string | null;
  findingId: string | null;
  journeyId: string | null;
  stepId: string | null;
  appJourneyId: string | null;
  kind: string;
  reason: string;
  text: string;
  authorId: string;
};

async function draftFor(env: AgentEnv, board: GapBoard, row: Row) {
  const [author, team, app, run, finding, step, scenario, journey] = await Promise.all([
    env.db.user.findUnique({ where: { id: row.authorId }, select: { email: true } }),
    env.db.team.findUnique({ where: { id: row.teamId }, select: { name: true } }),
    env.db.app.findUnique({ where: { id: row.appId, ...systemWide("scheduler") }, select: { appSlug: true } }),
    row.runId ? env.db.run.findUnique({ where: { id: row.runId, ...systemWide("scheduler") }, select: { publicId: true, runNumber: true } }) : null,
    row.findingId ? env.db.finding.findUnique({ where: { id: row.findingId }, select: { number: true, title: true } }) : null,
    row.stepId ? env.db.step.findUnique({ where: { id: row.stepId }, select: { label: true, unverifiedReason: true } }) : null,
    row.appJourneyId ? env.db.appJourney.findUnique({ where: { id: row.appJourneyId }, select: { title: true } }) : null,
    row.journeyId ? env.db.journey.findUnique({ where: { id: row.journeyId }, select: { title: true } }) : null,
  ]);
  const of = scenario?.title ?? journey?.title;
  const what =
    finding ? `finding #${String(finding.number).padStart(3, "0")} “${finding.title}”`
    : step ? `step “${step.label}”${of ? ` of “${of}”` : ""}`
    : scenario ? `scenario “${scenario.title}”`
    : journey ? `journey “${journey.title}”`
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
