// Waking Mender (CHE-445, CHE-486). It used to be a clock: GitHub's own
// schedule fired every 4–7 hours, so this worker's cron asked GitHub to start a
// tick every few minutes. Owner, 2026-10-15: «главное чтобы не было кронов, а
// триггерами монитора были ошибки в проде». Now Mender is woken by the event
// itself — a ticket filed for it — at the place that files it (wakeMender).
// Its reviews, its gate and its self-chaining are events too.
//
// The token is a fine-grained one that may only start workflows in this
// repository (actions: write). Without it this does nothing.

export const MENDER_REPO = "JobLander-app/check-my-app";
export const MENDER_WORKFLOW = "mender-agent.yml";
/** The watch after a deploy (CHE-486 part 4; .github/workflows/mender-watch.yml). */
export const WATCH_WORKFLOW = "mender-watch.yml";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function dispatchMender(
  bindings: { MENDER_DISPATCH_TOKEN?: string },
  doFetch: Fetch = (url, init) => fetch(url, init),
  run: { workflow?: string; inputs?: Record<string, string> } = {},
): Promise<"dispatched" | "no-token"> {
  const token = bindings.MENDER_DISPATCH_TOKEN;
  if (!token) return "no-token";
  const res = await doFetch(`https://api.github.com/repos/${MENDER_REPO}/actions/workflows/${run.workflow ?? MENDER_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "checkmyapp-agent",
    },
    body: JSON.stringify(run.inputs ? { ref: "main", inputs: run.inputs } : { ref: "main" }),
    // A stalled GitHub must not hold whatever filed the ticket (CodeRabbit, #307).
    signal: AbortSignal.timeout(5_000),
  });
  if (res.status !== 204) throw new Error(`GitHub answered ${res.status} to the Mender dispatch`);
  return "dispatched";
}

/**
 * The tracker, noting each ticket it creates in `created`. Filing does more
 * after the ticket exists (the ledger row), and when that fails the ticket is
 * still Mender's: it is woken for what was created, not for what was recorded
 * (Codex, #357).
 */
export function noteCreated<T extends { createIssue(draft: never): Promise<{ identifier: string }> }>(tracker: T, created: string[]): T {
  return new Proxy(tracker, {
    get(target, prop) {
      if (prop === "createIssue") {
        return async (draft: never) => {
          const issue = await target.createIssue(draft);
          created.push(issue.identifier);
          return issue;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Where a wake GitHub refused is kept until it is delivered (the evidence bucket; one small object). */
export const OWED_WAKE_KEY = "system/mender-wake-owed.json";

type Outbox = {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<unknown>;
};
type WakeBindings = { MENDER_DISPATCH_TOKEN?: string; EVIDENCE?: Outbox };

/**
 * Wake Mender because something was just filed for it. Never throws: a ticket
 * that exists is not undone by a GitHub that did not answer. Nor is the wake
 * forgotten (Codex, #357/#358): it is owed, and the scheduler's next tick
 * delivers it (deliverOwedWake).
 */
export async function wakeMender(bindings: WakeBindings, why: string, doFetch?: Fetch): Promise<"dispatched" | "no-token" | "failed"> {
  try {
    const result = await dispatchMender(bindings, doFetch);
    if (result === "dispatched") console.log(`[mender] woken: ${why}`);
    return result;
  } catch (err) {
    console.warn(`[mender] could not be woken (${why}): ${err instanceof Error ? err.message : String(err)} — owed to the next tick`);
    await bindings.EVIDENCE?.put(OWED_WAKE_KEY, JSON.stringify({ why, at: new Date().toISOString() })).catch(() => {});
    return "failed";
  }
}

/**
 * A ticket for a new production error or a new kind of failed check (CHE-486
 * part 4): the watch looks first — the last deploy is reverted if it carried
 * only Mender's changes and the error came right after it — and wakes Mender
 * either way. A watch GitHub refused falls back to waking Mender: the ticket is
 * never left alone, only the revert is lost. Never throws.
 */
export async function watchDeploy(bindings: WakeBindings, ticket: string, seen: Date, doFetch?: Fetch): Promise<"dispatched" | "no-token" | "failed"> {
  try {
    const result = await dispatchMender(bindings, doFetch, { workflow: WATCH_WORKFLOW, inputs: { watch: ticket, seen: seen.toISOString() } });
    if (result === "dispatched") console.log(`[mender] the watch looks at ${ticket}`);
    return result;
  } catch (err) {
    console.warn(`[mender] the watch for ${ticket} could not start: ${err instanceof Error ? err.message : String(err)} — waking Mender instead`);
    return wakeMender(bindings, `${ticket} (the watch could not start)`, doFetch);
  }
}

/**
 * A wake GitHub refused, delivered on the scheduler's tick. A retry of an event
 * that happened, never a clock: with nothing owed the tick starts nothing (the
 * owner's rule, 2026-10-15 — no crons). Delivered, the debt is cleared; refused
 * again, it stays for the next tick.
 */
export async function deliverOwedWake(bindings: WakeBindings, doFetch?: Fetch): Promise<"none" | "dispatched" | "no-token" | "failed"> {
  const owed = await bindings.EVIDENCE?.get(OWED_WAKE_KEY).catch(() => null);
  if (!owed) return "none";
  const why = await owed.text().then((t) => (JSON.parse(t) as { why?: string }).why ?? "an owed wake", () => "an owed wake");
  const result = await dispatchMender(bindings, doFetch).catch((err: unknown) => {
    console.warn(`[mender] the owed wake (${why}) was refused again: ${err instanceof Error ? err.message : String(err)}`);
    return "failed" as const;
  });
  if (result === "dispatched") {
    await bindings.EVIDENCE?.delete(OWED_WAKE_KEY).catch(() => {});
    console.log(`[mender] woken on the tick, owed since: ${why}`);
  }
  return result;
}
