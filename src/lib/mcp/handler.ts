// The remote MCP server: one POST in, one JSON answer out (CHE-315).
//
//   claude mcp add --transport http checkmyapp https://checkmyapp.dev/mcp \
//     --header "Authorization: Bearer cma_…"
//
// Stateless on purpose. A Worker isolate may serve the next request of the
// same client or may not exist by then, so nothing is kept between requests:
// every POST builds a fresh McpServer and transport (sessionIdGenerator
// undefined), answers with plain JSON (enableJsonResponse — no SSE stream to
// hold open), and is done. There is no session to resume, so GET (the
// server-to-client stream) and DELETE (ending a session) answer 405.
//
// Authentication is the owner API key (src/lib/apiKeys.ts, CHE-52/263) and
// nothing else: no Clerk session, no cookie. The key names a team and a scope;
// every tool acts for that team with that scope (src/lib/mcp/tools.ts).
//
// Lives in src/lib, with the platform passed in, so scripts/verify-mcp-remote.ts
// drives exactly this code with a stub database and no network.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { resolveApiKeyGrant } from "@/lib/apiKeys";
import type { UserPlan } from "@/lib/enums";
import { latestResults } from "@/lib/latest-results";
import { loadPlanStatus } from "@/lib/plan-status";
import { teamRunsTheAction } from "@/lib/release-action";
import { can, type TeamScope } from "@/lib/scopes";
import { mcpDoor } from "@/lib/started-via";
import { activeTeamContext } from "@/lib/teams";
import { buildInstructions } from "./instructions";
import { createRemoteTools, registerRemoteTools, type McpCaller, type McpDeps } from "./tools";

export const MCP_SERVER_VERSION = "2.0.0";

// JSON-RPC over HTTP: a refusal before any message is read is still a JSON-RPC
// error body, so a client prints the sentence rather than "unexpected token".
function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export const UNAUTHORIZED_MESSAGE =
  "CheckMyApp needs an API key: add the header `Authorization: Bearer cma_…` (dashboard → API keys).";

export function methodNotAllowed(): Response {
  return rpcError(405, -32000, "This MCP server is stateless: send JSON-RPC as POST.", { allow: "POST" });
}

// The server never asks the client to fill in a form (elicitation), which is
// the only thing the SDK's default JSON-schema validator is constructed for.
// Passing this instead keeps a schema compiler — code generation at runtime,
// which a Worker may refuse — out of every request.
const noElicitation: jsonSchemaValidator = {
  getValidator: () => () => ({ valid: false, data: undefined, errorMessage: "This server does not request input." }),
};

async function callerFor(deps: McpDeps, req: Request): Promise<McpCaller | null> {
  const grant = await resolveApiKeyGrant(deps.db, req);
  if (!grant) return null;
  // CHE-383: the client decides nothing but which of our labels a run gets.
  const door = mcpDoor(req.headers.get("user-agent"));
  // A key minted before keys carried a team (CHE-263) acts for its minter's
  // personal team — the same fallback requireScope (src/lib/team-auth.ts) uses.
  if (grant.team) {
    return {
      user: { id: grant.user.id, email: grant.user.email, name: grant.user.name },
      team: { id: grant.team.id, name: grant.team.name, plan: grant.team.plan },
      scope: grant.scope as TeamScope,
      door,
    };
  }
  const { team, scope } = await activeTeamContext(deps.db, grant.user, null);
  return {
    user: { id: grant.user.id, email: grant.user.email, name: grant.user.name },
    team: { id: team.id, name: team.name, plan: team.plan },
    scope,
    door,
  };
}

function isInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => typeof m === "object" && m !== null && (m as { method?: unknown }).method === "initialize");
}

export async function handleMcpRequest(req: Request, deps: McpDeps): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();

  const caller = await callerFor(deps, req);
  if (!caller) return rpcError(401, -32001, UNAUTHORIZED_MESSAGE, { "www-authenticate": 'Bearer realm="checkmyapp"' });
  // Connecting at all is reading the team's apps. Every scope may; each tool
  // then asks for its own action.
  if (!can(caller.scope, "read")) return rpcError(403, -32003, "This API key cannot read this team.");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(400, -32700, "Parse error: the body is not JSON.");
  }

  // The instructions are what an agent reads once, when it connects. Built
  // only for `initialize` — every later call would pay for a summary nobody
  // reads.
  const instructions = isInitialize(body)
    ? buildInstructions(
        caller.team.name,
        await latestResults(deps.db, caller.team.id),
        await loadPlanStatus(deps.db, { id: caller.team.id, plan: caller.team.plan as UserPlan }, deps.origin, new Date(deps.now())),
        await teamRunsTheAction(deps.db, caller.team.id),
      )
    : undefined;

  const server = new McpServer(
    { name: "checkmyapp", version: MCP_SERVER_VERSION },
    { instructions, jsonSchemaValidator: noElicitation },
  );
  registerRemoteTools(server, createRemoteTools(caller, deps));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, { parsedBody: body });
  } finally {
    // The JSON answer is complete by the time handleRequest resolves; nothing
    // of this server outlives the request.
    await server.close();
  }
}
