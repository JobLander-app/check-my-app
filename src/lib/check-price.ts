// Why a check cost what it cost (CHE-327).
//
// A bare price invites "why was this one $0.31 and that one $0.88?" (owner,
// 2026-09-28). So a price is never shown alone: next to it is the work it paid
// for, in the verdict's own terms — the journeys walked and their steps, or a
// quick check's pages — how that compares with what checks of this app
// usually cost, and, where the ledger recorded it, what each journey's share
// of the price was.
//
// The shares are real, not apportioned by guesswork: every LLM call is
// recorded in LlmUsage with its phase and, for a walk, its journey
// (src/agent/workflow.ts recordUsage). Each part's share of the PRICE is its
// share of the recorded cost; the parts are rounded to cents and the rounding
// remainder lands on the largest part, so they add up to the price exactly.
// Only prices leave this file — never a cost, never the multiplier (rule 1,
// and the owner's rule on showing margins). scripts/verify-balance.ts holds
// both properties.

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "@/lib/enums";
import { SMOKE_COST_USD, appPriceRange, usd } from "@/lib/plans";
import { teamOwned } from "@/lib/tenant-db";

export interface PricePart {
  label: string;
  // Steps walked, for a journey; absent for the other parts.
  steps?: number;
  price_usd: number;
}

