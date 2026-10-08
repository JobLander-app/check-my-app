import { getDbFromContext } from "@/lib/db";
import { captureServer } from "@/lib/analytics-server";
import { handleMcpRequest } from "@/lib/mcp/handler";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";
import { effectiveEphemeralTtlDays, effectiveSiteCap } from "@/lib/site-cap";
import { triggerRun } from "@/lib/trigger";

// POST /mcp (rewritten here by next.config.mjs) — the remote MCP server
// (CHE-315). Everything is in src/lib/mcp/handler.ts; this file only supplies
// the platform: the D1 client, the Workflow trigger, the runtime caps.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // CHE-193: our own checker never creates, starts or changes anything, and
  // several tools here do. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  return handleMcpRequest(req, {
    db: await getDbFromContext(),
    // The origin the request came to, so links work on a preview or a local
    // stack as well as on checkmyapp.dev (the review route does the same).
    origin: new URL(req.url).origin,
    trigger: triggerRun,
    siteCap: effectiveSiteCap,
    ephemeralTtlDays: effectiveEphemeralTtlDays,
    capture: captureServer,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });
}

// Stateless: there is no session to stream to (GET) or to end (DELETE), so
// neither is exported and Next answers both with 405.
