// CHE-486 part 3: what the agent worker does with production errors the
// monitor (src/monitor/index.ts) hands it. One signature, one ticket on our own
// board, labelled for Mender, and Mender is woken by it — an error in
// production is the trigger, never a clock (owner, 2026-10-15).
//
//   - a new signature → "[Prod error] …" ticket; the watch (part 4) looks at
//     the last deploy, reverts it if it was Mender's alone and came just before,
//     and wakes Mender either way;
//   - a repeat while the ticket is open → counted; the ticket hears of it at
//     most once an hour (a hot path can throw thousands of times a minute);
//   - back after the ticket was Done → a new "recurrence" ticket naming the old
//     one (the fix did not hold), and the watch as for a new one;
//   - the ticket Canceled → ruled not-a-bug: counted, never filed again.
//
// PROD_ERROR_FILING = "on" files tickets; anything else only records the
// signatures in our own table, so a new kind of event can be looked at before
// it can wake anything.
//
// Never throws: a failure here is itself an exception in the agent worker, and
// the monitor would report it back here.

import { prodErrorAction, type ProdErrorReport } from "@/lib/prod-error";
import type { TicketDraft } from "@/lib/tracker/types";
import { MENDER_LABEL, ourBoard, type GapBoard } from "./capability-gaps";
import type { AgentEnv } from "./env";
import { watchDeploy } from "./mender-dispatch";

export const PROD_ERROR_LABEL = "prod-error";

interface ProdErrorRow {
  signature: string;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  issueIdentifier: string | null;
  lastToldAt: Date | null;
  settled: boolean;
}

/** The ticket for a signature. Internal board: the worker, the path and the stack's function names, never a raw message. */
export function prodErrorDraft(r: ProdErrorReport, row: Pick<ProdErrorRow, "count" | "firstSeenAt">, previous: string | null): TicketDraft {
  const title = `[Prod error${previous ? " · recurrence" : ""}] ${r.script}: ${r.name}: ${r.message}`.slice(0, 200);
  const description = [
    previous
      ? `**This came back after ${previous} was Done** — the fix did not hold, or another path reaches the same failure.`
      : "**An error in production**, reported by the monitor (a Tail Worker on the web and agent workers) as it happened.",
    "",
    `- **Worker:** \`${r.script}\``,
    `- **Error:** \`${r.name}\` — ${r.message}`,
    r.frame ? `- **Thrown from:** \`${r.frame}\`` : "",
    r.path ? `- **Request:** \`${r.path}\`` : "",
    `- **Seen:** ${row.count} time(s) since ${row.firstSeenAt.toISOString()}`,
    "",
    "**How to know it is gone:** after the fix is deployed this signature stops arriving. If it comes back after this ticket is Done, the monitor opens a recurrence ticket naming this one.",
    "",
    "Signature:",
    "```",
    r.signature,
    "```",
  ].filter((l) => l !== "").join("\n");
  return { title, description, labelNames: [MENDER_LABEL, PROD_ERROR_LABEL], stateName: "Todo", priority: previous ? 1 : 2 };
}

type Db = {
  prodError: {
    upsert(args: unknown): Promise<ProdErrorRow>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
};

export async function intakeProdErrors(
  env: { db: unknown; bindings: AgentEnv["bindings"] },
  reports: ProdErrorReport[],
  opts: { board?: GapBoard | null; now?: Date } = {},
): Promise<{ filed: string[]; told: string[]; recorded: number }> {
  const db = env.db as Db;
  const now = opts.now ?? new Date();
  const filing = env.bindings.PROD_ERROR_FILING?.trim().toLowerCase() === "on";
  const filed: string[] = [];
  // When the earliest filed error happened — not when it was processed: the
  // watch asks whether it came after a deploy (CodeRabbit, #360).
  let firstAt = Infinity;
  const told: string[] = [];
  let board: GapBoard | null | undefined = opts.board;
  for (const r of reports) {
    let claim: { signature: string; lastToldAt: Date | null } | null = null;
    try {
      const row = await db.prodError.upsert({
        where: { signature: r.signature },
        create: { signature: r.signature, script: r.script, name: r.name, message: r.message, frame: r.frame, path: r.path, count: r.count, firstSeenAt: now, lastSeenAt: now },
        update: { count: { increment: r.count }, lastSeenAt: now, path: r.path ?? undefined },
      });
      if (!filing) continue;
      const action = prodErrorAction(row, now);
      if (action === "count") continue;
      board = board === undefined ? await ourBoard(env as AgentEnv) : board;
      if (!board) continue;
      // The claim (Codex, #358): tail invocations overlap, and two that both
      // read "no ticket yet" would open two. lastToldAt is swapped from the
      // value this one read to now in one statement; only the invocation whose
      // swap lands acts, and every other one reads "told within the hour".
      const claimed = await db.prodError.updateMany({ where: { signature: r.signature, lastToldAt: row.lastToldAt }, data: { lastToldAt: now } });
      if (claimed.count !== 1) continue;
      claim = { signature: r.signature, lastToldAt: row.lastToldAt };
      let previous: string | null = null;
      if (action === "tell" && row.issueIdentifier) {
        const outcome = await board.tracker.getIssueOutcome(row.issueIdentifier);
        if (outcome === "open") {
          await board.tracker.addComment(row.issueIdentifier, `Still happening: ${row.count} occurrence(s) since ${row.firstSeenAt.toISOString()}, the latest ${now.toISOString()}${r.path ? ` on \`${r.path}\`` : ""}.`);
          told.push(row.issueIdentifier);
          continue;
        }
        if (outcome === "canceled") {
          await db.prodError.update({ where: { signature: r.signature }, data: { settled: true } });
          continue;
        }
        if (outcome === "done") previous = row.issueIdentifier;
      }
      const issue = await board.tracker.createIssue(prodErrorDraft(r, row, previous));
      claim = null;
      // The ticket exists, so it is filed and Mender is woken whatever happens
      // next. Recording it is tried twice (Codex, #358); if both fail, the log
      // names the ticket, and the next report within the hour still only counts.
      filed.push(issue.identifier);
      firstAt = Math.min(firstAt, Number.isFinite(r.at) ? r.at : now.getTime());
      let recorded = false;
      for (let attempt = 0; attempt < 2 && !recorded; attempt++) {
        recorded = await db.prodError.update({ where: { signature: r.signature }, data: { issueIdentifier: issue.identifier, lastToldAt: now } })
          .then(() => true, () => false);
      }
      if (!recorded) console.warn(`[prod-error] filed ${issue.identifier} but could not record it on ${r.signature.slice(0, 120)}; a duplicate may follow after the hour`);
    } catch (err) {
      console.warn(`[prod-error] ${r.signature.slice(0, 120)}: ${err instanceof Error ? err.message : String(err)}`);
      // Nothing was filed: the claim is let go, so the next report tries again.
      if (claim) await db.prodError.updateMany({ where: { signature: claim.signature, lastToldAt: now }, data: { lastToldAt: claim.lastToldAt } }).catch(() => {});
    }
  }
  // A new error may be the last deploy's: the watch looks at it first and wakes
  // Mender either way (CHE-486 part 4). One watch per batch — it judges the
  // deploy, and its wake covers every ticket filed with it.
  if (filed.length) await watchDeploy(env.bindings, filed[0], new Date(Number.isFinite(firstAt) ? firstAt : now.getTime()));
  return { filed, told, recorded: reports.length };
}
