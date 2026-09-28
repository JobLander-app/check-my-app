// Site-wide free-check cap verification (owner decision 2026-09-05).
//
// Before launch, the number of free anonymous checks on the whole site is
// capped per UTC day (ANON_RUNS_PER_DAY_SITE). Four things must hold, all of
// them exercised through the real assertCanStartRun with a prisma-like stub —
// no database, no clock dependence beyond "today":
//   1. below the cap, an anonymous caller is let through as before;
//   2. at the cap, the answer is quota_site — for an identifiable client AND
//      for one we could not identify (the site cap comes before the
//      per-visitor bypass, or an unidentifiable crowd would walk past it);
//   3. an owner on the Free plan is never blocked by the site cap — it is a
//      cap on strangers, not on accounts;
//   4. with the site cap not reached, the per-visitor quota still fires.
// Plus the counting contract: anonRunsToday counts ownerId null rows created
// since midnight UTC of the given day, and reports that boundary — minus the
// $1 runs (paidCheckoutSessionId set): a paid run never consumes the free cap.
// Plus the runtime override: the web worker's env ANON_RUNS_PER_DAY_SITE, when
// a positive integer, is the cap the gate enforces (launch day: 100 → 99 runs
// ok, 100 → quota_site); unset or garbage is the default 20.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-site-quota.ts

import type { PrismaClient } from "@/generated/prisma/client";
import {
  ANON_RUNS_PER_DAY,
  ANON_RUNS_PER_DAY_SITE,
  anonRunsToday,
  assertCanStartRun,
  siteCapFromEnv,
  utcDayStart,
} from "@/lib/plans";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

type CountWhere = {
  ownerId?: string | null;
  // CHE-260: the owner's lifetime allowance became the team's.
  teamId?: string | null;
  anonKeyHash?: string;
  paidCheckoutSessionId?: string | null;
  createdAt?: { gte: Date };
};

// The stub answers run.count the way the gate asks it: site-wide anonymous
// rows today, this visitor's rows in the last 24h, this owner's rows ever.
// `sitePaid` of the site rows carry a paidCheckoutSessionId; a query that
// filters those out gets the difference, one that does not gets them all.
function stubDb(counts: { site: number; visitor: number; owner: number; sitePaid?: number }) {
  const calls: CountWhere[] = [];
  const db = {
    run: {
      count: async ({ where }: { where: CountWhere }) => {
        calls.push(where);
        if (where.ownerId === null) {
          return where.paidCheckoutSessionId === null ? counts.site - (counts.sitePaid ?? 0) : counts.site;
        }
        if (where.anonKeyHash) return counts.visitor;
        if (typeof where.teamId === "string") return counts.owner;
        throw new Error(`unexpected count where: ${JSON.stringify(where)}`);
      },
      // CHE-327: a team's gate reads its balance — nothing spent here.
      aggregate: async () => ({ _sum: { priceUsd: counts.owner, priceFromTopupUsd: 0 } }),
      findMany: async () => [],
    },
    team: { findUnique: async () => ({ topupUsd: 0 }) },
  };
  return { db: db as unknown as PrismaClient, calls };
}

