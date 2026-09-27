// Connecting a coding agent (CHE-317). The agent is the primary interface of
// CheckMyApp (CHE-313): the dashboard's job is to hand the person one line that
// connects their agent, and then to get out of the way.
//
// Pure on purpose — the panel renders these strings and the verify script
// checks them, so the command a person copies and the command we test are the
// same string.

export const MCP_URL = "https://checkmyapp.dev/mcp";
export const CONNECT_GUIDE_PATH = "/guides/connect-your-agent";

// What the command shows before a key exists. Visibly not a key, so nobody
// pastes it and wonders why it was refused.
export const KEY_PLACEHOLDER = "<KEY>";

export function installCommand(key: string | null): string {
  return `claude mcp add --transport http checkmyapp ${MCP_URL} --header "Authorization: Bearer ${key ?? KEY_PLACEHOLDER}"`;
}

// Cursor and the other clients that read an mcpServers JSON block.
export function clientConfig(key: string | null): string {
  return JSON.stringify(
    {
      mcpServers: {
        checkmyapp: { url: MCP_URL, headers: { Authorization: `Bearer ${key ?? KEY_PLACEHOLDER}` } },
      },
    },
    null,
    2,
  );
}

// Connected = a key of this team has actually been used. A key that was
// created and never used is a person who stopped halfway, and the panel stays
// in front of them until the agent makes its first call.
export function agentConnected(keys: { lastUsedAt: string | Date | null }[]): boolean {
  return keys.some((k) => k.lastUsedAt !== null);
}
