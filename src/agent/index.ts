// Agent worker entry. Exports the CheckRunWorkflow (durable orchestrator), a
// thin fetch handler — the web app starts a run by creating a Workflow instance
// via the CHECK_RUN binding (see src/lib/trigger.ts), and a manual POST /trigger
// is kept for ops/testing — and the cron handler that fires due Watches (CHE-41).

import { makeAgentEnv, type AgentBindings } from "./env";
import { fileOpenFeedback } from "./feedback-filing";
import { answerFeedback } from "./feedback-answers";
import { sendPilotDigest } from "./pilot-digest";
import { runDueWatches } from "./scheduler";
import { ensureSessionProbes, routeLiveView, routeSessionAdmin } from "./session-routes";
import type { CheckRunParams } from "./workflow";
import { CheckRunWorkflow } from "./workflow";

export { CheckRunWorkflow };
export { ExtensionRunner } from "./extension-runner";
// CHE-464: one Shopify session browser per team, in a Cloudflare Container.
export { SessionRunner } from "./session-runner";

// CHE-464: the live view's own hostname (a custom domain of this worker). On
// it the sign-in page's socket is the only thing served.
const LIVE_HOST = "live.checkmyapp.dev";
// CHE-341: the web worker sends team invites through this entrypoint (service
// binding MAILER in wrangler.jsonc), so the mail key lives in one worker only.
export { Mailer } from "./mailer";

export default {
  async fetch(req: Request, env: AgentBindings): Promise<Response> {
    const url = new URL(req.url);

    // A person on a Shopify app's sign-in page, to their own browser.
    if (url.pathname === "/session/view") return routeLiveView(req, env);
    if (url.hostname === LIVE_HOST) return new Response(null, { status: 404 });
    // Ours: moving a live sign-in into a slot's browser or from one to
    // another, reading a slot's state.
    if (url.pathname === "/session/jar" || url.pathname === "/session/move" || url.pathname === "/session/state") return routeSessionAdmin(req, env);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "agent" });
    }

    // POST /trigger { runId } — start a run Workflow (ops/testing; the web app
    // normally triggers via the CHECK_RUN binding directly).
    if (req.method === "POST" && url.pathname === "/trigger") {
      const body = (await req.json().catch(() => ({}))) as Partial<CheckRunParams>;
      if (!body.runId) {
        return Response.json({ error: "runId required" }, { status: 400 });
      }
      // Under the run's own id, like every other hand-off (CHE-423): a run that
      // already has an instance is refused, not started a second time.
      try {
        const instance = await env.CHECK_RUN.create({ id: body.runId, params: { runId: body.runId } });
        return Response.json({ id: instance.id, runId: body.runId }, { status: 201 });
      } catch (err) {
        return Response.json({ error: `not started: ${err instanceof Error ? err.message : String(err)}` }, { status: 409 });
      }
    }

    return new Response("agent worker", { status: 200 });
  },

  // Cron (*/15) — start the Watch rows that have come due. Awaited rather than
  // waitUntil'd so a failure shows up as a failed cron invocation in the logs.
  async scheduled(controller: ScheduledController, env: AgentBindings): Promise<void> {
    const { started, skipped } = await runDueWatches(env);
    console.log(`[scheduler] tick: started ${started.length}, skipped ${skipped}`);
    // CHE-464: every team whose browser holds a Shopify sign-in has its hourly
    // probe scheduled — a lost alarm does not stop the watch for long.
    try {
      await ensureSessionProbes(env);
    } catch (err) {
      console.warn(`[session-probe] scheduling failed: ${err instanceof Error ? err.message : err}`);
    }
    // CHE-434: reports of the check's mistakes, to our board — after the due
    // checks have started, so a slow tracker never delays one.
    try {
      const { filed, failed } = await fileOpenFeedback(makeAgentEnv(env));
      if (filed.length || failed) console.log(`[feedback] filed ${filed.join(", ") || "none"}, ${failed} waiting`);
    } catch (err) {
      console.warn(`[feedback] filing failed: ${err instanceof Error ? err.message : err}`);
    }
    // CHE-441: a settled report goes back to its author, once.
    try {
      const { settled, mailed, waiting } = await answerFeedback(makeAgentEnv(env));
      if (settled.length || mailed.length || waiting.length) {
        console.log(`[feedback-answer] settled ${settled.length}, mailed ${mailed.length}, waiting ${waiting.length}`);
      }
    } catch (err) {
      console.warn(`[feedback-answer] failed: ${err instanceof Error ? err.message : err}`);
    }
    // CHE-441: the pilot's daily digest — acts only on the 07:00 UTC ticks,
    // and sends once a day (its send id is the date).
    // The tick's own time, not the moment it ran: a cron event delivered late
    // still counts as its hour, and its day (Codex on #321).
    const digest = await sendPilotDigest({ db: makeAgentEnv(env).db, bindings: env }, new Date(controller.scheduledTime));
    if (digest !== "not_now") console.log(`[pilot-digest] ${digest}`);
  },
};
