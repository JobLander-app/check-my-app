// CHE-335 verification: a $1 check that ended failed is owed one re-check.
//
// The buyer paid because the site's free checks were used up; before this,
// "Run it again" on their failed run went through that same free-funnel gate
// and was refused — paid, no verdict, no way to get one. Driven through the
// real createRecheckRun over a prisma-like stub with the site cap already
// spent, and the real failed-run card rendered with react-dom/server.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-paid-retry.ts

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { PrismaClient } from "@/generated/prisma/client";
import { createRecheckRun, paidRetryOwed, RETRY_PASSWORD_NEEDED, type RecheckDeps } from "@/lib/recheck";
import { RunFailed } from "@/components/run-failed";
import { PAID_RETRY_LINE } from "@/lib/failed-run";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

type Row = Record<string, unknown> & { id: string; publicId: string; baselineRunId?: string | null };

function anonRun(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    publicId: `pub-${id}`,
    targetUrl: "https://shop.example.org",
    targetKind: "website",
    extensionId: null,
    extensionConfig: null,
    appSlug: "shop.example.org",
    testEmail: null,
    testPasswordEnc: null,
    testAccounts: null,
    scopeHints: null,
    userNotes: null,
    focusAreas: null,
    notifyEmail: "buyer@example.org",
    watchId: null,
    appId: null,
    ownerId: null,
    ephemeral: false,
    teamId: null,
    team: null,
    status: "failed",
    paidCheckoutSessionId: null,
    anonKeyHash: "buyer-key",
    ...over,
  };
}

function stubDb(rows: Row[]) {
  const created: Row[] = [];
  let counter = 1000;
  // Counter.name is the primary key: a second insert of the same name is the
  // P2002 the real D1 adapter raises.
  const names = new Set<string>();
  const all = () => [...rows, ...created];
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (typeof v === "object" && v !== null ? true : r[k] === v));
  const db = {
    counter: {
      upsert: async () => ({ value: ++counter }),
      findUnique: async ({ where }: { where: { name: string } }) => (names.has(where.name) ? { name: where.name, value: 1 } : null),
      create: async ({ data }: { data: { name: string } }) => {
        await Promise.resolve();
        if (names.has(data.name)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        names.add(data.name);
        return { name: data.name, value: 1 };
      },
    },
    app: { findFirst: async () => null },
    run: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        "runNumber" in where ? null : (all().find((r) => matches(r, where)) ?? null),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => all().find((r) => matches(r, where)) ?? null,
      // The site cap is spent: every count answers "full".
      count: async () => 1_000,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `new${created.length}`, publicId: `pub-new${created.length}` } as Row;
        created.push(row);
        return { id: row.id, publicId: row.publicId };
      },
    },
  };
  return { db: db as unknown as PrismaClient, created };
}

const deps: RecheckDeps = {
  canMutate: async () => true,
  trigger: async () => {},
  siteCap: () => 20,
  now: () => new Date("2026-09-28T20:00:00Z"),
  ephemeralTtlDays: () => 7,
};

