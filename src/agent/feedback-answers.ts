// CHE-441: a report of the check's mistake comes back to the person who made it.
//
// A report becomes a "[Pilot feedback]" ticket on our board (feedback-filing.ts).
// Whoever settles it says so through the ticket, the same contract as every
// other ticket of ours (CHE-61): Done is "fixed", Canceled is "the check was
// right". A Canceled ticket must also carry an "Answer: …" comment — what we
// found, in words the author reads — because "you were wrong" without a reason
// is not an answer. Until it has one, the row waits.
//
// On the scheduler tick, for every filed row: read its ticket; when settled,
// move the row (fixed / wont_fix) and mail the author once. The move happens
// first and is fenced on the row's state, so two ticks cannot both settle it;
// the mail is owed while answeredAt is null, and a tick whose send failed
// leaves it owed for the next. The provider's idempotency key is the row's, so
// a send that went out but was not recorded is not a second mail.

import { ourBoard, type GapBoard } from "./capability-gaps";
import { noticeIdempotencyKey, sendFeedbackAnswer } from "@/lib/email";
import { hasEnvironmentLeak, hasHomework } from "@/lib/verdict-language";
import { systemWide } from "@/lib/tenant-db";
import type { AgentEnv } from "./env";

const PER_TICK = 20;

export type AnswerSend = typeof sendFeedbackAnswer;

export interface AnswerTickResult {
  settled: string[];
  mailed: string[];
  waiting: string[];
}

export async function answerFeedback(
  env: AgentEnv,
  opts: { board?: GapBoard | null; send?: AnswerSend; now?: Date } = {},
): Promise<AnswerTickResult> {
  const out: AnswerTickResult = { settled: [], mailed: [], waiting: [] };
  const now = opts.now ?? new Date();
  const send = opts.send ?? sendFeedbackAnswer;

  // 1. Settle: filed rows whose ticket has an outcome.
  const filed = await env.db.feedback.findMany({
    where: { ...systemWide("scheduler"), status: "filed", issueIdentifier: { not: null } },
    orderBy: { createdAt: "asc" },
    take: PER_TICK,
    select: { id: true, issueIdentifier: true },
  });
  if (filed.length) {
    const board = opts.board !== undefined ? opts.board : await ourBoard(env);
    if (!board) {
      out.waiting.push(...filed.map((r) => r.id));
    } else {
      for (const row of filed) {
        const id = row.issueIdentifier as string;
        let outcome;
        try {
          outcome = await board.tracker.getIssueOutcome(id);
        } catch (err) {
          console.warn(`[feedback-answer] could not read ${id}: ${err instanceof Error ? err.message : String(err)}`);
          out.waiting.push(row.id);
          continue;
        }
        if (outcome === "open" || outcome === "missing") continue;
        let answer: string | null = null;
        if (outcome === "canceled") {
          answer = board.tracker.latestAnswer ? await board.tracker.latestAnswer(id).catch(() => null) : null;
          // Our own words go to a customer: the same rules as a verdict (CLAUDE.md §1).
          if (!answer || hasHomework(answer) || hasEnvironmentLeak(answer)) {
            console.warn(`[feedback-answer] ${id} is canceled but has no usable "Answer:" comment; ${row.id} waits`);
            out.waiting.push(row.id);
            continue;
          }
        }
        const moved = await env.db.feedback.updateMany({
          where: { id: row.id, status: "filed" },
          data: { status: outcome === "done" ? "fixed" : "wont_fix", answer },
        });
        if (moved.count === 1) out.settled.push(row.id);
      }
    }
  }

  // 2. Tell: settled rows whose author has not heard yet.
  const owed = await env.db.feedback.findMany({
    where: { ...systemWide("scheduler"), status: { in: ["fixed", "wont_fix"] }, answeredAt: null },
    orderBy: { createdAt: "asc" },
    take: PER_TICK,
    select: { id: true, status: true, text: true, answer: true, authorId: true, appId: true, runId: true },
  });
  const base = (env.bindings.APP_URL ?? "https://checkmyapp.dev").replace(/\/+$/, "");
  for (const row of owed) {
    const [author, app, run] = await Promise.all([
      env.db.user.findUnique({ where: { id: row.authorId }, select: { email: true } }),
      env.db.app.findUnique({ where: { id: row.appId, ...systemWide("scheduler") }, select: { appSlug: true } }),
      row.runId ? env.db.run.findUnique({ where: { id: row.runId, ...systemWide("scheduler") }, select: { publicId: true } }) : null,
    ]);
    const to = author?.email?.trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
      // Nobody to tell: the row is settled all the same; nothing is owed.
      await env.db.feedback.updateMany({ where: { id: row.id, answeredAt: null }, data: { answeredAt: now } });
      continue;
    }
    try {
      await send({
        to,
        appSlug: app?.appSlug ?? "your app",
        theirWords: row.text,
        outcome: row.status as "fixed" | "wont_fix",
        answer: row.answer,
        url: run ? `${base}/verdict/${run.publicId}` : `${base}/health/apps/${row.appId}`,
        apiKey: env.bindings.EMAIL_API_KEY,
        from: env.bindings.EMAIL_FROM,
        replyTo: env.bindings.EMAIL_REPLY_TO,
        idempotencyKey: noticeIdempotencyKey(`feedback-answer/${row.id}`, to),
      });
    } catch (err) {
      console.warn(`[feedback-answer] mail for ${row.id} not sent: ${err instanceof Error ? err.message : String(err)}`);
      out.waiting.push(row.id);
      continue;
    }
    await env.db.feedback.updateMany({ where: { id: row.id, answeredAt: null }, data: { answeredAt: now } });
    out.mailed.push(row.id);
  }
  return out;
}
