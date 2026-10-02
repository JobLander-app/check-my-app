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

export type McpDoor = "mcp" | "action";

const KNOWN_CLIENTS: ReadonlyArray<{ userAgent: RegExp; door: Exclude<McpDoor, "mcp"> }> = [
  { userAgent: /^checkmyapp-action\/\d+(?:\.\d+){0,2}$/, door: "action" },
];

export function mcpDoor(userAgent: string | null | undefined): McpDoor {
  const ua = (userAgent ?? "").trim();
  return KNOWN_CLIENTS.find((c) => c.userAgent.test(ua))?.door ?? "mcp";
}