async function main() {
  check("cap is the owner's number", ANON_RUNS_PER_DAY_SITE === 20, String(ANON_RUNS_PER_DAY_SITE));

  // Counting contract.
  {
    const now = new Date("2026-09-05T17:42:11.000Z");
    check("utcDayStart: midnight UTC of the given instant",
      utcDayStart(now).toISOString() === "2026-09-05T00:00:00.000Z", utcDayStart(now).toISOString());
    const { db, calls } = stubDb({ site: 7, visitor: 0, owner: 0 });
    const today = await anonRunsToday(db, now);
    check("anonRunsToday: used / cap / dayStartIso",
      today.used === 7 && today.cap === ANON_RUNS_PER_DAY_SITE && today.dayStartIso === "2026-09-05T00:00:00.000Z",
      JSON.stringify(today));
    const where = calls[0];
    check("anonRunsToday: counts ownerId null rows created since midnight UTC",
      where.ownerId === null && where.createdAt?.gte.toISOString() === "2026-09-05T00:00:00.000Z",
      JSON.stringify(where));
    check("anonRunsToday: paid runs are excluded from the count",
      where.paidCheckoutSessionId === null, JSON.stringify(where));
  }

  // 20 anonymous runs today, one of them paid: 19 free → the next stranger is
  // let through. A $1 run bought its own slot; it does not take a free one.
  {
    const { db } = stubDb({ site: ANON_RUNS_PER_DAY_SITE, sitePaid: 1, visitor: 0, owner: 0 });
    const today = await anonRunsToday(db);
    check("20 anonymous runs, 1 paid → free count 19", today.used === ANON_RUNS_PER_DAY_SITE - 1, String(today.used));
    const gate = await assertCanStartRun(db, null, "hash-p");
    check("20 anonymous runs, 1 paid → anonymous caller ok", gate.ok, JSON.stringify(gate));
  }

  // 1 — 19 site runs today: an anonymous first-timer is let through.
  {
    const { db } = stubDb({ site: ANON_RUNS_PER_DAY_SITE - 1, visitor: 0, owner: 0 });
    const gate = await assertCanStartRun(db, null, "hash-a");
    check("19 site runs today → anonymous caller ok", gate.ok, JSON.stringify(gate));
  }

  // 2 — 20 site runs today: quota_site, with the two ways forward in the copy.
  {
    const { db, calls } = stubDb({ site: ANON_RUNS_PER_DAY_SITE, visitor: 0, owner: 0 });
    const gate = await assertCanStartRun(db, null, "hash-a");
    check("20 site runs today → quota_site", !gate.ok && gate.code === "quota_site", JSON.stringify(gate));
    check("quota_site: reason names the $1 run and today's checks and the reset",
      !gate.ok && /\$1/.test(gate.reason) && /today's checks/i.test(gate.reason) && /midnight UTC/.test(gate.reason),
      gate.ok ? "" : gate.reason);
    check("quota_site: the per-visitor count was never consulted",
      !calls.some((w) => w.anonKeyHash), `${calls.length} count calls`);
    const unidentified = await assertCanStartRun(db, null, null);
    check("20 site runs today → an unidentifiable client is blocked too",
      !unidentified.ok && unidentified.code === "quota_site", JSON.stringify(unidentified));
  }

  // 3 — an owner on Free with the site cap hit: their own lifetime quota is
  // the only thing that applies.
  {
    const { db, calls } = stubDb({ site: ANON_RUNS_PER_DAY_SITE, visitor: 0, owner: 0 });
    const gate = await assertCanStartRun(db, { id: "team_owner-1", plan: "free" }, null);
    check("owner (free, 0 runs) with site cap hit → ok", gate.ok, JSON.stringify(gate));
    check("owner: the site-wide count was never consulted",
      !calls.some((w) => w.ownerId === null), `${calls.length} count calls`);
    const paid = await assertCanStartRun(db, { id: "owner-2", plan: "starter" }, null);
    check("owner (starter) with site cap hit → ok", paid.ok, JSON.stringify(paid));
  }

  // 4 — site cap not reached, this visitor already had theirs: quota_anon.
  {
    const { db } = stubDb({ site: 5, visitor: ANON_RUNS_PER_DAY, owner: 0 });
    const gate = await assertCanStartRun(db, null, "hash-b");
    check("site cap not reached, visitor at their cap → quota_anon",
      !gate.ok && gate.code === "quota_anon", JSON.stringify(gate));
  }

  // 5 — the runtime override. Launch day: the owner sets the web worker's
  // env to 100; the day after, back to 20. Only a positive integer counts.
  {
    check("env unset → default 20", siteCapFromEnv({}) === 20 && siteCapFromEnv(undefined) === 20);
    check("env \"100\" → 100", siteCapFromEnv({ ANON_RUNS_PER_DAY_SITE: "100" }) === 100);
    check("env \" 100 \" (whitespace) → 100", siteCapFromEnv({ ANON_RUNS_PER_DAY_SITE: " 100 " }) === 100);
    for (const garbage of ["", "abc", "0", "-5", "1.5", "1e2", "20x", true, null]) {
      check(`env ${JSON.stringify(garbage)} → default 20`, siteCapFromEnv({ ANON_RUNS_PER_DAY_SITE: garbage }) === 20,
        String(siteCapFromEnv({ ANON_RUNS_PER_DAY_SITE: garbage })));
    }

    const cap = siteCapFromEnv({ ANON_RUNS_PER_DAY_SITE: "100" });
    const under = await assertCanStartRun(stubDb({ site: 99, visitor: 0, owner: 0 }).db, null, "hash-l", { siteCap: cap });
    check("env 100, 99 site runs today → ok", under.ok, JSON.stringify(under));
    const at = await assertCanStartRun(stubDb({ site: 100, visitor: 0, owner: 0 }).db, null, "hash-l", { siteCap: cap });
    check("env 100, 100 site runs today → quota_site", !at.ok && at.code === "quota_site", JSON.stringify(at));
    // Without the override, 20 is still 20 — 21 site runs are past the cap.
    const plain = await assertCanStartRun(stubDb({ site: 21, visitor: 0, owner: 0 }).db, null, "hash-l");
    check("no override, 21 site runs today → quota_site", !plain.ok && plain.code === "quota_site", JSON.stringify(plain));
    // The counter the page and the form show is the effective cap.
    const today = await anonRunsToday(stubDb({ site: 42, visitor: 0, owner: 0 }).db, new Date(), cap);
    check("anonRunsToday reports the effective cap", today.cap === 100 && today.used === 42, JSON.stringify(today));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
