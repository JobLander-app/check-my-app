// Billing (CHE-355, epic CHE-348): the sentences the page says about money,
// pure so scripts/verify-billing-page.ts can hold each one.
//
// Owner, 2026-10-01, on the old balance block: it must give a clear idea of
// what all the apps cost, and — as an example — what the last check of one of
// them cost. So the page leads with what the apps cost a month, then the
// balance, then how the two relate; and every app's last check opens into what
// it did for its price.
//
// Prices only (CLAUDE.md §10): nothing here is what a check cost us.

const round = (n: number) => `$${Math.round(n)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Under "Your apps cost $X a month". */
export function appsCostLine(i: { windowDays: number; apps: number; checks: number; perDayUsd: number; usd: (n: number) => string }): string {
  if (i.checks === 0) return `No checks in the last ${i.windowDays} days.`;
  return `Last ${i.windowDays} days, ${plural(i.apps, "app")}, ${plural(i.checks, "check")}. About ${i.usd(i.perDayUsd)} a day.`;
}

/** Under the balance: what the plan adds and when, and what was bought on top. */
export function balanceLine(i: { plan: string; creditUsd: number | null; renewsOn: string | null; topupUsd: number; usd: (n: number) => string }): string {
  const planName = i.plan.charAt(0).toUpperCase() + i.plan.slice(1);
  // A plan's amount is a round number: "$499", not "$499.00".
  const amount = (n: number) => (Number.isInteger(n) ? `$${n}` : i.usd(n));
  const parts = [
    i.creditUsd === null
      ? `${planName} plan: no limit on checks.`
      : i.renewsOn
        ? `${planName} plan adds ${amount(i.creditUsd)} on ${i.renewsOn}.`
        : `${planName} plan: ${amount(i.creditUsd)} once, it does not renew.`,
    i.topupUsd > 0 ? `${amount(i.topupUsd)} of the balance was topped up.` : null,
  ].filter(Boolean);
  return parts.join(" ");
}

/**
 * "At this pace": how the plan's monthly amount relates to what the apps cost.
 *   - covers twice or more → "The plan covers your apps N times over";
 *   - covers once          → "The plan covers your apps";
 *   - does not cover       → how many days the balance lasts;
 *   - Free (no renewal)    → how many days the balance lasts;
 *   - unlimited / nothing spent → said plainly.
 */
export function pace(i: {
  creditUsd: number | null;
  renews: boolean;
  monthlyUsd: number;
  perDayUsd: number;
  balanceUsd: number | null;
}): { headline: string; detail: string } {
  if (i.monthlyUsd <= 0) return { headline: "Nothing spent yet", detail: "A month of checks shows here once your apps have been checked." };
  if (i.creditUsd === null || i.balanceUsd === null) return { headline: "No limit on this plan", detail: `Your apps come to about ${round(i.monthlyUsd)} of checks a month.` };
  const against = `${round(i.creditUsd)} a month against ${round(i.monthlyUsd)} of checks.`;
  // From the amounts themselves, not from a ratio rounded for display: $29 of
  // plan against $29.30 of checks rounds to "1.0 times" and is still short.
  const covers = i.creditUsd / i.monthlyUsd;
  if (i.renews && covers >= 1) {
    const times = Math.floor(covers);
    return {
      headline: times >= 2 ? `The plan covers your apps ${times} times over` : "The plan covers your apps",
      detail: `${against} Top-ups are only needed beyond that.`,
    };
  }
  const days = i.perDayUsd > 0 ? Math.floor(i.balanceUsd / i.perDayUsd) : null;
  const lasts = days === null ? "The balance is not being spent" : days < 1 ? "The balance runs out today" : `The balance lasts about ${plural(days, "day")}`;
  return {
    headline: lasts,
    detail: i.renews ? `${against} The rest comes from top-ups.` : "This plan's amount does not renew. A paid plan adds its amount every month.",
  };
}

/** An app's share of the window's spending, as a bar width: 0–100, at least 1 when it spent anything. */
export function sharePercent(appUsd: number, totalUsd: number): number {
  if (totalUsd <= 0 || appUsd <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round((appUsd / totalUsd) * 100)));
}

/**
 * What the team paid for outside its apps — a PR preview, an address it never
 * saved. appHealth counts it in the total and in no app, so without this row
 * the table adds up to less than the tile above it. Null when there is none.
 */
export function outsideApps(
  total: { usd: number; checks: number },
  apps: { spendUsd: number; checks: number }[],
): { usd: number; checks: number } | null {
  const usd = Math.round((total.usd - apps.reduce((s, a) => s + a.spendUsd, 0)) * 100) / 100;
  const checks = total.checks - apps.reduce((n, a) => n + a.checks, 0);
  return usd > 0 || checks > 0 ? { usd: Math.max(0, usd), checks: Math.max(0, checks) } : null;
}

/** "31 checks" / "1 check" / "not scheduled" for the scheduled column of an app nobody scheduled. */
export function countLine(count: number, none: string): string {
  return count === 0 ? none : plural(count, "check");
}
