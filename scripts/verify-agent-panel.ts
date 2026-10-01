// CHE-317: the dashboard says "this is the last time you need to be here —
// connect your agent", and means it. This proves, without a browser or a D1:
//
//   1. the panel is big and in front of a team with no used key — no key at
//      all, or a key nobody has used yet — and shrinks to one line once any of
//      the team's keys has been used;
//   2. the install command a person copies carries the key that was just
//      created, both for Claude Code and for the JSON clients, and shows a
//      placeholder (never a real-looking key) before one exists;
//   3. the panel's words obey CLAUDE.md §1 — no machinery, no homework;
//   4. lastUsedAt, the fact "connected" is read from, is written on the first
//      use and then at most once an hour, not on every request;
//   5. the dashboard renders the panel above the apps, from the team's keys.
//
// It renders the real components with react-dom/server.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-agent-panel.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AgentInstall, ConnectAgent } from "@/components/connect-agent";
import {
  CONNECT_GUIDE_PATH,
  KEY_PLACEHOLDER,
  agentConnected,
  clientConfig,
  installCommand,
} from "@/lib/agent-connect";
import { LAST_USED_TOUCH_MS, shouldTouchLastUsed } from "@/lib/apiKeys";
import { hasEnvironmentLeak, hasHomework, narrationIn } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
function render(el: ReturnType<typeof createElement>): string {
  return renderToString(createElement(AppRouterContext.Provider, { value: router as never }, el));
}
// React escapes quotes and angle brackets in text; compare against what the
// person sees, not the markup.
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const HEADLINE = "This is the last time you need to be here.";
const KEY = "cma_0123456789abcdef0123456789abcdef";

// ─── 1. Shown until a key is used ───────────────────────────────────────────

const none = text(render(createElement(ConnectAgent, { keys: [] })));
check("no keys: the headline is shown", none.includes(HEADLINE));
check("no keys: one-click Create key", none.includes("Create key"));
check("no keys: the command is shown with a placeholder", none.includes(installCommand(null)), none);
check("no keys: not claiming to be connected", !none.includes("Connected to your agent"));

const unused = text(render(createElement(ConnectAgent, { keys: [{ lastUsedAt: null }] })));
check("a key that was never used: still the full panel", unused.includes(HEADLINE) && !unused.includes("Connected to your agent"));

const used = text(
  render(createElement(ConnectAgent, { keys: [{ lastUsedAt: null }, { lastUsedAt: "2026-09-27T10:00:00.000Z" }] })),
);
check("a used key: collapses to 'Connected to your agent · setup'", used.includes("Connected to your agent · setup"), used);
check("a used key: the headline is gone", !used.includes(HEADLINE));
check("a used key: setup is still reachable inside", used.includes("Create key") && used.includes("claude mcp add"));

check("agentConnected: [] → false", agentConnected([]) === false);
check("agentConnected: never used → false", agentConnected([{ lastUsedAt: null }]) === false);
check("agentConnected: one used → true", agentConnected([{ lastUsedAt: null }, { lastUsedAt: new Date() }]) === true);

// ─── 2. The command carries the created key ─────────────────────────────────

check(
  "installCommand is exactly the documented one",
  installCommand(KEY) ===
    `claude mcp add --transport http checkmyapp https://checkmyapp.dev/mcp --header "Authorization: Bearer ${KEY}"`,
  installCommand(KEY),
);
const withKey = text(render(createElement(AgentInstall, { rawKey: KEY })));
check("created key: the rendered command contains it", withKey.includes(installCommand(KEY)), withKey);
check("created key: no placeholder left", !withKey.includes(KEY_PLACEHOLDER));
const json = JSON.parse(clientConfig(KEY)) as { mcpServers: { checkmyapp: { url: string; headers: { Authorization: string } } } };
check(
  "created key: the Cursor / other clients JSON carries it",
  json.mcpServers.checkmyapp.url === "https://checkmyapp.dev/mcp" &&
    json.mcpServers.checkmyapp.headers.Authorization === `Bearer ${KEY}`,
);
check("…and it is rendered", withKey.includes(`"Authorization": "Bearer ${KEY}"`) && withKey.includes("Cursor / other clients"));
check("the guide is linked", render(createElement(AgentInstall, { rawKey: null })).includes(`href="${CONNECT_GUIDE_PATH}"`));
check("placeholder is not shaped like a key", !/^cma_[0-9a-f]{32}$/.test(KEY_PLACEHOLDER));

const panelSource = readFileSync(join(process.cwd(), "src/components/connect-agent.tsx"), "utf8");
check("the Create button puts the created key into the command", /setRawKey\(created\.rawKey\)/.test(panelSource) && /<AgentInstall rawKey=\{rawKey\} \/>/.test(panelSource));
check("…through the same createApiKey action as the API keys block", /await createApiKey\(/.test(panelSource));
check("no useEffect in the panel (owner rule)", !/useEffect/.test(panelSource));

// ─── 3. §1: the product, not our machinery ──────────────────────────────────

for (const [name, t] of [["full panel", none], ["collapsed line", used]] as const) {
  check(`${name}: no homework`, !hasHomework(t));
  check(`${name}: no environment leak`, !hasEnvironmentLeak(t));
  check(`${name}: no machinery narration`, narrationIn(t).length === 0, narrationIn(t).join(" | "));
}

// ─── 4. lastUsedAt: first use, then at most hourly ──────────────────────────

const now = new Date("2026-09-27T12:00:00.000Z");
check("never used → written", shouldTouchLastUsed(null, now));
check("used 5 minutes ago → not written again", !shouldTouchLastUsed(new Date(now.getTime() - 5 * 60_000), now));
check("used an hour ago → written", shouldTouchLastUsed(new Date(now.getTime() - LAST_USED_TOUCH_MS), now));
const keysSource = readFileSync(join(process.cwd(), "src/lib/apiKeys.ts"), "utf8");
check(
  "resolveApiKeyGrant writes lastUsedAt only behind the throttle",
  /if \(shouldTouchLastUsed\(key\.lastUsedAt, now\)\) \{\s*await db\.apiKey\.update\(/.test(keysSource) &&
    (keysSource.match(/data: \{ lastUsedAt/g) ?? []).length === 1,
);

// ─── 5. On the dashboard, first ─────────────────────────────────────────────

// CHE-351: the dashboard is Today (/home) inside the app shell; the panel is
// also on Agent and API keys, beside the keys themselves.
const dashboard = readFileSync(join(process.cwd(), "src/app/(app)/home/page.tsx"), "utf8");
const panelAt = dashboard.indexOf("<ConnectAgent");
check("Today renders the panel", panelAt !== -1);
check("…above the apps", panelAt !== -1 && panelAt < dashboard.indexOf("{apps.length === 0 ?"));
check("…from the team's keys' lastUsedAt", /<ConnectAgent keys=\{apiKeys\.map\(\(k\) => \(\{ lastUsedAt:/.test(dashboard));
const keysPage = readFileSync(join(process.cwd(), "src/app/(app)/settings/api-keys/page.tsx"), "utf8");
check("Agent and API keys renders it too, from the same field", /<ConnectAgent keys=\{apiKeys\.map\(\(k\) => \(\{ lastUsedAt:/.test(keysPage));

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
