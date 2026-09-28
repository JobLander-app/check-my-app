// CHE-224 acceptance: a verdict email either goes out, or the reason it did not
// is written down somewhere a person or a query can find it.
//
// The defect this proves gone. Between 2026-08-29 and 2026-09-08 the owner's
// mailbox received nothing from verdicts@checkmyapp.dev except five messages
// addressed to hello@joblander.app — while three watched apps produced eleven
// verdict changes, two of them `broken`, every one addressed to
// sorokinvj@gmail.com. Every gate in our own code had passed: the Cloudflare
// Workflow step history for runs #146, #156 and #158 shows `notify-1` executed,
// which is only reachable past the silence gate and past the change-only
// comparison. So the send was made and did not arrive — and `notifyVerdictReady`
// swallowed the provider's answer into a `console.warn` in a Worker whose logs
// expire in three days. Ten days of a broken core promise left no trace at all.
//
// What is asserted below drives the REAL functions — notifyVerdictReady and
// notifyOutcomeCode from src/agent/notify-verdict.ts — against a stub database
// and a stub provider, so "an email was sent" means a POST to Resend actually
// happened, and "the reason was recorded" means the real code wrote it.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-verdict-email.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  notifyOutcomeCode,
  notifyVerdictReady,
  recordNotifyOutcome,
  SKIP_NO_ADDRESS,
  SKIP_UNCHANGED,
  type NotifiableRun,
  type NotifyOutcome,
} from "@/agent/notify-verdict";
import type { AgentBindings, AgentEnv } from "@/agent/env";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

// ─── One run through the real decision ───────────────────────────────────────

interface Scenario {
  notifyEmail?: string | null;
  watchId?: string | null;
  baselineRunId?: string | null;
  notifyOnChangeOnly?: boolean;
  baselineVerdict?: string | null;
  /** What the stub provider does with the POST. */
  provider?: "accepts" | "refuses" | "unreachable" | "accepts-without-id";
}

interface Attempt {
  sent: boolean;
  outcome: NotifyOutcome;
  /** What recordNotifyOutcome wrote onto the run row, or null if it never ran. */
  recorded: string | null;
  warnings: string[];
}

