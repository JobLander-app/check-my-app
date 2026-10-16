// CHE-486 part 3: what the agent worker does with production errors the
// monitor (src/monitor/index.ts) hands it. One signature, one ticket on our own
// board, labelled for Mender, and Mender is woken by it — an error in
// production is the trigger, never a clock (owner, 2026-10-15).
//
//   - a new signature → "[Prod error] …" ticket, Mender woken;
//   - a repeat while the ticket is open → counted; the ticket hears of it at
//     most once an hour (a hot path can throw thousands of times a minute);
//   - back after the ticket was Done → a new "recurrence" ticket naming the old
//     one (the fix did not hold), Mender woken;
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
import { wakeMender } from "./mender-dispatch";

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
      await db.prodError.update({ where: { signature: r.signature }, data: { issueIdentifier: issue.identifier, lastToldAt: now } });
      filed.push(issue.identifier);
    } catch (err) {
      console.warn(`[prod-error] ${r.signature.slice(0, 120)}: ${err instanceof Error ? err.message : String(err)}`);
      // Nothing was filed: the claim is let go, so the next report tries again.
      if (claim) await db.prodError.updateMany({ where: { signature: claim.signature, lastToldAt: now }, data: { lastToldAt: claim.lastToldAt } }).catch(() => {});
    }
  }
  if (filed.length) await wakeMender(env.bindings, `prod error(s) ${filed.join(", ")}`);
  return { filed, told, recorded: reports.length };
}
