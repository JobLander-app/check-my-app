// CHE-486 part 3: an error in production is what wakes the loop — owner,
// 2026-10-15: «главное чтобы не было кронов, а триггерами монитора были ошибки в
// проде». What must hold, on the real code and real event shapes:
//   1. one signature per defect: ids, numbers, quoted values, emails, tokens,
//      URL queries and line numbers never split it, and never reach the board;
//   2. the tail events that went wrong become reports — an exception, an
//      invocation out of CPU or memory, a 5xx answer — and nothing else does;
//      the monitor never reports itself;
//   3. a new signature is filed for Mender and wakes it; a repeat within the
//      hour costs nothing; an open ticket hears of it hourly; back after Done is
//      a recurrence; Canceled is settled; a failing tracker throws nothing;
//   4. recording-only unless PROD_ERROR_FILING is "on" — and in production it is
//      on, so an error is the trigger;
//   5. the wiring: both workers tail into the monitor, the monitor hands off to
//      the agent's ProdErrorIntake, CI deploys the monitor first.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-prod-errors.ts

import { readFileSync } from "node:fs";
import { frameOf, normalizeMessage, prodErrorAction, reportsFrom, MONITOR_SCRIPT, TELL_EVERY_MS, type TraceLike } from "../src/lib/prod-error";
import { intakeProdErrors, PROD_ERROR_LABEL } from "../src/agent/prod-errors";
import type { GapBoard } from "../src/agent/capability-gaps";
import type { IssueOutcome, TicketDraft } from "../src/lib/tracker/types";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
};

const exception = (message: string, line = 1234, script = "checkmyapp-web", name = "TypeError"): TraceLike => ({
  scriptName: script, outcome: "exception", eventTimestamp: 1, logs: [],
  exceptions: [{ name, message, stack: `${name}: ${message}\n    at loadVerdict (index.js:${line}:17)\n    at async Object.fetch (index.js:9:3)` }],
  event: { request: { url: "https://checkmyapp.dev/verdict/cmv6s6psu00030b1ow5wcjn4s?x=1", method: "GET" }, response: { status: 500 } },
});