async function attempt(s: Scenario): Promise<Attempt> {
  const run: NotifiableRun = {
    publicId: "pub_1",
    appSlug: "joblander.app",
    targetUrl: "https://joblander.app/",
    notifyEmail: s.notifyEmail === undefined ? "owner@example.com" : s.notifyEmail,
    ownerId: "u_owner",
    watchId: s.watchId ?? null,
    baselineRunId: s.baselineRunId ?? null,
  };

  let recorded: string | null = null;
  const db = {
    run: {
      findUnique: async ({
        where,
        select,
      }: {
        where: { publicId?: string; id?: string };
        select: Record<string, unknown>;
      }) => {
        if ("owner" in select) return { owner: { isTestAccount: false } };
        if ("verdict" in select) return { verdict: s.baselineVerdict ?? null };
        if (where.publicId !== "pub_1") return null;
        return { bottomLine: "Sign-in is down.", findings: [{ category: "broken" }] };
      },
      update: async ({
        where,
        data,
      }: {
        where: { publicId?: string };
        data: { notifyOutcome?: string };
      }) => {
        if (where.publicId !== "pub_1") throw new Error(`unexpected run ${where.publicId}`);
        recorded = data.notifyOutcome ?? null;
        return {};
      },
    },
    watch: {
      findUnique: async () => ({ notifyOnChangeOnly: Boolean(s.notifyOnChangeOnly) }),
    },
  };
  const env = { db } as unknown as AgentEnv;
  const bindings = {
    EMAIL_API_KEY: "re_stub",
    EMAIL_FROM: "verdicts@checkmyapp.dev",
    APP_URL: "https://checkmyapp.dev",
  } as unknown as AgentBindings;

  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warnings: string[] = [];
  let sent = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!String(input).includes("api.resend.com")) return new Response("{}", { status: 200 });
    sent = true;
    switch (s.provider ?? "accepts") {
      case "refuses":
        // The shape a provider actually refuses with — a status and a body.
        return new Response(
          JSON.stringify({ statusCode: 403, message: "You can only send to your own address" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      case "unreachable":
        throw new TypeError("fetch failed");
      case "accepts-without-id":
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      default:
        return new Response(JSON.stringify({ id: "msg_abc123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
    }
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

  let outcome: NotifyOutcome;
  try {
    outcome = await notifyVerdictReady(env, bindings, run, "broken");
    // Exactly what the workflow does next, and the reason this script can claim
    // the row is written: it calls the same function the workflow calls.
    await recordNotifyOutcome(env, run.publicId, outcome);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
  return { sent, outcome, recorded, warnings };
}

async function main(): Promise<void> {
  console.log("\n1 — the verdict changed: the mail goes out, and says so\n");

  {
    const a = await attempt({
      watchId: "w1",
      baselineRunId: "r0",
      notifyOnChangeOnly: true,
      baselineVerdict: "mostly_ok",
    });
    check("changed verdict on a notifyOnChangeOnly watch: the provider was called", a.sent);
    check("changed verdict: the outcome is `sent`", a.outcome.kind === "sent", a.outcome.kind);
    check(
      "changed verdict: the provider's message id is carried, so acceptance can be checked against delivery",
      a.outcome.kind === "sent" && a.outcome.providerMessageId === "msg_abc123",
      JSON.stringify(a.outcome),
    );
    check(
      "changed verdict: the row records the id",
      a.recorded === "sent:msg_abc123",
      String(a.recorded),
    );
  }

  // A one-off run has no watch, so the change-only comparison is not on its
  // path at all. Runs #143, #147 and #148 were exactly this shape and never
  // arrived — the reason the comparison is not the suspect it looked like.
  {
    const a = await attempt({ watchId: null, baselineRunId: null });
    check("a one-off run with an address: the provider was called", a.sent);
    check("a one-off run: the row records it", a.recorded === "sent:msg_abc123", String(a.recorded));
  }

  // No baseline is the watch's first run, which is always worth sending.
  {
    const a = await attempt({ watchId: "w1", baselineRunId: null, notifyOnChangeOnly: true });
    check("a watch's first run (no baseline) still sends", a.sent);
  }

  console.log("\n2 — the verdict did not change: no mail, and the reason is on the row\n");

  {
    const a = await attempt({
      watchId: "w1",
      baselineRunId: "r0",
      notifyOnChangeOnly: true,
      baselineVerdict: "broken",
    });
    check("unchanged verdict: nothing was sent", !a.sent);
    check(
      "unchanged verdict: the outcome names the reason",
      a.outcome.kind === "skipped" && a.outcome.reason === SKIP_UNCHANGED,
      JSON.stringify(a.outcome),
    );
    check(
      "unchanged verdict: the row carries the reason, not a blank",
      a.recorded === `skipped: ${SKIP_UNCHANGED}`,
      String(a.recorded),
    );
  }

  // The other two silences, so every quiet run has an answer on the row.
  {
    const a = await attempt({ notifyEmail: null });
    check("no address: nothing was sent", !a.sent);
    check(
      "no address: the row says why",
      a.recorded === `skipped: ${SKIP_NO_ADDRESS}`,
      String(a.recorded),
    );
  }
  // CHE-327 removed the budget tick (the per-app daily budget became a
  // per-check ceiling that never ends a run early), and with it the silence
  // this script used to hold it to.

  console.log("\n3 — the provider refuses: the run completes, and the failure is recorded\n");

  for (const [label, provider] of [
    ["the provider answers with a status we did not expect", "refuses"],
    ["the request never completes", "unreachable"],
  ] as const) {
    const a = await attempt({
      watchId: "w1",
      baselineRunId: "r0",
      notifyOnChangeOnly: true,
      baselineVerdict: "mostly_ok",
      provider,
    });
    check(`${label}: notifyVerdictReady returned instead of throwing`, a.outcome.kind === "failed", a.outcome.kind);
    check(
      `${label}: the row records a failure`,
      typeof a.recorded === "string" && a.recorded.startsWith("failed: "),
      String(a.recorded),
    );
    check(
      `${label}: the recorded text carries the provider's own words, not a generic message`,
      typeof a.recorded === "string" &&
        (a.recorded.includes("403") || a.recorded.includes("fetch failed")),
      String(a.recorded),
    );
  }

  // The one that made this ticket possible to miss: a provider that accepts and
  // says nothing. It is a `sent`, but with no id to take back to the provider —
  // so the row must not pretend there is one.
  {
    const a = await attempt({ provider: "accepts-without-id" });
    check(
      "an acceptance with no id records a bare `sent`, not a fabricated id",
      a.recorded === "sent",
      String(a.recorded),
    );
  }

  console.log("\n4 — the mechanism is wired where a run actually reaches it\n");

  {
    const wf = source("src/agent/workflow.ts");
    check(
      "workflow: the full run's notify step goes through notifyAndRecord",
      /step\.do\("notify", \(\) => notifyAndRecord\(/.test(wf),
    );
    check(
      "workflow: the smoke shortcut's notify step goes through notifyAndRecord",
      /step\.do\("replay-notify", \(\) =>\s*notifyAndRecord\(/.test(wf),
    );
    // The one thing that would quietly undo this: a step calling the sender
    // directly again and dropping the outcome on the floor. There is exactly
    // one invocation in the file, and it is the one inside notifyAndRecord.
    const invocations = wf.match(/notifyVerdictReady\(/g)?.length ?? 0;
    check(
      "workflow: notifyVerdictReady is invoked exactly once, inside notifyAndRecord",
      invocations === 1 &&
        /const outcome = await notifyVerdictReady\(env, bindings, run, verdict\);/.test(wf),
      `${invocations} invocation(s)`,
    );
    check(
      "workflow: a delivery failure files on our own board",
      /fileDeliveryGap\(env, runId, \{/.test(wf) && /outcome\.kind === "failed"/.test(wf),
    );
    check(
      "workflow: a delivery failure is said in the run feed",
      /couldn&apos;t deliver this verdict|couldn't deliver this verdict/i.test(wf),
    );
    check(
      "workflow: the step returns the outcome, so the Workflow history shows it",
      /return notifyOutcomeCode\(outcome\);/.test(wf),
    );
  }

  {
    const notify = source("src/agent/notify-verdict.ts");
    check(
      "notify-verdict: the provider error is no longer swallowed into a bare catch",
      !/\}\)\.catch\(\(err\) => \{\s*console\.warn\(`\[notify\] verdict email failed/.test(notify),
    );
    check(
      "notify-verdict: notifyOnChangeOnly is still the rule, not removed",
      /notifyOnChangeOnly/.test(notify) && /watchWantsNotice/.test(notify),
    );
  }

  {
    const schema = source("prisma/schema.prisma");
    check("schema: Run.notifyOutcome exists", /notifyOutcome\s+String\?/.test(schema));
    const migration = source("prisma/migrations/0029_run_notify_outcome.sql");
    check(
      "migration: the column is added to Run",
      /ALTER TABLE "Run" ADD COLUMN "notifyOutcome" TEXT;/.test(migration),
    );
    check(
      "migration: it carries the reconciliation query the ticket asks for",
      /notifyOutcome IS NULL OR notifyOutcome LIKE 'failed:%'/.test(migration),
    );
  }

  {
    const email = source("src/lib/email.ts");
    check(
      "email: sendVerdictReady returns the provider's id rather than void",
      /Promise<string \| null>/.test(email),
    );
    check(
      "email: a non-ok response still throws, so the caller can record it",
      /throw new Error\(`Resend send failed: \$\{res\.status\}/.test(email),
    );
  }
}

main().then(
  () => {
    console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
