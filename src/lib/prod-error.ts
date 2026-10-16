// CHE-486 part 3: an error in production is what wakes the loop (owner,
// 2026-10-15: «главное чтобы не было кронов, а триггерами монитора были ошибки
// в проде»). The monitor worker (src/monitor/index.ts) is a Tail Worker on the
// web and agent workers: every invocation that threw, ran out of CPU or memory,
// or answered 5xx reaches it as it happens. This module turns those events
// into reports, one per signature, and decides what a repeat of a known one is
// owed. Pure: no I/O, so scripts/verify-prod-errors.ts runs the real rules.
//
// One signature, one ticket. A signature is what stays the same between two
// occurrences of the same defect and differs between two defects: the worker,
// the error's name, its message with every id, number, quoted value and URL
// query taken out, and the function it was thrown from — never a line number,
// which every deploy moves.

/** What a tail event looks like, as much of it as this module reads (workers-types TraceItem). */
export interface TraceLike {
  scriptName: string | null;
  outcome: string;
  eventTimestamp: number | null;
  exceptions: { name: string; message: string; stack?: string; timestamp?: number }[];
  logs: { level: string; message: unknown[] }[];
  event: unknown;
}

export interface ProdErrorReport {
  signature: string;
  script: string;
  name: string;
  /** Normalised: no ids, numbers, quoted values or URL queries — safe to publish on our board. */
  message: string;
  /** The function it was thrown from, if the stack names one. */
  frame: string | null;
  /** The request path, ids taken out. Null outside a fetch. */
  path: string | null;
  /** Occurrences in this batch. */
  count: number;
  /** When it last happened in this batch (the tail event's time). */
  at: number;
}

/** The monitor never reports itself: its own failure would report itself forever. */
export const MONITOR_SCRIPT = "checkmyapp-monitor";

// Invocations that ended badly without an exception object. "canceled" is the
// client going away; "ok" with a 5xx is handled below.
const BAD_OUTCOMES = new Set(["exception", "exceededCpu", "exceededMemory", "exceededWallTime", "scriptNotFound"]);

const PLACEHOLDER = "#";

export function normalizeMessage(message: string): string {
  return String(message ?? "")
    .replace(/https?:\/\/[^\s"'<>)]+/g, (u) => {
      try {
        const url = new URL(u);
        return `${url.origin}${normalizePath(url.pathname)}`;
      } catch {
        return `${PLACEHOLDER}url`;
      }
    })
    // Any length, and escaped quotes inside count as inside: a long quoted value
    // or a serialised object is customer data all the same (Codex, #360). A
    // stray escaped quote left after that is the start of one too.
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, `"${PLACEHOLDER}"`)
    .replace(/\\["'`][^\s]*/g, `"${PLACEHOLDER}"`)
    // A person's address or a credential is never part of a signature, and the
    // message goes on our board: emails, then anything token-shaped.
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, `${PLACEHOLDER}@${PLACEHOLDER}`)
    // Whatever follows a credential's name, and any long opaque run even with no
    // digit in it (Codex, #358): an error name is shorter than 32 characters.
    .replace(/\b(bearer|basic|token|secret|password|passwd|api[_-]?key|authorization|cookie|session)\b(\s*[:=]\s*|\s+)[^\s,;]+/gi, `$1$2${PLACEHOLDER}`)
    .replace(/(?<![\w+/=-])[A-Za-z0-9_+/=-]{32,}(?![\w+/=-])/g, PLACEHOLDER)
    .replace(/\b(?=[\w-]*\d)[A-Za-z0-9_-]{20,}\b/g, PLACEHOLDER)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, PLACEHOLDER)
    .replace(/\bc[a-z0-9]{20,}\b/g, PLACEHOLDER)
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{10,}\b/gi, PLACEHOLDER)
    .replace(/\d+/g, PLACEHOLDER)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** A path with every segment that carries a digit or an id replaced: /run/cmv6… → /run/#. */
export function normalizePath(path: string): string {
  return path
    .split("/")
    .map((seg) => (/\d/.test(seg) || seg.length > 24 ? PLACEHOLDER : seg))
    .join("/");
}

