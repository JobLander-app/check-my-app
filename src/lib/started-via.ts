// Which door a check came through when it came through MCP (CHE-383).
//
// Run.startedVia is measurement only (CHE-327): the Release lens (CHE-367) and
// the pricing questions want "a release triggered this" told apart from "a
// person's coding agent asked". Both arrive at /mcp with an API key; only the
// client tells them apart. The GitHub Action (sorokinvj/checkmyapp-action)
// sends `User-Agent: checkmyapp-action/<major>` on every call.
//
// A client never names its own door. An exact pattern per known client maps it
// to a fixed value; anything else — no header, another client, a header that
// merely contains the name — stays "mcp". A spoofed header can only ever move
// a run between two of our own labels, never write a free-form string.

// Was a check started by its app's schedule? The door says so: the scheduler
// writes "watch" (src/agent/scheduler.ts). The watch a run CARRIES does not —
// a re-check by hand copies its predecessor's watchId (src/lib/recheck.ts),
// enabling a watch from a verdict attaches it to that run
// (src/lib/watch-enable.ts), and removing a watch clears it from every run it
// started. So the watch is asked only of rows from before the door was
// recorded (startedVia null: runs up to #260 on prod). One rule for
// appHealth's scheduled / on-request split and for Health → Checks, in code
// and in the database (Codex P1 on #249).
export function startedBySchedule(run: { startedVia?: string | null; watchId: string | null }): boolean {
  return run.startedVia != null ? run.startedVia === SCHEDULE_DOOR : run.watchId !== null;
}
export const SCHEDULE_DOOR = "watch";
// The same rule as a Prisma filter. (`not: "watch"` leaves NULLs out — SQL's
// NULL <> x — which is why the legacy half is its own branch.)
export const BY_SCHEDULE = { OR: [{ startedVia: SCHEDULE_DOOR }, { startedVia: null, watchId: { not: null } }] };
export const ON_REQUEST = { OR: [{ startedVia: { not: SCHEDULE_DOOR } }, { startedVia: null, watchId: null }] };

export type McpDoor = "mcp" | "action";

const KNOWN_CLIENTS: ReadonlyArray<{ userAgent: RegExp; door: Exclude<McpDoor, "mcp"> }> = [
  { userAgent: /^checkmyapp-action\/\d+(?:\.\d+){0,2}$/, door: "action" },
];

export function mcpDoor(userAgent: string | null | undefined): McpDoor {
  const ua = (userAgent ?? "").trim();
  return KNOWN_CLIENTS.find((c) => c.userAgent.test(ua))?.door ?? "mcp";
}
