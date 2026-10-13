// CHE-464: the agent worker's doors to a team's session browser
// (session-runner.ts). No container runtime here: scripts/verify-session-runner.ts
// drives these exact functions with a stub in place of the Durable Object.

import type { AgentBindings } from "./env";
import { SESSION_TEAM_HEADER, SESSION_TEAM_ID, sessionRunnerFor } from "./session-address";
import { verifyViewToken, viewKeyFor, viewTokenSlot } from "@/lib/session-view";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);

// GET wss://live.checkmyapp.dev/session/view?token=… — a person on the
// sign-in page, to their team's browser. The token is checked here with the
// team's key before anything wakes, and again by the viewer in the container.
export async function routeLiveView(request: Request, bindings: Pick<AgentBindings, "SESSION_RUNNER" | "SESSION_VIEW_SECRET">): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const team = viewTokenSlot(token);
  const secret = bindings.SESSION_VIEW_SECRET?.trim();
  if (!team || !secret || !bindings.SESSION_RUNNER) return new Response(null, { status: 403 });
  if (!(await verifyViewToken(await viewKeyFor(secret, team), token))) return new Response(null, { status: 403 });
  const headers = new Headers(request.headers);
  headers.set(SESSION_TEAM_HEADER, team);
  return sessionRunnerFor(bindings, team).fetch(new Request(`http://session/v1/view?token=${encodeURIComponent(token)}`, { headers }));
}

// Ours, behind SESSION_ADMIN_TOKEN: moving a live sign-in into a team's
// browser (POST /session/jar {teamId, cookies}) and reading its state
// (GET /session/state?teamId=…). An answer never carries a cookie value.
export async function routeSessionAdmin(request: Request, bindings: Pick<AgentBindings, "SESSION_RUNNER" | "SESSION_ADMIN_TOKEN">): Promise<Response> {
  const expected = bindings.SESSION_ADMIN_TOKEN?.trim();
  const given = request.headers.get("Authorization") ?? "";
  if (!expected || expected.length < 32 || !(await sameText(given, `Bearer ${expected}`))) return new Response(null, { status: 401 });
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.pathname === "/session/jar") {
      const input = (await request.json().catch(() => null)) as { teamId?: string; cookies?: unknown } | null;
      if (!input?.teamId) return Response.json({ error: "teamId required" }, { status: 400 });
      return Response.json(await sessionRunnerFor(bindings, input.teamId).importJar(input.teamId, input.cookies));
    }
    if (request.method === "GET" && url.pathname === "/session/state") {
      const teamId = url.searchParams.get("teamId") ?? "";
      return Response.json(await sessionRunnerFor(bindings, teamId).describe(teamId));
    }
  } catch (error) {
    return Response.json({ error: message(error) }, { status: 422 });
  }
  return new Response(null, { status: 404 });
}

async function sameText(a: string, b: string): Promise<boolean> {
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// The scheduler's tick: every team with a Shopify app has its probe scheduled
// (a no-op for a team whose browser has never held a sign-in).
export async function ensureSessionProbes(bindings: Pick<AgentBindings, "SESSION_RUNNER" | "DB">): Promise<number> {
  if (!bindings.SESSION_RUNNER) return 0;
  const rows = await bindings.DB.prepare("SELECT DISTINCT teamId FROM App WHERE targetKind = 'session' AND teamId IS NOT NULL").all<{ teamId: string }>();
  let watched = 0;
  for (const { teamId } of rows.results ?? []) {
    if (!SESSION_TEAM_ID.test(teamId)) continue;
    if (await sessionRunnerFor(bindings, teamId).ensureProbe(teamId).catch(() => false)) watched++;
  }
  return watched;
}
