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
  const { slug, trialEndsAt } = (await created.json()) as { slug: string; trialEndsAt: string | null };
  expect(slug).toBe("example.com");

  // The trial stamp itself, off the same answer (the cards no longer show
  // it, Codex on #270). Free: a date within WATCH_TRIAL_DAYS of now — or
  // earlier, when a re-run reuses a watch whose clock started on an earlier
  // night (the clock is not restarted on resume). Paid: null, never expires.
  // Which plan the nightly user is on is not readable from any public surface,
  // so both are legitimate; what is not is a Free watch with no stamp at all,
  // which would run forever — and a paid watch with one.
  const now = Date.now();
  if (trialEndsAt !== null) {
    const ends = Date.parse(trialEndsAt);
    expect(Number.isNaN(ends)).toBe(false);
    expect(ends).toBeLessThanOrEqual(now + WATCH_TRIAL_DAYS * DAY_MS + 60_000);
    expect(ends).toBeGreaterThan(now - 365 * DAY_MS);
  }

  try {
    // The app's card on Health → All apps (CHE-348 moved the apps off the old
    // dashboard; /dashboard now redirects to /home, which lists no cards). The
    // card is the <article> whose name link is the slug — not the first
    // element that happens to contain the slug: the balance block's spend
    // list said "example.com · 7 checks" and the old `li` locator read that
    // for two nights (2026-10-03, -04).
    await page.goto(`${BASE}/health/apps?view=cards`);
    const card = page.locator("article", { has: page.getByRole("link", { name: slug, exact: true }) }).first();
    await expect(card).toBeVisible();
    await expect(card.getByRole("link", { name: "Settings" })).toBeVisible();
    const text = (await card.innerText()).toLowerCase();

    // The schedule label (src/lib/all-apps.ts scheduleLabel) must agree with
    // the stamp: "Trial ended" once a Free trial's date has passed, "Daily"
    // before that and on a paid plan. Anything else means the watch the API
    // just created is not the one the page shows.
    const ended = trialEndsAt !== null && Date.parse(trialEndsAt) <= now;
    expect(text).toMatch(ended ? /trial ended/ : /\bdaily\b/);
    expect(text).not.toMatch(/not scheduled|\bpaused\b/);
  } finally {
    // Never leave a recurring daily agent run behind on the dogfood account.
    const removed = await page.request.delete(`${BASE}/api/watch/${slug}`);
    expect(removed.ok()).toBe(true);
  }
});