async function main() {
  // 1. The free public check that failed: the cap still applies.
  {
    const { db, created } = stubDb([anonRun("free")]);
    const r = await createRecheckRun(db, "pub-free", { anonKeyHash: "buyer-key" }, {}, deps);
    check("a failed FREE check is still refused once the site cap is spent", r.kind === "quota", r.kind);
    check("…and starts nothing", created.length === 0);
  }

  // 2. The paid one: owed, starts, does not eat the visitor's free check.
  {
    const { db, created } = stubDb([anonRun("paid", { paidCheckoutSessionId: "cs_live_1" })]);
    check("paidRetryOwed: a failed $1 check with no re-check yet", await paidRetryOwed(db, { id: "paid", status: "failed", paidCheckoutSessionId: "cs_live_1" }));
    const r = await createRecheckRun(db, "pub-paid", { anonKeyHash: "buyer-key" }, {}, deps);
    check("a failed $1 check's re-check starts although the site cap is spent", r.kind === "ok", r.kind);
    check("…names the failed run as its baseline", created[0]?.baselineRunId === "paid");
    check("…and is not counted against the buyer's own free check", created[0]?.anonKeyHash === null);

    // 3. Once.
    const again = await createRecheckRun(db, "pub-paid", { anonKeyHash: "buyer-key" }, {}, deps);
    check("a second press goes through the gates like any other", again.kind === "quota", again.kind);
    check("paidRetryOwed is false once the re-check is claimed",!(await paidRetryOwed(db, { id: "paid", status: "failed", paidCheckoutSessionId: "cs_live_1" })));
  }

  // 3b. Two presses at once (two tabs, the API and the page): one run.
  {
    const { db, created } = stubDb([anonRun("race", { paidCheckoutSessionId: "cs_live_3" })]);
    const [a, b] = await Promise.all([
      createRecheckRun(db, "pub-race", { anonKeyHash: "buyer-key" }, {}, deps),
      createRecheckRun(db, "pub-race", { anonKeyHash: "buyer-key" }, {}, deps),
    ]);
    const kinds = [a.kind, b.kind].sort().join(",");
    check("two concurrent presses start exactly one owed re-check", kinds === "ok,quota" && created.length === 1, `${kinds}, ${created.length} run(s)`);
  }

  // 3c. A paid check that signed in: the password went when it ended.
  {
    process.env.CREDENTIALS_SECRET ??= "verify-paid-retry";
    const { db, created } = stubDb([anonRun("login", { paidCheckoutSessionId: "cs_live_4", testEmail: "qa@shop.example.org" })]);
    const bare = await createRecheckRun(db, "pub-login", { anonKeyHash: "buyer-key" }, {}, deps);
    check("a signed-in paid check's re-check asks for the password", bare.kind === "quota" && bare.reason === RETRY_PASSWORD_NEEDED, bare.kind);
    check("…without spending the owed re-check", created.length === 0 && (await paidRetryOwed(db, { id: "login", status: "failed", paidCheckoutSessionId: "cs_live_4" })));
    const withPw = await createRecheckRun(db, "pub-login", { anonKeyHash: "buyer-key", testPassword: "s3cret" }, {}, deps);
    check("with the password it starts, signed in", withPw.kind === "ok" && typeof created[0]?.testPasswordEnc === "string" && created[0]?.testEmail === "qa@shop.example.org", withPw.kind);
    check("…and the password is stored encrypted, never as typed", created[0]?.testPasswordEnc !== "s3cret");
  }

  // 4. A paid run that completed owes nothing.
  {
    const { db } = stubDb([anonRun("done", { status: "completed", paidCheckoutSessionId: "cs_live_2" })]);
    check("a completed $1 check owes no re-check", !(await paidRetryOwed(db, { id: "done", status: "completed", paidCheckoutSessionId: "cs_live_2" })));
  }

  // 5. The page says so, and only where it is owed.
  const owed = renderToString(createElement(RunFailed, { free: false, paidRetry: true, retry: { runId: "pub-paid", appSlug: "shop.example.org" } }));
  check("the failed-run card says the re-check is on us", owed.includes(PAID_RETRY_LINE.replace(/'/g, "&#x27;")));
  const plain = renderToString(createElement(RunFailed, { free: false, retry: { runId: "pub-free", appSlug: "shop.example.org" } }));
  check("…and a free check's card does not", !plain.includes("on us"));
  const signedIn = renderToString(createElement(RunFailed, { free: false, paidRetry: true, retry: { runId: "pub-login", appSlug: "shop.example.org", loginEmail: "qa@shop.example.org" } }));
  check("a signed-in paid check's card asks for that account's password", signedIn.includes('name="testPassword"') && signedIn.includes("qa@shop.example.org"));
  check("…and no other card does", !owed.includes("testPassword") && !plain.includes("testPassword"));

  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
