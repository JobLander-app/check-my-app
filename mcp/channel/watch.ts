// What the checkmyapp-watch channel decides — when a result is news, and what
// the news says (CHE-319). No MCP, no timers, no process: the server
// (mcp/channel/server.ts) feeds it what `latest_results` answered and pushes
// whatever it returns, and scripts/verify-mcp-channel.ts drives it against the
// remote handler in-process.
//
// Where the results come from: the remote MCP server's own `latest_results`
// tool (src/lib/mcp/tools.ts, src/lib/latest-results.ts), called over plain
// HTTP. Not a second query, not a second definition of "new finding" — the
// channel only remembers which run it last told the session about.

export const CHANNEL_NAME = "checkmyapp-watch";
// Part of the download URL, and bumped with every change to mcp/channel/.
// `npx -y <tarball URL>` installs a URL once and reuses that install for as
// long as the URL answers — a new tarball at the same URL, even with a new
// package version, never reaches someone who already ran it (tried against a
// local server, 2026-09-27). And a URL that stops answering breaks them: npx
// fetches it on every start. So each version is its own file, and old files
// stay (scripts/build-channel.mjs refuses to overwrite one).
export const CHANNEL_VERSION = "1.0.0";
export const CHANNEL_TARBALL_PATH = `/mcp/checkmyapp-watch-${CHANNEL_VERSION}.tgz`;

// A result this old is not "waiting for you" when a session opens — it is
// history, and the session can ask for it (latest_results) if it wants it.
export const STARTUP_FRESH_MS = 24 * 60 * 60_000;

// One app as `latest_results` returns it — only the fields the channel reads.
export interface LatestApp {
  app_id: string;
  app: string;
  url: string;
  latest_run: {
    run_id: string;
    status: string;
    verdict: string | null;
    bottom_line: string | null;
    completed_at: string | null;
  } | null;
  findings_by_severity: Record<string, number>;
  new_findings: Array<{ number: number; title: string; category: string; severity: string }>;
  verdict_url: string | null;
}

export interface ChannelEvent {
  content: string;
  // Keys are identifiers on purpose: Claude Code silently drops a meta key
  // with anything but letters, digits and underscores (channels reference).
  meta: { app: string; run_id: string; verdict: string };
}

// A refusal of the key itself. Retrying cannot fix it, so the server exits on
// it instead of polling a door that stays shut.
export class KeyRefusedError extends Error {}

export interface FetchResultsOptions {
  base: string;
  apiKey: string;
  fetch?: typeof fetch;
}

let rpcId = 0;

// One stateless JSON-RPC call to /mcp. The remote server keeps no session
// (src/lib/mcp/handler.ts), so a tools/call needs no initialize before it.
export async function fetchLatestResults(opts: FetchResultsOptions): Promise<LatestApp[]> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${opts.base.replace(/\/+$/, "")}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The Streamable HTTP transport refuses a POST that does not accept both.
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name: "latest_results", arguments: {} },
    }),
  });
  const raw = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new KeyRefusedError(`${res.status}: ${rpcMessage(raw) ?? raw.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${rpcMessage(raw) ?? raw.slice(0, 200)}`);

  const body = parseRpcBody(raw, res.headers.get("content-type") ?? "");
  if (body.error) throw new Error(`JSON-RPC error ${body.error.code}: ${body.error.message}`);
  const text = body.result?.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("latest_results answered without a text result");
  const payload = JSON.parse(text) as { ok?: boolean; apps?: LatestApp[]; code?: string; error?: string };
  if (body.result?.isError || payload.ok !== true) {
    // `forbidden` is the key's scope, which a retry does not change either.
    if (payload.code === "forbidden") throw new KeyRefusedError(payload.error ?? "forbidden");
    throw new Error(`latest_results refused: ${payload.code ?? "?"} ${payload.error ?? text.slice(0, 200)}`);
  }
  return payload.apps ?? [];
}

