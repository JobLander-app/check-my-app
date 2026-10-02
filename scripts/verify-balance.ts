// CHE-327 verification: one currency — a dollar balance, and every check has
// its own price.
//
// Owner decision, 2026-09-28: a plan puts a credit on the team's balance each
// UTC month (Free: $3, once); every check — a watch's tick, the agent's
// start_check, the dashboard's button, a re-check, a full re-check — is priced
// at what it cost us × the plan's multiplier and debited when it finishes; our
// failure costs nothing; a quick check that found nothing changed costs its
// real, tiny price; bought top-ups roll over and are spent after the credit.
// The customer sees a check's PRICE and their BALANCE — never our cost, never
// the multiplier — and a price is never shown without the work it paid for.
//
// What this proves, without a network or a database (the stub in
// scripts/fixtures/mcp-db.ts evaluates every `where`):
//   1. the plan numbers are the owner's, in one place (PLAN_LIMITS);
//   2. the balance: monthly window for a paid plan, lifetime for Free, the
//      renewal date, bought balance after the credit, and a slightly negative
//      balance blocking the next start;
//   3. the start gate: positive and at least what a check of this app usually
//      costs; the refusal names the team's balance and both ways out, and the
//      code is quota_balance / quota_free;
//   4. pricing a finished run (src/agent/pricing.ts): cost × multiplier, a
//      quick check at its few cents, a failed run at 0, idempotent under a
//      retried step, the overflow taken from the bought balance, and a voided
//      price giving that back;
//   5. the scheduler admits every tick through the same gate and pauses (and
//      tells the team once) when the balance cannot cover a check;
//   6. a top-up is credited exactly once per paid session, and only for the
//      amounts we sell, charged as named;
//   7. the price explanation: the work (journeys and steps, or a quick
//      check's pages), the comparison with the app's usual, and per-part
//      shares that are PRICES summing exactly to the check's price — with no
//      cost, token, multiplier or machinery word in it (the verdict-language
//      leak checks);
//   8. no customer surface still sells full re-checks, watch caps or a daily
//      budget, and none prints the multiplier;
//   9. the runaway fuse and "our failure is free" are wired in the workflow,
//      and the measurement events are in the catalogue.
//
// On origin/main this fails at step 1: PLAN_LIMITS has no creditUsd.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-balance.ts

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createStubDb } from "./fixtures/mcp-db";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const close = (a: number, b: number) => Math.abs(a - b) < 0.0001;

