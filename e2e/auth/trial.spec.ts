import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { shouldSkipWatch, watchCapReason, watchTrialState, WATCH_TRIAL_DAYS } from "../../src/lib/plans";

// Dogfood: the Daily Watch free trial (CHE-54). Free gets one watch for 7 days;
// after that the scheduler stops running it until the owner subscribes.
//
// Two halves, for two different reasons:
//
//   1. The RULES are asserted against the pure functions the app and the
//      scheduler both call. Expiry can't be walked in a browser without time
//      travel, and the cap can't be walked either — proving it end-to-end needs
//      a second checked app, which on the Free plan means spending the run
//      quota this suite deliberately keeps exhausted.
//   2. The WIRING is walked for real: sign in, enable a watch through the same
//      API the verdict page posts to, and read the trial back off the dashboard
//      (nothing else exposes trialEndsAt).
//
// Ordering: Playwright runs spec files alphabetically with workers=1, so this
// lands after downgrade.spec.ts, which normally leaves the user on free. It
// doesn't assume that — the plan isn't readable from any public surface, so the
// live half branch-asserts both outcomes.
//
// The watch is deleted at the end. A daily watch left behind on the dogfood
// account is a real agent run, and its bill, every single day.

const BASE = process.env.TARGET_URL ?? "http://localhost:3000";

// The suite's sandbox domain — the only app the test user has ever checked
// (quotas.spec.ts submits it too).
const SANDBOX_URL = "https://example.com";

const DAY_MS = 24 * 60 * 60 * 1000;

test.describe("trial rules", () => {
  test("a watch with no trial date never expires", () => {
    // Paid owners and the legacy ownerless watches from before M3.
    expect(shouldSkipWatch({ trialEndsAt: null }, "free")).toBe(false);
    expect(shouldSkipWatch({ trialEndsAt: null }, null)).toBe(false);
  });

  test("free owner: the watch runs until trialEndsAt, then stops", () => {
    const now = new Date("2026-08-22T12:00:00.000Z");
    const inADay = { trialEndsAt: new Date(now.getTime() + DAY_MS) };
    const yesterday = { trialEndsAt: new Date(now.getTime() - DAY_MS) };

    expect(shouldSkipWatch(inADay, "free", now)).toBe(false);
    expect(shouldSkipWatch(yesterday, "free", now)).toBe(true);
    // The boundary belongs to the expired side: at trialEndsAt the trial is over.
    expect(shouldSkipWatch({ trialEndsAt: now }, "free", now)).toBe(true);
  });

  test("upgrading resumes an expired trial with no other state change", () => {
    const now = new Date("2026-08-22T12:00:00.000Z");
    const expired = { trialEndsAt: new Date(now.getTime() - 30 * DAY_MS) };

    expect(shouldSkipWatch(expired, "free", now)).toBe(true);
    // Same row, same stale trialEndsAt — only the owner's current plan differs.
    for (const plan of ["starter", "growth", "business", "enterprise"] as const) {
      expect(shouldSkipWatch(expired, plan, now)).toBe(false);
    }
  });

  test("free plan allows the first watch and refuses the second", () => {
    expect(watchCapReason("free", 0)).toBeNull();

    const denied = watchCapReason("free", 1);
    expect(denied).not.toBeNull();
    expect(denied).toMatch(/upgrade/i);
    expect(denied).toContain(`${WATCH_TRIAL_DAYS}-day trial`);

    // Paid plans have no watch cap: every watch spends the team's balance
    // (CHE-327).
    expect(watchCapReason("growth", 5)).toBeNull();
    expect(watchCapReason("growth", 500)).toBeNull();
  });

  test("dashboard trial state tracks the same rule as the scheduler", () => {
    const now = new Date("2026-08-22T12:00:00.000Z");

    expect(watchTrialState({ trialEndsAt: null }, "free", now)).toEqual({ kind: "none" });
    // A paid owner sees no trial banner even if the column still holds a date.
    expect(
      watchTrialState({ trialEndsAt: new Date(now.getTime() - DAY_MS) }, "starter", now),
    ).toEqual({ kind: "none" });
    expect(watchTrialState({ trialEndsAt: new Date(now.getTime() - DAY_MS) }, "free", now)).toEqual({
      kind: "ended",
    });
    // Rounded up: a partial day left is still a day left.
    expect(
      watchTrialState({ trialEndsAt: new Date(now.getTime() + 1.2 * DAY_MS) }, "free", now),
    ).toEqual({ kind: "active", daysLeft: 2 });
  });
});

test("enable Daily Watch: the trial is stamped and shown on the dashboard", async ({ page }) => {
  await setupClerkTestingToken({ page });
  await page.goto(`${BASE}/`);
  await clerk.signIn({ page, emailAddress: process.env.E2E_CLERK_USER_EMAIL! });

  // Same lookup the /check page uses to say "we already checked this app" — it
  // returns the caller's own (or an anonymous) completed run for the domain.
  const lookup = await page.request.get(
    `${BASE}/api/checks/lookup?url=${encodeURIComponent(SANDBOX_URL)}`,
  );
  expect(lookup.ok()).toBe(true);
  const found = (await lookup.json()) as { found: boolean; run?: { publicId: string } };
  test.skip(!found.found, "no completed run for the sandbox domain — nothing to watch");

  const created = await page.request.post(`${BASE}/api/watch`, {
    data: { runId: found.run!.publicId, frequency: "daily", notifyOnChangeOnly: true },
  });

  if (created.status() === 403) {
    // The account already watches a different app and is at its cap — that is
    // the gate this feature adds, asserted on the live route.
    const body = (await created.json()) as { error: string };
    expect(body.error).toMatch(/upgrade/i);
    return;
  }

  expect(created.status()).toBe(201);
  const { slug } = (await created.json()) as { slug: string };
  expect(slug).toBe("example.com");

  try {
    await page.goto(`${BASE}/dashboard`);
    const card = page.locator("li", { hasText: slug }).first();
    await expect(card).toBeVisible();
    const text = (await card.innerText()).toLowerCase();

    if (text.includes("trial")) {
      // Free plan: the watch carries trialEndsAt, and the card says so. Either
      // wording is legitimate — a re-run of this spec reuses a watch created
      // more than WATCH_TRIAL_DAYS ago, whose trial has since run out.
      expect(text).toMatch(/free trial · \d+ days? left|trial ended — daily watch paused/);
    } else {
      // Paid plan (the Stripe downgrade hasn't landed yet): no trial is stamped,
      // and the watch just runs.
      expect(text).toContain("watching · daily");
    }
  } finally {
    // Never leave a recurring daily agent run behind on the dogfood account.
    const removed = await page.request.delete(`${BASE}/api/watch/${slug}`);
    expect(removed.ok()).toBe(true);
  }
});
