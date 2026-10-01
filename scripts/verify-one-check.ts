// Launch verification: a $1 one-off check produces exactly one run, and only
// once it is paid for.
//
// Two starters can race on one payment — the Stripe webhook and the success
// page's poll — and D1 has no transactions. The unique Run.paidCheckoutSessionId
// is the lock; the loser reads the winner's run. Four things must hold, and
// all four are exercised here through the real startPaidCheck / paidCheckState
// against a stub Prisma and a stub Stripe — no database, no network, no money:
//   1. the first start creates one run from the parked input, carrying the
//      session id, the anonymous key and the decrypted-then-re-encrypted
//      password; the parked password is cleared afterwards;
//   2. a second start on the same payment returns the same run and creates
//      nothing — whether the pending row already records the run, or a
//      concurrent insert beat ours and the unique constraint fired;
//   3. a session Stripe reports as anything but paid starts nothing, and the
//      success page's state is "pending";
//   4. a session that is paid starts the run from the poll alone, without the
//      webhook, and reports "started" with the run's public id;
//   5. the janitor's sweep deletes only pending checks that are past expiry
//      AND never got a run — a paid one is the payment's record and stays;
//   6. the buyer is sent Stripe's receipt, once, to the email typed into
//      Checkout — set on the charge by the webhook, since an anonymous buyer's
//      address is unknown when the session is created.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-one-check.ts

process.env.CREDENTIALS_SECRET ??= "verify-one-check-secret";

import { readFileSync } from "node:fs";
import type { PrismaClient } from "@/generated/prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { isPaidOneCheck, paidCheckState, sendPaidCheckReceipt, startPaidCheck } from "@/lib/one-check";
import { sweepExpiredPendingChecks } from "@/agent/janitor";
import type { AgentEnv } from "@/agent/env";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

type PendingRow = {
  id: string;
  targetUrl: string;
  testEmail: string | null;
  testPasswordEnc: string | null;
  // CHE-372
  storePasswordEnc: string | null;
  userNotes: string | null;
  notifyEmail: string | null;
  anonKeyHash: string | null;
  checkoutSessionId: string | null;
  runId: string | null;
};
type RunRow = Record<string, unknown> & { id: string; publicId: string; paidCheckoutSessionId: string | null };

// The slice of Prisma the paid start touches. `beforeCreate` lets a test slip
// a competing insert in between the read and the write, the way a webhook
// delivery would land during the poll.
function stubDb(pending: PendingRow, opts: { beforeCreate?: () => void } = {}) {
  const runs: RunRow[] = [];
  let counter = 0;
  const creates: RunRow[] = [];
  const db = {
    pendingCheck: {
      findUnique: async ({ where }: { where: { id?: string; checkoutSessionId?: string } }) =>
        (where.id && pending.id === where.id) ||
        (where.checkoutSessionId && pending.checkoutSessionId === where.checkoutSessionId)
          ? { ...pending }
          : null,
      update: async ({ data }: { data: Partial<PendingRow> }) => {
        Object.assign(pending, data);
        return { ...pending };
      },
    },
    run: {
      findUnique: async ({ where }: { where: { id?: string; paidCheckoutSessionId?: string; runNumber?: number } }) =>
        runs.find(
          (r) =>
            (where.id && r.id === where.id) ||
            (where.paidCheckoutSessionId && r.paidCheckoutSessionId === where.paidCheckoutSessionId) ||
            (where.runNumber !== undefined && r.runNumber === where.runNumber),
        ) ?? null,
      findFirst: async () => runs[runs.length - 1] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        opts.beforeCreate?.();
        if (data.paidCheckoutSessionId && runs.some((r) => r.paidCheckoutSessionId === data.paidCheckoutSessionId)) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`paidCheckoutSessionId`)"), {
            code: "P2002",
          });
        }
        const row: RunRow = { ...data, id: `run_${runs.length + 1}`, publicId: `pub_${runs.length + 1}` } as RunRow;
        runs.push(row);
        creates.push(row);
        return { id: row.id, publicId: row.publicId };
      },
    },
    counter: {
      upsert: async () => ({ name: "runNumber", value: ++counter }),
    },
  };
  return { db: db as unknown as PrismaClient, runs, creates, insert: (row: RunRow) => runs.push(row) };
}

function pendingRow(over: Partial<PendingRow> = {}): PendingRow {
  return {
    id: "pc_1",
    targetUrl: "https://target.test/",
    testEmail: "qa@target.test",
    testPasswordEnc: encryptSecret("hunter2"),
    storePasswordEnc: encryptSecret("storefront-pw"),
    userNotes: "do not delete the account",
    notifyEmail: "owner@target.test",
    anonKeyHash: "anon-hash",
    checkoutSessionId: "cs_test_1",
    runId: null,
    ...over,
  };
}

function stubStripe(session: { mode: string; payment_status: string; metadata: Record<string, string> | null }) {
  let retrieves = 0;
  return {
    stripe: { checkout: { sessions: { retrieve: async () => (retrieves++, session) } } } as never,
    retrieves: () => retrieves,
  };
}

