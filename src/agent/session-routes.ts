// CHE-464: the agent worker's doors to a session browser (session-runner.ts).
// No container runtime here: scripts/verify-session-runner.ts drives these
// exact functions with a stub in place of the Durable Object.
//
// CHE-482: every door names a slot — one person in one team — not a team.

import type { AgentBindings } from "./env";
import { SESSION_SLOT_HEADER, sessionRunnerFor } from "./session-address";
import { SESSION_SLOT, storeSlot, verifyViewToken, viewKeyFor, viewTokenSlot } from "@/lib/session-view";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);

// GET wss://live.checkmyapp.dev/session/view?token=… — a person on the
// sign-in page, to their own browser. The token is checked here with the
// slot's key before anything wakes, and again by the viewer in the container.
export async function routeLiveView(request: Request, bindings: Pick<AgentBindings, "SESSION_RUNNER" | "SESSION_VIEW_SECRET">): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const slot = viewTokenSlot(token);
  const secret = bindings.SESSION_VIEW_SECRET?.trim();
  if (!slot || !secret || !bindings.SESSION_RUNNER) return new Response(null, { status: 403 });
  if (!(await verifyViewToken(await viewKeyFor(secret, slot), token))) return new Response(null, { status: 403 });
  const headers = new Headers(request.headers);
  headers.set(SESSION_SLOT_HEADER, slot);
  return sessionRunnerFor(bindings, slot).fetch(new Request(`http://session/v1/view?token=${encodeURIComponent(token)}`, { headers }));
}

// Ours, behind SESSION_ADMIN_TOKEN: moving a live sign-in into a slot's
// browser (POST /session/jar {slot, cookies}), from one slot's browser to
// another's (POST /session/move {from, to}), and reading a slot's state
// (GET /session/state?slot=…). An answer never carries a cookie value.
export async function routeSessionAdmin(request: Request, bindings: Pick<AgentBindings, "SESSION_RUNNER" | "SESSION_ADMIN_TOKEN">): Promise<Response> {
  const expected = bindings.SESSION_ADMIN_TOKEN?.trim();
  const given = request.headers.get("Authorization") ?? "";
  if (!expected || expected.length < 32 || !(await sameText(given, `Bearer ${expected}`))) return new Response(null, { status: 401 });
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.pathname === "/session/jar") {
      const input = (await request.json().catch(() => null)) as { slot?: string; cookies?: unknown } | null;
      if (!input?.slot) return Response.json({ error: "slot required" }, { status: 400 });
      return Response.json(await sessionRunnerFor(bindings, input.slot).importJar(input.slot, input.cookies));
    }
    if (request.method === "POST" && url.pathname === "/session/move") {
      const input = (await request.json().catch(() => null)) as { from?: string; to?: string } | null;
      if (!input?.from || !input.to) return Response.json({ error: "from and to required" }, { status: 400 });
      return Response.json(await sessionRunnerFor(bindings, input.from).handOver(input.from, input.to));
    }
    if (request.method === "GET" && url.pathname === "/session/state") {
      const slot = url.searchParams.get("slot") ?? "";
      return Response.json(await sessionRunnerFor(bindings, slot).describe(slot));
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

// The scheduler's tick: every person with a Shopify store in a team, while they
// are on it, has their probe scheduled (a no-op for a slot whose browser has
// never held a sign-in). Someone who left is not woken (Codex on #351).
export async function ensureSessionProbes(bindings: Pick<AgentBindings, "SESSION_RUNNER" | "DB">): Promise<number> {
  if (!bindings.SESSION_RUNNER) return 0;
  const rows = await bindings.DB.prepare(
    "SELECT DISTINCT a.teamId, a.ownerId FROM App a JOIN Membership m ON m.teamId = a.teamId AND m.userId = a.ownerId WHERE a.targetKind = 'session'",
  ).all<{ teamId: string; ownerId: string }>();
  let watched = 0;
  for (const row of rows.results ?? []) {
    let slot: string | null;
    try {
      slot = storeSlot(row);
    } catch {
      continue;
    }
    if (!slot || !SESSION_SLOT.test(slot)) continue;
    if (await sessionRunnerFor(bindings, slot).ensureProbe(slot).catch(() => false)) watched++;
  }
  return watched;
}