async function main() {
  const plans = (await import("@/lib/plans")) as Record<string, unknown> & typeof import("@/lib/plans");
  const L = plans.PLAN_LIMITS as unknown as Record<string, Record<string, unknown>>;

  // ─── 1. The owner's numbers ──────────────────────────────────────────────
  const WANT: Record<string, [number | null, number]> = {
    free: [3, 3], starter: [29, 3], growth: [99, 2.5], business: [499, 2], enterprise: [null, 2],
  };
  for (const [plan, [credit, mult]] of Object.entries(WANT)) {
    check(`${plan}: credit ${credit ?? "unlimited"}, multiplier ×${mult}`,
      L[plan]?.creditUsd === credit && L[plan]?.priceMultiplier === mult,
      JSON.stringify(L[plan]));
  }
  if (!("creditUsd" in (L.starter ?? {}))) return finish();
  for (const gone of ["maxWatches", "maxFrequency", "dailyBudgetUsd", "fullRechecksPerMonth"]) {
    check(`PLAN_LIMITS has no ${gone} any more`, !Object.values(L).some((l) => gone in l));
  }
  check("the top-up amounts are $10 / $25 / $50 (nothing smaller)", JSON.stringify(plans.TOPUP_AMOUNTS_USD) === "[10,25,50]");
  check("price = cost × multiplier, in cents", plans.priceForCost("starter", 0.3) === 0.9 && plans.priceForCost("growth", 0.333) === 0.83);

  // ─── 2. The balance ──────────────────────────────────────────────────────
  const NOW = new Date("2026-09-20T12:00:00Z");
  const paid = plans.balanceFrom("starter", { spentUsd: 10, planSpentUsd: 10, topupUsd: 5 }, NOW);
  check("starter: $29 − $10 spent + $5 topped up = $24, renews October 1",
    paid.balanceUsd === 24 && paid.renewsOn === "October 1" && paid.window === "month", JSON.stringify(paid));
  const over = plans.balanceFrom("starter", { spentUsd: 35, planSpentUsd: 29, topupUsd: -0.4 }, NOW);
  check("a check that finished past what was left leaves the balance slightly negative", over.balanceUsd === -0.4, String(over.balanceUsd));
  const free = plans.balanceFrom("free", { spentUsd: 1, planSpentUsd: 1, topupUsd: 0 }, NOW);
  check("free: lifetime window, never renews", free.window === "lifetime" && free.renewsOn === null && free.balanceUsd === 2);
  check("enterprise: unlimited", plans.balanceFrom("enterprise", { spentUsd: 1e6, planSpentUsd: 1e6, topupUsd: 0 }, NOW).balanceUsd === null);

  {
    const lastMonth = new Date("2026-08-31T23:00:00Z");
    const thisMonth = new Date("2026-09-01T00:00:00Z");
    const { db } = createStubDb({
      team: [{ id: "t_paid", plan: "starter", topupUsd: 0 }, { id: "t_free", plan: "free", topupUsd: 0 }],
      run: [
        { id: "a", teamId: "t_paid", appSlug: "a.test", priceUsd: 20, priceFromTopupUsd: 0, createdAt: lastMonth },
        { id: "b", teamId: "t_paid", appSlug: "a.test", priceUsd: 4, priceFromTopupUsd: 0, createdAt: thisMonth },
        { id: "c", teamId: "t_free", appSlug: "f.test", priceUsd: 1, priceFromTopupUsd: 0, createdAt: new Date("2026-01-01") },
        { id: "d", teamId: "t_free", appSlug: "f.test", priceUsd: 1, priceFromTopupUsd: 0, createdAt: thisMonth },
        { id: "x", teamId: "t_other", appSlug: "x.test", priceUsd: 100, priceFromTopupUsd: 0, createdAt: thisMonth },
      ],
    });
    const p = await plans.teamBalance(db, { id: "t_paid", plan: "starter" }, NOW);
    check("month boundary: last month's spending does not count on a paid plan", p.spentUsd === 4 && p.balanceUsd === 25, JSON.stringify(p));
    const f = await plans.teamBalance(db, { id: "t_free", plan: "free" }, NOW);
    check("Free: every check the team ever ran counts against the one-time credit", f.spentUsd === 2 && f.balanceUsd === 1, JSON.stringify(f));
  }

  // ─── 3. The start gate ───────────────────────────────────────────────────
  const ok = plans.balanceDecision("starter", plans.balanceFrom("starter", { spentUsd: 28, planSpentUsd: 28, topupUsd: 0 }, NOW), 0.9);
  check("$1 left, a check usually $0.90 → admitted", ok.ok);
  const low = plans.balanceDecision("starter", plans.balanceFrom("starter", { spentUsd: 28.5, planSpentUsd: 28.5, topupUsd: 0 }, NOW), 0.9);
  check("$0.50 left, a check usually $0.90 → quota_balance", !low.ok && low.code === "quota_balance", JSON.stringify(low));
  check("…the refusal says it is the team's balance, when it renews, and both ways out",
    !low.ok && /team's balance is \$0\.50/.test(low.reason) && /October 1/.test(low.reason) && /Top up/.test(low.reason) && /upgrade/.test(low.reason),
    low.ok ? "" : low.reason);
  const neg = plans.balanceDecision("growth", plans.balanceFrom("growth", { spentUsd: 99, planSpentUsd: 99, topupUsd: -0.1 }, NOW), 0.03);
  check("a negative balance blocks even a quick check", !neg.ok);
  const freeOut = plans.balanceDecision("free", plans.balanceFrom("free", { spentUsd: 3, planSpentUsd: 3, topupUsd: 0 }, NOW), 0.72);
  check("Free's credit used → quota_free, naming the top-up and Starter", !freeOut.ok && freeOut.code === "quota_free" &&
    /Top up/.test(freeOut.reason) && /Starter/.test(freeOut.reason), JSON.stringify(freeOut));
  const topped = plans.balanceDecision("free", plans.balanceFrom("free", { spentUsd: 3, planSpentUsd: 3, topupUsd: 10 }, NOW), 0.72);
  check("…and a top-up lets Free start again", topped.ok);
  {
    const { db } = createStubDb({
      team: [{ id: "t", plan: "growth", topupUsd: 0 }],
      run: [0.2, 0.3, 0.4, 0.5].map((c, i) => ({ id: `h${i}`, teamId: "t", appSlug: "big.test", costUsd: c, priceUsd: c * 2.5, createdAt: new Date(2026, 8, i + 1) })),
    });
    const est = await plans.estimateCheckPrice(db, { id: "t", plan: "growth" }, "big.test");
    check("the estimate is this app's own median price", close(est, 1), String(est));
    const fresh = await plans.estimateCheckPrice(db, { id: "t", plan: "growth" }, "new.test");
    check("…and the plan's typical low end for an app with no history", fresh === plans.typicalPriceRange("growth").low, String(fresh));
  }
  for (const f of ["src/lib/start-saved-app.ts", "src/lib/recheck.ts", "src/app/api/checks/route.ts", "src/lib/mcp/tools.ts"]) {
    check(`${f}: starts go through assertCanStartRun with the app named`, /assertCanStartRun\([\s\S]{0,300}appSlug/.test(read(f)));
  }
  for (const f of ["src/app/api/checks/route.ts", "src/app/api/runs/[id]/recheck/route.ts"]) {
    check(`${f}: an empty balance answers with buy_url and upgrade_url`, /buy_url:[\s\S]{0,80}upgrade_url:/.test(read(f)));
  }

  // ─── 4. Pricing a finished run ───────────────────────────────────────────
  const pricing = await import("@/agent/pricing");
  {
    const { db, table } = createStubDb({
      team: [{ id: "t", plan: "starter", topupUsd: 5 }],
      run: [
        { id: "spent", teamId: "t", appSlug: "a.test", status: "completed", costUsd: 9.4, priceUsd: 28.2, priceFromTopupUsd: 0, createdAt: new Date("2026-09-05") },
        { id: "walk", teamId: "t", appSlug: "a.test", status: "completed", costUsd: 0.3, priceUsd: null, priceFromTopupUsd: 0, createdAt: new Date("2026-09-20") },
        { id: "quick", teamId: "t", appSlug: "a.test", status: "completed", costUsd: plans.SMOKE_COST_USD, priceUsd: null, priceFromTopupUsd: 0, createdAt: new Date("2026-09-20") },
        { id: "boom", teamId: "t", appSlug: "a.test", status: "failed", costUsd: 0.6, priceUsd: null, priceFromTopupUsd: 0, createdAt: new Date("2026-09-20") },
        { id: "anon", teamId: null, appSlug: "a.test", status: "completed", costUsd: 0.3, priceUsd: null, priceFromTopupUsd: 0, createdAt: new Date("2026-09-20") },
      ],
    });
    const run = (id: string) => table("run").find((r) => r.id === id)!;
    const team = () => table("team")[0];
    const p1 = await pricing.priceRun(db, "walk", NOW);
    check("a walk that cost $0.30 is priced $0.90 on Starter", p1 === 0.9 && run("walk").priceUsd === 0.9, String(p1));
    check("…$0.80 of credit was left, so $0.10 came off the bought balance",
      close(run("walk").priceFromTopupUsd as number, 0.1) && close(team().topupUsd as number, 4.9), JSON.stringify({ r: run("walk").priceFromTopupUsd, t: team().topupUsd }));
    await pricing.priceRun(db, "walk", NOW);
    check("pricing twice (a retried step) debits once", close(team().topupUsd as number, 4.9), String(team().topupUsd));
    await pricing.priceRun(db, "quick", NOW);
    check("a quick check costs its real, tiny price — not zero", run("quick").priceUsd === 0.03, String(run("quick").priceUsd));
    await pricing.priceRun(db, "boom", NOW);
    check("a failed run costs nothing (our failure is free)", run("boom").priceUsd === 0);
    await pricing.priceRun(db, "anon", NOW);
    check("an anonymous run belongs to no balance and stays unpriced", run("anon").priceUsd === null);
    // The quick check came entirely off the bought balance (the credit was gone).
    check("…the quick check's $0.03 came off the bought balance too", close(team().topupUsd as number, 4.87), String(team().topupUsd));
    await pricing.voidRunPrice(db, "walk");
    check("a run that failed after it was priced is voided: price 0, the bought $0.10 goes back",
      run("walk").priceUsd === 0 && close(team().topupUsd as number, 4.97), JSON.stringify({ p: run("walk").priceUsd, t: team().topupUsd }));
    await pricing.voidRunPrice(db, "walk");
    check("…and voiding twice gives back once", close(team().topupUsd as number, 4.97));
  }

  // ─── 5. The scheduler ────────────────────────────────────────────────────
  {
    const s = read("src/agent/scheduler.ts");
    const admit = s.indexOf("admitTeamCheck(env.db");
    check("scheduler: every tick is admitted by admitTeamCheck, with the app named", admit > 0 && /admitTeamCheck\(env\.db, \{ id: watch\.teamId, plan \}, watch\.appSlug/.test(s));
    check("scheduler: …before the watch is claimed or a run created",
      admit > 0 && admit < s.indexOf("lastRunAt: now") && admit < s.indexOf("createWatchRun(env, watch"));
    check("scheduler: a refused tick pauses the watch, says why, and tells the team once per window",
      /pauseBalanceUsedUp\(/.test(s) && /balanceNoticeSentAt/.test(s) && /sendBalanceUsedUp\(/.test(s) && /source: "watch"/.test(s));
  }

  // ─── 6. Top-ups ──────────────────────────────────────────────────────────
  const topup = await import("@/lib/topup");
  {
    const session = (over: Record<string, unknown> = {}) => ({
      id: "cs_1", mode: "payment", payment_status: "paid", amount_total: 2500,
      metadata: topup.topUpMetadata("t", 25), ...over,
    }) as Parameters<typeof topup.paidTopUp>[0];
    check("a paid $25 top-up is recognised", JSON.stringify(topup.paidTopUp(session())) === JSON.stringify({ sessionId: "cs_1", teamId: "t", amountUsd: 25 }));
    check("…not when unpaid", topup.paidTopUp(session({ payment_status: "unpaid" })) === null);
    check("…not when Stripe charged a different amount than it names", topup.paidTopUp(session({ amount_total: 100 })) === null);
    check("…not for an amount we do not sell", topup.paidTopUp(session({ amount_total: 700, metadata: { kind: "balance_topup", teamId: "t", amountUsd: "7" } })) === null);
    const { db, table } = createStubDb({ team: [{ id: "t", plan: "starter", topupUsd: -0.2 }] });
    const first = await topup.creditTopUp(db, { sessionId: "cs_1", teamId: "t", amountUsd: 25 });
    const again = await topup.creditTopUp(db, { sessionId: "cs_1", teamId: "t", amountUsd: 25 });
    check("credited once however many times Stripe delivers it", first && !again && close(table("team")[0].topupUsd as number, 24.8) && table("balanceTopUp").length === 1,
      JSON.stringify({ first, again, topup: table("team")[0].topupUsd }));
    const hook = read("src/app/api/webhooks/stripe/route.ts");
    check("the webhook credits top-ups and records balance_topped_up only for the delivery that credited",
      /paidTopUp\(session\)/.test(hook) && /await creditTopUp\(db, topUp\)\)/.test(hook) && /"balance_topped_up"/.test(hook));
    const route = read("src/app/api/billing/topup/route.ts");
    check("the top-up route is a signed-in admin's (billing.manage) and sells only TOPUP_AMOUNTS_USD",
      /requireScope\(db, req, "billing\.manage"/.test(route) && /isTopUpAmount\(amountUsd\)/.test(route));
    // The first real top-up (2026-09-29) went out without receipt_email and its
    // payer got no receipt: Stripe sends one for a one-time payment only when
    // the payment names the address or a dashboard toggle is on.
    const params = (customer: string | null) => topup.topUpSessionParams({
      amountUsd: 10, teamId: "t", userId: "u", email: "admin@team.test", customer, appUrl: "https://app.test",
    });
    const guest = params(null), known = params("cus_1");
    check("a top-up asks Stripe for the payer's receipt by address, with or without a Stripe customer",
      guest.payment_intent_data?.receipt_email === "admin@team.test" && known.payment_intent_data?.receipt_email === "admin@team.test",
      JSON.stringify({ guest: guest.payment_intent_data, known: known.payment_intent_data }));
    check("…and still charges exactly the amount it credits",
      guest.mode === "payment" && guest.line_items?.[0]?.price_data?.unit_amount === 1000 &&
        guest.metadata?.amountUsd === "10" && guest.customer_email === "admin@team.test" && known.customer === "cus_1");
    check("the top-up route builds its session with topUpSessionParams, from the signed-in user's email",
      /topUpSessionParams\(\{[^}]*email: user\.email/.test(route));
  }

  // ─── 7. The price explanation ────────────────────────────────────────────
  const cp = await import("@/lib/check-price");
  const lang = await import("@/lib/verdict-language");
  {
    const parts = cp.splitByCost(0.88, [{ label: "A", cost: 0.1 }, { label: "B", cost: 0.1 }, { label: "C", cost: 0.1 }]);
    check("shares are prices in cents summing exactly to the price", Math.round(parts.reduce((s, p) => s + p.price_usd * 100, 0)) === 88, JSON.stringify(parts));

    const step = (journeyId: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${journeyId}s${i}`, journeyId, order: i, status: "ok" }));
    const history = Array.from({ length: 4 }, (_, i) => ({ id: `old${i}`, teamId: "t", appSlug: "shop.test", status: "completed",
      costUsd: 0.3, priceUsd: 0.75, createdAt: new Date(2026, 8, i + 1) }));
    const { db } = createStubDb({
      team: [{ id: "t", plan: "growth", topupUsd: 0 }],
      run: [
        ...history,
        { id: "walk", publicId: "pub_walk", teamId: "t", appSlug: "shop.test", status: "completed", costUsd: 0.6, priceUsd: 1.5, quickPagesOpened: null, createdAt: new Date(2026, 8, 20) },
        { id: "quick", publicId: "pub_quick", teamId: "t", appSlug: "shop.test", status: "completed", costUsd: 0.01, priceUsd: 0.03, quickPagesOpened: 3, createdAt: new Date(2026, 8, 21) },
      ],
      journey: [
        ...history.map((h, i) => ({ id: `oj${i}`, runId: h.id, order: 0, title: "Old", carriedFromRunId: null })),
        { id: "j1", runId: "walk", order: 0, title: "Sign in", carriedFromRunId: null },
        { id: "j2", runId: "walk", order: 1, title: "Checkout", carriedFromRunId: null },
        { id: "j3", runId: "walk", order: 2, title: "Carried", carriedFromRunId: "old0" },
      ],
      step: [...history.flatMap((_, i) => step(`oj${i}`, 4)), ...step("j1", 3), ...step("j2", 5), ...step("j3", 9)],
      llmUsage: [
        { id: "u1", runId: "walk", phase: "discovery", journeyId: null, costUsd: 0.2 },
        { id: "u2", runId: "walk", phase: "walking", journeyId: "j1", costUsd: 0.1 },
        { id: "u3", runId: "walk", phase: "walking", journeyId: "j2", costUsd: 0.25 },
        { id: "u4", runId: "walk", phase: "synthesis", journeyId: null, costUsd: 0.05 },
      ],
    });
    const walk = await cp.explainRunPrice(db, "t", "pub_walk");
    check("walk: the work is the journeys walked THIS run and their steps", walk?.work === "Walked 2 journeys, 8 steps" &&
      walk.journeys_walked === 2 && walk.steps_walked === 8, JSON.stringify(walk));
    check("walk: parts — mapping, each journey with its steps, writing — summing exactly to the price",
      walk !== null && walk.parts.length === 4 && walk.parts[1].label === "Sign in" && walk.parts[1].steps === 3 &&
        Math.round(walk.parts.reduce((s, p) => s + p.price_usd * 100, 0)) === 150, JSON.stringify(walk?.parts));
    check("walk: compared with the app's usual, and why, in product terms",
      /^Above this app's usual \$0\.75–\$0\.75: 1 journey more than usual \(2 vs 1\)\.$/.test(walk?.comparison ?? ""), walk?.comparison ?? "");
    const quick = await cp.explainRunPrice(db, "t", "pub_quick");
    check("quick: the work is the pages opened, and the reason is that nothing changed",
      quick?.work === "Quick check — nothing had changed, 3 pages opened" && quick.kind === "quick" && /only a quick pass/.test(quick.comparison ?? ""),
      JSON.stringify(quick));
    // CHE-379: run #221 (an extension check, every journey skipped) read
    // "Walked 5 journeys, 0 steps". A journey counts as walked when at least
    // one of its steps was; the work line says so when none was.
    const { db: skipDb } = createStubDb({
      team: [{ id: "t", plan: "growth", topupUsd: 0 }],
      run: [
        { id: "none", publicId: "pub_none", teamId: "t", appSlug: "ext.test", status: "completed", costUsd: 0.11, priceUsd: 0.27, quickPagesOpened: null, createdAt: new Date(2026, 8, 14) },
        { id: "some", publicId: "pub_some", teamId: "t", appSlug: "ext.test", status: "completed", costUsd: 0.2, priceUsd: 0.5, quickPagesOpened: null, createdAt: new Date(2026, 8, 15) },
      ],
      journey: [
        ...["A", "B", "C", "D", "E"].map((t, i) => ({ id: `n${i}`, runId: "none", order: i, title: t, carriedFromRunId: null })),
        { id: "s0", runId: "some", order: 0, title: "Sign in", carriedFromRunId: null },
        { id: "s1", runId: "some", order: 1, title: "Practice", carriedFromRunId: null },
        { id: "s2", runId: "some", order: 2, title: "History", carriedFromRunId: null },
      ],
      step: [
        // #221's shape: four journeys with only skipped steps, one with none.
        ...["n0", "n0", "n1", "n2", "n3"].map((j, i) => ({ id: `ns${i}`, journeyId: j, order: i, status: "skipped" })),
        ...step("s0", 3), ...step("s1", 2),
        { id: "ss", journeyId: "s2", order: 0, status: "skipped" },
      ],
      llmUsage: [
        { id: "nu1", runId: "none", phase: "discovery", journeyId: null, costUsd: 0.08 },
        { id: "nu2", runId: "none", phase: "walking", journeyId: "n0", costUsd: 0.03 },
      ],
    });
    const none = await cp.explainRunPrice(skipDb, "t", "pub_none");
    check("every journey skipped: it does not say it walked them — 0 journeys, 0 steps, and the work names what was done",
      none?.journeys_walked === 0 && none.steps_walked === 0 && none.work === "Mapped the app; no journey was walked",
      JSON.stringify(none && { work: none.work, journeys_walked: none.journeys_walked }));
    check("…and its price is still accounted for, part by part, summing to the price",
      none !== null && Math.round(none.parts.reduce((s, p) => s + p.price_usd * 100, 0)) === 27, JSON.stringify(none?.parts));
    const some = await cp.explainRunPrice(skipDb, "t", "pub_some");
    check("one journey of three skipped: Walked 2 journeys, 5 steps", some?.work === "Walked 2 journeys, 5 steps" && some.journeys_walked === 2,
      some?.work ?? "");
    // Codex on #229: with earlier all-skipped checks the usual is 0 journeys
    // and 0 steps, so neither differs, and the comparison fell through to "the
    // journeys took longer than usual" — next to "no journey was walked".
    {
      const history = Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, publicId: `pub_h${i}`, teamId: "t", appSlug: "skip.test", status: "completed",
        costUsd: 0.1, priceUsd: 0.25, quickPagesOpened: null, createdAt: new Date(2026, 8, 1 + i) }));
      const { db: zeroDb } = createStubDb({
        team: [{ id: "t", plan: "growth", topupUsd: 0 }],
        run: [...history, { id: "z", publicId: "pub_z", teamId: "t", appSlug: "skip.test", status: "completed", costUsd: 0.4, priceUsd: 1, quickPagesOpened: null, createdAt: new Date(2026, 8, 10) }],
        journey: [...history, { id: "z" }].map((r) => ({ id: `j${r.id}`, runId: r.id, order: 0, title: "Sign in", carriedFromRunId: null })),
        step: [...history, { id: "z" }].map((r) => ({ id: `s${r.id}`, journeyId: `j${r.id}`, order: 0, status: "skipped" })),
        llmUsage: [{ id: "zu", runId: "z", phase: "discovery", journeyId: null, costUsd: 0.4 }],
      });
      const z = await cp.explainRunPrice(zeroDb, "t", "pub_z");
      check("nothing walked, above a usual of earlier all-skipped checks: the comparison names no journey or step",
        z !== null && /^Above this app's usual \$0\.25–\$0\.25\.$/.test(z.comparison ?? "") && !/journey|step/i.test(z.comparison ?? ""),
        z?.comparison ?? "");
      for (const usualJourneys of [0, 4]) {
        const line = cp.comparePrice({ kind: "walk", price: 0.1, usual: { low: 0.4, high: 0.8 }, journeys: 0, steps: 0, usualJourneys, usualSteps: usualJourneys * 3 }) ?? "";
        check(`nothing walked, below a usual of ${usualJourneys} journeys: the price is not explained by journeys or steps`,
          line === "Below this app's usual $0.40–$0.80." , line);
      }
      // Check #294 (2026-10-02): "Below this app's usual $0.65–$0.89: more
      // steps than usual (18 vs 15)". A reason must point the way the price
      // went, or not be given.
      const usual = { low: 0.65, high: 0.89 };
      const line = (price: number, journeys: number, steps: number, usualJourneys: number, usualSteps: number) =>
        cp.comparePrice({ kind: "walk", price, usual, journeys, steps, usualJourneys, usualSteps }) ?? "";
      check("below usual with MORE steps: no reason is given (#294)", line(0.46, 5, 18, 5, 15) === "Below this app's usual $0.65–$0.89.", line(0.46, 5, 18, 5, 15));
      check("below usual with fewer steps: that is the reason", line(0.46, 5, 12, 5, 15) === "Below this app's usual $0.65–$0.89: fewer steps than usual (12 vs 15).", line(0.46, 5, 12, 5, 15));
      check("above usual with FEWER journeys but more steps: the steps explain it, the journeys do not",
        line(1.2, 4, 30, 5, 15) === "Above this app's usual $0.65–$0.89: more steps than usual (30 vs 15).", line(1.2, 4, 30, 5, 15));
      check("above usual with more journeys: that is the reason", line(1.2, 7, 20, 5, 15) === "Above this app's usual $0.65–$0.89: 2 journeys more than usual (7 vs 5).", line(1.2, 7, 20, 5, 15));
      check("above usual with fewer journeys and fewer steps: no reason is given", line(1.2, 4, 12, 5, 15) === "Above this app's usual $0.65–$0.89.", line(1.2, 4, 12, 5, 15));
      check("the same journeys and steps as usual: the journeys took longer / were shorter",
        line(1.2, 5, 15, 5, 15) === "Above this app's usual $0.65–$0.89: the journeys took longer than usual." &&
          line(0.46, 5, 15, 5, 15) === "Below this app's usual $0.65–$0.89: the journeys were shorter than usual.", `${line(1.2, 5, 15, 5, 15)} / ${line(0.46, 5, 15, 5, 15)}`);
    }
    for (const [name, e] of [["walk", walk], ["quick", quick], ["skipped", none]] as const) {
      const text = JSON.stringify(e);
      check(`${name}: no cost, token or multiplier anywhere in the explanation`, !/cost|token|multipl|markup|×/i.test(text), text);
      const words = [e?.work, e?.comparison, ...(e?.parts ?? []).map((p) => p.label)].filter(Boolean).join(". ");
      check(`${name}: no machinery or homework in its words (verdict-language)`,
        lang.environmentLeaks(words).length === 0 && !lang.hasHomework(words) && lang.narrationIn(words).length === 0, words);
    }
    const tools = read("src/lib/mcp/tools.ts");
    for (const tool of ["wait_for_run", "wait_for_review", "get_review", "latest_results"]) {
      const at = tools.indexOf(`async ${tool}(`);
      const body = tools.slice(at, tools.indexOf("\n    },", at));
      check(`MCP ${tool}: carries price_usd and the explanation`, /priceFields\(/.test(body));
    }
    check("MCP priceFields: price_usd with journeys_walked, steps_walked and price_explanation",
      /price_usd: p\.price_usd,\s*journeys_walked[\s\S]{0,80}steps_walked[\s\S]{0,40}price_explanation/.test(tools));
    // CHE-371: the verdict's body is one component, rendered by the permalink and inside the app.
    const verdict = read("src/components/verdict-view.tsx");
    check("verdict page: the price is a disclosure over the explanation, for the team only",
      /<CheckPrice explanation=/.test(verdict) && /viewerTeam\.team\.id === run\.teamId/.test(verdict) && /<details/.test(read("src/components/check-price.tsx")));
  }

  // ─── 8. Customer surfaces ────────────────────────────────────────────────
  {
    const { PLAN_CATALOG } = await import("@/lib/plan-catalog");
    const status = await import("@/lib/plan-status");
    const customerText = [
      JSON.stringify(PLAN_CATALOG),
      ...status.GUIDE_PLANS.map((p) => status.planAllowance(p).text),
      read("src/lib/mcp/instructions.ts"),
      read("src/lib/email.ts"),
    ].join("\n");
    check("no customer text sells full re-checks a month, watch caps or a daily budget",
      !/full re-checks? (a|per) month|\d+ full re-checks?|up to \d+ apps|watched apps? of \d|per app per day|\/day\/app/i.test(customerText));
    check("no customer text prints a multiplier or our cost", !/multiplier|markup|×\d|at cost|costs? us/i.test(customerText));
    for (const plan of ["starter", "growth", "business"] as const) {
      const card = PLAN_CATALOG.find((p) => p.id === plan)!;
      check(`pricing: ${plan}'s card sells PLAN_LIMITS.creditUsd and its typical price`,
        card.features.some((f) => f.startsWith(`${plans.usd(L[plan].creditUsd as number)} of checks every month`)) &&
          card.features.some((f) => f.includes(`${plans.usd(plans.typicalPriceRange(plan).low)}–${plans.usd(plans.typicalPriceRange(plan).high)}`)));
    }
    const offenders: string[] = [];
    const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [join(dir, d.name)] : []);
    for (const f of [...walk("src/app"), ...walk("src/components")]) {
      if (/priceMultiplier/.test(read(f))) offenders.push(f);
    }
    check("no page or component reads the multiplier", offenders.length === 0, offenders.join(", "));
  }

  // ─── 9. Workflow wiring and events ───────────────────────────────────────
  {
    const wf = read("src/agent/workflow.ts");
    check("workflow: a quick check is priced (price-quick) and a finished walk is priced (price)",
      /step\.do\("price-quick"[\s\S]{0,80}priceRun\(/.test(wf) && /step\.do\("price"[\s\S]{0,80}priceRun\(/.test(wf));
    check("workflow: a failed run is priced 0 and any earlier price voided",
      /priceRun\(env\.db, runId\)\s*\.then\(\(\) => voidRunPrice\(env\.db, runId\)\)/.test(wf));
    check("workflow: the runaway fuse runs before each journey and stops the run as ours",
      /assertBelowRunaway\(runId, \(discovery\?\.costUsd \?\? 0\) \+ walkCost\)/.test(wf) && /NonRetryableError\(\s*`internal: runaway fuse/.test(wf));
    check("workflow: no per-check ceiling or daily budget branch is left", !/ceiling|budget-complete|smokeOnly/.test(wf));
    // Run.smokeOnly is the daily budget's last trace: out of the Prisma model
    // (so no client selects it — step 1 of dropping the column) and out of its
    // one historical reader. Strip comments so a history note can still name it.
    const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    check("schema: Run has no smokeOnly field", !/^\s*smokeOnly\s/m.test(code("prisma/schema.prisma")));
    check("cost-trend: no longer reads smokeOnly", !/smokeOnly/.test(code("scripts/cost-trend.mjs")));
    // Step 2: the column itself is dropped by a migration.
    const migrations = readdirSync(join(ROOT, "prisma/migrations")).filter((f) => f.endsWith(".sql"));
    check("migration: Run.smokeOnly is dropped",
      migrations.some((f) => /ALTER TABLE "Run" DROP COLUMN "smokeOnly"/.test(read(`prisma/migrations/${f}`))));
    const { SERVER_ANALYTICS_EVENTS } = await import("@/lib/analytics-server");
    const ev = SERVER_ANALYTICS_EVENTS as readonly string[];
    check("events: balance_exhausted and balance_topped_up are catalogued", ev.includes("balance_exhausted") && ev.includes("balance_topped_up"));
    check("events: checkout_completed carries the team, so exhausted → upgrade joins per team",
      /"checkout_completed", userId, \{ plan: plan \?\? "unknown", teamId: team\.id \}/.test(read("src/app/api/webhooks/stripe/route.ts")));
  }

  finish();
}

function finish() {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-balance: crashed:", err);
  process.exit(1);
});