async function main() {
  // 1 — signatures.
  const a = normalizeMessage('Cannot read properties of undefined (reading "cmv6s6psu00030b1ow5wcjn4s") for run 395 at https://checkmyapp.dev/run/cmv6ynouj0003ys1r8h5af1cg?t=9');
  const b = normalizeMessage('Cannot read properties of undefined (reading "cmuvtk34a0002ue1tf94hw9pt") for run 401 at https://checkmyapp.dev/run/cmuxyz0000000000000000000?t=2');
  check("ids, numbers, quoted values and URL queries never split a signature", a === b, `${a} | ${b}`);
  // Unmistakably synthetic, shaped only like what the normaliser must catch: a
  // long run of letters and digits (Codex, #358: no real provider prefix here).
  const secret = normalizeMessage("Login failed for someone@example.test with token FAKEtoken0000notakey0000FAKE and jwt FAKEjwt0000notajwt0000");
  check("…and an email or a token never reaches the board", !/example\.test|someone|FAKE|notakey|notajwt/.test(secret), secret);
  // Codex, #358: a credential with no digit in it.
  const alpha = normalizeMessage("Upstream said: Bearer FAKEabcdefFAKEghijkl and apikey=FAKEonlylettersFAKE then FAKEopaqueFAKEopaqueFAKEopaqueFAKEopaque");
  check("…nor one with no digit in it: after its name, or long and opaque", !/FAKE/.test(alpha) && /Bearer #/.test(alpha), alpha);
  check("…while an error's own name survives", normalizeMessage("PrismaClientKnownRequestError: query failed") === "PrismaClientKnownRequestError: query failed");
  check("the frame is the function, never its line", frameOf("E\n    at loadVerdict (index.js:1:2)") === "loadVerdict" && frameOf("E\n    at async handle (x.js:9:9)") === "handle");
  const [r1] = reportsFrom([exception("boom 1", 1234)]);
  const [r2] = reportsFrom([exception("boom 2", 9876)]);
  check("a deploy that moves line numbers keeps the signature", r1.signature === r2.signature, `${r1.signature} | ${r2.signature}`);
  check("…and the request path keeps no id", r1.path === "/verdict/#", String(r1.path));

  // 2 — what counts.
  const ok: TraceLike = { scriptName: "checkmyapp-web", outcome: "ok", eventTimestamp: 1, logs: [], exceptions: [], event: { request: { url: "https://checkmyapp.dev/", method: "GET" }, response: { status: 200 } } };
  const canceled: TraceLike = { ...ok, outcome: "canceled" };
  const page500: TraceLike = { ...ok, event: { request: { url: "https://checkmyapp.dev/health/apps/cm123abc456def7890xyz", method: "GET" }, response: { status: 500 } },
    logs: [{ level: "error", message: ["Error: prisma query failed for app cm123abc456def7890xyz"] }] };
  const cpu: TraceLike = { ...ok, scriptName: "checkmyapp-agent", outcome: "exceededCpu", event: null };
  const self: TraceLike = { ...exception("monitor broke"), scriptName: MONITOR_SCRIPT };
  const reports = reportsFrom([ok, canceled, page500, cpu, self, exception("x"), exception("x")]);
  const names = reports.map((r) => `${r.script}/${r.name}×${r.count}`).sort().join(", ");
  check("an exception, a 5xx page and an exhausted CPU are reports; ok, canceled and the monitor itself are not; a batch counts repeats",
    names === "checkmyapp-agent/exceededCpu×1, checkmyapp-web/HTTP 500×1, checkmyapp-web/TypeError×2", names);
  const p500 = reports.find((r) => r.name === "HTTP 500");
  check("a 5xx page is named by the error it logged, normalised", p500?.message === "Error: prisma query failed for app #" && p500.path === "/health/apps/#", `${p500?.message} @ ${p500?.path}`);

  // 3 — the action table.
  const now = new Date("2026-10-16T12:00:00Z");
  const row = (o: Partial<{ issueIdentifier: string | null; lastToldAt: Date | null; settled: boolean }>) =>
    ({ issueIdentifier: null, lastToldAt: null, settled: false, ...o });
  check("new → file; told within the hour → count; later → tell; settled → count",
    prodErrorAction(row({}), now) === "file" &&
      prodErrorAction(row({ issueIdentifier: "CHE-1", lastToldAt: new Date(now.getTime() - 60_000) }), now) === "count" &&
      prodErrorAction(row({ issueIdentifier: "CHE-1", lastToldAt: new Date(now.getTime() - TELL_EVERY_MS - 1) }), now) === "tell" &&
      prodErrorAction(row({ issueIdentifier: "CHE-1", settled: true }), now) === "count");

  // 3/4 — the intake, on a fake table and a fake board.
  type Row = { signature: string; count: number; firstSeenAt: Date; lastSeenAt: Date; issueIdentifier: string | null; lastToldAt: Date | null; settled: boolean };
  const table = new Map<string, Row>();
  const db = {
    prodError: {
      async upsert(args: { where: { signature: string }; create: Row; update: { count: { increment: number } } }) {
        const known = table.get(args.where.signature);
        const next = known ? { ...known, count: known.count + args.update.count.increment } : { ...args.create, issueIdentifier: null, lastToldAt: null, settled: false };
        table.set(args.where.signature, next);
        return next;
      },
      async update(args: { where: { signature: string }; data: Partial<Row> }) {
        table.set(args.where.signature, { ...table.get(args.where.signature)!, ...args.data });
      },
      // One statement, so atomic: the swap lands only on the value it names.
      async updateMany(args: { where: { signature: string; lastToldAt: Date | null }; data: Partial<Row> }) {
        const known = table.get(args.where.signature);
        if (!known || (known.lastToldAt?.getTime() ?? null) !== (args.where.lastToldAt?.getTime() ?? null)) return { count: 0 };
        table.set(args.where.signature, { ...known, ...args.data });
        return { count: 1 };
      },
    },
  };
  const created: TicketDraft[] = [];
  const comments: string[] = [];
  let outcome: IssueOutcome = "open";
  let trackerDown = false;
  const board = {
    tracker: {
      async createIssue(d: TicketDraft) { if (trackerDown) throw new Error("Linear 500"); created.push(d); return { id: `i${created.length}`, identifier: `CHE-${900 + created.length}`, url: "u" }; },
      async addComment(_id: string, body: string) { comments.push(body); },
      async addLabel() {},
      async getIssueOutcome() { return outcome; },
    },
  } as unknown as GapBoard;
  const dispatched: string[] = [];
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    dispatched.push(String(url));
    bodies.push(String(init?.body ?? ""));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const env = (filing?: string) => ({ db, bindings: { PROD_ERROR_FILING: filing, MENDER_DISPATCH_TOKEN: "t" } as never });
  const [report] = reportsFrom([exception("x")]);

  const recorded = await intakeProdErrors(env(undefined), [report], { board, now });
  check("recording only, unless PROD_ERROR_FILING is \"on\": counted, nothing filed, nobody woken",
    recorded.filed.length === 0 && created.length === 0 && dispatched.length === 0 && table.get(report.signature)?.count === 1,
    `count ${table.get(report.signature)?.count}`);

  const first = await intakeProdErrors(env("on"), [report], { board, now });
  check("a new signature is one ticket for Mender, and Mender is woken",
    first.filed.length === 1 && created[0]?.labelNames.includes("mender") && created[0].labelNames.includes(PROD_ERROR_LABEL) &&
      created[0].title.startsWith("[Prod error] checkmyapp-web: TypeError:") && dispatched.length === 1, JSON.stringify(created[0]?.title));
  // CHE-486 part 4: through the watch, which judges the last deploy and wakes Mender itself.
  check("…through the watch, with the ticket and the time it was seen",
    dispatched[0]?.endsWith("/actions/workflows/mender-watch.yml/dispatches") &&
      JSON.stringify(JSON.parse(bodies[0] ?? "{}").inputs) === JSON.stringify({ watch: first.filed[0], seen: now.toISOString() }), `${dispatched[0]} ${bodies[0]}`);
  await intakeProdErrors(env("on"), [report], { board, now: new Date(now.getTime() + 60_000) });
  check("a repeat within the hour costs nothing: no ticket, no comment, nobody woken", created.length === 1 && comments.length === 0 && dispatched.length === 1);
  await intakeProdErrors(env("on"), [report], { board, now: new Date(now.getTime() + TELL_EVERY_MS + 1) });
  check("…an hour on, the open ticket hears it is still happening", created.length === 1 && comments.length === 1 && /Still happening/.test(comments[0] ?? ""));
  outcome = "done";
  await intakeProdErrors(env("on"), [report], { board, now: new Date(now.getTime() + 3 * TELL_EVERY_MS) });
  check("back after Done is a recurrence ticket naming the old one, Urgent, and Mender is woken again",
    created.length === 2 && created[1].title.startsWith("[Prod error · recurrence]") && created[1].description.includes("CHE-901") && created[1].priority === 1 && dispatched.length === 2,
    created[1]?.title);
  outcome = "canceled";
  await intakeProdErrors(env("on"), [report], { board, now: new Date(now.getTime() + 5 * TELL_EVERY_MS) });
  await intakeProdErrors(env("on"), [report], { board, now: new Date(now.getTime() + 7 * TELL_EVERY_MS) });
  check("a Canceled ticket settles the signature: never filed again", created.length === 2 && table.get(report.signature)?.settled === true);
  // Codex, #358: tail invocations overlap. Two at once with a new signature
  // open one ticket and wake Mender once.
  const [twin] = reportsFrom([exception("z", 1, "checkmyapp-web", "SyntaxError")]);
  const before = { created: created.length, dispatched: dispatched.length };
  await Promise.all([intakeProdErrors(env("on"), [twin], { board, now }), intakeProdErrors(env("on"), [twin], { board, now })]);
  check("two invocations at once with a new signature open one ticket, and wake Mender once",
    created.length === before.created + 1 && dispatched.length === before.dispatched + 1 && table.get(twin.signature)?.count === 2,
    `${created.length - before.created} ticket(s), ${dispatched.length - before.dispatched} wake(s)`);
  trackerDown = true;
  const [other] = reportsFrom([exception("y", 1, "checkmyapp-agent", "RangeError")]);
  let threw = false;
  try { await intakeProdErrors(env("on"), [other], { board, now }); } catch { threw = true; }
  check("a tracker that fails throws nothing (the monitor would report the throw back)", !threw);
  trackerDown = false;
  await intakeProdErrors(env("on"), [other], { board, now: new Date(now.getTime() + 60_000) });
  check("…and lets its claim go: the next report files it, without waiting out the hour",
    created.some((d) => d.title.includes("checkmyapp-agent: RangeError")));
  // Codex, #358: the ticket exists but recording it hiccups once — it is retried, and Mender is woken.
  const [third] = reportsFrom([exception("w", 1, "checkmyapp-web", "URIError")]);
  const realUpdate = db.prodError.update;
  let hiccups = 1;
  db.prodError.update = async (args) => { if ("issueIdentifier" in args.data && hiccups-- > 0) throw new Error("D1 hiccup"); return realUpdate(args); };
  const wakesBefore = dispatched.length;
  const hiccup = await intakeProdErrors(env("on"), [third], { board, now });
  db.prodError.update = realUpdate;
  check("a ticket whose record hiccups once is recorded on the retry, and Mender is woken for it",
    hiccup.filed.length === 1 && table.get(third.signature)?.issueIdentifier === hiccup.filed[0] && dispatched.length === wakesBefore + 1,
    `${hiccup.filed} / ${table.get(third.signature)?.issueIdentifier}`);
  check("the ticket carries no raw message", !created.some((d) => /cmv6s6psu|otp\.plus/.test(d.description + d.title)));
  globalThis.fetch = realFetch;

  // 5 — wiring.
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  check("both workers tail into the monitor",
    /"tail_consumers": \[\{ "service": "checkmyapp-monitor" \}\]/.test(read("wrangler.jsonc")) &&
      /"tail_consumers": \[\{ "service": "checkmyapp-monitor" \}\]/.test(read("wrangler-agent.jsonc")));
  const monitor = read("wrangler-monitor.jsonc");
  check("the monitor hands off to the agent's ProdErrorIntake, has no cron and no database",
    /"name": "checkmyapp-monitor"/.test(monitor) && /"entrypoint": "ProdErrorIntake"/.test(monitor) && !/crons|d1_databases/.test(monitor) &&
      /export \{ ProdErrorIntake \} from "\.\/prod-error-intake";/.test(read("src/agent/index.ts")));
  check("in production an error files its ticket: the loop's trigger is on", /"PROD_ERROR_FILING": "on"/.test(read("wrangler-agent.jsonc")));
  check("CI deploys the monitor before the workers that name it",
    /run: npx wrangler deploy --config wrangler-monitor\.jsonc && npx wrangler deploy --config wrangler-agent\.jsonc/.test(read(".github/workflows/ci.yml")));

  console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