async function main() {
  // 1 — the first start creates one run from the parked input.
  {
    const pending = pendingRow();
    const parkedStore = pending.storePasswordEnc;
    const triggered: string[] = [];
    const { db, runs } = stubDb(pending);
    const run = await startPaidCheck(db, "pc_1", "cs_test_1", { trigger: async (id) => void triggered.push(id) });
    check("start: one run created", runs.length === 1 && run?.id === "run_1", `${runs.length} runs`);
    const row = runs[0];
    check("start: the run carries the session id, no owner, the anonymous key",
      row.paidCheckoutSessionId === "cs_test_1" && row.ownerId === null && row.anonKeyHash === "anon-hash");
    check("start: parked input lands on the run",
      row.targetUrl === "https://target.test/" && row.appSlug === "target.test" && row.testEmail === "qa@target.test" &&
        row.userNotes === "do not delete the account" && row.notifyEmail === "owner@target.test" && row.status === "queued",
      JSON.stringify({ url: row.targetUrl, slug: row.appSlug }));
    check("start: the password is re-encrypted for the run, not copied as the parked blob",
      typeof row.testPasswordEnc === "string" && row.testPasswordEnc !== pending.testPasswordEnc &&
        decryptSecret(row.testPasswordEnc as string) === "hunter2");
    check("start: the agent is handed exactly this run", triggered.length === 1 && triggered[0] === "run_1", triggered.join());
    check("start: the pending row records the run and drops the password",
      pending.runId === "run_1" && pending.testPasswordEnc === null, `${pending.runId}/${pending.testPasswordEnc}`);
    check("start (CHE-372): the store password lands on the run re-encrypted, and leaves the pending row",
      typeof row.storePasswordEnc === "string" && row.storePasswordEnc !== parkedStore &&
        decryptSecret(row.storePasswordEnc as string) === "storefront-pw" && pending.storePasswordEnc === null,
      `${String(row.storePasswordEnc).slice(0, 12)}/${pending.storePasswordEnc}`);

    // 2a — a second start on the same payment: same run, no second insert.
    const again = await startPaidCheck(db, "pc_1", "cs_test_1", { trigger: async () => void triggered.push("again") });
    check("repeat: the second start returns the same run", again?.id === "run_1" && again.publicId === "pub_1");
    check("repeat: no second run, no second hand-off", runs.length === 1 && triggered.length === 1, `${runs.length}/${triggered.length}`);
  }

  // 2b — the race: the other starter's insert lands between our read and our
  // write. The unique constraint fires; we return its run.
  {
    const pending = pendingRow();
    const triggered: string[] = [];
    let slipped = false;
    const stub = stubDb(pending, {
      beforeCreate: () => {
        if (slipped) return;
        slipped = true;
        stub.insert({ id: "run_webhook", publicId: "pub_webhook", paidCheckoutSessionId: "cs_test_1" });
      },
    });
    const run = await startPaidCheck(stub.db, "pc_1", "cs_test_1", { trigger: async (id) => void triggered.push(id) });
    check("race: the loser returns the winner's run", run?.id === "run_webhook" && run.publicId === "pub_webhook", run?.id);
    check("race: the loser created nothing and triggered nothing",
      stub.creates.length === 0 && triggered.length === 0 && stub.runs.length === 1, `${stub.creates.length}/${triggered.length}`);
    check("race: the pending row still records the winner", pending.runId === "run_webhook", String(pending.runId));
  }

  // 2c — a mismatched session never starts anything.
  {
    const pending = pendingRow();
    const { db, runs } = stubDb(pending);
    const run = await startPaidCheck(db, "pc_1", "cs_test_other", { trigger: async () => {} });
    check("mismatch: a session the pending check was not created for starts nothing",
      run === null && runs.length === 0 && pending.runId === null);
  }

  // 3 — not paid: nothing starts, state is pending.
  for (const payment_status of ["unpaid", "no_payment_required"]) {
    const pending = pendingRow();
    const { db, runs } = stubDb(pending);
    const { stripe, retrieves } = stubStripe({ mode: "payment", payment_status, metadata: { pendingCheckId: "pc_1" } });
    const state = await paidCheckState(db, stripe, "cs_test_1", { trigger: async () => {} });
    check(`unpaid (${payment_status}): the poll reports pending and starts nothing`,
      state?.state === "pending" && runs.length === 0 && pending.runId === null && retrieves() === 1,
      JSON.stringify(state));
  }
  check("isPaidOneCheck: a subscription session is never a one-check",
    !isPaidOneCheck({ mode: "subscription", payment_status: "paid", metadata: { pendingCheckId: "pc_1" } }));
  check("isPaidOneCheck: a paid session without our metadata is not ours",
    !isPaidOneCheck({ mode: "payment", payment_status: "paid", metadata: {} }));
  check("isPaidOneCheck: a paid session naming another pending check is refused for this one",
    !isPaidOneCheck({ mode: "payment", payment_status: "paid", metadata: { pendingCheckId: "pc_2" } }, "pc_1"));

  // 4 — paid, webhook absent: the poll starts the run itself.
  {
    const pending = pendingRow();
    const triggered: string[] = [];
    const { db, runs } = stubDb(pending);
    const { stripe, retrieves } = stubStripe({ mode: "payment", payment_status: "paid", metadata: { pendingCheckId: "pc_1" } });
    const deps = { trigger: async (id: string) => void triggered.push(id) };
    const state = await paidCheckState(db, stripe, "cs_test_1", deps);
    check("paid: the poll starts the run and reports it",
      state?.state === "started" && state.runPublicId === "pub_1" && runs.length === 1 && triggered.length === 1,
      JSON.stringify(state));
    // Once started, the poll answers from our own rows — Stripe is not asked again.
    const later = await paidCheckState(db, stripe, "cs_test_1", deps);
    check("paid: a later poll answers from the pending row without Stripe",
      later?.state === "started" && later.runPublicId === "pub_1" && retrieves() === 1 && runs.length === 1,
      `${retrieves()} retrieves`);
    const unknown = await paidCheckState(db, stripe, "cs_test_nobody", deps);
    check("paid: an unknown session is null, not pending", unknown === null);
  }

  // 5 — the janitor deletes expired rows that never got a run, and nothing else.
  {
    const now = new Date("2026-09-06T12:00:00.000Z");
    const rows = [
      { id: "expired-unpaid", runId: null, expiresAt: new Date("2026-09-06T11:59:59.000Z") },
      { id: "expired-paid", runId: "run_1", expiresAt: new Date("2026-09-06T11:00:00.000Z") },
      { id: "live-unpaid", runId: null, expiresAt: new Date("2026-09-06T13:00:00.000Z") },
    ];
    let where: { runId?: string | null; expiresAt?: { lt: Date } } = {};
    const env = {
      db: {
        pendingCheck: {
          deleteMany: async (args: { where: typeof where }) => {
            where = args.where;
            const gone = rows.filter((r) => r.runId === where.runId && r.expiresAt < where.expiresAt!.lt);
            return { count: gone.length };
          },
        },
      },
    } as unknown as AgentEnv;
    const removed = await sweepExpiredPendingChecks(env, now);
    check("janitor: only the expired row without a run is deleted", removed === 1, `${removed} removed`);
    check("janitor: the filter is runId null AND expiresAt before now",
      where.runId === null && where.expiresAt?.lt.toISOString() === now.toISOString(), JSON.stringify(where));
  }

  // 6 — the buyer gets Stripe's receipt. Anonymous, so the address is only
  // known after Checkout; the webhook names it on the charge, once.
  {
    const receiptStripe = (receipt_email: string | null) => {
      const updates: { id: string; receipt_email?: string; key?: string }[] = [];
      const stripe = {
        paymentIntents: { retrieve: async () => ({ latest_charge: { id: "ch_1", receipt_email } }) },
        charges: {
          update: async (id: string, p: { receipt_email?: string }, o?: { idempotencyKey?: string }) =>
            (updates.push({ id, ...p, key: o?.idempotencyKey }), {}),
        },
      } as never;
      return { stripe, updates };
    };
    const session = { payment_intent: "pi_1", customer_details: { email: "buyer@visitor.test" } } as never;
    const fresh = receiptStripe(null);
    const sent = await sendPaidCheckReceipt(fresh.stripe, session);
    check("receipt: a paid charge without an address is sent a receipt to the Checkout email",
      sent && fresh.updates.length === 1 && fresh.updates[0].id === "ch_1" && fresh.updates[0].receipt_email === "buyer@visitor.test",
      JSON.stringify(fresh.updates));
    // Two deliveries arriving together both read the charge empty; the key is
    // what makes Stripe perform the update — and send the receipt — once.
    const twin = receiptStripe(null);
    await Promise.all([sendPaidCheckReceipt(twin.stripe, session), sendPaidCheckReceipt(twin.stripe, session)]);
    check("receipt: concurrent deliveries send the same idempotency key, stable per charge",
      twin.updates.length === 2 && twin.updates.every((u) => u.key === "one-check-receipt:ch_1"), JSON.stringify(twin.updates));
    const named = receiptStripe("buyer@visitor.test");
    check("receipt: a redelivered event finds the address set and mails nothing twice",
      !(await sendPaidCheckReceipt(named.stripe, session)) && named.updates.length === 0);
    const noEmail = receiptStripe(null);
    check("receipt: no Checkout email, no update",
      !(await sendPaidCheckReceipt(noEmail.stripe, { payment_intent: "pi_1", customer_details: null } as never)) &&
        noEmail.updates.length === 0);
    const hook = readFileSync("src/app/api/webhooks/stripe/route.ts", "utf8");
    check("receipt: the webhook sends it for a paid one-off check, after the run is started",
      /await startPaidCheck\(db, pendingCheckId, session\.id\);\s*(\/\/[^\n]*\n\s*)*await sendPaidCheckReceipt\(stripe, session\);/.test(hook));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