/** The function the error was thrown from: the first named frame of the stack. */
export function frameOf(stack: string | undefined): string | null {
  for (const line of String(stack ?? "").split("\n").slice(1)) {
    const m = line.match(/^\s*at\s+(?:async\s+)?([\w$.<>\[\] ]+?)\s+\(/);
    if (m && !/^(?:new )?Promise|^Object\.<anonymous>$/.test(m[1])) return m[1].trim();
  }
  return null;
}

function fetchOf(event: unknown): { path: string | null; status: number | null; method: string | null } {
  const e = event as { request?: { url?: string; method?: string }; response?: { status?: number } } | null;
  if (!e?.request?.url) return { path: null, status: null, method: null };
  let path: string | null = null;
  try {
    path = normalizePath(new URL(e.request.url).pathname);
  } catch {
    path = null;
  }
  return { path, status: typeof e.response?.status === "number" ? e.response.status : null, method: e.request.method ?? null };
}

function firstErrorLog(logs: TraceLike["logs"]): string | null {
  const line = logs.find((l) => l.level === "error");
  if (!line) return null;
  return line.message.map((m) => (typeof m === "string" ? m : m instanceof Error ? m.message : JSON.stringify(m))).join(" ");
}

/**
 * The reports in one batch of tail events, one per signature with its count.
 * An exception is a report; so is an invocation that ended badly without one,
 * and a fetch our worker answered with 5xx — a server-rendered page that
 * crashed is caught by the framework and only shows as the status (and the
 * error it logged, which then names the report).
 */
export function reportsFrom(events: TraceLike[]): ProdErrorReport[] {
  const out = new Map<string, ProdErrorReport>();
  const add = (script: string, name: string, rawMessage: string, stack: string | undefined, path: string | null, at: number) => {
    const message = normalizeMessage(rawMessage);
    const frame = frameOf(stack);
    const signature = [script, name, message, frame ?? ""].join(" | ");
    const known = out.get(signature);
    if (known) {
      known.count++;
      // The latest occurrence: if any came after a deploy, the watch must see it (Codex, #360).
      known.at = Math.max(known.at, at);
    } else out.set(signature, { signature, script, name, message, frame, path, count: 1, at });
  };
  for (const e of events) {
    const script = e.scriptName ?? "unknown";
    if (script === MONITOR_SCRIPT) continue;
    const at = e.eventTimestamp ?? Date.now();
    const { path, status, method } = fetchOf(e.event);
    if (e.exceptions.length) {
      for (const x of e.exceptions) add(script, x.name || "Error", x.message, x.stack, path, at);
      continue;
    }
    if (BAD_OUTCOMES.has(e.outcome)) {
      add(script, e.outcome, firstErrorLog(e.logs) ?? `the invocation ended: ${e.outcome}`, undefined, path, at);
      continue;
    }
    if (status !== null && status >= 500) {
      add(script, `HTTP ${status}`, firstErrorLog(e.logs) ?? `${method ?? "GET"} ${path ?? "/"} answered ${status}`, undefined, path, at);
    }
  }
  return [...out.values()];
}

/** How often an open ticket hears that its error is still happening. */
export const TELL_EVERY_MS = 60 * 60 * 1000;

/**
 * What a report of a known signature is owed.
 *   "file" — no ticket yet: open one (and wake Mender).
 *   "count" — counted in our own table only: ruled not-a-bug, or told (or being
 *             filed by another invocation) within the hour.
 *   "tell" — ask the ticket: still open → a comment; Done and back → a recurrence
 *            ticket; Canceled → settled, never filed again; gone → a new ticket.
 * lastToldAt is also the claim on the signature (prod-errors.ts), so it is read
 * before the ticket: a signature claimed for filing is not filed twice.
 */
export function prodErrorAction(
  row: { issueIdentifier: string | null; lastToldAt: Date | null; settled: boolean },
  now: Date,
): "file" | "count" | "tell" {
  if (row.settled) return "count";
  if (row.lastToldAt && now.getTime() - row.lastToldAt.getTime() < TELL_EVERY_MS) return "count";
  if (!row.issueIdentifier) return "file";
  return "tell";
}