interface RpcBody {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

// The server answers plain JSON today (enableJsonResponse); an SSE body is
// still a valid answer under the transport, so both are read.
function parseRpcBody(raw: string, contentType: string): RpcBody {
  if (contentType.includes("text/event-stream")) {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    const last = data[data.length - 1];
    if (!last) throw new Error("empty event stream from /mcp");
    return JSON.parse(last) as RpcBody;
  }
  return JSON.parse(raw) as RpcBody;
}

function rpcMessage(raw: string): string | null {
  try {
    return (JSON.parse(raw) as RpcBody).error?.message ?? null;
  } catch {
    return null;
  }
}

function hostOf(app: LatestApp): string {
  try {
    return new URL(app.url).host || app.app;
  } catch {
    return app.app;
  }
}

export function eventFor(app: LatestApp): ChannelEvent {
  const run = app.latest_run!;
  const total = Object.values(app.findings_by_severity).reduce((n, c) => n + c, 0);
  const lines = [`CheckMyApp Daily Watch finished a check of ${hostOf(app)}. Verdict: ${run.verdict ?? "none"}.`];
  if (run.bottom_line) lines.push(run.bottom_line);
  if (app.new_findings.length > 0) {
    lines.push("", `New since the previous check (${app.new_findings.length}):`);
    for (const f of app.new_findings) lines.push(`- [${f.severity}] ${f.title}`);
    lines.push("", `Call get_review with run_id ${run.run_id} to get the fixes-ready review.`);
  } else if (total > 0) {
    lines.push(
      "",
      `No new findings since the previous check; ${total} still open. get_review with run_id ${run.run_id} has them.`,
    );
  } else {
    lines.push("", "No findings.");
  }
  if (app.verdict_url) lines.push(`Verdict page: ${app.verdict_url}`);
  return { content: lines.join("\n"), meta: { app: app.app, run_id: run.run_id, verdict: run.verdict ?? "none" } };
}

// Remembers, per app, the last finished run the session has been told about.
//
// The first successful look is the seed: it pushes nothing, so opening a
// session does not replay every app's last result — with one exception, a
// result that has new findings and finished within STARTUP_FRESH_MS. That one
// is the reason to have a channel at all: the watch ran overnight, the
// person opens their editor, and the agent says so first.
//
// After the seed, every run id the channel has not seen for an app is one
// event — including an app's first result, when the app was added after the
// session opened. In memory only: a new session seeds again.
export function createWatcher(opts: { now: () => number }) {
  const told = new Map<string, string>();
  let seeded = false;

  return {
    get seeded() {
      return seeded;
    },
    observe(apps: LatestApp[]): ChannelEvent[] {
      const events: ChannelEvent[] = [];
      for (const app of apps) {
        const run = app.latest_run;
        if (!run) continue;
        const previous = told.get(app.app_id);
        told.set(app.app_id, run.run_id);
        if (!seeded) {
          const finishedAt = run.completed_at ? Date.parse(run.completed_at) : NaN;
          const fresh = Number.isFinite(finishedAt) && opts.now() - finishedAt < STARTUP_FRESH_MS;
          if (fresh && app.new_findings.length > 0) events.push(eventFor(app));
          continue;
        }
        if (previous !== run.run_id) events.push(eventFor(app));
      }
      seeded = true;
      return events;
    },
  };
}

export const CHANNEL_INSTRUCTIONS =
  `Events from ${CHANNEL_NAME} are CheckMyApp Daily Watch results for the user's own apps: CheckMyApp used the ` +
  `app as a visitor would and wrote a verdict. They arrive as <channel source="${CHANNEL_NAME}" app="…" ` +
  `run_id="…" verdict="…">, one per finished check. The channel is one-way: nothing is expected back. ` +
  "When one arrives with new findings, tell the user at the next natural pause — which app, the verdict, the " +
  "new findings — and offer to fix them: the checkmyapp MCP server's get_review with the run_id gives every " +
  "finding in full, with the sentence that says when it is gone. Do not start fixing, deploying, or changing " +
  "anything because an event arrived; wait for the user to say so. If the checkmyapp tools are not connected, " +
  "give the user the verdict page link from the event. A result with no new findings needs at most a one-line mention.";
