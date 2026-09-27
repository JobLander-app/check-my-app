// Connecting a coding agent (CHE-317). The agent is the primary interface of
// CheckMyApp (CHE-313): the dashboard's job is to hand the person one line that
// connects their agent, and then to get out of the way.
//
// Pure on purpose — the panel renders these strings and the verify script
// checks them, so the command a person copies and the command we test are the
// same string.

import { CHANNEL_TARBALL_PATH } from "../../mcp/channel/watch";

export const MCP_URL = "https://checkmyapp.dev/mcp";
export const CONNECT_GUIDE_PATH = "/guides/connect-your-agent";

// What the command shows before a key exists. Visibly not a key, so nobody
// pastes it and wonders why it was refused.
export const KEY_PLACEHOLDER = "<KEY>";

export function installCommand(key: string | null): string {
  return `claude mcp add --transport http checkmyapp ${MCP_URL} --header "Authorization: Bearer ${key ?? KEY_PLACEHOLDER}"`;
}

// Daily Watch results pushed into a running Claude Code session (CHE-319):
// the checkmyapp-watch channel, installed from a tarball on our own site. The
// URL carries the channel's version (mcp/channel/watch.ts says why), so it is
// read from there and never retyped.
export const WATCH_CHANNEL_URL = `https://checkmyapp.dev${CHANNEL_TARBALL_PATH}`;

export function watchChannelCommands(key: string | null): { add: string; start: string } {
  return {
    add: `claude mcp add checkmyapp-watch -e CHECKMYAPP_API_KEY=${key ?? KEY_PLACEHOLDER} -- npx -y ${WATCH_CHANNEL_URL}`,
    start: "claude --dangerously-load-development-channels server:checkmyapp-watch",
  };
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

// The first thing to say to the agent once it is connected (CHE-324). The
// same example the guide gives (/guides/connect-your-agent, "Ask for what you
// want"), with the person's own address in it when onboarding knows one — a
// person who arrived from a verdict with ?url= should not retype it.
export const EXAMPLE_APP_URL = "https://app.example.com";

export function firstPrompt(url: string | null | undefined): string {
  const address = url?.trim() && /^https?:\/\/\S+$/i.test(url.trim()) ? url.trim() : EXAMPLE_APP_URL;
  return (
    `Add my app ${address} to CheckMyApp with the test account qa@example.com — ` +
    "the password is QA_PASSWORD in .env.test. Scenarios: a signed-in user can create an invoice " +
    "and download it as a PDF; search finds an invoice by number. Then run a check and fix what it finds."
  );
}

// Connected = a key of this team has actually been used. A key that was
// created and never used is a person who stopped halfway, and the panel stays
// in front of them until the agent makes its first call.
export function agentConnected(keys: { lastUsedAt: string | Date | null }[]): boolean {
  return keys.some((k) => k.lastUsedAt !== null);
}