export interface PriceExplanation {
  price_usd: number;
  kind: "quick" | "walk";
  // One line of work: "Walked 7 journeys, 48 steps" / "Quick check — nothing
  // had changed, 3 pages opened".
  work: string;
  journeys_walked: number;
  steps_walked: number;
  // What each part of the work cost, as prices summing to price_usd. Empty
  // when the ledger holds nothing to split by (a quick check; an old run).
  parts: PricePart[];
  // What checks of this app usually cost this team, when there is a history.
  usual: { low: number; high: number } | null;
  // How this check compares with that, and why, in product terms.
  comparison: string | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Pure: split `price` over parts in proportion to their recorded cost, in
// cents, summing exactly to `price`.
export function splitByCost(price: number, parts: { label: string; steps?: number; cost: number }[]): PricePart[] {
  const total = parts.reduce((s, p) => s + p.cost, 0);
  if (total <= 0 || parts.length === 0) return [];
  const priceCents = Math.round(price * 100);
  const shares = parts.map((p) => ({ ...p, cents: Math.round((p.cost / total) * priceCents) }));
  const drift = priceCents - shares.reduce((s, p) => s + p.cents, 0);
  if (drift !== 0) {
    const largest = shares.reduce((a, b) => (b.cents > a.cents ? b : a));
    largest.cents += drift;
  }
  return shares.map((p) => ({ label: p.label, ...(p.steps !== undefined ? { steps: p.steps } : {}), price_usd: p.cents / 100 }));
}

// What a quick check did, in the words the price explanation uses — exported so
// a list of checks (the App page's timeline, CHE-358) says the same thing about
// one, and a place that already shows this line can leave the comparison out.
export const quickCheckWork = (pages: number) => `Quick check — nothing had changed, ${plural(pages, "page")} opened`;
export const QUICK_COMPARISON = "Nothing had changed since the last check, so this was only a quick pass.";

// Pure: the comparison line.
export function comparePrice(input: {
  kind: "quick" | "walk";
  price: number;
  usual: { low: number; high: number } | null;
  journeys: number;
  steps: number;
  usualJourneys: number | null;
  usualSteps: number | null;
}): string | null {
  if (input.kind === "quick") return QUICK_COMPARISON;
  const { usual } = input;
  if (!usual) return null;
  const range = `${usd(usual.low)}–${usd(usual.high)}`;
  if (input.price >= usual.low && input.price <= usual.high) return `In this app's usual range (${range}).`;
  const above = input.price > usual.high;
  // CHE-379: nothing was walked, so no journey or step explains the price —
  // the work line already says what it paid for. Without this, a usual of
  // earlier all-skipped checks (0 vs 0) fell through to "the journeys took
  // longer than usual".
  if (input.journeys === 0) return `${above ? "Above" : "Below"} this app's usual ${range}.`;
  // A reason is given only when it points the way the price went. Check #294
  // read "Below this app's usual $0.65–$0.89: more steps than usual (18 vs
  // 15)" — a count that went up cannot explain a price that went down. When
  // the counts differ the other way, the price is stated without a reason
  // rather than with a wrong one.
  const explains = (now: number, usual: number | null): usual is number => usual !== null && (above ? now > usual : now < usual);
  const differs = (now: number, usual: number | null) => usual !== null && now !== usual;
  const why = (() => {
    if (explains(input.journeys, input.usualJourneys)) {
      const d = Math.abs(input.journeys - input.usualJourneys);
      return `${plural(d, "journey")} ${above ? "more" : "fewer"} than usual (${input.journeys} vs ${input.usualJourneys})`;
    }
    if (explains(input.steps, input.usualSteps)) {
      return `${above ? "more" : "fewer"} steps than usual (${input.steps} vs ${input.usualSteps})`;
    }
    if (differs(input.journeys, input.usualJourneys) || differs(input.steps, input.usualSteps)) return null;
    return above ? "the journeys took longer than usual" : "the journeys were shorter than usual";
  })();
  return `${above ? "Above" : "Below"} this app's usual ${range}${why ? `: ${why}` : ""}.`;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Journeys with at least one step that was not skipped; `_count.steps` counts
// only those.
const walkedJourneys = (journeys: { _count: { steps: number } }[]) => journeys.filter((j) => j._count.steps > 0).length;

// The explanation for a run addressed by its public id, within one team — the
// shape the MCP tools and the verdict page ask for.
export async function explainRunPrice(db: PrismaClient, teamId: string, publicId: string): Promise<PriceExplanation | null> {
  const run = await db.run.findFirst({
    where: { ...teamOwned(teamId), publicId },
    select: { id: true, teamId: true, appSlug: true, priceUsd: true, quickPagesOpened: true, team: { select: { plan: true } } },
  });
  if (!run) return null;
  return explainPrice(db, run, (run.team?.plan ?? "free") as UserPlan);
}

// The explanation for one priced run of a team. Null for a run with no price
// yet (in flight, anonymous).
export async function explainPrice(
  db: PrismaClient,
  run: { id: string; teamId: string | null; appSlug: string; priceUsd: number | null; quickPagesOpened: number | null },
  plan: UserPlan,
): Promise<PriceExplanation | null> {
  if (run.priceUsd === null || !run.teamId) return null;
  const journeys = await db.journey.findMany({
    where: { runId: run.id, carriedFromRunId: null },
    orderBy: { order: "asc" },
    select: { id: true, title: true, _count: { select: { steps: { where: { status: { not: "skipped" } } } } } },
  });
  const steps = journeys.reduce((s, j) => s + j._count.steps, 0);
  // CHE-379: a journey was walked when at least one of its steps was. Every
  // journey of run #221 was skipped, and it read "Walked 5 journeys, 0 steps".
  const walked = walkedJourneys(journeys);
  const kind: "quick" | "walk" = journeys.length === 0 && run.quickPagesOpened !== null ? "quick" : "walk";
  const work =
    kind === "quick"
      ? quickCheckWork(run.quickPagesOpened ?? 0)
      : walked > 0
        ? `Walked ${plural(walked, "journey")}, ${plural(steps, "step")}`
        : null;

  const usage = await db.llmUsage.findMany({ where: { runId: run.id }, select: { phase: true, journeyId: true, costUsd: true } });
  const byJourney = new Map<string, number>();
  let mapping = 0;
  let writing = 0;
  for (const u of usage) {
    if (u.journeyId) byJourney.set(u.journeyId, (byJourney.get(u.journeyId) ?? 0) + u.costUsd);
    else if (u.phase === "discovery") mapping += u.costUsd;
    else writing += u.costUsd;
  }
  // Nothing walked: the price paid for what was done instead.
  const workLine = work ?? (mapping > 0 ? "Mapped the app; no journey was walked" : "No journey was walked");
  const parts = splitByCost(run.priceUsd, [
    ...(mapping > 0 ? [{ label: "Mapping the app", cost: mapping }] : []),
    ...journeys.map((j) => ({ label: j.title, steps: j._count.steps, cost: byJourney.get(j.id) ?? 0 })),
    ...(writing > 0 ? [{ label: "Writing the verdict", cost: writing }] : []),
  ]);

  // The app's usual: its recent walking checks, other than this one.
  const usual = await appPriceRange(db, { id: run.teamId, plan }, run.appSlug);
  const history = await db.run.findMany({
    where: { ...teamOwned(run.teamId), appSlug: run.appSlug, id: { not: run.id }, priceUsd: { gt: 0 }, costUsd: { gt: SMOKE_COST_USD * 1.1 } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { journeys: { where: { carriedFromRunId: null }, select: { _count: { select: { steps: { where: { status: { not: "skipped" } } } } } } } },
  });
  const usualJourneys = history.length >= 3 ? median(history.map((h) => walkedJourneys(h.journeys))) : null;
  const usualSteps = history.length >= 3 ? median(history.map((h) => h.journeys.reduce((s, j) => s + j._count.steps, 0))) : null;

  return {
    price_usd: run.priceUsd,
    kind,
    work: workLine,
    journeys_walked: walked,
    steps_walked: steps,
    parts,
    usual: usual ? { low: usual.low, high: usual.high } : null,
    comparison: comparePrice({ kind, price: run.priceUsd, usual, journeys: walked, steps, usualJourneys, usualSteps }),
  };
}
